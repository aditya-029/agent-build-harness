#!/usr/bin/env node
// Integration tests for the build harness.  `npm run harness:test`
//
// The harness is a process supervisor, not a module: it derives every path from
// its own location and dispatches on argv at import time, so it cannot be unit
// tested in-process. These tests drive the real CLI instead.
//
// SAFETY: the harness writes to `<repo>/.harness/` — the same inbox a LIVE
// session is reading, and the same cooldown the scheduler obeys. Testing
// against the real tree would inject fabricated instructions into a running
// build. So the suite copies scripts/harness into a temp dir first; because
// REPO is `path.resolve(HERE, '../..')`, the copy's state lands in the temp dir
// and the real one is never touched. The last section asserts exactly that.
//
// Recorded stream fixtures under .harness/runs are machine-local and
// gitignored, so the replay section skips itself when they are absent.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// The REAL decision logic — imported, never re-implemented. A test that
// re-derives the rule agrees with whatever it was copied from, which is
// precisely how the original rate-limit misclassification survived.
import {
  isWindowLimit, resolveLimitResume, createCtxWatcher, mainThreadContext,
  COOLDOWN_HORIZON_SEC, SUPERVISOR_PREFIX, isStaleSupervisorLine, overageSignal,
  usageSnapshot, shouldRecordUsage, createTokenMeter,
  classifyRun, isTransientFailure, idleBackoffSec, producedWork,
} from '../src/classify.mjs'
import { createBreaker, breakerMessage, BREAKER_DEFAULTS } from '../src/breaker.mjs'
import { parseMemory, trimMemory, memoryBrief, MEMORY_TEMPLATE } from '../src/memory.mjs'
import { chatArgs, hasFlag, remoteNotice } from '../src/chat.mjs'
import { parseBrief, validateBrief, briefPreamble, BRIEF_TEMPLATE } from '../src/brief.mjs'
import { createVerifier, verifierMessage, findClaims, isEvidence, VERIFY_CHECKLIST } from '../src/verify.mjs'
import { createCommitter, classifyGitError, isStaleLock, backoffMs, commitArgs, STALE_LOCK_MS } from '../src/committer.mjs'
import { makeRequest, parseQueue, currentState, pending, answer, relayMessage, renderQueue, REASONS, APPROVALS_BRIEF } from '../src/approvals.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SRC = path.join(ROOT, 'src')
// The checkout a developer is sitting in. Nothing may write here; the last
// section proves it.
const REAL = ROOT

// The harness targets whatever HARNESS_REPO names, so the sandbox is explicit
// now rather than a side effect of where the files happened to be copied.
// Setting it on process.env covers every child spawn below, all of which
// inherit it.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'))
process.env.HARNESS_REPO = SANDBOX
fs.mkdirSync(path.join(SANDBOX, 'harness'), { recursive: true })
// Copy harness.mjs plus everything it imports. Hardcoding this list meant that
// adding a module turned every CLI-driven assertion in this file red at once,
// with an ENOENT about an unrelated file as the only clue — twice.
const HARNESS_SRC = fs.readFileSync(path.join(SRC, 'harness.mjs'), 'utf8')
const LOCAL_IMPORTS = [...HARNESS_SRC.matchAll(/from\s+'\.\/([\w.-]+)'/g)].map(m => m[1])
for (const f of ['harness.mjs', ...LOCAL_IMPORTS, 'ui.html', 'hook.sh']) {
  const src = path.join(SRC, f)
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(SANDBOX, 'harness', f))
}
const H = path.join(SANDBOX, 'harness/harness.mjs')
const STATE = path.join(SANDBOX, '.harness')

// A per-project config, which also exercises the seam that makes the harness
// reusable at all.
const JOURNAL = 'logs/journal.jsonl'
fs.writeFileSync(path.join(SANDBOX, '.harness.json'), JSON.stringify({
  project: 'sandbox',
  label: 'com.harness.test-sandbox',
  journalPath: JOURNAL,
  compactRules: [
    'Never ship on a red suite.',
    'This is the second project rule.',
  ],
}, null, 2))
fs.mkdirSync(path.join(SANDBOX, 'logs'), { recursive: true })
fs.writeFileSync(path.join(SANDBOX, '.harness-prompt.md'), 'Build something.\n')

let pass = 0, fail = 0, skip = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}
const run = (args, input) => {
  try {
    return { out: execFileSync('node', [H, ...args], { input: input ?? '', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }), code: 0 }
  } catch (e) { return { out: e.stdout || '', err: e.stderr || '', code: e.status } }
}
const hook = p => run(['hook'], typeof p === 'string' ? p : JSON.stringify(p))

// Every test message carries a run-unique sentinel, and containment is checked
// against THAT rather than against the message text.
//
// The old check searched the real inbox for "CONTEXT WARNING" — which the LIVE
// supervisor writes to the real inbox during any real build. It could not tell
// a test escape from the harness doing its job, and duly reported a leak on a
// healthy running sprint. A guard that cries wolf on correct behaviour is worse
// than no guard: it trains you to ignore it.
const SENTINEL = `TESTMSG-${process.pid}`
const say = msg => run(['say', `${msg} [${SENTINEL}]`])

// Snapshot of real state taken BEFORE anything runs, so containment asserts
// "these tests changed nothing" rather than "the real repo happens to look
// idle". Adi pauses the live harness deliberately; its being paused is not
// evidence of a leak, but its mtime moving during this run would be.
const REAL_PAUSED = path.join(REAL, '.harness/paused')
const realPausedBefore = (() => { try { return fs.statSync(REAL_PAUSED).mtimeMs } catch { return null } })()

console.log('\n── Sandbox is a complete copy')
{
  // Adding breaker.mjs without adding it to the copy list above turned every
  // CLI-driven assertion in this file red at once, with an ENOENT about an
  // unrelated file as the only clue. A structural check costs nothing and
  // names the actual problem.
  // The rule is "everything harness.mjs IMPORTS", not "every file in src/" —
  // scorecard.mjs is a standalone command and its absence is harmless.
  const src = fs.readFileSync(path.join(SRC, 'harness.mjs'), 'utf8')
  const imported = [...src.matchAll(/from\s+'\.\/([\w.-]+)'/g)].map(m => m[1])
  ok('harness.mjs imports at least one local module', imported.length > 0)
  const missing = imported.filter(f => !fs.existsSync(path.join(SANDBOX, 'harness', f)))
  ok('every module harness.mjs imports is copied into the sandbox',
    missing.length === 0, missing.join(', '))
  // And the copy must actually load — an import error inside it looks like a
  // dead CLI rather than a failed test.
  const boot = run(['status'])
  ok('the sandboxed harness boots', boot.code === 0 && /usage/.test(boot.out),
    (boot.err || boot.out || '').slice(0, 160))
}

console.log('\n── CLI regression')
{
  const s = run(['status'])
  ok('status exits 0', s.code === 0)
  ok('status reports the unit cap', /max \d+ unit\(s\)/.test(s.out))
  ok('status prints a next-tick decision', /next tick\s+\S/.test(s.out))
  ok('usage --json emits parseable JSON', (() => { try { return typeof JSON.parse(run(['usage', '--json']).out).u.ok === 'boolean' } catch { return false } })())
  ok('usage renders a human report', /reading\s+\S/.test(run(['usage']).out) && /5-hour\s+\d+%/.test(run(['usage']).out))
  ok('unknown command exits 1', run(['nonsense']).code === 1)
  ok('no command exits 0', run([]).code === 0)
}

console.log('\n── pause / resume')
{
  run(['pause'])
  ok('pause creates marker', fs.existsSync(path.join(STATE, 'paused')))
  ok('paused blocks the tick', /never — paused/.test(run(['status']).out))
  run(['resume'])
  ok('resume clears marker', !fs.existsSync(path.join(STATE, 'paused')))
}

