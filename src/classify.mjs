// Pure decision logic for the build harness, extracted so it can be tested
// directly rather than re-implemented in the test file.
//
// This module exists because of a specific failure: the supervisor misread the
// CLI's rate-limit signal for weeks, silently, and every failed run got a wrong
// backoff. A test that re-derives the classification rule cannot catch that
// class of bug — it agrees with whatever it was copied from. So the rule lives
// here once, `harness.mjs` imports it, and `harness.test.mjs` imports the same
// function.
//
// Nothing here does I/O or reads the clock; `now` is always a parameter.

// A cooldown further out than this is not believable and is treated as a bad
// reading rather than an instruction. Without this clamp a `resetsAt` that ever
// arrived in milliseconds — the same units confusion that caused the original
// bug — would park the scheduler roughly 55,000 years out, and nothing in the
// system expires or repairs a cooldown.
export const COOLDOWN_HORIZON_SEC = 86_400

/**
 * Did this run end because the usage window rejected it?
 *
 * `subtype` is deliberately not consulted: a rate-limited run reports
 * `subtype: "success"` alongside `is_error: true`, which is exactly what made
 * the original misclassification invisible.
 *
 * `terminal_reason: "api_error"` alone is NOT sufficient — it also covers a 401
 * from a revoked key, a 400, and a 500 overload. Classifying those as a usage
 * window would put a permanently broken key into a silent 15-minute retry loop
 * that never trips the error backoff: the same bug, pointed the other way.
 */
export function isWindowLimit({ result, rateLimited = 0 }) {
  if (result?.api_error_status === 429) return true
  return rateLimited > 0 && result?.terminal_reason === 'api_error'
}

/**
 * Did this run die to a transport fault that will very likely not repeat?
 *
 * Added 2026-08-22 after the replay suite went red. The harness had only TWO
 * buckets — window limit, or error — so anything that was not a window limit
 * inherited the 30-minute error backoff. Measured against all 143 recorded
 * runs, the failure taxonomy is actually three-way and always has been:
 *
 *   36 runs  api_error + api_error_status 429 + a rejected rate_limit_event
 *            → the usage window. Resume at its own resets_at.
 *    5 runs  api_error + NO status + NO rate_limit_event, message
 *            "API Error: Connection closed mid-response."
 *            → the stream dropped. Nothing is wrong with the account.
 *    0 runs  anything else.
 *
 * Those 5 (07-11 Aug) each bought a 30-minute park for a fault that a retry
 * clears in seconds: ~2.5 hours of dead scheduler time inside a build being
 * tuned for throughput. The error backoff exists to stop a REVOKED KEY from
 * spinning in a 15-minute retry loop, and that reasoning does not transfer to
 * a dropped connection.
 *
 * Deliberately narrow, because the cost of a false positive here is exactly the
 * bug the error backoff was built to prevent. All four must hold:
 *   - the run failed,
 *   - it was not already classified as a window limit (caller's job, but the
 *     rate-limit checks below make this safe to call standalone),
 *   - there is no api_error_status — a 401/403/500 carries one, and a broken
 *     key or a server fault must keep the long backoff,
 *   - the message matches a known transport-fault shape.
 *
 * A new transport phrasing is therefore treated as a hard error until someone
 * adds it here. That is the safe direction to be wrong in: the harness idles
 * 30 minutes instead of hammering a genuinely broken account.
 */
const TRANSPORT_FAULTS = [
  /connection closed mid-response/i,
  /connection (reset|closed) by peer/i,
  /socket hang up/i,
  /network (error|timeout)/i,
  /ECONNRESET|ETIMEDOUT|EPIPE|ENETDOWN|ENETUNREACH/,
]

export function isTransientFailure({ result, rateLimited = 0 }) {
  if (!result?.is_error) return false
  if (isWindowLimit({ result, rateLimited })) return false
  // Any HTTP status at all means the API answered. An answer is not a dropped
  // connection, and 401/403/429/500 must never land in a short retry loop.
  if (result.api_error_status != null) return false
  if (result.terminal_reason !== 'api_error') return false
  const msg = String(result.result ?? result.error ?? '')
  return TRANSPORT_FAULTS.some(re => re.test(msg))
}

