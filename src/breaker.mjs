// Runaway guardrail — the one class of failure this harness could not see.
//
// Every existing gate is either PRE-FLIGHT (usage floor, budget cap, cooldown:
// should a session start?) or POST-MORTEM (classifyRun, idle backoff: what did
// that session turn out to be?). Between those two there was nothing. Once a
// tick started, an agent could spin on the same tool call, or burn output at
// three times its normal rate, for its entire context window, and the first the
// harness heard of it was the bill.
//
// Ported from the circuit breaker in Munder Difflin (MIT, Chaitanya Giri —
// src/main/breaker.ts), which solves the same problem for a floor of agents.
// The policy is theirs; the plumbing is ours. What is kept:
//
//   - the ESCALATION LADDER rather than a kill switch. steer → constrain →
//     stop, one level per beat, never jumping straight to a kill, and
//     de-escalating a level per healthy beat so a blip does not stick.
//   - hard stop OFF by default. Without it the ladder caps at `constrained`
//     and the worst it can do is tell the agent to land.
//   - velocity as the DIFF of consecutive cumulative samples, never a single
//     sample treated as an increment. Their comment is emphatic about this and
//     it is the obvious way to get it wrong.
//   - the COMPACTION EXEMPTION. Compaction burns a burst of output tokens while
//     touching nothing, which is exactly the shape of a velocity false positive.
//     They hit this: their own auto-compact tripped their own breaker.
//   - the truncated tool key. A Write's tool_input can carry a whole file, and
//     this runs on every tool call, so each string field is capped before the
//     key is built.
//
// What is deliberately NOT ported: their Stop-hook forced continuation. Their
// design doc calls it the autonomous loop; their shipped code disabled it, with
// the reason in a comment — it "could spend credits while a user was answering
// a question". That is a lesson worth taking for free.
//
// Nothing here does I/O or reads the clock; `now` is always a parameter.

export const LEVELS = ['healthy', 'steering', 'constrained', 'stopped']
const rank = l => LEVELS.indexOf(l)

export const BREAKER_DEFAULTS = {
  enabled: true,
  // A tool call repeated identically this many times in a row is a loop. Three
  // is too low — a retry after a genuine failure is normal and looks the same.
  repeatLimit: 6,
  // Consecutive api_errors with no successful tool call between them.
  errorLimit: 5,
  // No DISTINCT tool call for this long, while the session is still spending.
  // A long single Bash call (a test suite) is progress, so this is measured from
  // the last distinct call, not the last event.
  noProgressMs: 10 * 60 * 1000,
  // Output tokens per minute, averaged over the diff between two samples.
  // Measured normal for a working session is ~200-600/min; 2,500 is far enough
  // above that a trip means something is genuinely wrong.
  velocityTokensPerMin: 2500,
  // Two consecutive velocity samples over the line before it counts. A single
  // burst is a long reply, not a runaway.
  velocityBeats: 2,
  // Dollars in ONE session. Distinct from the harness-wide budget cap, which
  // guards the account; this guards the session.
  sessionCapUsd: 8,
  // Off by default: the ladder caps at `constrained` and never kills.
  hardStop: false,
  // Grace after a compaction starts, during which velocity arms are ignored.
  compactGraceMs: 3 * 60 * 1000,
  postCompactGraceMs: 30 * 1000,
}

/** Cap each string field before building the key — a Write carries whole files. */
function toolKey(name, input) {
  let s = ''
  try {
    s = JSON.stringify(input, (_k, v) => (typeof v === 'string' && v.length > 250 ? v.slice(0, 250) : v)) ?? ''
  } catch { s = String(input) }
  return `${name ?? '?'}:${s.slice(0, 200)}`
}

/**
 * A stateful breaker for ONE session.
 *
 * Feed it `recordToolUse`, `recordError`, `recordCompactStart/End` and a
 * periodic `beat({ outputTokens, usd, now })`. `beat` returns a decision; the
 * caller performs the enforcement. Deliberately side-effect free so the tests
 * drive the real policy rather than a copy of it.
 */
