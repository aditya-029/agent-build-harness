// The approvals queue: the human as a designed exit, not an interrupt handler.
//
// Every other stop in this harness is a stop. The breaker halts a runaway, the
// budget cap halts spending, the usage floor refuses to start. Those are all
// the machine deciding it should not continue. This is the other case — where
// the machine has no business deciding at all, and the correct move is to ask.
//
// The escalation list is deliberately short, because a queue that catches
// everything is a queue nobody answers, and a stalled approval is a stalled
// build:
//
//   destructive   — deletes or overwrites in a way that is hard to undo
//   spend         — costs real money outside the metered token budget
//   scope         — work drifting from what was actually asked for
//   conflict      — an impasse the session cannot resolve on its own
//
// Everything not on that list stays autonomous. The default when a case is
// genuinely ambiguous is ASK, not act: a build that waits is recoverable, and
// `rm -rf` on the wrong directory at 3am is not.

export const REASONS = ['destructive', 'spend', 'scope', 'conflict']

/** A request is open until a human answers it. Nothing expires on its own. */
export const STATUSES = ['pending', 'approved', 'rejected']

/**
 * Build a request. `id` is caller-supplied so the harness controls ordering and
 * the tests are not at the mercy of a clock.
 */
export function makeRequest({ id, reason, summary, detail = '', session = null, ts }) {
  if (!id) throw new Error('approval: id is required')
  if (!REASONS.includes(reason)) {
    throw new Error(`approval: reason must be one of ${REASONS.join(', ')} — got "${reason}"`)
  }
  const text = String(summary || '').trim()
  if (!text) throw new Error('approval: a summary is required — "approve this?" is not a question')
  return {
    id, reason, summary: text, detail: String(detail || ''),
    session, status: 'pending', ts: ts ?? null, answered_ts: null, note: null,
  }
}

/** Parse a JSONL queue file, skipping lines too corrupt to read. */
export function parseQueue(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const r = JSON.parse(t)
      if (r && typeof r.id === 'string') out.push(r)
    } catch { /* a torn line is not a reason to lose the rest of the queue */ }
  }
  return out
}

/**
 * Collapse the log into current state. The file is append-only — an answer is
 * a new line, not an edit — so the LAST entry for an id is the live one. That
 * keeps two writers from clobbering each other's answers.
 */
export function currentState(records) {
  const byId = new Map()
  for (const r of records) byId.set(r.id, { ...(byId.get(r.id) || {}), ...r })
  return [...byId.values()]
}

export function pending(records) {
  return currentState(records).filter(r => r.status === 'pending')
}

/** Answer a request. Returns the record to append, or null if there is nothing to answer. */
export function answer(records, id, status, { note = null, ts = null } = {}) {
  if (!STATUSES.includes(status) || status === 'pending') {
    throw new Error(`approval: answer must be approved or rejected — got "${status}"`)
  }
  const state = currentState(records)
  const found = state.find(r => r.id === id)
  if (!found) return null
  // An already-answered request stays answered. Re-answering would let a stale
  // terminal overwrite a decision the human already made somewhere else.
  if (found.status !== 'pending') return null
  return { ...found, status, note, answered_ts: ts }
}

/**
 * The message handed back to the session once a human has answered.
 *
 * The note travels with it, because "yes, but cap it at $5" is the common shape
 * of a real answer and dropping the condition would be worse than refusing.
 */
export function relayMessage(record) {
  if (!record || record.status === 'pending') return null
  const verdict = record.status === 'approved' ? 'APPROVED' : 'REJECTED'
  const note = record.note ? ` — ${record.note}` : ''
  return record.status === 'approved'
    ? `[human] ${verdict}: ${record.summary}${note}. Proceed, and stay within exactly what was approved.`
    : `[human] ${verdict}: ${record.summary}${note}. Do not do it. Record it and continue with the rest.`
}

/** One line per request, for `harness approvals`. */
export function renderQueue(records) {
  const open = pending(records)
  if (open.length === 0) return 'no approvals pending.'
  const lines = [`${open.length} pending:`, '']
  for (const r of open) {
    lines.push(`  ${r.id}  [${r.reason}]  ${r.summary}`)
    if (r.detail) lines.push(`      ${r.detail.split('\n')[0].slice(0, 100)}`)
  }
  lines.push('')
  lines.push('  harness approve <id> [note]   ·   harness reject <id> [note]')
  return lines.join('\n')
}

// Injected into the session so it knows what to escalate and, just as
// importantly, what NOT to. A queue that catches everything is a queue nobody
// answers.
export const APPROVALS_BRIEF = `ESCALATION. Four things are not yours to decide. Run
\`harness ask <destructive|spend|scope|conflict> "<one line>"\` and STOP that line of work:
- destructive: deleting or overwriting anything hard to undo (force pushes, dropped data, rm -rf)
- spend: anything costing real money beyond your token budget
- scope: work drifting from the brief's Goal — file it, do not follow it
- conflict: an impasse you cannot resolve
Everything else is yours; decide it and keep moving. When genuinely unsure, ASK — a build
that waits is recoverable. Do not batch trivia into the queue: a queue nobody answers is a
build that never finishes.`
