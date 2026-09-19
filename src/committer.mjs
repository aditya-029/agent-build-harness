// One writer for git.
//
// Git is not built for concurrent writers. Staging or committing takes an
// exclusive lock by creating `.git/index.lock`, works against it, then renames
// it over `.git/index`. That is fine for a person typing one command. With two
// agents finishing in the same second you get three distinct failures:
//
//   contention     — one wins the lock, the other dies on "File exists"
//   half-applied   — interleaved add/commit stage a set matching nobody's intent
//   stale locks    — an agent is killed mid-commit and the orphaned lock blocks
//                    EVERY future commit, by anyone, until someone deletes it
//
// You cannot be careful enough to avoid this; two well-behaved processes that
// simply finish together will collide. The guarantee has to come from the
// design. So: agents write plain files and never touch git, and exactly one
// process commits, serialised. Many readers, one writer — the shape git is
// perfectly happy with.
//
// The IO is injected rather than imported. That is not ceremony: it means the
// retry ladder and the stale-lock rule are tested against a fake git that can
// be made to fail on demand, instead of against whatever the developer's real
// repository happens to be doing that afternoon.

/** A lock untouched for longer than this belongs to a dead process. */
export const STALE_LOCK_MS = 10_000

/** Attempts before giving up. The next change retries anyway, so this is cheap. */
export const MAX_ATTEMPTS = 6

/** Growing wait between attempts: 50ms, 100ms, 150ms, ... */
export function backoffMs(attempt) {
  return 50 * (attempt + 1)
}

/**
 * Classify what git said. The distinction that matters most is that "nothing
 * to commit" is a SUCCESS — the tree was already clean, which is the normal
 * outcome of a tick that only read things. Treating it as a failure is how a
 * committer ends up retrying six times over nothing on most invocations.
 */
export function classifyGitError(stderr = '', stdout = '') {
  const text = `${stderr}\n${stdout}`
  if (/nothing to commit|no changes added to commit|working tree clean/i.test(text)) return 'clean'
  if (/index\.lock|Unable to create.*lock|another git process/i.test(text)) return 'locked'
  return 'error'
}

/** Is this lock old enough to be presumed orphaned? */
export function isStaleLock(mtimeMs, now, thresholdMs = STALE_LOCK_MS) {
  if (typeof mtimeMs !== 'number' || Number.isNaN(mtimeMs)) return false
  return now - mtimeMs >= thresholdMs
}

/**
 * Build the argv for a commit that cannot hang.
 *
 * A fixed identity because this process commits on behalf of the whole team,
 * and gpgsign off because a signing prompt in an unattended committer is a
 * process that waits forever for a keyboard nobody is at.
 */
export function commitArgs(message, { name = 'harness', email = 'harness@local' } = {}) {
  return [
    '-c', 'commit.gpgsign=false',
    '-c', `user.name=${name}`,
    '-c', `user.email=${email}`,
    'commit', '-m', message,
  ]
}

/** Stage only the files a worker declares it owns. Broad staging is explicit. */
export function stageArgs({ paths = [], all = false } = {}) {
  if (all) return ['add', '-A']
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('commit scope required: pass paths, or explicitly opt into all')
  }
  const clean = paths.map(p => String(p).trim())
  for (const p of clean) {
    if (!p || p === '.' || p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)
      || p.split(/[\\/]/).includes('..')) {
      throw new Error(`unsafe commit path: ${p || '(empty)'}`)
    }
  }
  return ['add', '--', ...clean]
}

/**
 * The single committer.
 *
 * @param {object} io
 * @param {(args: string[]) => {status: number, stdout: string, stderr: string}} io.git
 * @param {(p: string) => number|null} io.lockMtime  - mtime of .git/index.lock, or null if absent
 * @param {(p: string) => void}        io.removeLock
 * @param {() => number}               io.now
 * @param {(ms: number) => Promise<void>} io.sleep
 * @param {(msg: string) => void}      [io.log]
 * @param {object} [opts]
 */
export function createCommitter(io, opts = {}) {
  const {
    lockPath = '.git/index.lock',
    staleMs = STALE_LOCK_MS,
    maxAttempts = MAX_ATTEMPTS,
    identity,
  } = opts
  const log = io.log || (() => {})

  // Serialises callers within this process. Two `commit()` calls that overlap
  // would recreate, inside one process, exactly the race this module exists to
  // remove — so they queue instead.
  let tail = Promise.resolve()

  async function attemptOnce(message, scope) {
    // Clear an orphaned lock BEFORE trying, not after failing. A lock left by
    // a process that died an hour ago will never clear itself, and retrying
    // into it just burns the whole ladder before reporting a failure whose
    // cause was sitting on disk the entire time.
    const mtime = io.lockMtime(lockPath)
    if (mtime !== null && isStaleLock(mtime, io.now(), staleMs)) {
      log(`clearing a stale ${lockPath} (untouched for ${Math.round((io.now() - mtime) / 1000)}s)`)
      io.removeLock(lockPath)
    }

    const add = io.git(stageArgs(scope))
    if (add.status !== 0) {
      const kind = classifyGitError(add.stderr, add.stdout)
      return { done: kind !== 'locked', ok: false, kind, output: add.stderr || add.stdout }
    }

    const res = io.git(commitArgs(message, identity))
    if (res.status === 0) return { done: true, ok: true, kind: 'committed' }

    const kind = classifyGitError(res.stderr, res.stdout)
    // A clean tree is not a failure and must not be retried.
    if (kind === 'clean') return { done: true, ok: true, kind: 'clean' }
    if (kind === 'locked') return { done: false, ok: false, kind, output: res.stderr || res.stdout }
    return { done: true, ok: false, kind, output: res.stderr || res.stdout }
  }

  /**
   * Commit a declared set of repo-relative paths. `all: true` is an explicit
   * escape hatch for a human-controlled whole-tree commit.
   * @returns {Promise<{ok: boolean, kind: string, attempts: number, output?: string}>}
   */
  function commit(message, scope = {}) {
    try { stageArgs(scope) } catch (e) {
      return Promise.resolve({ ok: false, kind: 'scope_required', attempts: 0, output: e.message })
    }
    const job = tail.then(async () => {
      let last = null
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        last = await attemptOnce(message, scope)
        if (last.done) return { ...last, attempts: attempt + 1 }
        await io.sleep(backoffMs(attempt))
      }
      // Out of attempts against a live lock. Give up quietly: something else
      // is genuinely mid-write, and the next change will commit both.
      return { ok: false, kind: 'locked', attempts: maxAttempts, output: last?.output }
    })
    // Keep the queue alive even when a job rejects, or one thrown error
    // wedges every future commit behind a permanently-rejected promise.
    tail = job.then(() => {}, () => {})
    return job
  }

  return { commit }
}
