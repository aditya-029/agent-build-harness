// Tiered notifications (D10): Mac + phone, only when it is worth a glance.
//
//   immediate — approval needed, a unit failed, the runner is blocked or parked.
//               Something is waiting on a human; every minute unread is a
//               minute the factory is not building.
//   batch     — a unit finished. Good news keeps; three finishes inside a few
//               minutes arrive as ONE push, not three buzzes.
//   log       — routine progress. Written to the log, never pushed.
//
// Policy lives here and is pure (clock and sender injected). Transport is the
// small adapter at the bottom: macOS via osascript; phone via the Claude app
// (a one-tool headless Claude call to PushNotification, ~$0.004 of window per
// push, which Claude itself withholds while the operator is active at the
// terminal — the Mac notification covers that case), ntfy, or Telegram.
// Phone credentials live OUTSIDE the repository, in a file only the operator
// writes (trust via keys, not prompts), and are never put in an agent's env.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

export const TIERS = {
  approval: 'immediate', failure: 'immediate', blocked: 'immediate', parked: 'immediate',
  done: 'batch',
  progress: 'log',
}
export const tierOf = kind => TIERS[kind] ?? 'log'

/**
 * @param {object} o
 * @param {(msg: {title: string, body: string, tier: string}) => void} o.send
 * @param {() => number} o.now          unix seconds
 * @param {number} [o.quietSec=60]      send a batch once no new finish has arrived for this long
 * @param {number} [o.maxWaitSec=300]   ...or once the oldest finish has waited this long
 * @param {(e: object) => void} [o.log]
 */
export function createNotifier({ send, now, quietSec = 60, maxWaitSec = 300, log = () => {} }) {
  let pending = []
  const flushBatch = () => {
    if (!pending.length) return false
    const items = pending
    pending = []
    const title = items.length === 1 ? items[0].title : `${items.length} units done`
    const body = items.length === 1 ? items[0].body : items.map(i => i.title).join(' · ')
    send({ title, body, tier: 'batch' })
    return true
  }
  return {
    event(e) {
      const tier = tierOf(e.kind)
      log({ ...e, tier, at: now() })
      if (tier === 'immediate') send({ title: e.title, body: e.body || '', tier })
      else if (tier === 'batch') pending.push({ ...e, at: now() })
    },
    /** Call on every runner wake-up. Returns true when a batch went out. */
    tick() {
      if (!pending.length) return false
      const t = now()
      const newest = pending[pending.length - 1].at
      const oldest = pending[0].at
      if (t - newest >= quietSec || t - oldest >= maxWaitSec) return flushBatch()
      return false
    },
    /** Seconds until the pending batch is due, or null when nothing is pending. */
    dueIn() {
      if (!pending.length) return null
      const t = now()
      const byQuiet = pending[pending.length - 1].at + quietSec - t
      const byMax = pending[0].at + maxWaitSec - t
      return Math.max(0, Math.min(byQuiet, byMax))
    },
    /** Deliver whatever is pending right now (runner shutdown). */
    flush: flushBatch,
    pendingCount: () => pending.length,
  }
}

// ───────────────────────────────────────────────────────────── transport

export const NOTIFY_CONFIG = path.join(os.homedir(), '.config', 'harness', 'notify.json')

/**
 * Read the operator's channel config. Absent file = Mac only, which is the safe
 * default: nothing leaves the machine until the operator opts in.
 *
 *   { "macos": true,
 *     "claudeApp": { "model": "haiku" },
 *     "ntfy":     { "topic": "long-random-topic", "server": "https://ntfy.sh" },
 *     "telegram": { "tokenFile": "~/.config/harness/telegram-token", "chatId": "123" } }
 */
export function loadChannels(file = NOTIFY_CONFIG) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'))
    return {
      macos: c.macos !== false, ntfy: c.ntfy || null, telegram: c.telegram || null,
      claudeApp: c.claudeApp ? { model: c.claudeApp.model || 'haiku' } : null,
    }
  } catch { return { macos: true, ntfy: null, telegram: null, claudeApp: null } }
}

const expand = p => String(p).replace(/^~(?=$|\/)/, os.homedir())
const osaQuote = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 240)}"`

/** A sender that fans out to every configured channel. Failures are logged, never thrown. */
/** Argv for the Claude-app push: one tool, no MCP, no skills, no saved session. */
export function claudePushArgs(text, model = 'haiku') {
  return [
    '-p', `Send this notification now: ${JSON.stringify(text)}. Reply with the tool result only.`,
    '--model', model, '--tools', 'PushNotification',
    '--system-prompt', 'You are a notification relay for a background build process. Call PushNotification exactly once with the given text, then reply with the tool result.',
    '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands',
    '--output-format', 'json', '--max-turns', '3',
  ]
}

export function createSender({ project = 'harness', channels = loadChannels(), onError = () => {}, env = process.env } = {}) {
  return ({ title, body, tier }) => {
    const heading = `${project}: ${title}`
    if (channels.macos && process.platform === 'darwin') {
      execFile('osascript', ['-e', `display notification ${osaQuote(body || ' ')} with title ${osaQuote(heading)}`],
        err => err && onError(`macos: ${err.message}`))
    }
    if (channels.claudeApp) {
      const text = `${heading}${body ? ` — ${body}` : ''}`.slice(0, 300)
      execFile('claude', claudePushArgs(text, channels.claudeApp.model), { env, timeout: 120_000 },
        err => err && onError(`claude app: ${err.message.split('\n')[0]}`))
    }
    if (channels.ntfy?.topic) {
      const server = (channels.ntfy.server || 'https://ntfy.sh').replace(/\/$/, '')
      fetch(`${server}/${encodeURIComponent(channels.ntfy.topic)}`, {
        method: 'POST', body: body || title,
        headers: { Title: heading, Priority: tier === 'immediate' ? 'high' : 'default' },
      }).catch(e => onError(`ntfy: ${e.message}`))
    }
    if (channels.telegram?.chatId && channels.telegram?.tokenFile) {
      let token = ''
      try { token = fs.readFileSync(expand(channels.telegram.tokenFile), 'utf8').trim() } catch (e) { onError(`telegram token: ${e.message}`) }
      if (token) {
        fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: channels.telegram.chatId, text: `${heading}\n${body || ''}`.trim() }),
        }).catch(e => onError(`telegram: ${e.message}`))
      }
    }
  }
}