/**
 * Classify a finished run into exactly one bucket.
 *
 * Exhaustive by construction, so a new failure mode surfaces as 'error' — the
 * conservative bucket — rather than falling through a chain of ifs into
 * whichever branch happened to be last. The replay test asserts this partition
 * over every recorded run instead of asserting any one bucket is empty; the
 * previous test asserted the latter and went red the first time a third
 * failure mode appeared in production.
 */
export function classifyRun({ result, rateLimited = 0 }) {
  if (!result) return 'incomplete'
  if (!result.is_error) return 'ok'
  if (isWindowLimit({ result, rateLimited })) return 'window_limit'
  if (isTransientFailure({ result, rateLimited })) return 'transient'
  return 'error'
}

/**
 * When should the next tick run after a window rejection?
 *
 * `resetsAt` from the stream is the window's own number and outranks any local
 * cache — but only when it is plausible. Absent, zero, non-numeric, in the
 * past, or beyond the horizon all fall back to the caller's cached estimate.
 *
 * Returns null to mean "use the cached estimate".
 */
export function resolveLimitResume({ resetsAt, now, horizonSec = COOLDOWN_HORIZON_SEC }) {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return null
  if (resetsAt <= now) return null
  if (resetsAt > now + horizonSec) return null // implausible — likely wrong units
  return resetsAt + 30 // a beat past the reset, never a beat before
}

/**
 * Extract the context size of one stream event, or null if it is not a
 * main-thread assistant turn carrying usage.
 *
 * Subagent turns are excluded deliberately: their context is bounded and
 * disposable, and counting it would penalise exactly the delegation this is
 * meant to encourage.
 */
export function mainThreadContext(ev) {
  if (!ev || ev.type !== 'assistant') return null
  if (ev.parent_tool_use_id || ev.agent_id) return null
  const u = ev.message?.usage
  if (!u) return null
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
}

/**
 * Watches main-thread context and fires each threshold at most once.
 *
 * Tracks the running peak rather than the latest value, so a dip (a turn that
 * happens to carry less usage) cannot re-arm a threshold that already fired.
 */
export function createCtxWatcher({ warnTokens, handoffTokens, onWarn, onHandoff }) {
  let peak = 0, firedAt = 0
  return {
    peak: () => peak,
    feed(ev) {
      const ctx = mainThreadContext(ev)
      if (ctx === null || ctx <= peak) return null
      peak = ctx
      if (ctx >= handoffTokens && firedAt < handoffTokens) {
        firedAt = handoffTokens
        onHandoff?.(ctx)
        return 'handoff'
      }
      if (ctx >= warnTokens && firedAt < warnTokens) {
        firedAt = warnTokens
        onWarn?.(ctx)
        return 'warn'
      }
      return null
    },
  }
}

/**
 * Is this stream event evidence the session has crossed from the included plan
 * allowance into PAID usage credits?
 *
 * On a Pro plan the 5-hour session allowance is included — work done inside it
 * costs nothing. Usage credits exist only to "keep using Claude if you hit a
 * plan limit", so `isUsingOverage: true` is the exact moment the meter starts.
 * Before that the marginal cost of a turn is zero; after it, it is real money
 * against a monthly spend limit.
 *
 * `status: "allowed_warning"` with a `utilization` float is the approach
 * warning (fires from 0.9), and is NOT yet overage — it is the cue to wrap up
 * while the work is still free.
 */
export function overageSignal(ev) {
  if (!ev || ev.type !== 'rate_limit_event') return null
  const info = ev.rate_limit_info || {}
  return {
    usingOverage: info.isUsingOverage === true,
    overageAllowed: info.overageStatus === 'allowed',
    utilization: typeof info.utilization === 'number' ? info.utilization : null,
    rejected: info.status === 'rejected',
    resetsAt: info.resetsAt || 0,
    kind: info.rateLimitType || null,
  }
}

