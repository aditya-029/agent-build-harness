// Provider adapters for the two coding CLIs the harness can currently drive.
//
// Keep provider facts here. The scheduler should reason in terms of
// capabilities and normalized events, not know which vendor spells a session
// "thread" or which flag enables JSONL output.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chatArgs } from './chat.mjs'

export const PROVIDER_NAMES = ['claude', 'codex']

const CAPABILITIES = {
  claude: {
    accountUsage: true,
    costUsd: true,
    hookInbox: true,
    liveQueue: false,
    remoteControl: true,
    callerChoosesSessionId: true,
  },
  codex: {
    accountUsage: false,
    costUsd: false,
    hookInbox: false,
    liveQueue: true,
    remoteControl: false,
    callerChoosesSessionId: false,
  },
}

export function providerCapabilities(name) {
  const caps = CAPABILITIES[name]
  if (!caps) throw new Error(`unsupported provider "${name}" (choose ${PROVIDER_NAMES.join(' or ')})`)
  return { ...caps }
}

function addModel(args, model, flag = '--model') {
  if (typeof model === 'string' && model.trim()) args.push(flag, model.trim())
}

/** Build one non-interactive provider invocation. */
export function headlessInvocation({
  provider, repo, prompt, sessionId = null, fresh = true,
  model = null, fallbackModel = null,
  sandbox = 'workspace-write', permissionMode = 'auto', unsafeBypass = false,
  hookEvents = true,
}) {
  if (!PROVIDER_NAMES.includes(provider)) providerCapabilities(provider)
  if (typeof prompt !== 'string') throw new Error('headless invocation requires a prompt')

  if (provider === 'claude') {
    if (!sessionId) throw new Error('Claude invocation requires a session id')
    const args = [
      '-p', prompt,
      ...(fresh ? ['--session-id', sessionId] : ['--resume', sessionId]),
    ]
    if (unsafeBypass) args.push('--dangerously-skip-permissions')
    else args.push('--permission-mode', permissionMode)
    addModel(args, model)
    if (fallbackModel) args.push('--fallback-model', fallbackModel)
    args.push('--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--forward-subagent-text')
    if (hookEvents) args.push('--include-hook-events')
    return { command: 'claude', args }
  }

  // Codex chooses the thread id and reports it in `thread.started`. A resumed
  // exec inherits its working directory; sandbox is repeated through config so
  // automation never silently falls back to a broader user default.
  if (fresh) {
    const args = ['exec', '--json', '--sandbox', sandbox, '-C', repo]
    addModel(args, model, '--model')
    args.push(prompt)
    return { command: 'codex', args }
  }
  if (!sessionId) throw new Error('Codex resume requires a session id')
  const args = ['exec', 'resume', '--json', '-c', `sandbox_mode="${sandbox}"`]
  addModel(args, model, '--model')
  args.push(sessionId, prompt)
  return { command: 'codex', args }
}

/** Build an interactive attachment. Codex needs an existing headless thread. */
export function interactiveInvocation({
  provider, repo, sessionId, fresh = false, prompt, model = null,
  sandbox = 'workspace-write', permissionMode = 'auto', unsafeBypass = false,
  remoteControl = false, remoteName = null, project = 'harness', extra = [],
}) {
  if (provider === 'claude') {
    return {
      command: 'claude',
      args: chatArgs({
        sessionId, fresh, prompt, model, permissionMode, unsafeBypass,
        remoteControl, remoteName, project, extra,
      }),
    }
  }
  providerCapabilities(provider)
  if (fresh || !sessionId) {
    throw new Error('Codex chat needs an existing thread; run one `harness tick` first')
  }
  const args = [
    'resume', '--include-non-interactive', '--sandbox', sandbox,
    '--ask-for-approval', 'on-request', '-C', repo,
  ]
  addModel(args, model, '--model')
  args.push(sessionId, ...extra)
  return { command: 'codex', args }
}

/** Build a provider-native live steering command, or null when hooks deliver it. */
export function queueInvocation({ provider, sessionId, message, model = null }) {
  if (provider !== 'codex' || !sessionId || !message?.trim()) return null
  const args = ['queue', '--thread', sessionId, '--message', message.trim()]
  addModel(args, model, '--model')
  return { command: 'codex', args }
}

/** Prove a persisted session still exists before attempting to resume it. */
export function providerSessionExists(provider, sessionId, repo, home = os.homedir()) {
  if (!sessionId) return false
  if (provider === 'claude') {
    const dir = path.resolve(repo).replace(/[/.]/g, '-')
    return fs.existsSync(path.join(home, '.claude', 'projects', dir, `${sessionId}.jsonl`))
  }
  providerCapabilities(provider)
  try {
    const lines = fs.readFileSync(path.join(home, '.codex', 'session_index.jsonl'), 'utf8').split('\n')
    return lines.some(line => {
      if (!line.trim()) return false
      try { return JSON.parse(line).id === sessionId } catch { return false }
    })
  } catch { return false }
}

function codexUsage(raw = {}) {
  // Codex reports cached input as a subset of input_tokens. Claude reports
  // fresh and cache-read input as separate fields, which the neutral meters
  // add. Subtract before mapping or every cached token is counted twice.
  const totalInput = raw.input_tokens || 0
  const cachedInput = raw.cached_input_tokens || 0
  return {
    input_tokens: Math.max(0, totalInput - cachedInput),
    cache_read_input_tokens: cachedInput,
    cache_creation_input_tokens: 0,
    output_tokens: raw.output_tokens || 0,
  }
}

/**
 * Convert provider streams to the small Claude-shaped event vocabulary the
 * existing breaker, verifier, context watcher and token meter consume.
 */
export function normalizeProviderEvent(provider, raw) {
  if (provider === 'claude') return [raw]
  providerCapabilities(provider)
  if (!raw || typeof raw !== 'object') return []

  if (raw.type === 'thread.started') {
    return [{ type: 'provider_session', session_id: raw.thread_id }]
  }
  if (raw.type === 'item.started' && raw.item?.type === 'command_execution') {
    return [{
      type: 'assistant',
      message: { content: [{
        type: 'tool_use', id: raw.item.id || `command-${Date.now()}`,
        name: 'Bash', input: { command: raw.item.command || '' },
      }] },
    }]
  }
  if (raw.type === 'item.completed' && raw.item?.type === 'agent_message') {
    return [{
      type: 'assistant',
      message: { content: [{ type: 'text', text: raw.item.text || '' }] },
    }]
  }
  if (raw.type === 'item.completed' && raw.item?.type === 'file_change') {
    return [{
      type: 'assistant',
      message: { content: [{
        type: 'tool_use', id: raw.item.id || `edit-${Date.now()}`,
        name: 'Edit', input: { changes: raw.item.changes || [], status: raw.item.status || null },
      }] },
    }]
  }
  if (raw.type === 'turn.completed') {
    const usage = codexUsage(raw.usage)
    return [
      { type: 'assistant', message: { usage, content: [] } },
      { type: 'result', subtype: 'success', is_error: false, num_turns: 1, usage, total_cost_usd: null },
    ]
  }
  if (raw.type === 'turn.failed' || raw.type === 'error') {
    const error = raw.error?.message || raw.error || raw.message || 'Codex run failed'
    return [{
      type: 'result', subtype: 'error', is_error: true,
      terminal_reason: 'api_error', result: String(error), total_cost_usd: null,
    }]
  }
  return []
}