export function createBreaker(cfg = {}) {
  const c = { ...BREAKER_DEFAULTS, ...cfg }
  const s = {
    level: 'healthy', reason: '',
    repeatKey: null, repeatCount: 0, errorCount: 0,
    // null, not 0 — 0 is a legitimate timestamp and using it as the "unset"
    // sentinel made the no-progress arm silently dead whenever the clock
    // happened to start at zero. Only a test clock does that in practice, but a
    // guard that can be switched off by its own initial value is a bug either way.
    lastDistinctToolAt: null, compactingUntil: 0,
    lastSample: null, hotBeats: 0, started: 0,
  }

  /** A NEW (name+input) is forward progress; the SAME key again is the signal. */
  function recordToolUse(name, input, now = 0) {
    const key = toolKey(name, input)
    if (key === s.repeatKey) { s.repeatCount += 1; return }
    s.repeatKey = key
    s.repeatCount = 1
    s.errorCount = 0            // a distinct call is progress — clear the storm
    s.lastDistinctToolAt = now
  }
  const recordError = () => { s.errorCount += 1 }
  const recordCompactStart = (now = 0) => { s.compactingUntil = now + c.compactGraceMs }
  const recordCompactEnd = (now = 0) => {
    // Shorten to a trailing grace so the burst still lands in the next diff.
    // A no-op when nothing was compacting, so a plain session start grants
    // no exemption of its own.
    if (s.compactingUntil > now) s.compactingUntil = now + c.postCompactGraceMs
  }

  /** What is wrong right now, or null. Order matters: the cheapest, most
   *  certain signals are checked first so the reason names the real cause. */
  function trip({ outputTokens, usd, now }) {
    if (s.repeatCount >= c.repeatLimit) {
      return `the same tool call ${s.repeatCount}x in a row`
    }
    if (s.errorCount >= c.errorLimit) {
      return `${s.errorCount} consecutive API errors with no successful call between them`
    }
    if (typeof usd === 'number' && c.sessionCapUsd > 0 && usd >= c.sessionCapUsd) {
      return `this session has spent $${usd.toFixed(2)} of its $${c.sessionCapUsd} session cap`
    }
    const compacting = now < s.compactingUntil
    if (!compacting && s.lastDistinctToolAt !== null && (now - s.lastDistinctToolAt) >= c.noProgressMs) {
      return `no distinct tool call for ${Math.round((now - s.lastDistinctToolAt) / 60000)} minutes`
    }
    // Velocity: the diff of two cumulative samples over the elapsed time between
    // them. A single cumulative reading is not a rate.
    if (!compacting && typeof outputTokens === 'number') {
      const prev = s.lastSample
      if (prev && now > prev.now) {
        const perMin = ((outputTokens - prev.outputTokens) / (now - prev.now)) * 60_000
        if (perMin >= c.velocityTokensPerMin) {
          s.hotBeats += 1
          if (s.hotBeats >= c.velocityBeats) {
            return `output running at ${Math.round(perMin)} tokens/min over ${s.hotBeats} beats`
          }
        } else s.hotBeats = 0
      }
    }
    return null
  }

  /**
   * One beat. Escalates at most ONE level, de-escalates at most one, and
   * reports `action` only on an escalation so a durable steer is not re-sent
   * every beat.
   */
  function beat({ outputTokens = null, usd = null, now = 0 } = {}) {
    if (!c.enabled) {
      const changed = s.level !== 'healthy'
      s.level = 'healthy'; s.reason = ''
      return { level: 'healthy', reason: '', action: 'none', changed }
    }
    const why = trip({ outputTokens, usd, now })
    const before = s.level

    if (why) {
      const next = LEVELS[Math.min(rank(s.level) + 1, LEVELS.length - 1)]
      // With hardStop off the ladder stops one rung short of a kill, so the
      // worst outcome is an agent told firmly to land.
      s.level = (next === 'stopped' && !c.hardStop) ? 'constrained' : next
      s.reason = why
    } else {
      s.level = LEVELS[Math.max(rank(s.level) - 1, 0)]
      if (s.level === 'healthy') s.reason = ''
    }

    if (typeof outputTokens === 'number') s.lastSample = { outputTokens, now }

    const escalated = rank(s.level) > rank(before)
    const action = escalated
      ? ({ steering: 'steer', constrained: 'constrain', stopped: 'stop' }[s.level] ?? 'none')
      : 'none'
    return { level: s.level, reason: s.reason, action, changed: s.level !== before }
  }

  return {
    recordToolUse, recordError, recordCompactStart, recordCompactEnd, beat,
    state: () => ({ ...s }),
  }
}

/** The message sent to the agent when the ladder escalates. Steering is a
 *  question, not an order — the agent may have a good reason, and an accusation
 *  it disagrees with wastes a turn arguing. Constraining is an instruction. */
export function breakerMessage(level, reason) {
  if (level === 'steering') {
    return `[supervisor] Something looks stuck: ${reason}. If you are making progress, `
      + `say so in one line and carry on. If not, change approach — do not retry the same thing again.`
  }
  if (level === 'constrained') {
    return `[supervisor] Still stuck: ${reason}. Stop starting anything new. Commit only what is `
      + `already verified, write your journal line with a precise "next", and end the session.`
  }
  return `[supervisor] Halting: ${reason}.`
}
