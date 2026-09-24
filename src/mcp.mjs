// The control tower (D5, D7): the harness as a tool inside any chat.
//
// A minimal MCP server over stdio — newline-delimited JSON-RPC 2.0, which is
// what both Claude Code and Codex speak to local servers. Zero dependencies, so
// the repository contract holds.
//
// Every tool is a thin call onto an existing harness CLI command (the caller
// injects `run`). The tower adds reach, not new powers: anything it can do,
// `harness <cmd>` in a terminal could already do, with the same guards.
//
// One power it deliberately withholds: an agent the harness launched must not
// answer its own approval requests. Build sessions run with
// HARNESS_AGENT_SESSION=1 (see environment.mjs); inside one, the human-only
// tools refuse. The CLI enforces the same rule, so this is not the only lock.

export const PROTOCOL_VERSION = '2025-06-18'
export const HUMAN_ONLY = new Set(['approve', 'reject', 'resume', 'approve_unit'])

const str = (description) => ({ type: 'string', description })
const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false })

/** Tool name → schema + the harness argv it maps to. */
export const TOOLS = {
  status: {
    description: 'One-screen harness status: scheduler, providers, headroom, runner, unit queue, pending approvals and undelivered messages.',
    inputSchema: obj(),
    argv: () => [['status'], ['runner', 'status'], ['units']],
  },
  history: {
    description: 'What happened: the recent run log, notifications and finished sessions.',
    inputSchema: obj({ lines: { type: 'integer', description: 'How many log lines (default 40, max 400)' } }),
    argv: a => [['history', String(Math.min(Math.max(Number(a.lines) || 40, 1), 400))]],
  },
  steer: {
    description: 'Queue a message for the running build session. It is delivered on the session\'s next tool call (Claude) or queued natively (Codex). The build keeps running.',
    inputSchema: obj({ message: str('What the build session should do or know') }, ['message']),
    argv: a => [['say', String(a.message ?? '')]],
  },
  approvals: {
    description: 'List approval requests waiting on the operator.',
    inputSchema: obj(),
    argv: () => [['approvals']],
  },
  approve: {
    description: 'Approve a pending request by id (e.g. a001), optionally with a condition. Human-only.',
    inputSchema: obj({ id: str('Approval id'), note: str('Optional condition, e.g. "yes, but cap it at $5"') }, ['id']),
    argv: a => [['approve', String(a.id ?? ''), ...(a.note ? [String(a.note)] : [])]],
  },
  reject: {
    description: 'Reject a pending request by id, optionally with a reason. Human-only.',
    inputSchema: obj({ id: str('Approval id'), note: str('Optional reason') }, ['id']),
    argv: a => [['reject', String(a.id ?? ''), ...(a.note ? [String(a.note)] : [])]],
  },
  pause: {
    description: 'Pause autonomy: the runner and scheduler start no new session. A session already running finishes its turn.',
    inputSchema: obj(),
    argv: () => [['pause']],
  },
  resume: {
    description: 'Resume autonomy after a pause. Human-only.',
    inputSchema: obj(),
    argv: () => [['resume']],
  },
  units: {
    description: 'The unit queue: each unit\'s owner, status, and what it is waiting on.',
    inputSchema: obj(),
    argv: () => [['units']],
  },
  approve_unit: {
    description: 'Release a unit that is gated on operator approval (money, production, destructive). Human-only.',
    inputSchema: obj({ id: str('Unit id, e.g. A11') }, ['id']),
    argv: a => [['units', 'approve', String(a.id ?? '')]],
  },
}

const reply = (id, result) => ({ jsonrpc: '2.0', id, result })
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })

/**
 * Handle one JSON-RPC message. Returns the response object, or null for a
 * notification (which gets no reply).
 *
 * @param {object} msg
 * @param {object} ctx
 * @param {(argv: string[]) => Promise<{out: string, code: number}>} ctx.run
 * @param {boolean} [ctx.agentSession] - true inside a harness-launched build session
 * @param {string}  [ctx.version]
 */
export async function handleMessage(msg, { run, agentSession = false, version = '2' }) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return msg?.id !== undefined ? fail(msg.id ?? null, -32600, 'invalid request') : null
  }
  const { id, method, params = {} } = msg
  const isNotification = id === undefined
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'harness', version },
        instructions: 'Control tower for the agent build harness. Read status/history, steer the running build, answer approvals, pause/resume. The build keeps running while you use these.',
      })
    case 'ping':
      return reply(id, {})
    case 'tools/list':
      return reply(id, {
        tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })),
      })
    case 'tools/call': {
      const name = params.name
      const tool = TOOLS[name]
      if (!tool) return fail(id, -32602, `unknown tool "${name}"`)
      const args = params.arguments || {}
      if (HUMAN_ONLY.has(name) && agentSession) {
        return reply(id, {
          isError: true,
          content: [{ type: 'text', text: `"${name}" is reserved for the operator; a harness-launched build session cannot use it.` }],
        })
      }
      for (const key of tool.inputSchema.required || []) {
        if (!String(args[key] ?? '').trim()) return fail(id, -32602, `"${key}" is required`)
      }
      const parts = []
      let failed = false
      for (const argv of tool.argv(args)) {
        const r = await run(argv)
        if (r.code !== 0) failed = true
        parts.push(r.out.trim())
      }
      return reply(id, {
        isError: failed,
        content: [{ type: 'text', text: parts.filter(Boolean).join('\n\n') || '(no output)' }],
      })
    }
    default:
      if (isNotification) return null // initialized, cancelled, …
      return fail(id, -32601, `method not found: ${method}`)
  }
}

/** Wire handleMessage to a byte stream pair (stdin/stdout in production). */
export function serveStdio({ input, output, ...ctx }) {
  let buf = ''
  let queue = Promise.resolve()
  input.setEncoding('utf8')
  input.on('data', chunk => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      // Serialised: tool calls that mutate state (pause, approve) must land in
      // the order the client sent them.
      queue = queue.then(async () => {
        let msg
        try { msg = JSON.parse(line) } catch {
          output.write(JSON.stringify(fail(null, -32700, 'parse error')) + '\n'); return
        }
        const res = await handleMessage(msg, ctx).catch(e => fail(msg.id ?? null, -32603, e.message))
        if (res) output.write(JSON.stringify(res) + '\n')
      })
    }
  })
  return new Promise(resolve => input.on('end', () => queue.then(resolve)))
}
