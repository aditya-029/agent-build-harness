// The unit queue: what the runner is allowed to build, in what order, and how
// it will know each piece is finished.
//
// A unit is one session-sized piece of work with an owner and a runnable
// acceptance command. The command is the whole point. An unattended agent with
// no executable definition of done does not stall — it builds something
// plausible, reports success, and the first anyone learns otherwise is a human
// reading the diff days later. So a unit without one is REFUSED at load time,
// not warned about (D11).
//
// Owners (D12):
//   agent — the runner builds it.
//   adi   — hands-on work for the operator (eval thresholds, guardrail design,
//           core logic). The runner never starts these; agent units that
//           depend on one wait, and the runner picks something else meanwhile.
//
// The plan (this file's input) is operator-approved and changes rarely. Runtime
// progress — attempts, completions, failures — lives in harness state, never in
// the plan, so the runner never has to commit to the operator's file.

export const OWNERS = ['agent', 'adi']
export const PLAN_STATUSES = ['queued', 'done', 'dropped']
export const PROVIDER_PREFS = ['any', 'claude', 'codex']
export const DEFAULT_MAX_ATTEMPTS = 3

/**
 * Validate a parsed queue document. Returns every problem, not just the first:
 * an operator fixing the file wants the whole list in one pass.
 *
 * @returns {{ ok: boolean, problems: string[], units: object[] }}
 */
export function validateQueue(doc) {
  const problems = []
  const units = Array.isArray(doc?.units) ? doc.units : null
  if (!units) return { ok: false, problems: ['queue has no "units" array'], units: [] }

  const ids = new Set()
  const normal = []
  for (const [i, u] of units.entries()) {
    const where = `unit ${u?.id ? `"${u.id}"` : `#${i + 1}`}`
    if (!u || typeof u !== 'object') { problems.push(`${where}: not an object`); continue }
    const id = typeof u.id === 'string' ? u.id.trim() : ''
    if (!id) problems.push(`${where}: missing id`)
    else if (ids.has(id)) problems.push(`${where}: duplicate id`)
    else ids.add(id)
    if (!String(u.title ?? '').trim()) problems.push(`${where}: missing title`)
    if (!OWNERS.includes(u.owner)) problems.push(`${where}: owner must be ${OWNERS.join(' or ')}`)
    const status = u.status ?? 'queued'
    if (!PLAN_STATUSES.includes(status)) problems.push(`${where}: status must be one of ${PLAN_STATUSES.join(', ')}`)
    const provider = u.provider ?? 'any'
    if (!PROVIDER_PREFS.includes(provider)) problems.push(`${where}: provider must be one of ${PROVIDER_PREFS.join(', ')}`)
    const cmd = typeof u.acceptance === 'string' ? u.acceptance : u.acceptance?.command
    // The refusal D11 asks for. Prose ("tests pass") is not a command.
    if (typeof cmd !== 'string' || !cmd.trim()) {
      problems.push(`${where}: REFUSED — no runnable acceptance command`)
    }
    const depends = u.depends ?? []
    if (!Array.isArray(depends)) problems.push(`${where}: depends must be an array`)
    normal.push({
      id, title: String(u.title ?? '').trim(), owner: u.owner, status, provider,
      depends: Array.isArray(depends) ? depends.map(String) : [],
      acceptance: {
        command: typeof cmd === 'string' ? cmd.trim() : '',
        cwd: (typeof u.acceptance === 'object' && u.acceptance?.cwd) || '.',
        timeoutSec: Number(u.acceptance?.timeoutSec) || 900,
      },
      brief: String(u.brief ?? '').trim(),
      approval: u.approval ? String(u.approval) : null,
      maxAttempts: Number(u.maxAttempts) || DEFAULT_MAX_ATTEMPTS,
    })
  }
  for (const u of normal) {
    for (const d of u.depends) if (!ids.has(d)) problems.push(`unit "${u.id}": depends on unknown unit "${d}"`)
  }
  const cycle = findCycle(normal)
  if (cycle) problems.push(`dependency cycle: ${cycle.join(' → ')}`)
  return { ok: problems.length === 0, problems, units: normal }
}