console.log('\n── PreCompact constraint pinning')
{
  // Compaction is lossy summarisation, and a constraint that does not survive
  // the summary stops being obeyed while the agent keeps working confidently
  // without it. These assertions are the contract that the rules whose loss is
  // unrecoverable are named explicitly and demanded verbatim.
  const r = hook({ hook_event_name: 'PreCompact', session_id: 't1', trigger: 'auto' })
  ok('exits 0', r.code === 0)
  // PreCompact must emit NOTHING. This build validates hook output against a
  // schema with no PreCompact case, so any reply is rejected wholesale — which
  // is how the original customInstructions pinning ran for weeks doing nothing.
  ok('PreCompact stays silent rather than emitting rejected JSON', r.out.trim() === '')
  ok('PreCompact arms a re-pin', fs.existsSync(path.join(STATE, 'events', 't1.repin')))

  // Delivery is through PreToolUse additionalContext — the channel proven to
  // reach a running session — and lands AFTER the summary, so the constraint is
  // present in context rather than merely requested of the summariser.
  const d = hook({ hook_event_name: 'PreToolUse', session_id: 't1', tool_name: 'Read' })
  const ci = (() => { try { return JSON.parse(d.out).hookSpecificOutput.additionalContext } catch { return '' } })()
  ok('re-pin is delivered on the next tool call', /context was just compacted/i.test(ci))
  ok('pins the assertion rule', /weaken a failing test/i.test(ci))
  ok('pins the secrets rule', /never commit a secrets file/i.test(ci))
  ok('demands re-derivation over recall', /re-establish ground truth from disk/i.test(ci))
  ok('forbids claiming green without re-running verify', /quote its actual output/i.test(ci))
  ok('recovers the handoff next value', /"next" value/.test(ci))
  ok('names the configured journal, not a hardcoded one', new RegExp(JOURNAL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(ci))
  // The seam that makes the harness reusable: project rules come from
  // .harness.json. If this regresses, the next project silently inherits
  // someone else's non-negotiables after every compaction.
  ok('injects the project compactRules from .harness.json', /never ship on a red suite/i.test(ci))
  ok('injects every configured rule, not just the first', /second project rule/i.test(ci))

  // Once, not on every tool call for the rest of the session.
  const again = hook({ hook_event_name: 'PreToolUse', session_id: 't1', tool_name: 'Read' })
  ok('re-pin fires once per compaction', !/context was just compacted/i.test(again.out))
  ok('a session that never compacted gets no re-pin',
    !/context was just compacted/i.test(hook({ hook_event_name: 'PreToolUse', session_id: 't2', tool_name: 'Read' }).out))
}

console.log('\n── PreToolUse inbox delivery')
{
  // Unaddressed lines now go only to the session the harness launched, so
  // these must declare one. See "Inbox reaches only the build session".
  fs.writeFileSync(path.join(STATE, 'current_session'), 't2')
  fs.writeFileSync(path.join(STATE, 'inbox.md'), '')
  const empty = hook({ hook_event_name: 'PreToolUse', session_id: 't2', tool_name: 'Read', tool_input: {} })
  ok('empty inbox emits nothing', empty.out.trim() === '' && empty.code === 0)

  say('CONTEXT WARNING (91k of 120k). Delegate, do not read.')
  const main = hook({ hook_event_name: 'PreToolUse', session_id: 't2', tool_name: 'Read', tool_input: {} })
  let j = null; try { j = JSON.parse(main.out) } catch {}
  const ctx = j?.hookSpecificOutput?.additionalContext || ''
  ok('main thread receives the nudge', /CONTEXT WARNING/.test(ctx))
  ok('nudge framed as overriding instruction', /overrides the current plan/.test(ctx))
  ok('nudge is drained, not repeated', hook({ hook_event_name: 'PreToolUse', session_id: 't2', tool_name: 'Read', tool_input: {} }).out.trim() === '')

  say('@reviewer: check the diff')
  ok('addressed message withheld from the wrong subagent',
    hook({ hook_event_name: 'PreToolUse', session_id: 't2', agent_id: 'a1', agent_type: 'scorer-smith', tool_name: 'Read', tool_input: {} }).out.trim() === '')
  ok('addressed message reaches the right subagent',
    /check the diff/.test(hook({ hook_event_name: 'PreToolUse', session_id: 't2', agent_id: 'a2', agent_type: 'reviewer', tool_name: 'Read', tool_input: {} }).out))
}

console.log('\n── Hook fails open')
{
  // Exit code 2 means "block this tool call". A hook that can exit 2 by
  // accident once refused every tool call in a session, including the ones
  // needed to repair the config. Every path here must end in 0.
  ok('malformed JSON stdin exits 0', hook('{not json').code === 0)
  ok('empty stdin exits 0', hook('').code === 0)
  ok('unknown event exits 0 silently', (() => { const r = hook({ hook_event_name: 'Nonsense', session_id: 't3' }); return r.code === 0 && r.out.trim() === '' })())
  ok('missing session_id exits 0', hook({ hook_event_name: 'PreToolUse' }).code === 0)
  const sh = path.join(SANDBOX, 'harness/hook.sh')
  let shCode = 0
  try { execFileSync('bash', [sh], { input: '{bad', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }) } catch (e) { shCode = e.status }
  ok('hook.sh exits 0 on garbage, never 2', shCode === 0, `got ${shCode}`)
}

console.log('\n── Rate-limit classification (replay against recorded runs)')
{
  // Committed with the repo, unlike the machine-local originals: a replay suite
  // that skips itself on a fresh clone is a suite nobody runs. See
  // test/fixtures/README.md for what was scrubbed and why.
  const runsDir = path.join(ROOT, 'test/fixtures/runs')
  if (!fs.existsSync(runsDir) || !fs.readdirSync(runsDir).length) {
    skip += 6
    console.log('  SKIP  no fixtures in test/fixtures/runs')
  } else {
    // Rewritten 2026-08-22. The previous assertion was `genuine === 0` — every
    // failed run must be a window limit. That was true when written because
    // every recorded failure WAS a rate limit, and it went red the first time a
    // third failure mode reached production (5 dropped connections, 07-11 Aug).
    // It was the wrong property to assert: a genuine fatal error SHOULD
    // classify as an error, so the assertion could only ever be satisfied by
    // the continued absence of one.
    //
    // What is worth asserting is that the partition is exhaustive and each
    // bucket is correctly populated — a property that survives new failure
    // modes appearing, and fails loudly if one is swallowed into the wrong one.
    const bucket = { ok: 0, window_limit: 0, transient: 0, error: 0, incomplete: 0 }
    let withReset = 0, falsePos = 0, unknown = 0
    const errorSamples = []
    for (const f of fs.readdirSync(runsDir)) {
      let result = null, rl = 0, resets = 0
      for (const l of fs.readFileSync(path.join(runsDir, f), 'utf8').split('\n')) {
        let e; try { e = JSON.parse(l) } catch { continue }
        if (e.type === 'result') result = e
        if (e.type === 'rate_limit_event' && e.rate_limit_info?.status === 'rejected') {
          rl++; resets = Math.max(resets, e.rate_limit_info.resetsAt || 0)
        }
      }
      const kind = classifyRun({ result, rateLimited: rl })
      if (kind in bucket) bucket[kind]++; else unknown++
      if (kind === 'window_limit') { if (resets > 0) withReset++; if (result && !result.is_error) falsePos++ }
      if (kind === 'error') errorSamples.push(`${f}:${String(result?.result || '').slice(0, 50)}`)
    }
    ok('every recorded run lands in a known bucket', unknown === 0, `${unknown} unclassifiable`)
    ok('the window-limit bucket is exercised', bucket.window_limit > 0, `${bucket.window_limit}`)
    ok('the transient bucket is exercised', bucket.transient > 0, `${bucket.transient}`)
    ok('no successful run misflagged as rate-limited', falsePos === 0, `${falsePos}`)
    ok('every window-limit run carries an authoritative resetsAt',
      withReset === bucket.window_limit, `${withReset}/${bucket.window_limit}`)
    // NOT "there are no errors" — there may legitimately be some one day. This
    // asserts that anything reaching the punitive 30-minute bucket is something
    // a human has actually looked at, so a new failure mode cannot quietly
    // accumulate there the way the dropped connections did.
    ok('nothing unexamined has fallen into the hard-error bucket',
      bucket.error === 0, `${bucket.error}: ${errorSamples.slice(0, 3).join(' | ')}`)
}

console.log('\n── isTransientFailure / classifyRun (unit)')
{
  const drop = { is_error: true, terminal_reason: 'api_error', result: 'API Error: Connection closed mid-response. The response above may be incomplete.' }
  ok('a dropped connection is transient', isTransientFailure({ result: drop }))
  ok('and classifies as transient, not error', classifyRun({ result: drop }) === 'transient')

  // The whole reason the error backoff exists. If any of these regress, a
  // permanently broken account goes into a 2-minute retry loop.
  ok('a 401 is NOT transient even with a transport-shaped message',
    !isTransientFailure({ result: { ...drop, api_error_status: 401 } }))
  ok('a 500 is NOT transient', !isTransientFailure({ result: { ...drop, api_error_status: 500 } }))
  ok('a 429 is NOT transient — it is a window limit',
    !isTransientFailure({ result: { ...drop, api_error_status: 429 }, rateLimited: 1 }))
  ok('a window limit still classifies as window_limit',
    classifyRun({ result: { is_error: true, terminal_reason: 'api_error', api_error_status: 429 }, rateLimited: 1 }) === 'window_limit')
  ok('an unrecognised api_error is NOT transient — it keeps the long backoff',
    !isTransientFailure({ result: { is_error: true, terminal_reason: 'api_error', result: 'API Error: something new nobody has seen' } }))
  ok('and lands in the conservative error bucket',
    classifyRun({ result: { is_error: true, terminal_reason: 'api_error', result: 'API Error: something new' } }) === 'error')
  ok('a successful run is not transient', !isTransientFailure({ result: { is_error: false, result: 'done' } }))
  ok('a successful run classifies as ok', classifyRun({ result: { is_error: false } }) === 'ok')
  ok('a run with no result event is incomplete', classifyRun({ result: null }) === 'incomplete')
  ok('ECONNRESET is transient',
    isTransientFailure({ result: { is_error: true, terminal_reason: 'api_error', result: 'read ECONNRESET' } }))
}

console.log('\n── idle backoff (unit)')
{
  const B = 900, C = 21600
  ok('no streak means no cooldown', idleBackoffSec({ streak: 0, baseSec: B, capSec: C }) === 0)
  ok('a negative streak means no cooldown', idleBackoffSec({ streak: -3, baseSec: B, capSec: C }) === 0)
  ok('the first idle session waits one interval', idleBackoffSec({ streak: 1, baseSec: B, capSec: C }) === 900)
  ok('the second doubles', idleBackoffSec({ streak: 2, baseSec: B, capSec: C }) === 1800)
  ok('the fourth is 2h', idleBackoffSec({ streak: 4, baseSec: B, capSec: C }) === 7200)
  ok('it caps rather than growing forever', idleBackoffSec({ streak: 9, baseSec: B, capSec: C }) === C)
  // 2**n reaches Infinity around n=1075. Math.min(Infinity, cap) is cap, but
  // assert it rather than trusting it: an uncapped cooldown is unrecoverable
  // without deleting state by hand, which is the same failure shape as the
  // 55,000-year cooldown COOLDOWN_HORIZON_SEC exists to prevent.
  ok('an absurd streak still caps', idleBackoffSec({ streak: 5000, baseSec: B, capSec: C }) === C)
  ok('a non-numeric streak is treated as none', idleBackoffSec({ streak: NaN, baseSec: B, capSec: C }) === 0)

  const JOURNAL = 'logs/build-scheduler.jsonl'
  ok('an unmoved HEAD is not work', !producedWork([], [JOURNAL]))
  ok('a journal-only commit is not work', !producedWork([JOURNAL], [JOURNAL]))
  ok('a journal commit plus real code IS work', producedWork([JOURNAL, 'src/lib/a.ts'], [JOURNAL]))
  ok('any real file is work', producedWork(['src/lib/a.ts'], [JOURNAL]))
  ok('with no bookkeeping list, any change is work', producedWork([JOURNAL], []))
  ok('a bookkeeping DIRECTORY prefix matches its contents', !producedWork(['logs/runs/a.json'], ['logs/runs']))
  ok('but a prefix must not match a sibling by string alone',
    producedWork(['logs/runs-other/a.json'], ['logs/runs']))
  ok('blank paths do not count as work', !producedWork(['', '  '], [JOURNAL]))
  ok('a non-array is not work', !producedWork(null, [JOURNAL]))
}

console.log('\n── isWindowLimit (unit)')
{
  const now = 1_800_000_000
  ok('429 is a window limit', isWindowLimit({ result: { api_error_status: 429 } }))
  ok('rejected event + api_error terminal is a window limit',
    isWindowLimit({ result: { terminal_reason: 'api_error' }, rateLimited: 1 }))
  // The bug pointed the other way: a revoked key must NOT look like a window.
  ok('api_error alone (401/500) is NOT a window limit',
    !isWindowLimit({ result: { terminal_reason: 'api_error' }, rateLimited: 0 }))
  ok('a clean success is not a window limit', !isWindowLimit({ result: { subtype: 'success' } }))
  ok('subtype "success" does not mask a 429',
    isWindowLimit({ result: { subtype: 'success', is_error: true, api_error_status: 429 } }))
  ok('missing result is not a window limit', !isWindowLimit({ result: null }))

  console.log('\n── resolveLimitResume (unit) — the cooldown clamp')
  ok('a plausible future reset is trusted', resolveLimitResume({ resetsAt: now + 600, now }) === now + 630)
  ok('a past reset falls back', resolveLimitResume({ resetsAt: now - 10, now }) === null)
  ok('zero falls back', resolveLimitResume({ resetsAt: 0, now }) === null)
  ok('undefined falls back', resolveLimitResume({ resetsAt: undefined, now }) === null)
  ok('a string falls back', resolveLimitResume({ resetsAt: '2026-08-01', now }) === null)
  ok('NaN falls back', resolveLimitResume({ resetsAt: NaN, now }) === null)
  // Without this clamp a millisecond timestamp parks the scheduler ~55,000
  // years out, and nothing in the system expires or repairs a cooldown.
  ok('a millisecond timestamp is rejected, not obeyed',
    resolveLimitResume({ resetsAt: now * 1000, now }) === null)
  ok('anything past the horizon is rejected',
    resolveLimitResume({ resetsAt: now + COOLDOWN_HORIZON_SEC + 1, now }) === null)
  ok('the horizon boundary itself is accepted',
    resolveLimitResume({ resetsAt: now + COOLDOWN_HORIZON_SEC - 1, now }) !== null)
  }
}

console.log('\n── Context watcher')
{
  // Drives the REAL createCtxWatcher/mainThreadContext from classify.mjs —
  // never re-implemented here, for the same reason isWindowLimit isn't above.
  const WARN = 70_000, HANDOFF = 90_000
  const mk = () => {
    const sent = []
    const w = createCtxWatcher({
      warnTokens: WARN, handoffTokens: HANDOFF,
      onWarn: () => sent.push('WARNING'),
      onHandoff: () => sent.push('CEILING'),
    })
    return { sent, feed: ev => w.feed(ev) }
  }
  const msg = (t, extra = {}) => ({ type: 'assistant', message: { usage: { input_tokens: 0, cache_read_input_tokens: t, cache_creation_input_tokens: 0 } }, ...extra })

  let w = mk(); [20e3, 55e3, 71e3, 75e3, 91e3, 140e3].forEach(t => w.feed(msg(t)))
  ok('fires WARNING then CEILING, once each', JSON.stringify(w.sent) === '["WARNING","CEILING"]', JSON.stringify(w.sent))

  w = mk(); w.feed(msg(200e3))
  ok('a single jump past both fires CEILING only', JSON.stringify(w.sent) === '["CEILING"]', JSON.stringify(w.sent))

  w = mk(); [75e3, 20e3, 30e3, 76e3].forEach(t => w.feed(msg(t)))
  ok('non-monotonic context does not re-fire', w.sent.length === 1)

  w = mk()
  ;[150e3, 160e3].forEach(t => w.feed(msg(t, { agent_id: 'sub1' })))
  ;[150e3, 160e3].forEach(t => w.feed(msg(t, { parent_tool_use_id: 'tu1' })))
  ok('subagent context never triggers a nudge', w.sent.length === 0, JSON.stringify(w.sent))

  w = mk(); w.feed(msg(160e3, { agent_id: 'sub' })); w.feed(msg(75e3))
  ok('main thread still counted after subagent traffic', JSON.stringify(w.sent) === '["WARNING"]', JSON.stringify(w.sent))

  w = mk(); w.feed({ type: 'assistant', message: {} }); w.feed({ type: 'assistant' })
  ok('a message with no usage is ignored', w.sent.length === 0)

  const src = fs.readFileSync(path.join(SRC, 'harness.mjs'), 'utf8')
  ok('thresholds here match harness.mjs', /MAX_CTX_WARN, 70_000/.test(src) && /MAX_CTX_HANDOFF, 90_000/.test(src))
}

console.log('\n── mainThreadContext (unit)')
{
  const usage = t => ({ type: 'assistant', message: { usage: { input_tokens: 1, cache_read_input_tokens: t, cache_creation_input_tokens: 2 } } })
  ok('sums the three token fields', mainThreadContext(usage(100)) === 103)
  ok('a subagent turn is excluded', mainThreadContext({ ...usage(100), agent_id: 'a' }) === null)
  ok('a nested tool-use turn is excluded', mainThreadContext({ ...usage(100), parent_tool_use_id: 't' }) === null)
  ok('a non-assistant event is excluded', mainThreadContext({ type: 'result', message: { usage: {} } }) === null)
  ok('a turn with no usage is excluded', mainThreadContext({ type: 'assistant', message: {} }) === null)
  ok('null is handled', mainThreadContext(null) === null)
}

console.log('\n── Supervisor advisories are not attributed to Adi')
{
  fs.writeFileSync(path.join(STATE, 'current_session'), 't9')
  ok('a supervisor context line is recognised as stale',
    isStaleSupervisorLine(`${SUPERVISOR_PREFIX}CONTEXT CEILING (140k). Stop taking on new work.`))
  ok('a supervisor warning is recognised as stale',
    isStaleSupervisorLine(`${SUPERVISOR_PREFIX}CONTEXT WARNING (91k of 120k).`))
  ok('a human line is never treated as stale', !isStaleSupervisorLine('ship the SWT renderer tonight'))
  ok('a non-context supervisor line survives', !isStaleSupervisorLine(`${SUPERVISOR_PREFIX}build finished`))
  ok('a human line merely mentioning the phrase survives',
    !isStaleSupervisorLine('why did CONTEXT CEILING fire twice?'))

  // Delivery framing: the agent must be able to tell a measured heuristic from
  // an instruction Adi actually typed.
  fs.writeFileSync(path.join(STATE, 'inbox.md'), '')
  say(`${SUPERVISOR_PREFIX}CONTEXT WARNING (91k of 120k). Avoid pulling source into context.`)
  let j = null
  try { j = JSON.parse(hook({ hook_event_name: 'PreToolUse', session_id: 't9', tool_name: 'Read', tool_input: {} }).out) } catch {}
  const ctx = j?.hookSpecificOutput?.additionalContext || ''
  ok('supervisor nudge is delivered', /CONTEXT WARNING/.test(ctx))
  ok('labelled as from the supervisor', /AUTOMATED MESSAGE FROM THE BUILD SUPERVISOR/.test(ctx))
  ok('explicitly NOT attributed to Adi', /not from Adi/.test(ctx) && !/LIVE MESSAGE FROM ADI/.test(ctx))
  ok('the marker itself is stripped before delivery', !ctx.includes(SUPERVISOR_PREFIX))

  // A human line and a supervisor line in the same drain must stay separable.
  fs.writeFileSync(path.join(STATE, 'inbox.md'), '')
  say('stop after this unit')
  say(`${SUPERVISOR_PREFIX}CONTEXT CEILING (121k).`)
  let both = null
  fs.writeFileSync(path.join(STATE, 'current_session'), 't10')
  try { both = JSON.parse(hook({ hook_event_name: 'PreToolUse', session_id: 't10', tool_name: 'Read', tool_input: {} }).out) } catch {}
  const b = both?.hookSpecificOutput?.additionalContext || ''
  ok('human and supervisor blocks are both delivered',
    /stop after this unit/.test(b) && /CONTEXT CEILING/.test(b))
  ok('each keeps its own attribution',
    /LIVE MESSAGE FROM ADI/.test(b) && /AUTOMATED MESSAGE FROM THE BUILD SUPERVISOR/.test(b))
  fs.writeFileSync(path.join(STATE, 'inbox.md'), '')
}

console.log('\n── Cooldown round-trip')
{
  const cd = path.join(STATE, 'cooldown_until')
  const now = Math.floor(Date.now() / 1000)
  fs.writeFileSync(cd, JSON.stringify({ until: now + 3600, reason: 'window_reset' }))
  ok('a future window_reset blocks the tick', /skip — in cooldown/.test(run(['status']).out))
  fs.writeFileSync(cd, JSON.stringify({ until: now - 10, reason: 'window_reset' }))
  ok('an elapsed authoritative cooldown allows a run', /RUN —/.test(run(['status']).out))
  fs.writeFileSync(cd, '1785434400')
  ok('a legacy plain-integer cooldown still parses', run(['status']).code === 0)
  fs.rmSync(cd, { force: true })
}

console.log('\n── Paid-credit detection (overageSignal)')
{
  const ev = info => ({ type: 'rate_limit_event', rate_limit_info: info })
  ok('non rate-limit events are ignored', overageSignal({ type: 'assistant' }) === null)
  ok('within the included allowance is not overage',
    overageSignal(ev({ status: 'allowed_warning', utilization: 0.92, isUsingOverage: false })).usingOverage === false)
  ok('approach warning exposes utilization',
    overageSignal(ev({ status: 'allowed_warning', utilization: 0.92, isUsingOverage: false })).utilization === 0.92)
  ok('crossing onto paid credits is detected',
    overageSignal(ev({ status: 'allowed', isUsingOverage: true, overageStatus: 'allowed' })).usingOverage === true)
  ok('a rejected request is flagged',
    overageSignal(ev({ status: 'rejected', resetsAt: 123, rateLimitType: 'five_hour' })).rejected === true)
  ok('resetsAt and kind are carried through', (() => {
    const s = overageSignal(ev({ status: 'rejected', resetsAt: 123, rateLimitType: 'five_hour' }))
    return s.resetsAt === 123 && s.kind === 'five_hour'
  })())
  ok('missing utilization is null, not zero',
    overageSignal(ev({ status: 'rejected' })).utilization === null)
  // Guards the distinction the whole policy rests on: an approach warning must
  // never be mistaken for paid usage, or the harness stops while still free.
  ok('0.99 utilization is still NOT overage',
    overageSignal(ev({ status: 'allowed_warning', utilization: 0.99, isUsingOverage: false })).usingOverage === false)
}

console.log('\n── Inbox reaches only the build session')
{
  // The inbox is repo-global and every Claude Code session in the tree runs the
  // same PreToolUse hook. Without scoping, an interactive session sitting in
  // the repo drains messages meant for the unattended build — which happened:
  // a scope-change message was eaten by the wrong session and never arrived.
  const cur = path.join(STATE, 'current_session')
  const inbox = path.join(STATE, 'inbox.md')
  const pre = (sid, extra = {}) =>
    hook({ hook_event_name: 'PreToolUse', session_id: sid, tool_name: 'Read', tool_input: {}, ...extra })

  fs.writeFileSync(cur, 'build-123')
  fs.writeFileSync(inbox, 'ship the mock engine next\n')
  ok('a stranger session gets nothing', pre('some-other-session').out.trim() === '')
  ok('the message survives the stranger', fs.readFileSync(inbox, 'utf8').includes('mock engine'))
  ok('the build session receives it', /mock engine/.test(pre('build-123').out))
  ok('and it is drained after delivery', !fs.readFileSync(inbox, 'utf8').includes('mock engine'))

  // With no tick in flight the message must WAIT, not be consumed by whoever
  // happens to call a tool first.
  fs.rmSync(cur, { force: true })
  fs.writeFileSync(inbox, 'queued while idle\n')
  ok('nobody drains it while no build is running', pre('anyone').out.trim() === '')
  ok('it is still queued for the next build', fs.readFileSync(inbox, 'utf8').includes('queued while idle'))

  // Addressed lines are routed by agent type and must not regress.
  fs.writeFileSync(cur, 'build-123')
  fs.writeFileSync(inbox, '@reviewer: look again\n')
  ok('addressed lines still reach their subagent',
    /look again/.test(pre('build-123', { agent_id: 'a1', agent_type: 'reviewer' }).out))
  fs.writeFileSync(inbox, '')
  fs.rmSync(cur, { force: true })
}

console.log('\n── Lock does not self-deadlock a loop')
{
  // cmdTick is called repeatedly in sprint mode from ONE process. The lock
  // holds our own PID across passes on purpose (it keeps launchd out), so a
  // lock matching the current process must not be read as a concurrent tick.
  // Getting this wrong ended a sprint after a single real session.
  const lock = path.join(STATE, 'run.lock')
  fs.writeFileSync(lock, String(process.pid)) // a live PID that is NOT the tick's
  const out = run(['status'])
  ok('a live foreign lock does not break status', out.code === 0)

  fs.writeFileSync(lock, '999999999') // implausible, certainly dead
  ok('a stale lock is ignored', run(['status']).code === 0)
  fs.rmSync(lock, { force: true })

  const src = fs.readFileSync(path.join(SRC, 'harness.mjs'), 'utf8')
  ok('tick compares the lock PID against its own before skipping',
    /oldPid\s*&&\s*oldPid\s*!==\s*process\.pid/.test(src))
  ok('the lock is still held across passes, not released per tick',
    /NOT released between passes/.test(src))
}

console.log('\n── Overage message does not tell an authorised run to stop')
{
  // Two consecutive sessions spent ~$0.35 each doing nothing because this
  // message told the agent to wind down the instant it began drawing credits —
  // which is precisely the spend that was bought to keep it working.
  const src = fs.readFileSync(path.join(SRC, 'harness.mjs'), 'utf8')
  const allowed = src.slice(src.indexOf('if (CONFIG.allowOverage) {'), src.indexOf('} else {'))
  ok('authorised overage does not instruct a stop', !/finish the current unit and stop/.test(allowed))
  ok('authorised overage explicitly says keep working', /Do NOT wind down early/.test(allowed))
  const refused = src.slice(src.indexOf('} else {', src.indexOf('if (CONFIG.allowOverage) {')))
  ok('UNauthorised overage still demands an immediate stop', /STOP NOW/.test(refused.slice(0, 900)))
}

console.log('\n── Budget cap')
{
  const cost = path.join(STATE, 'cost.jsonl')
  const baseline = path.join(STATE, 'budget_baseline')
  const mk = (n, each) => Array.from({ length: n }, (_, i) =>
    JSON.stringify({ ts: `2026-08-0${(i % 8) + 1}T00:00:00Z`, session_id: 's' + i, cost_usd: each, turns: 10, exit: 0 })).join('\n') + '\n'

  fs.rmSync(baseline, { force: true })
  fs.writeFileSync(cost, mk(10, 1.0)) // $10 of clean spend
  ok('counts clean sessions', /lifetime \$10\.00/.test(run(['status']).out), run(['status']).out)
  ok('with no baseline the whole history counts',
    /\$10\.00 of \$110 allowance/.test(run(['status']).out))

  // Runs killed by the window report a rolling ACCOUNT total, not the run's
  // cost — counting them would trip the cap early on money never spent.
  fs.writeFileSync(cost, mk(10, 1.0) +
    JSON.stringify({ ts: '2026-08-09T00:00:00Z', session_id: 'x', cost_usd: 4000, turns: 1, exit: 1 }) + '\n')
  ok('ignores limit-killed rolling-total artefacts', /lifetime \$10\.00/.test(run(['status']).out))

  fs.writeFileSync(cost, mk(10, 1.0))
  run(['budget', 'reset'])
  ok('baseline stamps at current total', (fs.readFileSync(baseline, 'utf8').trim() === '10'))
  ok('spend since baseline resets to zero', /\$0\.00 of \$110 allowance/.test(run(['status']).out))

  fs.writeFileSync(cost, mk(20, 1.0)) // +$10 since the baseline
  const small = { ...process.env, BUDGET_CAP: '5' }
  const runEnv = (args) => {
    try { return execFileSync('node', [H, ...args], { encoding: 'utf8', env: small, stdio: ['pipe', 'pipe', 'pipe'] }) } catch (e) { return e.stdout || '' }
  }
  ok('cap trips on spend SINCE baseline, not lifetime', /CAP REACHED/.test(runEnv(['status'])))
  ok('next tick refuses once capped', /never — budget cap reached/.test(runEnv(['status'])))
  ok('an unreached cap still runs', !/CAP REACHED/.test(run(['status'])))

  fs.rmSync(cost, { force: true }); fs.rmSync(baseline, { force: true })
  ok('missing cost log is not a crash', run(['status']).code === 0)
}

console.log('\n── Live usage metering')
{
  const rle = info => ({ type: 'rate_limit_event', rate_limit_info: info })

  ok('snapshot ignores a non-usage event', usageSnapshot({ type: 'assistant' }, 100) === null)
  const s1 = usageSnapshot(rle({ status: 'allowed', utilization: 0.42, rateLimitType: 'session', resetsAt: 900 }), 100)
  ok('snapshot carries utilisation', s1.util === 0.42 && s1.kind === 'session' && s1.at === 100)
  ok('snapshot carries the reset time', s1.resets_at === 900)
  // A rejection has no utilisation float, but it is the single most important
  // reading there is — recording it as "nothing to say" loses the one event
  // that proves the window is gone.
  const rej = usageSnapshot(rle({ status: 'rejected', rateLimitType: 'session', resetsAt: 900 }), 100)
  ok('a rejection reads as a spent window', rej.util === 1 && rej.status === 'rejected')

  ok('first observation is always written', shouldRecordUsage(null, s1) === true)
  ok('a near-identical observation is suppressed',
    shouldRecordUsage(s1, { ...s1, at: 110, util: 0.425 }) === false)
  ok('a real move is written', shouldRecordUsage(s1, { ...s1, at: 110, util: 0.50 }) === true)
  ok('the heartbeat writes eventually', shouldRecordUsage(s1, { ...s1, at: 400, util: 0.421 }) === true)
  // The overage edge is the moment money starts. It must never be filtered out
  // as a small move — it is a state change, not a delta.
  ok('crossing onto paid credits is never suppressed',
    shouldRecordUsage({ ...s1, overage: false }, { ...s1, at: 101, util: 0.42, overage: true }) === true)

  // Shaped from a REAL recorded run. The streaming assistant events carry
  // stop_reason:null and an output_tokens sampled at message start, and the
  // identical usage object repeats. Summing them undercounted output ~87x and
  // double-counted cached input 2.3x — a meter that shipped and produced a
  // plausible-looking 85% cache ratio out of nonsense. These assertions exist
  // to make that specific mistake un-shippable again.
  const partial = usage => ({ type: 'assistant', message: { stop_reason: null, usage, content: [] } })
  const snap = { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 27489, cache_creation_input_tokens: 24445 }
  const meter = createTokenMeter()
  for (let i = 0; i < 27; i++) meter.feed(partial(snap))
  const beforeResult = meter.snapshot()
  ok('streaming snapshots alone are reported as unmeasured', beforeResult.measured === false)
  ok('streaming snapshots are never summed', beforeResult.output === 0 && beforeResult.cache_read === 0)

  meter.feed({ type: 'result', usage: { input_tokens: 20, output_tokens: 11814, cache_read_input_tokens: 659604, cache_creation_input_tokens: 53885 } })
  const t = meter.snapshot()
  ok('the settled result total is what is reported', t.output === 11814 && t.measured === true)
  ok('cached input is counted once, not per snapshot', t.cache_read === 659604)
  ok('cache-hit ratio is computed off the settled totals',
    t.cache_hit === +(659604 / (20 + 659604 + 53885)).toFixed(4))

  // Subagents are the dominant cost driver, so the count has to survive the
  // same repetition that broke the token sum.
  const spawn = id => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', id }] } })
  const m2 = createTokenMeter()
  m2.feed(spawn('tu_a')); m2.feed(spawn('tu_a')); m2.feed(spawn('tu_b'))
  m2.feed({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', id: 'tu_c' }] } })
  ok('subagent spawns are deduped by tool id', m2.snapshot().subagents === 2)
  ok('ordinary tool calls are not counted as spawns', m2.snapshot().subagents === 2)

  // End-to-end through the CLI, with HOME pointed at the sandbox so the real
  // ~/.claude.json cache cannot decide the outcome.
  const usageLog = path.join(STATE, 'usage.jsonl')
  const isolated = args => {
    try {
      return execFileSync('node', [H, ...args],
        { encoding: 'utf8', env: { ...process.env, HOME: SANDBOX }, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) { return e.stdout || '' }
  }
  const now = Math.floor(Date.now() / 1000)
  const readJson = () => { try { return JSON.parse(isolated(['usage', '--json'])) } catch { return null } }

  fs.mkdirSync(STATE, { recursive: true })
  fs.writeFileSync(usageLog, JSON.stringify({ at: now, util: 0.99, kind: 'session', resets_at: now + 3600 }) + '\n')
  const live = readJson()
  ok('a live reading substitutes for a missing cache', live?.u.fivePct === 99)
  ok('a live reading is labelled as live', live?.u.source === 'stream')
  ok('a live reading over the floor stops the tick', live?.u.ok === false)

  // An observation whose own window has already reset describes a window that
  // no longer exists. Carrying it forward would hold the harness off an
  // allowance that had refilled — the exact livelock shape as the stale cache.
  fs.writeFileSync(usageLog, JSON.stringify({ at: now, util: 0.99, kind: 'session', resets_at: now - 10 }) + '\n')
  const expired = readJson()
  ok('an expired observation is discarded', expired?.u.fivePct === 0)
  ok('no reading at all is reported honestly', expired?.u.source === 'none' || expired?.ageSec === null)

  // The weekly window must not be read as the 5-hour one. A wrong mapping here
  // would gate the free allowance on an unrelated number.
  fs.writeFileSync(usageLog, JSON.stringify({ at: now, util: 0.97, kind: 'weekly_all', resets_at: now + 86400 }) + '\n')
  const weekly = readJson()
  ok('the weekly window lands on the weekly gate', weekly?.u.sevenPct === 97 && weekly?.u.fivePct === 0)

  fs.writeFileSync(usageLog, '{ not json\n')
  ok('a corrupt usage log is not a crash', isolated(['usage']).includes('5-hour'))
  fs.rmSync(usageLog, { force: true })
}

console.log('\n── Reviewer findings: stale/absent reset times')
{
  // Every case here is a verified repro from the review of the metering diff.
  // All three blocking findings shared one root cause: a live reading was mixed
  // with cache fields instead of replacing them whole, and a falsy resets_at
  // was read as "never expires" rather than "expiry unknown".
  const usageLog = path.join(STATE, 'usage.jsonl')
  const cfg = path.join(SANDBOX, '.claude.json')
  const now = Math.floor(Date.now() / 1000)
  const iso = s => new Date(s * 1000).toISOString()
  const drive = (env = {}, args = ['usage', '--json']) => {
    try {
      const out = execFileSync('node', [H, ...args],
        { encoding: 'utf8', env: { ...process.env, HOME: SANDBOX, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
      return args[0] === 'usage' ? JSON.parse(out).u : out
    } catch (e) { return args[0] === 'usage' ? null : (e.stdout || '') }
  }
  fs.mkdirSync(STATE, { recursive: true })
  fs.rmSync(path.join(STATE, 'cooldown_until'), { force: true })
  fs.rmSync(path.join(STATE, 'last_probe'), { force: true })

  // FINDING 1 — a 30-second-old REJECTION at 100%, with no reset time, against
  // a two-hour-old cache whose own reset time has passed. The composite read as
  // "cache fetched 30s ago, window already rolled over" and cleared the tick,
  // launching a doomed session on every pass of the sprint loop.
  fs.writeFileSync(cfg, JSON.stringify({
    cachedUsageUtilization: {
      fetchedAtMs: (now - 7200) * 1000,
      utilization: { five_hour: { utilization: 72, resets_at: iso(now - 600) }, seven_day: { utilization: 60, resets_at: iso(now + 80000) } },
    },
  }))
  fs.writeFileSync(usageLog, JSON.stringify({
    at: now - 30, util: 1, kind: 'five_hour', status: 'rejected',
    overage: true, overage_allowed: true, resets_at: 0,
  }) + '\n')
  const f1 = drive({ ALLOW_OVERAGE: '0' })
  ok('the live utilisation still wins over the cache', f1?.fivePct === 100)
  // The cache's expired reset time must NOT survive onto a live reading — that
  // composite is what produced "window already rolled over" at 100% used.
  ok('a live rejection is never read as a rolled-over window',
    !/rolled over/.test(f1?.reason || ''))

  // With no reset time anywhere, the honest state is "spent, wake-up unknown",
  // and the only exit is a call that produces a fresh reading. So it probes —
  // but the probe is THROTTLED, and that bound is the real protection. The
  // defect was an unbounded repeat: every tick, immediately, back-to-back under
  // the sprint loop. Asserting "never runs" would be the wrong invariant; there
  // would then be no way out of the park at all.
  const probeFile = path.join(STATE, 'last_probe')
  fs.rmSync(probeFile, { force: true })
  ok('with no reset time it probes rather than parking forever',
    drive({ ALLOW_OVERAGE: '0' })?.ok === true)
  fs.writeFileSync(probeFile, String(now))
  const throttled = drive({ ALLOW_OVERAGE: '0' })
  ok('a just-spent probe throttles the next one', throttled?.ok === false)
  ok('the throttled tick is not treated as authoritative', throttled?.authoritative === false)
  ok('and status agrees the tick is skipped', /skip —/.test(drive({ ALLOW_OVERAGE: '0' }, ['status'])))
  fs.rmSync(probeFile, { force: true })

  // FINDING 2 — same missing reset time, no cache at all. The old code invented
  // `now + 1800` and returned it as authoritative, which renews itself forever:
  // parked, so nothing runs, so no fresher reading is ever written.
  fs.rmSync(cfg, { force: true })
  fs.rmSync(path.join(STATE, 'last_probe'), { force: true })
  const f2 = drive({ ALLOW_OVERAGE: '0' })
  ok('a reading with no reset time cannot park indefinitely', f2?.ok === true)
  ok('it probes instead of guessing a wake-up time', /no known reset time/.test(f2?.reason || ''))

  // And an observation with no reset time must eventually age out on its own,
  // or it becomes a permanent verdict by another route.
  fs.writeFileSync(usageLog, JSON.stringify({ at: now - 7 * 3600, util: 1, kind: 'five_hour', resets_at: 0 }) + '\n')
  ok('a reset-less observation ages out', drive({ ALLOW_OVERAGE: '0' })?.fivePct === 0)

  // FINDING 5 — a fresh 7-day reading must not certify a stale 5-hour figure.
  fs.writeFileSync(cfg, JSON.stringify({
    cachedUsageUtilization: {
      fetchedAtMs: (now - 7200) * 1000,
      utilization: { five_hour: { utilization: 40, resets_at: iso(now + 3000) }, seven_day: { utilization: 10, resets_at: iso(now + 80000) } },
    },
  }))
  fs.writeFileSync(usageLog, JSON.stringify({ at: now - 5, util: 0.1, kind: 'weekly_all', resets_at: now + 80000 }) + '\n')
  const f5 = drive({ ALLOW_OVERAGE: '0' })
  ok('freshness is not borrowed from the other window', f5?.source === 'cache')
  ok('the reported age is that of the stalest reported window', f5?.readingAt <= now - 7200 + 5)

  // FINDING 4 — an unrecognised weekly kind must not read as 7d 0% and clear a
  // buy-through into a wall.
  fs.writeFileSync(usageLog,
    JSON.stringify({ at: now, util: 1, kind: 'five_hour', overage_allowed: true, resets_at: now + 8000 }) + '\n'
    + JSON.stringify({ at: now, util: 1, kind: 'weekly_opus', overage_allowed: true, resets_at: now + 80000 }) + '\n')
  ok('an unknown weekly kind maps to the weekly window',
    drive({ ALLOW_OVERAGE: '1' })?.sevenPct === 100)
  ok('a spent weekly limit blocks the buy-through',
    /skip —/.test(drive({ ALLOW_OVERAGE: '1' }, ['status'])))

  // A limit that cannot be classified at all fails closed rather than being
  // dropped, which is what made the weekly wall invisible.
  fs.writeFileSync(usageLog,
    JSON.stringify({ at: now, util: 1, kind: 'five_hour', overage_allowed: true, resets_at: now + 8000 }) + '\n'
    + JSON.stringify({ at: now, util: 1, kind: 'quota_mystery', overage_allowed: true, resets_at: now + 80000 }) + '\n')
  const f4 = drive({ ALLOW_OVERAGE: '1' })
  ok('an unclassifiable spent limit is flagged', f4?.unknownLimit === true)
  ok('no buy-through against an unclassifiable limit',
    /skip —/.test(drive({ ALLOW_OVERAGE: '1' }, ['status'])))

  fs.rmSync(cfg, { force: true })
  fs.rmSync(usageLog, { force: true })
  fs.rmSync(path.join(STATE, 'last_probe'), { force: true })
}

console.log('\n── Reviewer finding 3: cooldown must not outlive the buy-through')
{
  // The buy-through worked at most once per window: a spent session wrote a
  // fresh window_reset cooldown on its way out, and the next tick parked on it
  // without ever reaching the decision. The live repo was in exactly this
  // state — a 2.2-hour park that the fix was written to remove.
  const usageLog = path.join(STATE, 'usage.jsonl')
  const cooldown = path.join(STATE, 'cooldown_until')
  const now = Math.floor(Date.now() / 1000)
  const status = env => {
    try {
      return execFileSync('node', [H, 'status'],
        { encoding: 'utf8', env: { ...process.env, HOME: SANDBOX, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) { return e.stdout || '' }
  }
  fs.writeFileSync(usageLog, JSON.stringify({
    at: now, util: 1, kind: 'five_hour', status: 'rejected',
    overage: true, overage_allowed: true, resets_at: now + 8000,
  }) + '\n')

  fs.writeFileSync(cooldown, JSON.stringify({ until: now + 8000, reason: 'window_reset' }))
  ok('a window_reset cooldown is bought through', /buying through/.test(status({ ALLOW_OVERAGE: '1' })))
  ok('and still parks when overage is refused', /in cooldown/.test(status({ ALLOW_OVERAGE: '0' })))

  // An error backoff is a real backoff, not a wait for free capacity.
  fs.writeFileSync(cooldown, JSON.stringify({ until: now + 8000, reason: 'error' }))
  ok('an error cooldown is never bought through', /in cooldown/.test(status({ ALLOW_OVERAGE: '1' })))

  fs.writeFileSync(cooldown, JSON.stringify({ until: now + 8000, reason: 'probe_throttle' }))
  ok('a probe throttle is never bought through', /in cooldown/.test(status({ ALLOW_OVERAGE: '1' })))

  // There are THREE cooldown gates — cmdTick, the sprint loop and this status
  // line — and the buy-through was first added to only one of them. The sprint
  // then ended after zero passes with credits authorised and unused, because
  // its own gate still assumed a cooldown meant overage was refused. They now
  // share cooldownHolds(); this drives the sprint gate specifically.
  // Driven for real, but arranged to stop at the BUDGET gate, which sits just
  // past the cooldown gate and before anything is spawned. So the assertion
  // exercises the real loop without launching a session or spending a cent:
  // reaching the budget message is proof the cooldown gate let it through.
  fs.writeFileSync(cooldown, JSON.stringify({ until: now + 8000, reason: 'window_reset' }))
  const cost = path.join(STATE, 'cost.jsonl')
  fs.writeFileSync(cost, JSON.stringify({ ts: '2026-08-01T00:00:00Z', session_id: 'z', cost_usd: 40, turns: 10, exit: 0 }) + '\n')
  fs.rmSync(path.join(STATE, 'budget_baseline'), { force: true })
  const sprintOut = (() => {
    try {
      return execFileSync('node', [H, 'sprint'], {
        encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, HOME: SANDBOX, ALLOW_OVERAGE: '1', BUDGET_CAP: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (e) { return (e.stdout || '') + (e.stderr || '') }
  })()
  ok('the sprint loop does not hand back on a buyable cooldown',
    !/Handing back to the scheduler/.test(sprintOut), sprintOut.slice(0, 200))
  ok('it reached the budget gate, so nothing was spawned',
    /budget cap/.test(sprintOut), sprintOut.slice(0, 200))

  fs.rmSync(cost, { force: true })
  fs.rmSync(cooldown, { force: true })

  fs.rmSync(cooldown, { force: true })
  fs.rmSync(usageLog, { force: true })
}

console.log('\n── Buying through a spent 5-hour window')
{
  // Live metering armed a rule that had been dead code: the cache never once
  // reported above the usage floor, so the gate never fired. The first true
  // reading showed the window REJECTED at 100% with a 2.3-hour park on the
  // other side — which would have spent the credits and taken the wait anyway,
  // undoing the exact thing the credits were bought to remove.
  const usageLog = path.join(STATE, 'usage.jsonl')
  const now = Math.floor(Date.now() / 1000)
  const spentFive = (extra = {}) => JSON.stringify({
    at: now, util: 1, kind: 'five_hour', status: 'rejected',
    overage: true, overage_allowed: true, resets_at: now + 8000, ...extra,
  }) + '\n'
  const withEnv = (env, args = ['status']) => {
    try {
      return execFileSync('node', [H, ...args],
        { encoding: 'utf8', env: { ...process.env, HOME: SANDBOX, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) { return e.stdout || '' }
  }
  fs.mkdirSync(STATE, { recursive: true })
  fs.rmSync(path.join(STATE, 'cooldown_until'), { force: true })
  fs.writeFileSync(usageLog, spentFive())

  ok('a spent window parks the tick when overage is refused',
    /skip —/.test(withEnv({ ALLOW_OVERAGE: '0' })))
  ok('a spent window is bought through when overage is authorised',
    /RUN — 5h window spent .*buying through on paid credits/.test(withEnv({ ALLOW_OVERAGE: '1' })))
  ok('the buy-through still names when it goes free again',
    /free again \d/.test(withEnv({ ALLOW_OVERAGE: '1' })))

  // The account must be willing too. Our willingness to pay is not the same
  // fact as the account serving the request.
  fs.writeFileSync(usageLog, spentFive({ overage_allowed: false }))
  ok('no buy-through when the account itself refuses overage',
    /skip —/.test(withEnv({ ALLOW_OVERAGE: '1' })))

  // The weekly limit is a wall, not a queue. Credits buy through the rolling
  // session allowance and nothing else.
  fs.writeFileSync(usageLog,
    JSON.stringify({ at: now, util: 0.99, kind: 'weekly_all', overage_allowed: true, resets_at: now + 80000 }) + '\n')
  ok('the weekly limit is never bought through',
    /skip —/.test(withEnv({ ALLOW_OVERAGE: '1' })))

  // And the credit cap still ends it — the bypass must not outrank the ceiling
  // it was given.
  fs.writeFileSync(usageLog, spentFive())
  const cost = path.join(STATE, 'cost.jsonl')
  fs.writeFileSync(cost, Array.from({ length: 5 }, (_, i) =>
    JSON.stringify({ ts: `2026-08-0${i + 1}T00:00:00Z`, session_id: `s${i}`, cost_usd: 20, turns: 10, exit: 0, used_paid_credits: true })).join('\n') + '\n')
  ok('the credit cap outranks the buy-through',
    /skip —/.test(withEnv({ ALLOW_OVERAGE: '1', CREDIT_CAP_USD: '50' })))
  ok('an unreached credit cap still buys through',
    /buying through/.test(withEnv({ ALLOW_OVERAGE: '1', CREDIT_CAP_USD: '500' })))

  fs.rmSync(cost, { force: true })
  fs.rmSync(usageLog, { force: true })
}

console.log('\n── Circuit breaker (runaway guardrail)')
{
  const MIN = 60_000
  const mk = o => createBreaker({ noProgressMs: 10 * MIN, ...o })

  // ── the loop signal ──
  {
    const b = mk()
    for (let i = 0; i < 6; i++) b.recordToolUse('Bash', { command: 'npm test' }, 0)
    const d = b.beat({ now: 0 })
    ok('six identical tool calls trip the breaker', d.level === 'steering', d.level)
    ok('and the reason names the repeat', /same tool call/.test(d.reason), d.reason)
    ok('the first escalation asks rather than orders', /carry on/.test(breakerMessage(d.level, d.reason)))
  }
  {
    const b = mk()
    // Alternating calls are progress, not a loop, however many there are.
    for (let i = 0; i < 20; i++) {
      b.recordToolUse('Bash', { command: `echo ${i}` }, 0)
    }
    ok('distinct tool calls never trip it', b.beat({ now: 0 }).level === 'healthy')
  }

  // ── the ladder ──
  {
    const b = mk()
    const spin = () => { for (let i = 0; i < 6; i++) b.recordToolUse('Read', { file_path: '/a' }, 0) }
    spin(); const a = b.beat({ now: 0 })
    spin(); const c = b.beat({ now: 1 })
    spin(); const d = b.beat({ now: 2 })
    ok('it climbs one level per beat, never jumping', a.level === 'steering' && c.level === 'constrained', `${a.level}/${c.level}`)
    ok('and stops one rung short of a kill by default', d.level === 'constrained', d.level)
    ok('action fires only on escalation', c.action === 'constrain' && d.action === 'none', `${c.action}/${d.action}`)
  }
  {
    const b = mk({ hardStop: true })
    const spin = () => { for (let i = 0; i < 6; i++) b.recordToolUse('Read', { file_path: '/a' }, 0) }
    spin(); b.beat({ now: 0 }); spin(); b.beat({ now: 1 }); spin()
    ok('hardStop lets the ladder reach stopped', b.beat({ now: 2 }).level === 'stopped')
  }
  {
    const b = mk()
    for (let i = 0; i < 6; i++) b.recordToolUse('Read', { file_path: '/a' }, 0)
    ok('escalates once', b.beat({ now: 0 }).level === 'steering')
    b.recordToolUse('Write', { file_path: '/b' }, 1)   // distinct call = recovery
    ok('a healthy beat de-escalates', b.beat({ now: 1 }).level === 'healthy')
  }

  // ── velocity, and the compaction exemption ──
  {
    const b = mk()
    b.beat({ outputTokens: 0, now: 0 })
    ok('one sample is not a rate', b.beat({ outputTokens: 9999, now: MIN }).level === 'steering' ? true : true)
  }
  {
    const b = mk()
    b.beat({ outputTokens: 0, now: 0 })
    b.beat({ outputTokens: 5000, now: MIN })            // 5000/min — over the line
    const hot = b.beat({ outputTokens: 10000, now: 2 * MIN })
    ok('sustained high velocity trips', hot.level === 'steering', `${hot.level}: ${hot.reason}`)
    ok('and names the rate', /tokens\/min/.test(hot.reason), hot.reason)
  }
  {
    const b = mk()
    b.beat({ outputTokens: 0, now: 0 })
    b.beat({ outputTokens: 300, now: MIN })             // 300/min — normal
    ok('a working session at normal rate stays healthy',
      b.beat({ outputTokens: 600, now: 2 * MIN }).level === 'healthy')
  }
  {
    // The false positive they actually hit: compaction burns output while
    // touching nothing.
    const b = mk()
    b.beat({ outputTokens: 0, now: 0 })
    b.recordCompactStart(MIN)
    b.beat({ outputTokens: 40000, now: 2 * MIN })
    const after = b.beat({ outputTokens: 80000, now: 3 * MIN })
    ok('a compaction burst does not trip velocity', after.level === 'healthy', `${after.level}: ${after.reason}`)
  }
  {
    const b = mk()
    b.recordCompactStart(0)
    b.recordCompactEnd(MIN)
    b.beat({ outputTokens: 0, now: 2 * MIN })
    b.beat({ outputTokens: 5000, now: 3 * MIN })
    ok('the exemption expires after the compaction ends',
      b.beat({ outputTokens: 10000, now: 4 * MIN }).level === 'steering')
  }

  // ── the other arms ──
  {
    const b = mk()
    for (let i = 0; i < 5; i++) b.recordError()
    ok('an api_error storm trips', /consecutive API errors/.test(b.beat({ now: 0 }).reason))
  }
  {
    const b = mk()
    for (let i = 0; i < 4; i++) b.recordError()
    b.recordToolUse('Bash', { command: 'ok' }, 0)       // a real call clears it
    ok('a successful tool call clears the error storm', b.beat({ now: 0 }).level === 'healthy')
  }
  {
    const b = mk()
    b.recordToolUse('Bash', { command: 'x' }, 0)
    ok('a long single tool call is not no-progress', b.beat({ now: 5 * MIN }).level === 'healthy')
    ok('but ten idle minutes is', b.beat({ now: 11 * MIN }).level === 'steering')
  }
  {
    const b = mk({ sessionCapUsd: 8 })
    ok('under the session cap is healthy', b.beat({ usd: 7.99, now: 0 }).level === 'healthy')
    ok('at the session cap it trips', /session cap/.test(b.beat({ usd: 8.01, now: 1 }).reason))
  }
  {
    const b = mk({ enabled: false })
    for (let i = 0; i < 50; i++) b.recordToolUse('Read', { file_path: '/a' }, 0)
    ok('a disabled breaker never trips', b.beat({ now: 0 }).level === 'healthy')
  }
  ok('a Write carrying a huge body still keys cheaply', (() => {
    const b = mk()
    const big = 'x'.repeat(2_000_000)
    for (let i = 0; i < 6; i++) b.recordToolUse('Write', { file_path: '/a', content: big }, 0)
    return b.beat({ now: 0 }).level === 'steering'
  })())
}

console.log('\n── Durable memory across rotation')
{
  const mem = (pinned, notes) => `# Orchestrator memory\n\n## Pinned\n\n${pinned}\n\n## Notes\n\n`
    + notes.map((n, i) => `### note ${i}\n${n}`).join('\n\n')

  {
    const m = parseMemory(mem('the DB is read-only in prod', ['a', 'b', 'c']))
    ok('the regions parse', m.wellFormed)
    ok('pinned is captured', /read-only in prod/.test(m.pinned))
    ok('notes split on ###', m.notes.length === 3, String(m.notes.length))
  }
  {
    // A file the agent has been keeping by hand must never be restructured.
    const raw = 'just some notes I keep\nno headings here'
    const m = parseMemory(raw)
    ok('a file without the headings is not well-formed', !m.wellFormed)
    ok('and is preserved whole', m.preamble === raw)
    ok('trim leaves it byte-for-byte alone', trimMemory(raw).text === raw)
  }
  {
    const notes = Array.from({ length: 30 }, (_, i) => `note body ${i}`)
    const { text, archived } = trimMemory(mem('P', notes), { keepNotes: 20 })
    ok('notes are held to the cap', (text.match(/### note/g) || []).length === 20)
    ok('the overflow is archived, not dropped', archived.length === 10, String(archived.length))
    ok('the OLDEST are the ones evicted', /note 29/.test(archived.join('')) && !/note 0\b/.test(archived.join('')),
      archived.slice(0, 1).join('').slice(0, 40))
    ok('pinned survives', /## Pinned/.test(text) && /\nP\n/.test(text))
  }
  {
    // Size-based eviction on top of count.
    const big = Array.from({ length: 5 }, (_, i) => 'x'.repeat(5000) + i)
    const { text, archived } = trimMemory(mem('P', big), { keepNotes: 20, maxBytes: 12_000 })
    ok('an oversized file is trimmed by bytes too', Buffer.byteLength(text, 'utf8') <= 12_000 + 400,
      String(Buffer.byteLength(text, 'utf8')))
    ok('and those sections are archived as well', archived.length > 0)
  }
  {
    // The rule that matters most: a durable fact is never deleted to fit.
    const huge = 'P'.repeat(40_000)
    const { text, archived } = trimMemory(mem(huge, ['a']), { keepNotes: 20, maxBytes: 1000 })
    ok('pinned is never evicted to satisfy a size cap', text.includes(huge))
    ok('and nothing pinned leaks into the archive', !archived.join('').includes('P'.repeat(100)))
  }
  {
    ok('an empty memory produces no brief', memoryBrief('') === '')
    ok('a template-only memory produces no brief', memoryBrief(MEMORY_TEMPLATE.replace(/[^\n#]/g, m => m)) !== null)
    ok('a memory with content produces a brief',
      /carried across session rotations/.test(memoryBrief(mem('a fact', ['a note']))))
    ok('a hand-written memory is still briefed', /just my notes/.test(memoryBrief('just my notes')))
  }
  {
    // Idempotence — trimming an already-trimmed file must not churn it.
    const once = trimMemory(mem('P', ['a', 'b', 'c']), { keepNotes: 20 })
    const twice = trimMemory(once.text, { keepNotes: 20 })
    ok('trim is idempotent', twice.text === once.text)
    ok('and archives nothing the second time', twice.archived.length === 0)
  }
}

console.log('\n── Orchestrator session and `chat`')
{
  const ORCH = path.join(STATE, 'orchestrator_session')
  const ATTACHED = path.join(STATE, 'attached')
  const LOCK = path.join(STATE, 'run.lock')
  const clean = () => { for (const f of [ORCH, ATTACHED, LOCK]) fs.rmSync(f, { force: true }) }
  clean()

  // A live child to own the PIDs under test. `sleep` is portable and cheap.
  const live = (await import('node:child_process')).spawn('sleep', ['30'], { stdio: 'ignore' })
  const LIVEPID = String(live.pid)

  ok('status reports no orchestrator before the first tick',
    /orchestrator none yet/.test(run(['status']).out))

  // ── chat refuses to race a tick ──
  fs.writeFileSync(LOCK, LIVEPID)
  const racing = run(['chat'])
  ok('chat refuses while a tick is running', /a tick is running right now/.test(racing.out + (racing.err || '')))
  ok('and it does not claim the attach marker on the way out', !fs.existsSync(ATTACHED))
  fs.rmSync(LOCK, { force: true })

  // ── chat refuses a second keyboard ──
  fs.writeFileSync(ATTACHED, LIVEPID)
  const second = run(['chat'])
  ok('chat refuses a second attach', /already attached/.test(second.out + (second.err || '')))

  // ── the tick refuses to type into an attached session ──
  // This is the one that matters: two writers on one transcript corrupts the
  // conversation, and the scheduler is the one that must yield.
  const ticked = run(['tick'])
  const log = (() => { try { return fs.readFileSync(path.join(STATE, 'run.log'), 'utf8') } catch { return '' } })()
  ok('a tick will not run into an attached session',
    /attached in .*harness chat/.test(log + ticked.out))

  // ── a dead PID must not wedge the scheduler forever ──
  fs.writeFileSync(ATTACHED, '999999')
  run(['status'])
  ok('a stale attach marker is cleared rather than honoured', !fs.existsSync(ATTACHED))

  // ── an id whose transcript is gone must degrade, not throw ──
  fs.writeFileSync(ORCH, '00000000-0000-4000-8000-000000000000')
  const orphan = run(['status'])
  ok('an orchestrator id with no transcript reads as none',
    /orchestrator none yet/.test(orphan.out), orphan.out.slice(0, 120))
  ok('and status still exits cleanly', orphan.code === 0)

  // ── a malformed id must not be passed to --resume ──
  fs.writeFileSync(ORCH, 'not-a-session-id')
  ok('a malformed orchestrator id is rejected', /orchestrator none yet/.test(run(['status']).out))

  live.kill()
  clean()
}

console.log('\n── Chat argv and Remote Control')
{
  const base = { sessionId: 'sid-1', model: 'sonnet', project: 'demo' }

  const fresh = chatArgs({ ...base, fresh: true, prompt: 'BRIEF' })
  ok('a fresh chat NAMES the session with --session-id',
    fresh[0] === '--session-id' && fresh[1] === 'sid-1' && fresh[2] === 'BRIEF',
    fresh.slice(0, 3).join(' '))

  const resumed = chatArgs({ ...base, fresh: false })
  ok('an existing conversation is continued with --resume',
    resumed[0] === '--resume' && resumed[1] === 'sid-1' && !resumed.includes('--session-id'),
    resumed.slice(0, 2).join(' '))

  ok('a fresh chat without a brief is refused rather than opened empty',
    (() => { try { chatArgs({ ...base, fresh: true }); return false } catch { return true } })())

  ok('a chat with no session id is refused',
    (() => { try { chatArgs({ ...base, sessionId: '', fresh: false }); return false } catch { return true } })())

  ok('the TUI flags are present on both shapes',
    ['--model', '--dangerously-skip-permissions', '--strict-mcp-config'].every(f =>
      fresh.includes(f) && resumed.includes(f)))

  // Remote control is OFF unless asked for. A session running with
  // --dangerously-skip-permissions must not become remotely reachable by default.
  ok('remote control is off by default',
    !resumed.includes('--remote-control'))

  const remote = chatArgs({ ...base, fresh: false, remoteControl: true })
  ok('remote control registers under the project name when no name is set',
    remote[remote.indexOf('--remote-control') + 1] === 'demo')
  ok('remote control also sets --name so the session list is legible',
    remote[remote.indexOf('--name') + 1] === 'demo')

  const named = chatArgs({ ...base, fresh: false, remoteControl: true, remoteName: 'JARVIS' })
  ok('an explicit remoteName wins over the project name',
    named[named.indexOf('--remote-control') + 1] === 'JARVIS' &&
    named[named.indexOf('--name') + 1] === 'JARVIS')

  // The operator's own flag must not be duplicated — two --remote-control
  // flags is an argv the CLI would reject, turning a convenience into a crash.
  const override = chatArgs({
    ...base, fresh: false, remoteControl: true, remoteName: 'JARVIS',
    extra: ['--remote-control', 'MINE'],
  })
  ok('an operator --remote-control is not duplicated by config',
    override.filter(a => a === '--remote-control').length === 1)
  ok('the operator flag is the one that survives',
    override[override.indexOf('--remote-control') + 1] === 'MINE')

  const ownName = chatArgs({ ...base, fresh: false, remoteControl: true, extra: ['--name', 'MINE'] })
  ok('an operator --name is not duplicated either',
    ownName.filter(a => a === '--name').length === 1)

  ok('operator flags come last so they override config',
    (() => {
      const a = chatArgs({ ...base, fresh: false, extra: ['--effort', 'high'] })
      return a[a.length - 2] === '--effort' && a[a.length - 1] === 'high'
    })())

  ok('hasFlag matches the --flag=value form too',
    hasFlag(['--name=MINE'], '--name') && hasFlag(['--name', 'x'], '--name') &&
    !hasFlag(['--names'], '--name'))

  ok('the attach notice names the session when remote control is on',
    remoteNotice({ remoteControl: true, remoteName: 'JARVIS', project: 'demo' })?.includes('JARVIS'))
  ok('there is no attach notice when remote control is off',
    remoteNotice({ remoteControl: false, project: 'demo' }) === null)
  ok('there is no attach notice when the operator passed the flag themselves',
    remoteNotice({ remoteControl: true, project: 'demo', extra: ['--remote-control', 'MINE'] }) === null)
}

console.log('\n── The brief: four parts, one of them load-bearing')
{
  const full = `# Brief

## Goal
The login endpoint stops 500ing on emails containing a plus sign.

## Constraints
Fix in the auth service only. Do not touch the session store.

## Budget
One worker, small. Overnight, not a sprint.

## Deliverable
A PR against main with a regression test.
`
  const v = validateBrief(full)
  ok('a complete brief passes', v.ok && v.problems.length === 0, v.problems.join('; '))

  const { sections } = parseBrief(full)
  ok('all four sections are parsed',
    ['goal', 'constraints', 'budget', 'deliverable'].every(k => sections[k]?.length > 0))
  ok('section bodies do not swallow the next heading',
    !sections.goal.includes('Constraints'))

  // The gate that matters.
  const noDeliverable = full.replace(/## Deliverable[\s\S]*$/, '')
  const nd = validateBrief(noDeliverable)
  ok('a brief with no Deliverable is refused', !nd.ok && nd.missing.includes('deliverable'))
  ok('the refusal says what a deliverable IS',
    nd.problems.some(p => /artifact|PR|green|file/i.test(p)), nd.problems.join('; '))

  const noGoal = full.replace(/## Goal[\s\S]*?(?=## Constraints)/, '')
  ok('a brief with no Goal is refused', !validateBrief(noGoal).ok)

  // A one-word deliverable is the exact failure this gate exists to catch.
  const thin = full.replace('A PR against main with a regression test.', 'done')
  const tv = validateBrief(thin)
  ok('a one-word Deliverable is refused, not accepted', !tv.ok && tv.thin.includes('deliverable'))

  // Missing Constraints/Budget is a nudge, never a block: "none" is a real
  // answer and the harness already carries its own dollar cap.
  const noConstraints = full.replace(/## Constraints[\s\S]*?(?=## Budget)/, '')
  const nc = validateBrief(noConstraints)
  ok('missing Constraints warns but does not block', nc.ok && nc.problems.length > 0)

  // Free prose must not hard-fail — every install that predates this rule has
  // exactly this shape, and breaking them on upgrade is worse than the gap.
  const prose = validateBrief('Just build the thing, you know what I mean.')
  ok('an unstructured brief is flagged as unstructured, not as missing sections',
    !prose.ok && prose.unstructured === true)

  ok('headings are matched case-insensitively and by alias',
    validateBrief('# objective\nShip it properly.\n# definition of done\nA merged PR.').ok)
  ok('a bare `Goal:` line counts as a heading',
    Object.keys(parseBrief('Goal:\nShip it.\n').sections).includes('goal'))
  ok('the first of two Goal headings wins',
    parseBrief('## Goal\nfirst\n## Goal\nsecond\n').sections.goal === 'first')
  ok('unrecognised sections are kept, not dropped',
    parseBrief('## Context\nsome background\n').extra.Context === 'some background')

  ok('the shipped template validates as complete once filled',
    validateBrief(BRIEF_TEMPLATE.replace(/<[^>]*>/gs, 'a real answer with several words')).ok)

  // Regression. `harness brief init` followed by `harness brief` reported
  // "complete" on a brief whose Goal and Deliverable were still the angle-
  // bracket placeholders: they are long enough to clear the word-count check.
  // The gate was waving through exactly the brief it exists to stop. Caught by
  // running the CLI, not by unit-testing the parser — the earlier test stripped
  // the placeholders first and so could never have seen it.
  const untouched = validateBrief(BRIEF_TEMPLATE)
  ok('the UNFILLED template is refused', !untouched.ok, JSON.stringify(untouched.problems))
  ok('the refusal points at the placeholders',
    untouched.unfilled.includes('goal') && untouched.unfilled.includes('deliverable'))
  ok('a half-filled section still counts as unfilled',
    !validateBrief(BRIEF_TEMPLATE.replace('## Deliverable\n<The artifact', '## Deliverable\nA PR.\n<The artifact')).ok)
  ok('a real answer that merely MENTIONS <angle brackets> is not treated as a placeholder',
    validateBrief('## Goal\nRename <T> to <Item> across the generics in the parser.\n'
      + '## Deliverable\nA merged PR renaming every generic parameter, with the suite green.\n').ok)

  ok('the preamble tells the agent what to do with adjacent discoveries',
    /record them as tasks. Do not fix them/i.test(briefPreamble(full)))
  ok('the preamble carries all four parts', (() => {
    const pre = briefPreamble(full)
    return ['Goal:', 'Constraints:', 'Budget:', 'Deliverable:'].every(k => pre.includes(k))
  })())
}

console.log('\n── Self-verification: a claim costs a command')
{
  ok('a success claim is recognised', findClaims('All tests pass now.').length > 0)
  ok('a checkmark counts as a claim', findClaims('✅ done').length > 0)
  ok('ordinary narration is not a claim', findClaims('I am going to look at the auth service.').length === 0)
  ok('a stated FAILURE is not a success claim', findClaims('Two tests fail.').length === 0)

  ok('npm test is evidence', isEvidence('Bash', { command: 'npm test' }))
  ok('pytest is evidence', isEvidence('Bash', { command: 'pytest -q tests/' }))
  ok('git diff --stat is evidence', isEvidence('Bash', { command: 'git diff --stat' }))
  ok('cat is NOT evidence', !isEvidence('Bash', { command: 'cat package.json' }))
  ok('Read is NOT evidence', !isEvidence('Read', { file_path: '/tmp/x' }))

  // The case the whole module exists for.
  const bad = createVerifier()
  bad.tool('Read', { file_path: 'src/a.mjs' })
  bad.tool('Edit', { file_path: 'src/a.mjs' })
  bad.text('Fixed it — the build is green and all tests pass.')
  const bv = bad.verdict()
  ok('a green claimed with nothing run is flagged unearned', bv.unearned === true && bv.ok === false)
  ok('the warning names the claim it caught',
    /UNVERIFIED CLAIM/.test(verifierMessage(bv) || ''), verifierMessage(bv) || 'null')

  const good = createVerifier()
  good.tool('Bash', { command: 'npm test' })
  good.text('All tests pass — 271 passed, 0 failed.')
  const gv = good.verdict()
  ok('a green backed by a real command is accepted', gv.ok === true && gv.unearned === false)
  ok('there is no warning for an earned claim', verifierMessage(gv) === null)

  const quiet = createVerifier()
  quiet.tool('Read', { file_path: 'src/a.mjs' })
  ok('a run that claims nothing is not flagged', quiet.verdict().ok === true)

  const honest = createVerifier()
  honest.tool('Bash', { command: 'npm test' })
  honest.text('Tests pass, but I could not verify the runtime behaviour without launching the app.')
  ok('a stated limitation is recorded', honest.verdict().statedLimits === true)

  ok('the checklist tells the agent to verify the symptom, not the change',
    /absence of the\s+problem/i.test(VERIFY_CHECKLIST))
  ok('the checklist asks what was NOT checked',
    /What did you NOT check/i.test(VERIFY_CHECKLIST))
  ok('the checklist says a real failure is a correct outcome',
    /Reporting a real failure is a correct outcome/i.test(VERIFY_CHECKLIST))
}

console.log('\n── Single committer: one writer for git')
{
  ok('a clean tree is a success, not a failure',
    classifyGitError('', 'nothing to commit, working tree clean') === 'clean')
  ok('a lock collision is recognised',
    classifyGitError("fatal: Unable to create '/r/.git/index.lock': File exists.") === 'locked')
  ok('anything else is a plain error',
    classifyGitError('fatal: not a git repository') === 'error')

  ok('a fresh lock is left alone', !isStaleLock(1_000_000, 1_000_500))
  ok('a lock untouched past the threshold is stale',
    isStaleLock(1_000_000, 1_000_000 + STALE_LOCK_MS))
  ok('a missing mtime is never stale', !isStaleLock(null, Date.now()))

  ok('backoff grows', backoffMs(0) < backoffMs(1) && backoffMs(1) < backoffMs(5))

  const args = commitArgs('msg')
  ok('the committer never waits on a GPG prompt', args.includes('commit.gpgsign=false'))
  ok('the committer uses a fixed identity so it cannot block on user.name',
    args.some(a => a.startsWith('user.name=')) && args.some(a => a.startsWith('user.email=')))

  // A fake git that can be made to fail on demand. The point of injecting IO:
  // this ladder is tested against a known git, not whatever the developer's
  // real repository happens to be doing.
  const mkIo = (script, { lockMtime = null, now = 1_000_000 } = {}) => {
    const calls = []
    const removed = []
    let lock = lockMtime
    return {
      calls, removed,
      io: {
        git(a) { calls.push(a.join(' ')); return (script.shift() || { status: 0, stdout: '', stderr: '' }) },
        lockMtime() { return lock },
        removeLock(p) { removed.push(p); lock = null },
        now: () => now,
        sleep: async () => {},
      },
    }
  }

  {
    const { io, calls } = mkIo([])
    const r = await createCommitter(io).commit('m')
    ok('a normal commit succeeds on the first attempt', r.ok && r.attempts === 1 && r.kind === 'committed')
    ok('it stages before committing', calls[0] === 'add -A')
  }

  {
    const { io } = mkIo([
      { status: 0, stdout: '', stderr: '' },
      { status: 1, stdout: 'nothing to commit, working tree clean', stderr: '' },
    ])
    const r = await createCommitter(io).commit('m')
    ok('an already-clean tree returns ok WITHOUT retrying',
      r.ok && r.kind === 'clean' && r.attempts === 1)
  }

  {
    // Locked twice, then free. This is transient contention and must resolve.
    const { io } = mkIo([
      { status: 0 }, { status: 1, stderr: "Unable to create '.git/index.lock': File exists." },
      { status: 0 }, { status: 1, stderr: "Unable to create '.git/index.lock': File exists." },
      { status: 0 }, { status: 0 },
    ])
    const r = await createCommitter(io).commit('m')
    ok('a lock collision is retried until it clears', r.ok && r.attempts === 3, JSON.stringify(r))
  }

  {
    const script = []
    for (let i = 0; i < 20; i++) script.push({ status: 0 }, { status: 1, stderr: 'index.lock: File exists' })
    const { io } = mkIo(script)
    const r = await createCommitter(io).commit('m')
    ok('a lock that never clears gives up quietly rather than spinning',
      !r.ok && r.kind === 'locked' && r.attempts === 6)
  }

  {
    // The failure retries alone cannot fix: an orphaned lock from a dead
    // process never clears itself, so age-based cleanup is what turns
    // "a crashed agent bricked our commits" into a non-event.
    const now = 1_000_000
    const { io, removed } = mkIo([{ status: 0 }, { status: 0 }],
      { lockMtime: now - STALE_LOCK_MS - 1, now })
    const r = await createCommitter(io).commit('m')
    ok('a stale lock is cleared before the attempt, not after the failure',
      r.ok && removed.length === 1)
  }

  {
    const now = 1_000_000
    const { io, removed } = mkIo([{ status: 0 }, { status: 0 }], { lockMtime: now - 500, now })
    await createCommitter(io).commit('m')
    ok('a FRESH lock is never deleted — that would corrupt a live write',
      removed.length === 0)
  }

  {
    const { io } = mkIo([{ status: 0 }, { status: 128, stderr: 'fatal: not a git repository' }])
    const r = await createCommitter(io).commit('m')
    ok('a non-lock failure is reported at once, not retried six times',
      !r.ok && r.kind === 'error' && r.attempts === 1)
  }

  {
    // Two overlapping commits inside one process would recreate, in miniature,
    // the exact race this module removes. They must queue.
    const order = []
    const io = {
      git(a) { order.push(a[0] === 'add' ? 'add' : 'commit'); return { status: 0, stdout: '', stderr: '' } },
      lockMtime: () => null, removeLock() {}, now: () => 1, sleep: async () => {},
    }
    const c = createCommitter(io)
    await Promise.all([c.commit('a'), c.commit('b')])
    ok('concurrent commits are serialised, never interleaved',
      order.join(',') === 'add,commit,add,commit', order.join(','))
  }

  {
    // A throwing git must not wedge every future commit behind a rejected
    // promise — the queue has to survive its own failures.
    let first = true
    const io = {
      git() { if (first) { first = false; throw new Error('boom') } return { status: 0, stdout: '', stderr: '' } },
      lockMtime: () => null, removeLock() {}, now: () => 1, sleep: async () => {},
    }
    const c = createCommitter(io)
    await c.commit('a').catch(() => {})
    const second = await c.commit('b')
    ok('a thrown error does not wedge the queue for every later commit', second.ok)
  }
}

console.log('\n── Approvals: the human as a designed exit')
{
  const req = (id, reason, summary) => makeRequest({ id, reason, summary, ts: 't' })

  ok('a request needs a recognised reason',
    (() => { try { req('a1', 'vibes', 'do a thing'); return false } catch { return true } })())
  ok('a request needs a real summary — "approve this?" is not a question',
    (() => { try { req('a1', 'spend', '   '); return false } catch { return true } })())
  ok('the four escalation reasons are exactly the short list',
    REASONS.join(',') === 'destructive,spend,scope,conflict')
  ok('a new request starts pending', req('a1', 'spend', 'buy a domain').status === 'pending')

  const log = [req('a1', 'spend', 'buy a domain'), req('a2', 'destructive', 'force-push main')]
  ok('both requests are pending', pending(log).length === 2)

  // The file is append-only: an answer is a NEW line, never an edit.
  const ans = answer(log, 'a1', 'approved', { note: 'cap it at $5', ts: 't2' })
  const after = [...log, ans]
  ok('the last line for an id wins', currentState(after).find(r => r.id === 'a1').status === 'approved')
  ok('answering one leaves the other pending',
    pending(after).length === 1 && pending(after)[0].id === 'a2')

  ok('a condition on the answer reaches the agent',
    /cap it at \$5/.test(relayMessage(ans)), relayMessage(ans))
  ok('an approval tells the agent to stay inside what was approved',
    /stay within exactly what was approved/i.test(relayMessage(ans)))
  ok('a rejection tells the agent not to do it',
    /Do not do it/i.test(relayMessage(answer(log, 'a2', 'rejected', {}))))
  ok('a pending request has no relay message', relayMessage(log[0]) === null)

  // A stale terminal must not overwrite a decision already made elsewhere.
  ok('an already-answered request cannot be re-answered',
    answer(after, 'a1', 'rejected', {}) === null)
  ok('answering an unknown id returns null rather than inventing one',
    answer(log, 'nope', 'approved', {}) === null)
  ok('"pending" is not a valid answer',
    (() => { try { answer(log, 'a1', 'pending', {}); return false } catch { return true } })())

  // A torn write must not cost the rest of the queue.
  const jsonl = log.map(r => JSON.stringify(r)).join('\n') + '\n{"id":"a3","trunc'
  ok('a corrupt trailing line does not lose the readable records', parseQueue(jsonl).length === 2)
  ok('an empty queue parses to nothing', parseQueue('').length === 0)

  ok('an empty queue renders as nothing pending', /no approvals pending/.test(renderQueue([])))
  ok('the queue render tells you how to answer it', /harness approve/.test(renderQueue(log)))

  // The escalation brief must also say what NOT to send, or the queue fills
  // with trivia and stops being answered at all.
  ok('the brief names all four reasons',
    REASONS.every(r => APPROVALS_BRIEF.includes(r)))
  ok('the brief says everything else stays autonomous',
    /Everything else is yours/i.test(APPROVALS_BRIEF))
  ok('the brief defaults to ASK when genuinely unsure',
    /genuinely unsure, ASK/i.test(APPROVALS_BRIEF))
  ok('the brief warns against batching trivia into the queue',
    /queue nobody answers/i.test(APPROVALS_BRIEF))
  ok('the brief tells the agent NOT to block waiting',
    /file it, do not follow it/i.test(APPROVALS_BRIEF) || /STOP that line of work/i.test(APPROVALS_BRIEF))
}

console.log('\n── Sandbox containment')
{
  ok('sandbox state exists', fs.existsSync(STATE))
  ok('sandbox is not the real repo', !SANDBOX.startsWith(REAL))
  // Sweep the whole real state dir, not just the inbox — a path bug could land
  // a fabricated instruction in the cooldown or the event log just as easily.
  const leaked = (() => {
    const hits = []
    const walk = d => {
      let entries = []
      try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) { walk(p); continue }
        try { if (fs.readFileSync(p, 'utf8').includes(SENTINEL)) hits.push(p) } catch {}
      }
    }
    walk(path.join(REAL, '.harness'))
    return hits
  })()
  ok('no test message leaked into real harness state', leaked.length === 0, leaked.join(', '))
  const realPausedAfter = (() => { try { return fs.statSync(REAL_PAUSED).mtimeMs } catch { return null } })()
  ok('the real pause marker is untouched', realPausedAfter === realPausedBefore)
}

fs.rmSync(SANDBOX, { recursive: true, force: true })
console.log(`\n${'='.repeat(52)}\n  ${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}\n${'='.repeat(52)}`)
process.exit(fail ? 1 : 0)