// ──────────────────────────────────────── live usage and token metering
//
// `rate_limit_event` is the only reading of the account's real position that is
// current at the moment it arrives. Claude Code's own ~/.claude.json cache
// refreshes when the CLI feels like it: measured mid-build at 87 minutes stale,
// still advertising a monthly_limit that had been raised hours earlier. A
// supervisor deciding how to spend money from an undated number is guessing.
//
// So every event is stamped and appended, and the freshest of {cache, observed}
// wins. The events already arrive — the old code reacted to them and dropped
// them on the floor, which is why nothing between runs knew anything.

/** Extract a durable usage observation, or null if this event carries none. */
export function usageSnapshot(ev, atSec) {
  const sig = overageSignal(ev)
  if (!sig) return null
  const info = ev.rate_limit_info || {}
  const snap = {
    at: atSec,
    util: sig.utilization,             // 0..1 of the CURRENT window, live
    kind: sig.kind,                    // which window: session, weekly, ...
    status: info.status || null,
    overage: sig.usingOverage,
    overage_allowed: sig.overageAllowed,
    resets_at: sig.resetsAt || 0,
  }
  // A rejection carries no utilisation float, but "rejected" IS the reading:
  // the window is spent. Without this the one event that matters most is the
  // one recorded as having said nothing.
  if (snap.util === null && sig.rejected) snap.util = 1
  return snap
}

/**
 * Should this observation be written, given the last one written?
 *
 * A busy session emits these continuously and an unfiltered append would grow
 * a log faster than the build writes code. Writes on: first sighting, a
 * meaningful utilisation move, any change of overage state, or a heartbeat.
 * Overage transitions are never suppressed — that edge is the money.
 */
export function shouldRecordUsage(prev, next, { minIntervalSec = 60, minDelta = 0.02 } = {}) {
  if (!next) return false
  if (!prev) return true
  if (prev.overage !== next.overage) return true
  if (prev.kind !== next.kind) return true
  if (next.at - prev.at >= minIntervalSec) return true
  if (typeof next.util === 'number' && typeof prev.util === 'number') {
    return Math.abs(next.util - prev.util) >= minDelta
  }
  return next.util !== prev.util
}

/**
 * Real token counts for a run, taken from the ONE place they are true.
 *
 * The obvious implementation — sum `message.usage` across `assistant` events —
 * is wrong twice over, and was shipped that way before being measured against
 * a real run. Those events are streaming snapshots: they carry
 * `stop_reason: null` and an `output_tokens` sampled at message start, and the
 * same usage object repeats across several events for one message. Summing
 * them undercounted output by ~87x (136 against a true 11,814) while
 * double-counting cached input by 2.3x. The resulting cache-hit ratio was
 * arithmetic on garbage that happened to land on a plausible-looking 85%.
 *
 * The `result` event's `usage` is the settled total for the run. It is a
 * session aggregate with no main-versus-subagent breakdown, and none is
 * reported here rather than inventing one — a split that cannot be derived is
 * not a split.
 *
 * (`mainThreadContext` above still reads assistant events, and is unaffected:
 * it treats them as a LEVEL to take the peak of, not a series to sum, and a
 * repeated identical reading is harmless to a maximum.)
 */
export function createTokenMeter() {
  let usage = null
  // Deduped by tool_use id, because the streaming repetition that broke the
  // token sum would inflate a naive count the same way.
  const spawns = new Set()
  return {
    feed(ev) {
      if (!ev) return false
      if (ev.type === 'result') { usage = ev.usage || usage; return true }
      if (ev.type !== 'assistant') return false
      for (const c of ev.message?.content || []) {
        if (c?.type === 'tool_use' && c.name === 'Agent' && c.id) spawns.add(c.id)
      }
      return true
    },
    snapshot() {
      const u = usage || {}
      const input = u.input_tokens || 0
      const cacheRead = u.cache_read_input_tokens || 0
      const cacheWrite = u.cache_creation_input_tokens || 0
      const billedIn = input + cacheRead + cacheWrite
      return {
        input, output: u.output_tokens || 0, cache_read: cacheRead, cache_write: cacheWrite,
        // Share of input served from cache. Cached input is roughly a tenth the
        // price of fresh, so a falling ratio is a cost regression no dollar
        // total surfaces until the bill arrives.
        cache_hit: billedIn ? +(cacheRead / billedIn).toFixed(4) : 0,
        // The measured dominant cost driver: ~0.89 correlation with run cost at
        // roughly $0.86 each, against -0.19 for turns.
        subagents: spawns.size,
        // False when the run died before emitting a result, so a zero can be
        // read as "not measured" rather than "spent nothing".
        measured: Boolean(usage),
      }
    },
  }
}