function findCycle(units) {
  const byId = new Map(units.map(u => [u.id, u]))
  const state = new Map() // 1 = visiting, 2 = done
  const stack = []
  const visit = id => {
    if (state.get(id) === 2) return null
    if (state.get(id) === 1) return stack.slice(stack.indexOf(id)).concat(id)
    state.set(id, 1); stack.push(id)
    for (const d of byId.get(id)?.depends ?? []) {
      if (!byId.has(d)) continue
      const c = visit(d)
      if (c) return c
    }
    stack.pop(); state.set(id, 2)
    return null
  }
  for (const u of units) { const c = visit(u.id); if (c) return c }
  return null
}

/**
 * The effective status of each unit: the plan's word, overlaid with runtime
 * progress. `done` in either place is done — a unit finished by hand and
 * marked in the plan must not be rebuilt because runtime state was wiped.
 */
export function effectiveStatus(unit, runtime = {}) {
  const r = runtime.units?.[unit.id] || {}
  if (unit.status === 'done' || r.status === 'done') return 'done'
  if (unit.status === 'dropped') return 'dropped'
  if (r.status === 'failed') return 'failed'
  if (unit.owner === 'adi') return 'adi'
  return 'queued'
}

/**
 * Units the runner may start now, in plan order: agent-owned, not finished or
 * failed, every dependency done, and not gated on an unanswered approval.
 */
export function readyUnits(units, runtime = {}) {
  const status = new Map(units.map(u => [u.id, effectiveStatus(u, runtime)]))
  return units.filter(u => status.get(u.id) === 'queued'
    && u.depends.every(d => status.get(d) === 'done')
    && !(u.approval && runtime.units?.[u.id]?.approved !== true))
}

/** Why a queued unit is not ready — for `harness units` and the control tower. */
export function blockedReason(unit, units, runtime = {}) {
  const status = new Map(units.map(u => [u.id, effectiveStatus(u, runtime)]))
  const waiting = unit.depends.filter(d => status.get(d) !== 'done')
  if (waiting.length) {
    const adi = waiting.filter(d => units.find(u => u.id === d)?.owner === 'adi')
    return adi.length ? `waiting on Adi: ${adi.join(', ')}` : `waiting on ${waiting.join(', ')}`
  }
  if (unit.approval && runtime.units?.[unit.id]?.approved !== true) return `needs approval (${unit.approval})`
  return null
}

/** The session brief a unit hands to the provider. Shaped for validateBrief. */
export function unitBrief(unit, { attempt = 1, lastFailure = null } = {}) {
  return `# Unit ${unit.id} — ${unit.title}

## Goal
${unit.brief || unit.title}

This is unit ${unit.id} of the operator-approved queue. It is finished when its acceptance
command passes — not before, and nothing beyond it.

## Budget
One session: the supervisor's context ceiling and unit cap apply. No spend outside the
subscription — anything that costs money goes through \`harness ask spend\`.

## Constraints
- One unit only. Do not start other work in this session.
- Stay inside the repository's own instructions (AGENTS.md / CLAUDE.md in the folder you touch).
- Anything destructive, costing money, needing a new secret, or changing scope: \`harness ask\` and stop that line of work.
- This is attempt ${attempt} of ${unit.maxAttempts}. Check \`git status\` and the journal first — an earlier attempt may have left partial work.${lastFailure ? `\n- The previous attempt failed its acceptance check:\n\n\`\`\`\n${lastFailure.slice(-1500)}\n\`\`\`` : ''}

## Deliverable
The acceptance command below exits 0, run from \`${unit.acceptance.cwd}\`:

\`\`\`
${unit.acceptance.command}
\`\`\`

The supervisor runs it after you stop; your own report does not count. Commit your work
(scoped paths) and write a one-line "why" explanation of the change in the commit message.
`
}
