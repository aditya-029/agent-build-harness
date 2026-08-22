#!/usr/bin/env node
// Per-session compliance scorecard.  `npm run harness:scorecard`
//
// Answers the question that has been unanswerable: did changing prompt.md
// actually help? Every edit to that file has so far been a guess, because
// nothing measured whether a session obeyed it.
//
// This adds NO new logging. Everything it reports is already captured and has
// simply never been joined:
//
//   .harness/events/<session>.jsonl   hook events — every tool call, every
//                                     subagent start/stop, with agent_type
//   .harness/cost.jsonl               peak_ctx_tokens, cost, turns, outcome
//   logs/build-scheduler.jsonl        the unit journal — status, commit, next
//
// The columns are the behaviours prompt.md actually asks for, so a regression
// in obedience shows up as a column going dark rather than as a vague sense
// that the agent has got worse.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')
const STATE = path.join(REPO, '.harness')

const readJsonl = p => {
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter(l => l.trim())
      .map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

const runs = readJsonl(path.join(STATE, 'cost.jsonl'))
const journal = readJsonl(path.join(REPO, 'logs/build-scheduler.jsonl'))

// Journal entries carry no session id, so they are matched to runs by time:
// a unit belongs to the run that was open when it was logged.
const journalFor = (startMs, endMs) => journal.filter(j => {
  const t = Date.parse(j.ts)
  return Number.isFinite(t) && t >= startMs && t <= endMs
})

const rows = []
for (const r of runs) {
  const events = readJsonl(path.join(STATE, 'events', `${r.session_id}.jsonl`))
  if (!events.length && !r.peak_ctx_tokens) continue

  const endMs = Date.parse(r.ts)
  const startMs = endMs - (r.duration_ms || 0)

  const subagents = events.filter(e => e.event === 'SubagentStart')
  const byType = {}
  for (const s of subagents) byType[s.agent_type || '?'] = (byType[s.agent_type || '?'] || 0) + 1

  // Reads the main thread performed itself. agent_id set => it was a subagent's
  // read, which is the behaviour we want and must not be counted against it.
  const mainReads = events.filter(e =>
    !e.agent_id && e.tool === 'Read' && /src\//.test(e.summary || ''))
  const ranVerify = events.some(e =>
    /npm run verify|npm run harness:test/.test(e.summary || ''))
  const sawReviewer = subagents.some(s => (s.agent_type || '') === 'reviewer')
  const units = journalFor(startMs, endMs)
  const committed = units.filter(u => u.commit && u.commit !== 'null')
  const withDetail = units.filter(u => u.next_detail)

  rows.push({
    when: (r.ts || '').slice(5, 16).replace('T', ' '),
    ctx: r.peak_ctx_tokens ? Math.round(r.peak_ctx_tokens / 1000) : null,
    cost: r.cost_usd,
    turns: r.turns,
    subs: subagents.length,
    types: Object.entries(byType).map(([k, v]) => `${k}${v > 1 ? '×' + v : ''}`).join(','),
    mainReads: mainReads.length,
    verify: ranVerify,
    reviewer: sawReviewer,
    units: units.length,
    committed: committed.length,
    handoff: units.length ? withDetail.length === units.length : null,
    limited: r.rate_limit_events > 0,
  })
}

if (!rows.length) {
  console.log('no sessions with recorded events yet')
  process.exit(0)
}

const yn = b => b === null ? ' - ' : b ? ' ok' : ' NO'
console.log('\n  when          ctx   cost  turns  subs  delegated to            reads  verify  revw  units  cmt  handoff')
console.log('  ' + '-'.repeat(104))
for (const r of rows) {
  console.log(
    '  ' + r.when.padEnd(12) +
    (r.ctx === null ? '  - ' : (r.ctx + 'k').padStart(4)) +
    ('$' + (r.cost ?? 0).toFixed(2)).padStart(7) +
    String(r.turns ?? 0).padStart(6) +
    String(r.subs).padStart(6) +
    '  ' + (r.types || '—').slice(0, 22).padEnd(22) +
    String(r.mainReads).padStart(5) +
    yn(r.verify).padStart(8) +
    yn(r.reviewer).padStart(6) +
    String(r.units).padStart(6) +
    String(r.committed).padStart(5) +
    yn(r.handoff).padStart(8))
}

// Aggregates over sessions that actually did work — a session killed on arrival
// says nothing about obedience and would only dilute the rates.
const worked = rows.filter(r => (r.turns ?? 0) >= 5)
if (worked.length) {
  const pct = n => Math.round((n / worked.length) * 100) + '%'
  const avg = f => (worked.reduce((s, r) => s + (f(r) || 0), 0) / worked.length)
  console.log('\n  Across ' + worked.length + ' working sessions:')
  console.log('    delegated at least once      ' + pct(worked.filter(r => r.subs > 0).length))
  console.log('    ran verify                   ' + pct(worked.filter(r => r.verify).length))
  console.log('    reviewer saw the diff        ' + pct(worked.filter(r => r.reviewer).length))
  console.log('    complete handoff detail      ' + pct(worked.filter(r => r.handoff).length))
  console.log('    avg main-thread src reads    ' + avg(r => r.mainReads).toFixed(1) + '   (lower is better)')
  console.log('    avg peak context             ' + Math.round(avg(r => r.ctx)) + 'k')
  console.log('    avg $/turn                   $' + (avg(r => r.cost) / Math.max(avg(r => r.turns), 1)).toFixed(4))
  const noRev = worked.filter(r => r.committed > 0 && !r.reviewer)
  if (noRev.length) {
    console.log('\n  ⚠  ' + noRev.length + ' session(s) committed WITHOUT reviewer seeing the diff:')
    for (const r of noRev) console.log('       ' + r.when)
  }
}
console.log()
