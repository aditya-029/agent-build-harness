// The event-driven runner's decisions (D3, D16, D17), kept pure so the tests
// drive the real rule rather than a copy of it.
//
// launchd's StartInterval was the old heartbeat: wake every 15 minutes, look
// around, maybe run. That is right for "wait out a spent window" and wrong for
// everything else — a unit that finishes at 10:01 sat idle until 10:15, and a
// window that reset at 10:02 waited the same. The runner replaces the timer
// with events: the next unit starts when the last one finishes and a provider
// has headroom; a spent provider hands the next unit to the other one; when
// both are spent the runner parks until the EARLIEST reset, which is a time the
// providers told us, not an interval we chose.
//
// Nothing here spawns or reads a file. harness.mjs gathers the facts (unit
// queue, runtime state, each provider's gate) and does what this returns.

import { readyUnits, effectiveStatus, blockedReason } from './units.mjs'

export const PROVIDER_ORDER = ['claude', 'codex']

/**
 * What should the runner do next?
 *
 * @param {object} o
 * @param {object[]} o.units      validated units (validateQueue().units)
 * @param {object}   o.runtime    runner state: { units: {id: {...}}, current }
 * @param {object}   o.providers  per provider: { installed, ok, available, resumeAt, reason }
 * @param {object}   o.control    { stopped, paused, attached, attachRequested }
 * @param {number}   o.now        unix seconds
 * @returns {{action: 'stop'|'hold'|'run'|'park'|'idle', ...}}
 */
export function decideNext({ units, runtime = {}, providers = {}, control = {}, now }) {
  if (control.stopped) return { action: 'stop', reason: 'stop marker set' }
  if (control.paused) return { action: 'hold', reason: 'paused (harness resume)' }
  // A human at the keyboard outranks the queue (D7). The runner waits for the
  // detach event rather than polling for it.
  if (control.attached) return { action: 'hold', reason: 'a human is attached' }
  if (control.attachRequested) return { action: 'hold', reason: 'a human asked to attach' }

  const ready = readyUnits(units, runtime)
  if (!ready.length) {
    const open = units.filter(u => effectiveStatus(u, runtime) === 'queued')
    if (!open.length) {
      const adi = units.filter(u => effectiveStatus(u, runtime) === 'adi')
      const failed = units.filter(u => effectiveStatus(u, runtime) === 'failed')
      return {
        action: 'idle',
        reason: failed.length ? `failed units need a look: ${failed.map(u => u.id).join(', ')}`
          : adi.length ? `only Adi's units remain: ${adi.map(u => u.id).join(', ')}`
          : 'queue empty',
      }
    }
    return {
      action: 'idle',
      reason: open.map(u => `${u.id} ${blockedReason(u, units, runtime) || 'blocked'}`).join('; '),
    }
  }

  // A unit interrupted by a spent window resumes where it was, on the same
  // provider, if that provider is usable again — its session holds the work.
  const cur = runtime.current
  const ordered = cur?.unit ? [...ready].sort((a, b) => (b.id === cur.unit) - (a.id === cur.unit)) : ready

  const parkUntil = []
  for (const unit of ordered) {
    const candidates = unit.provider === 'any' ? preferenceFor(unit, runtime) : [unit.provider]
    for (const name of candidates) {
      const p = providers[name]
      if (!p || !p.installed) continue
      if (p.ok) {
        return {
          action: 'run', unit, provider: name,
          // Unmetered is not the same as free (repository contract): the run
          // proceeds, and the decision says so out loud.
          metered: p.available !== false,
          resume: cur?.unit === unit.id && cur?.provider === name,
        }
      }
      if (p.resumeAt > now) parkUntil.push(p.resumeAt)
    }
  }
  if (!parkUntil.length) {
    return { action: 'idle', reason: 'no installed provider can take the ready units' }
  }
  return {
    action: 'park', until: Math.min(...parkUntil),
    reason: 'every usable provider is out of headroom',
  }
}

/**
 * Provider order for an `any` unit. The unit's last provider goes first — its
 * session holds the context — then the default order. Headroom routing (which
 * subscription to prefer when BOTH have room) is ApplyPilot unit A8; until then
 * Claude orchestrates and Codex takes over when Claude is capped.
 */
function preferenceFor(unit, runtime) {
  const last = runtime.units?.[unit.id]?.provider
  return last ? [last, ...PROVIDER_ORDER.filter(p => p !== last)] : [...PROVIDER_ORDER]
}

/**
 * Fold one finished session into the runtime record.
 *
 * `limited` is the provider's own verdict that the session ended on a spent
 * window. Such an attempt is not the unit's fault and does not count against
 * maxAttempts — otherwise a unit that happens to straddle two resets is marked
 * failed for work it never got to finish.
 */
export function recordOutcome(runtime, { unit, provider, passed, limited, output = '', now }) {
  const units = { ...(runtime.units || {}) }
  const prev = units[unit.id] || { attempts: 0 }
  const counted = !passed && !limited
  const attempts = prev.attempts + (counted ? 1 : 0)
  const next = {
    ...prev, provider, attempts,
    lastRunAt: now,
    lastFailure: passed ? null : String(output).slice(-4000),
  }
  if (passed) { next.status = 'done'; next.doneAt = now }
  else if (attempts >= unit.maxAttempts) next.status = 'failed'
  units[unit.id] = next
  return {
    ...runtime, units,
    // Keep the pointer only while the unit is unfinished; it is what routes a
    // resumed unit back to its own session.
    current: passed || next.status === 'failed' ? null : { unit: unit.id, provider },
  }
}

/** One line per state change worth telling a human about (notify.mjs tiers it). */
export function outcomeEvent(unit, runtime) {
  const r = runtime.units?.[unit.id] || {}
  if (r.status === 'done') return { kind: 'done', title: `${unit.id} done`, body: unit.title }
  if (r.status === 'failed') {
    return { kind: 'failure', title: `${unit.id} failed ${r.attempts}×`, body: 'Acceptance still red — parked for review.' }
  }
  return { kind: 'progress', title: `${unit.id} attempt ${r.attempts}`, body: 'acceptance red, retrying' }
}