// ────────────────────────────────────────────────── idle backoff
//
// Measured 2026-08-22 over all 143 recorded runs: 100 finished successfully,
// and 21 of those did nothing at all. They are the tail of the log, and they
// say so out loud — "this is the 23rd consecutive session confirming the MVP
// is complete". The backlog had been empty for days and the scheduler kept
// waking every 15 minutes, paying a cold start to load CLAUDE.md, git log and
// the tree, to rediscover that there was no work.
//
//   21 idle sessions · $8.38 · 87,632 output tokens spent saying "nothing to do"
//   avg $0.399 each, against $2.351 for a session that shipped something
//
// $8.38 is not the point. The point is that it does not converge: an empty
// backlog costs ~$38/day forever, and the harness had no way to notice. A
// fixed interval is the right cadence for a busy queue and the wrong one for
// an empty one, so the interval has to be a function of recent productivity.
//
// Doubling from the base interval, capped. The cap matters more than the
// curve: uncapped doubling would park a finished project for a week and miss
// the moment new work lands.

/**
 * How long to wait after `streak` consecutive sessions that produced no work.
 *
 * streak 0 → 0 (no cooldown; the normal interval applies)
 * streak 1 → base, 2 → 2x base, 3 → 4x base … capped at capSec.
 *
 * With base 15m and cap 6h, 21 idle sessions collapse to 8 wake-ups instead of
 * 21, and a project idle for a month costs 4 wake-ups a day rather than 96.
 */
export function idleBackoffSec({ streak, baseSec, capSec }) {
  if (!Number.isFinite(streak) || streak <= 0) return 0
  if (!Number.isFinite(baseSec) || baseSec <= 0) return 0
  const grown = baseSec * 2 ** (streak - 1)
  // 2**n overflows to Infinity long before it overflows a cap comparison, but
  // Math.min(Infinity, cap) is still cap, so this stays correct at any streak.
  return Math.min(grown, capSec)
}

/**
 * Did a run produce work, given the files its commits touched?
 *
 * The honest signal is the git tree, not the agent's own summary — "a summary
 * is not evidence" is already the rule after compaction and it applies here
 * too. But HEAD moving is not sufficient on its own: the build loop requires
 * every session to append and commit a journal line, so a session that did
 * nothing still lands one commit. Counting that as work would defeat the whole
 * backoff.
 *
 * So: work means at least one changed path that is not pure bookkeeping.
 * `bookkeeping` holds repo-relative path prefixes; it is configuration rather
 * than a constant because the journal's location is per-project.
 *
 * An empty `paths` (HEAD did not move) is not work.
 */
export function producedWork(paths, bookkeeping = []) {
  if (!Array.isArray(paths) || paths.length === 0) return false
  return paths.some(p => {
    const f = String(p).trim()
    if (!f) return false
    return !bookkeeping.some(b => f === b || f.startsWith(b.endsWith('/') ? b : b + '/'))
  })
}

// Marks a supervisor-generated inbox line. Without it these advisories are
// delivered to the agent as though Adi had typed them, which is the wrong
// default in a repo whose premise is that instructions must not silently drift.
export const SUPERVISOR_PREFIX = '!!supervisor '

/** True for a supervisor line that is stale once the session that earned it is gone. */
export function isStaleSupervisorLine(line) {
  return line.startsWith(SUPERVISOR_PREFIX) && /CONTEXT (WARNING|CEILING)/.test(line)
}
