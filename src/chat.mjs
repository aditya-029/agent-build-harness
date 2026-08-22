// How `harness chat` builds the command line for the orchestrator session.
//
// This lives in its own module for one reason: harness.mjs is a CLI that
// dispatches on argv at import time and therefore cannot be unit tested
// in-process. Anything that makes a DECISION belongs out here where a test can
// import it. The rule in this repo is that a test never re-implements the rule
// it is checking — that is exactly how the original rate-limit misclassification
// survived — so the CLI calls this and the test calls this.

/**
 * Build the argv for the interactive orchestrator session.
 *
 * `fresh` decides the shape of the first two arguments and nothing else:
 * `--session-id` NAMES a new session, `--resume` continues an existing one.
 * Everything after that is identical either way, because the whole point of
 * the persistent-session design is that the conversation is a stable address.
 *
 * @param {object} o
 * @param {string}  o.sessionId
 * @param {boolean} o.fresh          - true when opening a brand new conversation
 * @param {string}  [o.prompt]       - the brief; required when fresh
 * @param {string}  o.model
 * @param {boolean} [o.remoteControl] - register with Claude Code Remote Control
 * @param {string}  [o.remoteName]   - name to register under
 * @param {string}  [o.project]      - fallback name
 * @param {string[]} [o.extra]       - operator's own flags, passed through last
 * @returns {string[]}
 */
export function chatArgs({
  sessionId, fresh, prompt, model,
  remoteControl = false, remoteName = null, project = 'harness',
  extra = [],
}) {
  if (!sessionId) throw new Error('chatArgs: sessionId is required')
  if (fresh && typeof prompt !== 'string') {
    throw new Error('chatArgs: a fresh session needs the brief as `prompt`')
  }

  const args = fresh
    ? ['--session-id', sessionId, prompt]
    : ['--resume', sessionId]

  // Same flags the headless tick uses, minus the headless ones: this is a real
  // TUI and the child owns the terminal.
  args.push('--model', model, '--dangerously-skip-permissions', '--strict-mcp-config')

  // Remote Control makes THIS session — the one the scheduler drives —
  // reachable from the Claude app. No bespoke UI, no auth layer, nothing
  // listening on a non-loopback port; it is a flag on a process that already
  // exists. Off unless asked for, because registering a session running with
  // --dangerously-skip-permissions for remote reach is a deliberate choice.
  if (remoteControl && !hasFlag(extra, '--remote-control')) {
    const name = remoteName || project
    args.push('--remote-control', name)
    // `--name` too, so the session list says which project this is rather than
    // a bare hostname. Skipped if the operator set their own.
    if (!hasFlag(extra, '--name') && !hasFlag(extra, '-n')) args.push('--name', name)
  }

  // Operator flags go last so they win: a flag typed on the command line is
  // someone overriding config for one session, which is precisely the case
  // where config should get out of the way.
  return args.concat(extra)
}

/** True when `flag` appears in argv, either bare or as `--flag=value`. */
export function hasFlag(argv, flag) {
  return argv.some(a => a === flag || a.startsWith(`${flag}=`))
}

/**
 * The one line printed when a chat attaches, so the operator can see at a
 * glance whether this session is reachable from the phone. Returns null when
 * there is nothing worth saying.
 */
export function remoteNotice({ remoteControl, remoteName, project, extra = [] }) {
  if (!remoteControl || hasFlag(extra, '--remote-control')) return null
  return `remote control ON as "${remoteName || project}" — reachable from the Claude app.`
}
