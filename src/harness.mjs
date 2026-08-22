#!/usr/bin/env node
// An unattended build harness for Claude Code — scheduler, observer, and
// control plane in one. Points at a target git repository, wakes on a
// schedule, runs a build session, meters what it spends, and parks itself with
// a reason when it should stop.
//
//   harness <command>            (with HARNESS_REPO set, or run inside the repo)
//
//     tick            run one build session   (launchd calls this)
//     chat            TALK TO THE ORCHESTRATOR — opens the real Claude Code
//                     TUI on the very session the scheduler drives
//     hook            Claude Code hook target (settings.json calls this)
//     ui              live dashboard + message channel
//     say <message>   send a message to the running agent
//     sprint          run sessions back-to-back until a guard stops it
//     budget [reset]  stamp the spend baseline the cap counts from
//     status          one-screen summary
//     usage           live cost meter — window, credits, tokens, cache (--json)
//     pause | resume  skip ticks without unloading launchd
//     start | stop    load / unload the launchd job
//     install         (re)write the launchd plist from CONFIG
//
// This file is deliberately the ONLY place that knows where anything lives.
// The previous design had the same paths and thresholds restated in run.sh,
// check-usage.py and dashboard.mjs, so a change to the state layout silently
// desynced three languages. Everything below derives from CONFIG.
//
// TARGET REPOSITORY. The harness is a tool, not a part of the project it
// builds. It finds its target in this order:
//
//   1. $HARNESS_REPO                     — explicit, and what the tests use
//   2. the git root containing $PWD      — the ordinary interactive case
//   3. $PWD                              — last resort, so nothing throws
//
// PER-PROJECT CONFIGURATION lives in `<repo>/.harness.json`, which is read once
// at startup and layered over the defaults below. Every key in CONFIG can be
// set there. Anything project-shaped — the journal path, what counts as
// bookkeeping, the rules re-injected after a compaction — MUST come from that
// file rather than from this one, or the harness stops being reusable the first
// time someone hardcodes their own project into it.

import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import {
  isWindowLimit, resolveLimitResume, createCtxWatcher, overageSignal,
  usageSnapshot, shouldRecordUsage, createTokenMeter,
  SUPERVISOR_PREFIX, isStaleSupervisorLine,
  classifyRun, idleBackoffSec, producedWork,
} from './classify.mjs'
import { createBreaker, breakerMessage, BREAKER_DEFAULTS } from './breaker.mjs'
import { trimMemory, memoryBrief, MEMORY_TEMPLATE } from './memory.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function gitRootOf(dir) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'],
      { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim() || null
  } catch { return null }
}

const REPO = path.resolve(
  process.env.HARNESS_REPO || gitRootOf(process.cwd()) || process.cwd()
)

// Per-project overrides. Absent is normal and means "all defaults"; malformed
// is NOT ignored, because a config the operator believes is in force but which
// silently failed to parse is how an unattended run ends up using someone
// else's thresholds.
function loadProjectConfig(repo) {
  const f = path.join(repo, '.harness.json')
  let raw
  try { raw = fs.readFileSync(f, 'utf8') } catch { return {} }
  try { return JSON.parse(raw) } catch (e) {
    console.error(`harness: ${f} is not valid JSON — ${e.message}`)
    process.exit(1)
  }
}
const PROJECT = loadProjectConfig(REPO)

// A project value wins over the default; an env var wins over both, so a
// one-off `MAX_UNITS=2 harness tick` still works without editing the file.
const pick = (key, envVal, dflt) => envVal ?? PROJECT[key] ?? dflt

// ─────────────────────────────────────────────────────────── configuration
const CONFIG = {
  // launchd job label AND the identity of this harness instance on the machine.
  // Two projects running the harness must not share it or they fight over the
  // same launchd job. Derived from the repo directory name unless set.
  label: pick('label', process.env.HARNESS_LABEL,
    `com.harness.${path.basename(REPO).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`),
  // Human name for the project, used in the dashboard and the agent tree.
  project: pick('project', process.env.HARNESS_PROJECT, path.basename(REPO)),
  intervalSec: num(pick('intervalSec', process.env.HARNESS_INTERVAL, 900)),

  // Model is a knob, never a hardcode — the harness is model-agnostic and the
  // per-agent tiering lives in CLAUDE.md's org table and .claude/agents/*.md.
  model: pick('model', process.env.AGENT_MODEL, 'sonnet'),
  fallbackModel: pick('fallbackModel', process.env.AGENT_FALLBACK, 'haiku'),

  // Subscription account: the constraint is window headroom, not dollars.
  // Never START a session with less headroom than this — a cold start that
  // dies seconds in has still paid to load CLAUDE.md, git log and the tree.
  // Kept close to the old 90 on purpose: too low and the harness idles through
  // window capacity it could have spent, which costs more throughput than the
  // occasional truncated session costs waste. maxUnits is the real protection
  // against being cut off mid-edit.
  // Raised 85 -> 95 on 2026-08-02. The 85 was set defensively at a time when
  // being cut off by the window cost a WRONG 30-minute error backoff, so the
  // last 15% of every cycle was left unspent to avoid paying that. Hitting the
  // limit now costs only a resume scheduled at the window's own resets_at, and
  // the context ceiling plus maxUnits already prevent being cut off mid-edit.
  // That makes the reserve dead capacity: ~1 extra session per 5h cycle.
  usageFloorPct: num(pick('usageFloorPct', process.env.USAGE_FLOOR, 95)),
  sevenDayFloorPct: num(pick('sevenDayFloorPct', process.env.USAGE_FLOOR_7D, 95)),
  // A stale over-threshold cache can only be refreshed by making a real call,
  // so allow a probe to break the deadlock — but rarely.
  probeIntervalSec: num(pick('probeIntervalSec', process.env.USAGE_PROBE_INTERVAL, 1800)),
  // A cached utilisation reading younger than this is treated as current, so a
  // reading whose resets_at has already passed proves the window rolled over
  // rather than proving the cache is stale. See checkUsage().
  // freshCacheSec / USAGE_FRESH_CACHE removed 2026-08-03. It gated "trust an
  // expired resets_at only while the reading is fresh", which was the inverted
  // test that deadlocked the build — see the resumeAt <= now branch in
  // checkUsage(). Nothing reads it now, so keeping it would only imply a knob
  // that does nothing.

  // Units of work one session may commit before stopping cleanly.
  //
  // This was 2, on the theory that a small unit count keeps context small. It
  // does not: units measure commits, not tokens, and a "2 unit" session was
  // measured at 186 turns and 120k of PM context. The brake was firing while
  // the usage window still had headroom, which is the opposite of what we
  // want. Context is now the real stop condition (see maxCtx* below), so the
  // unit cap is loosened to a backstop rather than the primary limit.
  maxUnits: num(pick('maxUnits', process.env.MAX_UNITS, 8)),

  // Hard spend ceiling for the harness, in dollars, measured FROM A BASELINE
  // rather than from the start of time — `harness budget <n>` stamps the
  // current total and allows n dollars beyond it. Absolute caps are ambiguous
  // here because historical spend may or may not have come out of the credit
  // balance being protected; a delta is unambiguous either way.
  //
  // Nothing else in the system can stop an unattended run against a finite
  // balance: the usage floor guards a rolling window that refills, not a
  // balance that does not. Reaching the cap refuses to START a session; it
  // cannot interrupt one in flight, so leave headroom for that.
  budgetCapUsd: num(pick('budgetCapUsd', process.env.BUDGET_CAP, 110)),

  // ── PAID-CREDIT POLICY ───────────────────────────────────────────────────
  // On a Pro plan the 5-hour session allowance is INCLUDED: work inside it is
  // free at the margin. Usage credits exist only to "keep using Claude if you
  // hit a plan limit", so every dollar of credit is spent on work that could
  // instead have been done for nothing by waiting for the window to reset.
  //
  // The default is therefore to refuse to run on credits: stop, and let the
  // scheduler resume at the reset. Set ALLOW_OVERAGE=1 to buy speed with money
  // when a deadline is worth more than the credits.
  allowOverage: (process.env.ALLOW_OVERAGE ?? String(PROJECT.allowOverage ?? '')) === '1'
    || PROJECT.allowOverage === true,
  // Ceiling on estimated paid-credit spend, in USD-equivalent, measured from
  // our own run records rather than the account's used_credits field — that
  // field read 0 while the billing UI showed A$31.14, so it cannot be trusted
  // to stop anything. Roughly AUD = USD x 1.5.
  creditCapUsd: num(pick('creditCapUsd', process.env.CREDIT_CAP_USD, 50)),
  errorBackoffSec: num(pick('errorBackoffSec', process.env.ERROR_BACKOFF, 1800)),

  // A dropped connection is not a broken account. See isTransientFailure() in
  // classify.mjs for the measurement: 5 of 143 recorded runs died to
  // "Connection closed mid-response" and each bought the full 30-minute error
  // backoff, ~2.5 hours of dead scheduler time for a fault a retry clears.
  // One interval is deliberately the floor — retrying instantly against a
  // flapping connection is how a backoff becomes a hot loop.
  transientBackoffSec: num(pick('transientBackoffSec', process.env.TRANSIENT_BACKOFF, 120)),

  // Ceiling on the idle backoff. See idleBackoffSec() in classify.mjs: the
  // scheduler spent $8.38 and 87k output tokens across 21 consecutive sessions
  // whose entire content was "the MVP is complete, there is nothing to do".
  // A fixed interval is right for a busy queue and wrong for an empty one, so
  // the wait doubles per idle session up to this cap. The cap is what stops a
  // finished project from being parked for a week and missing new work.
  idleBackoffCapSec: num(pick('idleBackoffCapSec', process.env.IDLE_BACKOFF_CAP, 21600)),

  // Repo-relative paths whose modification does NOT count as work. The build
  // loop requires every session to commit a journal line, so without this list
  // an idle session still moves HEAD and the backoff never engages.
  bookkeepingPaths: (() => {
    const v = process.env.BOOKKEEPING_PATHS ?? PROJECT.bookkeepingPaths
      ?? (PROJECT.journalPath || 'logs/build-scheduler.jsonl')
    if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean)
    return String(v ?? '').split(',').map(x => x.trim()).filter(Boolean)
  })(),

  // Repo-relative path of the agent's own unit-of-work journal. The harness
  // never writes it — the agent does — but `status` surfaces its last line and
  // the default bookkeeping list points at it.
  journalPath: pick('journalPath', process.env.HARNESS_JOURNAL, 'logs/build-scheduler.jsonl'),
  // Repo-relative halt signal. Present = the agent stops unconditionally.
  blockedPath: pick('blockedPath', process.env.HARNESS_BLOCKED, 'logs/build-scheduler-blocked.md'),
  // The build brief handed to each session. Repo-relative, or absolute.
  promptPath: pick('promptPath', process.env.HARNESS_PROMPT, '.harness-prompt.md'),

  // ── ONE ORCHESTRATOR, NOT ONE AGENT PER TICK ────────────────────────────
  //
  // Originally every tick spawned a fresh `claude -p`, did a unit, and let it
  // exit. Two things were wrong with that, and they turned out to be the same
  // thing:
  //
  //   1. Every tick paid a cold start — re-read the project file, the log, the
  //      tree — before doing any work. That is most of what an idle session
  //      costs and a large slice of a working one.
  //   2. There was no session to ADDRESS. `say` could nudge a running one
  //      through the hook, but it could not reply and between ticks nothing was
  //      running at all. So steering the build meant opening a SECOND
  //      interactive session to read the logs and relay on your behalf. That
  //      middle man was the only component in the system with no reason to be.
  //
  // Now one session persists and every tick resumes it. A headless session
  // writes an ordinary transcript to ~/.claude/projects, which means
  // `harness chat` can open the REAL Claude Code TUI on the very conversation
  // the scheduler is driving. No custom REPL, no relay, no second session.
  //
  // Set false to restore the old spawn-per-tick behaviour.
  persistentSession: PROJECT.persistentSession !== false && process.env.PERSISTENT_SESSION !== '0',

  // Context at which the orchestrator session is retired and a fresh one
  // seeded from the journal. Persistence must not be allowed to defeat the
  // context discipline the rest of this file is built around — see
  // maxCtxHandoffTokens. The CONVERSATION is a stable address; the SESSION
  // behind it rotates, and `harness chat` never has to know which one is live.
  rotateCtxTokens: num(pick('rotateCtxTokens', process.env.ROTATE_CTX, 120_000)),

  // ── RUNAWAY GUARDRAIL ────────────────────────────────────────────────────
  // Every other gate here is pre-flight or post-mortem. Between them a running
  // session was unsupervised: it could spin on one tool call, or burn output at
  // several times its normal rate, for a whole context window, and the first
  // the harness knew of it was the bill. See breaker.mjs — the policy is ported
  // from Munder Difflin (MIT), the wiring is ours.
  breaker: { ...BREAKER_DEFAULTS, ...(PROJECT.breaker || {}) },
  // How often the breaker evaluates a running session.
  breakerBeatSec: num(pick('breakerBeatSec', process.env.BREAKER_BEAT, 20)),

  // Durable memory, carried across session rotations. See memory.mjs — without
  // it a rotation loses everything the retired session knew except one journal
  // line. Repo-relative; the archive sits beside it.
  memoryPath: pick('memoryPath', process.env.HARNESS_MEMORY, '.harness-memory.md'),
  memoryKeepNotes: num(pick('memoryKeepNotes', process.env.MEMORY_KEEP, 20)),
  memoryMaxBytes: num(pick('memoryMaxBytes', process.env.MEMORY_MAX_BYTES, 24_000)),

  // Rules re-injected verbatim after a context compaction, on top of the
  // generic ones below. These are the project's OWN non-negotiables — the
  // things that are both forbidden and invisible in a diff. Keep the list
  // short: everything here is paid for on every compaction.
  compactRules: Array.isArray(PROJECT.compactRules) ? PROJECT.compactRules : [],

  // PM context ceiling, in tokens of the MAIN thread only (subagent context
  // never lands here — that is the whole point of delegating).
  //
  // Why capping context lengthens a session rather than shortening it:
  // measured across 12 real sessions, a PM under 80k averaged $0.0400/turn and
  // a PM at or above 80k averaged $0.0607/turn — 1.5x. On a subscription the
  // binding constraint is the 5h window, so a fat context burns the window
  // faster and gets the session cut off EARLIER. The two most expensive
  // sessions on record ($8.80 at 111k, $9.98 at 120k) were both followed
  // immediately by "You've hit your session limit".
  //
  // warn: stop reading files, delegate instead. handoff: finish the current
  // unit, write the journal line, stop cleanly.
  // Both stay well clear of Claude Code's auto-compact line (~167k on a 200k
  // window), because a compacted session is a session that has silently
  // dropped CLAUDE.md's non-negotiables — see decisions/ and the governance
  // -decay finding. We stop instead of compacting, on purpose.
  // Tightened 90k/120k -> 70k/90k on 2026-08-02 for the credit-capped run.
  // Measured: a 95k session ran at $0.086/turn, a 116k session at $1.78/turn.
  // The ceiling is the cheapest lever on cost per unit of work there is.
  maxCtxWarnTokens: num(pick('maxCtxWarnTokens', process.env.MAX_CTX_WARN, 70_000)),
  maxCtxHandoffTokens: num(pick('maxCtxHandoffTokens', process.env.MAX_CTX_HANDOFF, 90_000)),

  uiPort: num(pick('uiPort', process.env.PORT, 4317)),

  // launchd gives its agents a minimal PATH; none of node/npm/claude/git
  // resolve without this. One list, used wherever a child is spawned.
  extraPath: [
    path.dirname(process.execPath),
    path.join(os.homedir(), '.local/bin'),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  ],
}

// Every path in the system, derived once.
const STATE = path.join(REPO, '.harness')
const P = {
  state: STATE,
  runs: path.join(STATE, 'runs'),        // stream-json transcript per tick
  events: path.join(STATE, 'events'),    // hook events, keyed by session id
  inbox: path.join(STATE, 'inbox.md'),
  cooldown: path.join(STATE, 'cooldown_until'),
  lock: path.join(STATE, 'run.lock'),
  paused: path.join(STATE, 'paused'),
  stopped: path.join(STATE, 'stopped'),
  probe: path.join(STATE, 'last_probe'),
  budgetBaseline: path.join(STATE, 'budget_baseline'),
  // Consecutive sessions that committed nothing but bookkeeping. Reset to 0 by
  // the first session that ships anything. Drives the idle backoff.
  idleStreak: path.join(STATE, 'idle_streak'),
  // The durable orchestrator conversation. Survives ticks, survives the harness
  // process dying, and is what `harness chat` attaches to.
  orchestrator: path.join(STATE, 'orchestrator_session'),
  // Held while a human is attached via `harness chat`. Two processes writing one
  // session transcript would corrupt it, so the tick refuses to run behind it.
  attached: path.join(STATE, 'attached'),
  // Touched by the PreCompact hook so the RUNNING tick — a different process —
  // can grant the breaker its compaction exemption. Compaction burns a burst of
  // output while touching nothing, which is the exact shape of a velocity false
  // positive, and it is the one Munder Difflin actually hit in production.
  compacting: path.join(STATE, 'compacting'),
  // Session id of the tick currently in flight. The inbox is repo-global and
  // ANY Claude Code session in this tree runs the same PreToolUse hook, so
  // without this an interactive session sitting in the repo drains messages
  // meant for the unattended build. That happened: a scope-change message was
  // consumed by the wrong session and never reached the harness.
  currentSession: path.join(STATE, 'current_session'),
  cost: path.join(STATE, 'cost.jsonl'),
  // Live usage observations off the stream. The account's real position is
  // knowable only while a call is in flight; ~/.claude.json is a cache with no
  // refresh guarantee (measured 87 minutes stale, still quoting a monthly limit
  // that had been raised hours earlier). Persisting what the stream already
  // told us is the difference between metering and guessing.
  usage: path.join(STATE, 'usage.jsonl'),
  runLog: path.join(STATE, 'run.log'),
  stderr: path.join(STATE, 'stderr.log'),
  launchdOut: path.join(STATE, 'launchd.out.log'),
  launchdErr: path.join(STATE, 'launchd.err.log'),
  // The agent's own unit-of-work journal. Product memory, not harness state:
  // it predates this rewrite, carries real history, and prompt.md reads it.
  journal: path.resolve(REPO, CONFIG.journalPath),
  // The agent's halt signal. It stops the build unconditionally at step 1 of
  // the loop, so it must be visible in `status` — it once sat unnoticed for six
  // sessions, each of which started, re-read it, re-diagnosed it and halted.
  blocked: path.resolve(REPO, CONFIG.blockedPath),
  // The build brief. Lives in the TARGET repo, not next to the harness — it is
  // the one input that is entirely the project's own.
  prompt: path.resolve(REPO, CONFIG.promptPath),
  // Durable memory lives in the REPO, not in .harness/ — it is the project's
  // knowledge, it is worth committing, and it must survive `rm -rf .harness`.
  memory: path.resolve(REPO, CONFIG.memoryPath),
  memoryArchive: path.resolve(REPO, CONFIG.memoryPath.replace(/\.md$/, '') + '.archive.md'),
  ui: path.join(HERE, 'ui.html'),
  plist: path.join(os.homedir(), 'Library/LaunchAgents', `${CONFIG.label}.plist`),
  claudeConfig: path.join(os.homedir(), '.claude.json'),
}

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d }
const nowSec = () => Math.floor(Date.now() / 1000)
const exists = p => { try { fs.accessSync(p); return true } catch { return false } }
const readInt = p => { try { return parseInt(fs.readFileSync(p, 'utf8').trim(), 10) || 0 } catch { return 0 } }

// HEAD at a moment in time, or null when git cannot answer (not a repo, no
// commits yet). Null is handled everywhere as "cannot tell", never as "no
// change" — guessing "no change" would let the idle backoff engage on a repo
// it simply failed to read.
function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8', stdio: 'pipe' }).trim() || null
  } catch { return null }
}

// Paths touched between two commits. Empty array = nothing moved; null = could
// not tell.
function gitChangedPaths(from, to) {
  if (!from || !to) return null
  if (from === to) return []
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${from}..${to}`],
      { cwd: REPO, encoding: 'utf8', stdio: 'pipe' })
    return out.split('\n').map(x => x.trim()).filter(Boolean)
  } catch { return null }
}

// ── the orchestrator conversation ─────────────────────────────────────────
//
// A session id is only usable if its transcript still exists — Claude Code
// stores one .jsonl per session under a directory named for the cwd. Resuming
// an id whose transcript has been deleted fails the whole tick, so an id that
// cannot be proven live is discarded and a new session started instead.
function transcriptPath(sid) {
  const dir = REPO.replace(/[/.]/g, '-')
  return path.join(os.homedir(), '.claude', 'projects', dir, `${sid}.jsonl`)
}

function readOrchestrator() {
  let sid
  try { sid = fs.readFileSync(P.orchestrator, 'utf8').trim() } catch { return null }
  if (!/^[0-9a-f-]{36}$/i.test(sid)) return null
  // Not finding the transcript is normal after a `claude` data reset, and must
  // degrade to "start a fresh session", never to a failed tick.
  return exists(transcriptPath(sid)) ? sid : null
}
const writeOrchestrator = sid => { ensureDirs(); fs.writeFileSync(P.orchestrator, sid) }

// A human is at the keyboard in `harness chat`. The marker carries the PID so a
// crashed chat cannot wedge the scheduler forever.
function attachedPid() {
  const pid = readInt(P.attached)
  if (!pid) return 0
  try { process.kill(pid, 0); return pid } catch { fs.rmSync(P.attached, { force: true }); return 0 }
}

// Seeded on first use so the agent has the shape to write into rather than
// inventing one, which is how a "memory file" becomes an unbounded log.
function readMemory() {
  try { return fs.readFileSync(P.memory, 'utf8') } catch { return '' }
}
function ensureMemory() {
  if (!exists(P.memory)) {
    try { fs.writeFileSync(P.memory, MEMORY_TEMPLATE) } catch { /* read-only tree */ }
  }
}
/** Hold memory to its bound, moving evictions to the archive. Lossless. */
function boundMemory() {
  const before = readMemory()
  if (!before) return 0
  const { text, archived } = trimMemory(before, {
    keepNotes: CONFIG.memoryKeepNotes, maxBytes: CONFIG.memoryMaxBytes,
  })
  if (!archived.length) return 0
  try {
    fs.appendFileSync(P.memoryArchive, archived.join('\n\n') + '\n\n')
    fs.writeFileSync(P.memory, text)
  } catch { return 0 }
  return archived.length
}

const readIdleStreak = () => readInt(P.idleStreak)
function writeIdleStreak(n) {
  ensureDirs()
  if (n > 0) fs.writeFileSync(P.idleStreak, String(n))
  else fs.rmSync(P.idleStreak, { force: true })
}

// The cooldown carries WHY it was set, not just until when. That distinction is
// what lets a scheduled post-reset resume fire on time: see checkUsage().
function readCooldown() {
  try {
    const raw = fs.readFileSync(P.cooldown, 'utf8').trim()
    if (raw.startsWith('{')) return JSON.parse(raw)
    return { until: parseInt(raw, 10) || 0, reason: 'legacy' }
  } catch { return { until: 0, reason: null } }
}
function writeCooldown(until, reason) {
  ensureDirs()
  fs.writeFileSync(P.cooldown, JSON.stringify({ until, reason }))
}
// Reasons whose wake-up time was derived from the API's own resets_at, and so
// can be trusted over a local cache known to lag. 'rate_limit' is the pre-
// rename spelling, kept so a cooldown written by an older build still resumes.
const AUTHORITATIVE_REASONS = new Set(['window_reset', 'rate_limit'])
const isAuthoritativeReason = r => AUTHORITATIVE_REASONS.has(r)
function ensureDirs() { for (const d of [P.state, P.runs, P.events, path.dirname(P.journal)]) fs.mkdirSync(d, { recursive: true }) }
function logLine(msg) {
  ensureDirs()
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19)
  fs.appendFileSync(P.runLog, `${ts} ${msg}\n`)
}
function childEnv() {
  return { ...process.env, PATH: [...CONFIG.extraPath, process.env.PATH || ''].join(':') }
}

// ───────────────────────────────────────────────────── observed live usage
// Which subscription window a stream event's rateLimitType refers to. Anything
// unrecognised is ignored rather than guessed at — a wrong mapping here would
// silently overlay the weekly figure onto the 5-hour gate.
const WINDOW_OF_KIND = { session: 'five', five_hour: 'five', weekly: 'seven', weekly_all: 'seven', seven_day: 'seven' }

// New limit kinds appear server-side without notice (weekly_opus, weekly_sonnet
// and friends already exist in the cached payload). An unrecognised kind is not
// mapped onto a window — guessing which one it gates is how a weekly wall gets
// treated as a session allowance — but it is not silently discarded either:
// `checkUsage` reports it, and `canBuyThrough` refuses to spend against a limit
// it cannot classify. Dropping it outright let a spent weekly limit read as
// `7d 0%` and cleared a buy-through straight into a refusal.
function classifyKind(kind) {
  if (WINDOW_OF_KIND[kind]) return WINDOW_OF_KIND[kind]
  if (typeof kind !== 'string') return null
  if (/^(weekly|seven)/.test(kind)) return 'seven'
  if (/^(session|five)/.test(kind)) return 'five'
  return null
}

// How long an observation carrying no reset time may be trusted.
//
// Without a reset time nothing can retire the reading, and a verdict that
// cannot be retired is permanent: the harness parks, no session runs, no newer
// observation is ever written, and the same figure is re-read at every wake-up.
// Ageing out is the escape hatch. Set beyond the longest window it describes so
// it never pre-empts a real reset time.
const OBSERVATION_TTL_SEC = 6 * 3600

/**
 * Freshest live reading per window, from usage.jsonl.
 *
 * An observation is dropped once its own window has reset: utilisation of a
 * window that no longer exists is not a smaller number, it is a wrong one, and
 * overlaying it would hold the harness off a window that had already refilled.
 */
function observedUsage(now = nowSec()) {
  let lines = []
  try { lines = fs.readFileSync(P.usage, 'utf8').trim().split('\n').filter(Boolean) } catch { return {} }
  const out = { unknownLimit: false }
  for (const ln of lines.slice(-400)) {
    let s; try { s = JSON.parse(ln) } catch { continue }
    if (typeof s.util !== 'number') continue
    // Falsy resets_at means UNKNOWN expiry, not "never expires". Treating 0 as
    // eternal is what turned one reading into a permanent 100% verdict, and
    // `overageSignal` writes `resetsAt: info.resetsAt || 0`, so a 0 is a
    // reachable input rather than a hypothetical.
    if (s.resets_at ? s.resets_at <= now : now - s.at > OBSERVATION_TTL_SEC) continue
    const w = classifyKind(s.kind)
    if (!w) { if (s.util >= CONFIG.usageFloorPct / 100) out.unknownLimit = true; continue }
    if (!out[w] || s.at > out[w].at) out[w] = s
  }
  return out
}

/**
 * Is a cooldown currently holding work back?
 *
 * The single answer for every gate. There are three — cmdTick, the sprint loop
 * and the `status` next-tick line — and when the buy-through was added to only
 * one of them, the sprint loop went on breaking after zero passes with credits
 * authorised and unused. The comment above `status` already records the same
 * lesson from an earlier divergence; three copies of a rule is the defect, not
 * the symptom.
 *
 * A `window_reset` cooldown is not a backoff. It is waiting for the free
 * allowance to refill, which is exactly what paid credits are bought to skip.
 * Every other reason is a real backoff and always holds:
 *   error           — something is wrong; spending money faster will not fix it
 *   probe_throttle  — deliberate rate limit on our own probing
 *   transient       — the connection dropped; wait a beat, do not buy anything
 *   breaker         — WE killed it. Something was wrong with the session
 *                     itself, and paying to restart it sooner buys a repeat
 *   idle            — there is NO WORK. Buying through would purchase the
 *                     privilege of rediscovering that sooner, which is exactly
 *                     the $8.38 the backoff exists to stop spending.
 */
function cooldownHolds(cd = readCooldown(), now = nowSec()) {
  if (now >= cd.until) return false
  if (cd.reason !== 'window_reset') return true
  return !canBuyThrough(checkUsage())
}

// Keep usage.jsonl bounded. observedUsage only ever reads the last 400 lines,
// so anything past OBSERVATION_KEEP is storage nobody reads on a path that runs
// at 2 Hz whenever the dashboard is open.
const OBSERVATION_KEEP = 800
function trimUsageLog() {
  try {
    const lines = fs.readFileSync(P.usage, 'utf8').split('\n').filter(Boolean)
    if (lines.length <= OBSERVATION_KEEP * 2) return
    fs.writeFileSync(P.usage, lines.slice(-OBSERVATION_KEEP).join('\n') + '\n')
  } catch { /* trimming is housekeeping, never a reason to fail a run */ }
}

/**
 * May a spent 5-hour window be bought through with paid credits?
 *
 * Shared by cmdTick and the `status` next-tick line for the reason already
 * learned the hard way in this file: when those two disagree, `status` reports
 * a skip that the real tick does not take, and the disagreement is invisible
 * until someone reads the run log.
 */
function canBuyThrough(usage, paidSoFar) {
  return Boolean(!usage.ok && usage.over?.five && !usage.over?.seven
    // A spent limit whose window could not be identified might be a weekly
    // wall. Spending against it buys a refusal, so this fails closed.
    && !usage.unknownLimit
    && CONFIG.allowOverage && usage.overageAllowed
    && (paidSoFar ?? paidCreditSpendUsd()) < CONFIG.creditCapUsd)
}

// ───────────────────────────────────────────────────────── usage headroom
// Reads Claude Code's own cached subscription utilisation, overlaid with any
// live reading that is newer. Returns { ok, fivePct, sevenPct, resumeAt, reason }.
function checkUsage(opts = {}) {
  const now = opts.now ?? nowSec()
  let util, fetchedAtMs = 0
  try {
    const cached = JSON.parse(fs.readFileSync(P.claudeConfig, 'utf8'))?.cachedUsageUtilization
    util = cached?.utilization
    fetchedAtMs = cached?.fetchedAtMs || 0
  } catch { /* fresh install */ }

  const seen = observedUsage(now)
  // A live reading is a complete substitute for a missing cache, not merely a
  // refinement of a present one — on a fresh install the old code returned
  // "no cached usage, ok" and would have run straight into a spent window.
  if (!util && !seen.five && !seen.seven) {
    return { ok: true, fivePct: 0, sevenPct: 0, readingAt: 0, source: 'none', reason: 'no cached usage' }
  }
  util = util || {}
  const cacheAtSec = fetchedAtMs ? Math.floor(fetchedAtMs / 1000) : 0

  /**
   * One window's reading, from whichever source is newer — taken WHOLE.
   *
   * Mixing sources is what made the first version dangerous: it took
   * utilisation from a live reading while leaving the cache's already-expired
   * `resets_at` in place. That composite described a moment that never
   * existed — 100% used, reset time in the past — which the staleness branch
   * below read as "the window rolled over" and cleared a doomed session on
   * every tick, back-to-back under `sprint`. A reading's utilisation and its
   * reset time are one fact, not two.
   *
   * Provenance is per window for the same reason. A single global fetch stamp
   * let a fresh 7-day reading certify a two-hour-old 5-hour figure as
   * seconds-old.
   */
  const pick = (cacheSlot, obs) => {
    if (obs && obs.at > cacheAtSec) {
      return { pct: Math.round(obs.util * 100), resetsAt: obs.resets_at || 0, at: obs.at, live: true }
    }
    const s = cacheSlot || {}
    return {
      pct: s.utilization ?? 0,
      resetsAt: s.resets_at ? Math.floor(Date.parse(s.resets_at) / 1000) : 0,
      at: cacheAtSec, live: false, absent: s.utilization == null,
    }
  }
  const five = pick(util.five_hour, seen.five)
  const seven = pick(util.seven_day, seen.seven)
  const fivePct = five.pct
  const sevenPct = seven.pct

  const overFive = fivePct >= CONFIG.usageFloorPct
  const overSeven = sevenPct >= CONFIG.sevenDayFloorPct
  const tripped = [overFive ? five : null, overSeven ? seven : null].filter(Boolean)

  // Freshness describes the windows that actually decided the outcome, and
  // takes the OLDEST of them: a reading is only as current as its stalest
  // component. Same for the source label — "from the live stream" has to be
  // true of everything the line is summarising.
  const reported = (tripped.length ? tripped : [five, seven]).filter(w => w.at > 0 && !w.absent)
  const freshest = [seen.five, seen.seven].filter(Boolean).sort((a, b) => b.at - a.at)[0]
  const meta = {
    readingAt: reported.length ? Math.min(...reported.map(w => w.at)) : 0,
    source: !reported.length ? 'none' : reported.every(w => w.live) ? 'stream' : 'cache',
    // Whether the ACCOUNT will serve work past the included allowance. Distinct
    // from whether we are willing to pay for it (CONFIG.allowOverage).
    overageAllowed: freshest?.overage_allowed === true,
    // A limit whose window we could not identify. Not fatal on its own, but
    // never something to spend money against.
    unknownLimit: seen.unknownLimit === true,
    fiveResetsAt: five.resetsAt,
    sevenResetsAt: seven.resetsAt,
  }

  if (!tripped.length) return { ok: true, fivePct, sevenPct, ...meta }

  // Consuming a probe is opt-IN, and only cmdTick opts in. Defaulting the
  // other way meant every read path burned the token: `harness ui` polls
  // twice a second, so leaving the dashboard open rewrote last_probe
  // continuously and the scheduler's `now - last >= probeIntervalSec` gate
  // could never become true — the harness would silently stop building for
  // as long as the dashboard was open. Same shape as the exit-2 hook that
  // wedged a session: an observer with a side effect on the thing observed.
  const markProbe = () => { if (opts.consumeProbe) { ensureDirs(); fs.writeFileSync(P.probe, String(now)) } }

  const resets = tripped.map(w => w.resetsAt).filter(Boolean)

  // Over the floor, and nothing says when it clears.
  //
  // The old code invented `now + 1800` here and returned it as authoritative.
  // That is a verdict that renews itself: the harness parks, so no session
  // runs, so no newer reading is ever written, so thirty minutes later the
  // same figure re-parks it. Permanent, and silent. The only thing that can
  // end the state is a call that produces a fresh reading, so probe on the
  // throttle rather than park on a guess.
  if (!resets.length) {
    const last = readInt(P.probe)
    if (now - last >= CONFIG.probeIntervalSec) {
      markProbe()
      return { ok: true, fivePct, sevenPct, ...meta, reason: 'over floor with no known reset time — probing' }
    }
    return {
      ok: false, fivePct, sevenPct, ...meta, authoritative: false,
      over: { five: overFive, seven: overSeven },
      resumeAt: last + CONFIG.probeIntervalSec,
      reason: 'over floor, no reset time known, probe throttled',
    }
  }

  let resumeAt = Math.max(...resets)

  if (resumeAt <= now) {
    // Cache is stale — its own reset time has passed but nothing has refreshed
    // it, because only a real call does and that is exactly what we are
    // withholding.
    //
    // Two cases hide here, and collapsing them is how the old harness fired a
    // doomed session every 15 minutes at 100% utilisation:
    //
    //  * We were sitting out a cooldown that WE scheduled from the API's own
    //    resets_at. That time passing is authoritative evidence the window
    //    rolled over, so resume immediately — this is the "start again the
    //    moment the subscription limit resets" behaviour, and it must not be
    //    re-gated by the very cache that is known to lag.
    //  * Otherwise the stale reading is unexplained. Probe rarely.

    // An expired reset is trusted at ANY reading age. `npm run harness:stress`
    // is the acceptance test for this and fails without it.
    //
    // The previous rule trusted an expired `resets_at` only while the reading
    // was FRESH (age <= freshCacheSec), and that test was inverted. A reading is
    // taken WHOLE, so its `resets_at` belongs to its own utilisation; if that
    // time has passed, that window rolled over AT it. Age does not weaken the
    // conclusion — it strengthens it. Utilisation can only be refilled by
    // sessions actually running, and any session that ran would have left a
    // newer reading behind (its own metering, or the CLI refreshing
    // `cachedUsageUtilization`), which the take-newest-whole rule above would
    // already have used to produce a `resumeAt` in the FUTURE. So reaching here
    // means the best evidence available says the window has rolled over.
    //
    // What the old rule caused: cmdTick calls checkUsage with consumeProbe and,
    // as the only caller permitted to spend the probe, writes `last_probe = now`
    // to authorise a launch. The session that launch creates then runs
    // `harness.mjs usage`, reads the same stamp, finds the 30-minute throttle
    // freshly spent, and refused with "stale cache, probe throttled". The act of
    // authorising the session guaranteed the session's own gate would refuse it,
    // and nothing could clear it because only a real session refreshes the
    // reading. Six ticks on 2026-08-03 started, refused and stopped — about
    // $0.36 each — while the 5-hour window sat at 24%. Same self-renewing-verdict
    // shape as the two livelocks described above.
    //
    // A grace period on the probe was tried and rejected: it survives the launch
    // but expires ~25 minutes in, when the session re-checks at step 9, so it
    // truncates sessions instead of never starting them. That case is the second
    // row of the stress test.
    //
    // The probe and trustExpiredCooldown paths that used to sit here are gone
    // rather than left unreachable: every one of them returned ok:true for this
    // same condition, only more slowly and less predictably.
    markProbe()
    return {
      ok: true, fivePct, sevenPct, ...meta,
      reason: `reset passed ${now - resumeAt}s ago — window rolled over`,
    }
  }
  // resumeAt came from the window's own resets_at.
  // Which window tripped, so the caller can tell "the free 5 hours are gone"
  // — a wait that money can remove — from "the weekly plan limit is gone",
  // which it cannot.
  return {
    ok: false, fivePct, sevenPct, ...meta, authoritative: true, resumeAt,
    over: { five: overFive, seven: overSeven },
    reason: 'window headroom below floor',
  }
}

// ───────────────────────────────────────────────────────────────── tick
async function cmdTick() {
  ensureDirs()
  if (exists(P.stopped)) { logLine('stop marker present — unloading launchd'); cmdStop(); return }
  if (exists(P.paused)) { logLine('paused — skipping'); return }
  // Never run a tick into a session a human is typing into. Both processes
  // would append to the same transcript and the conversation would interleave
  // into nonsense. The human wins; the scheduler comes back next interval.
  const who = attachedPid()
  if (who) { logLine(`attached in \`harness chat\` (pid ${who}) — skipping`); return }

  // A lock held by THIS process is not a concurrent tick — it is our own from a
  // previous pass. Only an exit handler used to clear it, which is correct for
  // the one-shot launchd path but self-deadlocks the moment cmdTick is called
  // in a loop: pass 2 reads our own live PID and skips forever. Sprint mode hit
  // exactly that and ended after one real session.
  const oldPid = readInt(P.lock)
  if (oldPid && oldPid !== process.pid) {
    try { process.kill(oldPid, 0); logLine(`tick ${oldPid} still running — skipping`); return } catch { /* stale */ }
  }
  fs.writeFileSync(P.lock, String(process.pid))
  // Deliberately NOT released between passes: holding it for the whole sprint
  // is what stops launchd starting a concurrent session alongside the loop.
  const release = () => { try { fs.rmSync(P.lock, { force: true }) } catch {} }
  process.on('exit', release)

  const cd = readCooldown()
  if (nowSec() < cd.until) {
    // A `window_reset` cooldown is not a backoff — it is "waiting for the free
    // allowance to refill", which is precisely the wait paid credits are bought
    // to remove. Checking it before the buy-through decision meant the feature
    // worked at most once per window: the first spent session wrote a fresh
    // window_reset cooldown on its way out, and the next tick parked on it
    // without ever reaching the decision. Error and probe-throttle cooldowns
    // are real backoffs and still apply unconditionally.
    if (cooldownHolds(cd)) {
      logLine(`in cooldown until ${new Date(cd.until * 1000).toLocaleTimeString()} — skipping`); return
    }
    logLine(`cooldown until ${new Date(cd.until * 1000).toLocaleTimeString()} is a wait for the free `
      + `window — buying through on paid credits instead`)
    fs.rmSync(P.cooldown, { force: true })
  }

  // A cooldown whose wake-up time came from the window's own resets_at has now
  // elapsed: that IS the scheduled wake-up, and it outranks a stale local
  // cache. It does not matter whether we learned the reset time pre-flight or
  // by being rate-limited mid-session — only that the time was authoritative.
  const usage = checkUsage({
    // INERT since 2026-08-03: checkUsage no longer reads this. An expired reset
    // is now trusted unconditionally, which is a superset of what this bought.
    // Left in place because unpicking it also orphans isAuthoritativeReason and
    // AUTHORITATIVE_REASONS, and that cleanup does not belong in a livelock fix.
    trustExpiredCooldown: cd.until > 0 && isAuthoritativeReason(cd.reason),
    consumeProbe: true, // the only caller permitted to
  })
  // A spent 5-hour window is the exact condition paid credits exist to cover,
  // and buying through it is the whole reason ALLOW_OVERAGE was turned on: it
  // removes the wait between sessions. Parking here would spend the money and
  // then take the wait anyway.
  //
  // This gate could never fire before live metering, because the cache never
  // reported above the floor — the first true reading showed the window
  // REJECTED at 100% while the cache still said 72%, with a 2.3-hour park
  // waiting on the other side of it. Making a number accurate can arm a rule
  // that was previously dead code, and this one would have undone the purchase.
  //
  // The weekly window is deliberately NOT bypassable. Credits buy through the
  // rolling session allowance; a weekly plan limit is a wall, and pretending
  // otherwise would just burn ticks against a refusal.
  const paidSoFar = paidCreditSpendUsd()
  if (!usage.ok && canBuyThrough(usage, paidSoFar)) {
    logLine(`5h window spent (${usage.fivePct}%) — buying through on paid credits `
      + `(est $${paidSoFar.toFixed(2)} of $${CONFIG.creditCapUsd}), reset ${new Date(usage.resumeAt * 1000).toLocaleTimeString()}`)
  } else if (!usage.ok) {
    writeCooldown(usage.resumeAt, usage.authoritative ? 'window_reset' : 'probe_throttle')
    logLine(`${usage.reason} (5h ${usage.fivePct}%) — until ${new Date(usage.resumeAt * 1000).toLocaleTimeString()}`)
    return
  }
  logLine(`usage OK (5h ${usage.fivePct}%, 7d ${usage.sevenPct}%) floor ${CONFIG.usageFloorPct}%`)

  // yyyymmddhhmmss — 14 chars. slice(0,15) kept the fractional-seconds dot and
  // produced "…143051..jsonl".
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const runLogPath = path.join(P.runs, `${stamp}.jsonl`)
  // Resume the orchestrator if there is one, otherwise open a new conversation.
  // `--resume` reuses the id, so `sessionId` is right either way.
  const resuming = CONFIG.persistentSession ? readOrchestrator() : null
  const sessionId = resuming || randomUUID()

  // A resumed orchestrator already HAS the brief in its context. Re-sending it
  // every tick would re-pay for it and, worse, read as a fresh instruction to
  // start over — the agent would re-orient instead of continuing. A resumed
  // tick therefore gets a short continuation turn and the live meter only.
  const prompt = resuming ? `[scheduler] Next unit. You are the same session as before — do NOT
re-orient from scratch, and do not re-read what you already know. Pick up from
the "next" value you last wrote and continue.

${meterPreamble()}

SESSION BUDGET: ${CONFIG.maxUnits} unit(s), and the context ceiling still applies.
Stop cleanly and write the journal line when you reach either.` : `${fs.readFileSync(P.prompt, 'utf8')}

${memoryBrief(readMemory())}

DURABLE MEMORY: ${path.relative(REPO, P.memory)}. This session will eventually be
retired and replaced by a fresh one — everything in your context now is lost at
that point, and this file is the ONLY thing that carries over besides the journal.
Append what a future session would be sorry not to know: a decision and why, a
constraint that is not obvious from the code, an approach that was tried and
failed. Put anything that must never be lost under "## Pinned"; everything else
goes newest-first under "## Notes". Do not write status there — that is the
journal's job. The harness keeps the file bounded, so append freely.


${meterPreamble()}

SESSION BUDGET: two limits, and the context one is the real one.

  CONTEXT (primary): keep your own context under ${Math.round(CONFIG.maxCtxWarnTokens / 1000)}k tokens by
  delegating rather than reading. The supervisor is watching it live and will
  send you a warning at ${Math.round(CONFIG.maxCtxWarnTokens / 1000)}k and a handoff instruction at ${Math.round(CONFIG.maxCtxHandoffTokens / 1000)}k. Obey
  them when they arrive. Run as long as you like below the ceiling — a lean
  session is a long session, and being cheap per turn is exactly what buys you
  more units before the usage window ends the session for you.

  UNITS (backstop): at most ${CONFIG.maxUnits} unit(s) of work, then stop cleanly even if
  headroom remains.

Whichever you reach first, stop cleanly. The supervisor restarts shortly, so
stopping costs nothing. Always append the ${path.relative(REPO, P.journal)} line
before stopping — it is the only thing that survives you.`

  // Checked after the lock and the cooldown, before spending anything. A
  // balance does not refill the way the usage window does, so this stop is
  // final until Adi raises the cap.
  const bud = budgetState()
  if (bud.exhausted) {
    logLine(`BUDGET CAP REACHED — $${bud.since.toFixed(2)} of $${bud.cap} allowance spent. `
      + `Not starting. Raise BUDGET_CAP or re-baseline with \`harness budget reset\`.`)
    return
  }

  // Paid credits are only ever spent on work the included allowance would have
  // covered for free after a wait. Refuse to start a session that can only run
  // on credits, unless that trade was explicitly bought with ALLOW_OVERAGE=1.
  const cr = creditState()
  if (cr.known && cr.enabled) {
    if (cr.limitReached) {
      logLine(`account spend limit reached (${cr.fmt(cr.usedMinor)} of ${cr.fmt(cr.limitMinor)}) — not starting`)
      return
    }
    const paid = paidCreditSpendUsd()
    if (CONFIG.allowOverage && paid >= CONFIG.creditCapUsd) {
      logLine(`credit cap reached (est $${paid.toFixed(2)} of $${CONFIG.creditCapUsd} on paid credits) — not starting`)
      return
    }
  }

  ensureMemory()
  const dropped = dropStaleSupervisorLines()
  if (dropped) logLine(`dropped ${dropped} stale supervisor nudge(s) from a prior session`)

  fs.writeFileSync(P.currentSession, sessionId)
  logLine(resuming
    ? `resuming orchestrator ${sessionId} — max ${CONFIG.maxUnits} unit(s)`
    : `starting tick — new session ${sessionId}, max ${CONFIG.maxUnits} unit(s)`)
  if (CONFIG.persistentSession && !resuming) writeOrchestrator(sessionId)

  const args = [
    '-p', prompt,
    // `--session-id` NAMES a new session; `--resume` continues an existing one.
    // Passing both is rejected, so this is either/or.
    ...(resuming ? ['--resume', sessionId] : ['--session-id', sessionId]),
    '--dangerously-skip-permissions',
    '--model', CONFIG.model,
    '--fallback-model', CONFIG.fallbackModel,
    '--output-format', 'stream-json', '--verbose',
    // Build sessions inherit Adi's ACCOUNT-LEVEL claude.ai connectors — Shopify,
    // Supermetrics, Zendrop, Gmail, Drive, Indeed — and each dumps an instruction
    // block and a deferred tool list into turn one. None relates to this repo. On
    // 2026-08-03 that pushed sessions to the context ceiling at START-UP, before
    // orientation and before a single file was read: three consecutive ticks
    // landed at 91-92% of the session allowance having done nothing.
    //
    // It cannot be fixed from the repo — `~/.claude.json` carries no `mcpServers`
    // globally or per-project and there is no `.mcp.json`; the connectors arrive
    // with the account. With no `--mcp-config` alongside it, this flag resolves to
    // "use no MCP servers at all", which is what an unattended single-repo build
    // wants. Requires Claude Code >= 2.1.220.
    '--strict-mcp-config',
    // Without this the stream carries subagent tool calls but not their text
    // or thinking, so the dashboard can show that renderer-smith is running
    // but not what it is doing. Requires Claude Code >= 2.1.211.
    '--forward-subagent-text',
  ]

  const sink = fs.createWriteStream(runLogPath, { flags: 'a' })
  const errSink = fs.createWriteStream(P.stderr, { flags: 'a' })
  // Stamped BEFORE the spawn so the comparison afterwards is against this run
  // and not against whatever the tree looked like when the harness booted.
  const headBefore = gitHead()
  const child = spawn('claude', args, { cwd: REPO, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
  child.stderr.pipe(errSink)


  // Classify from structured events, never from prose. The old harness grepped
  // stdout for "usage limit" and so scored every productive session — which
  // prompt.md tells to stop near the limit — as a failure.
  let buf = '', result = null, rateLimited = 0, retries = 0
  // The window's own reset time, learned from the stream rather than inferred.
  let limitResetsAt = 0, limitKind = null
  // Fire-once flags for the allowance-approach warning and the overage crossing.
  let warnedNearLimit = false, overageSeen = false
  // Highest MAIN-THREAD context seen. Each ceiling fires at most once — a nudge
  // repeated every turn is just noise the agent learns to skip. The decision
  // logic lives in classify.mjs so the tests can drive the real thing.
  let peakCtx = 0
  // Live metering. Both of these used to be observed and discarded: the usage
  // events were read for their two alarm thresholds and dropped, and the token
  // counts were read only for the context peak. Nothing outside the running
  // process could see either, so between runs the harness knew nothing about
  // its own spend that was less than a cache-refresh old.
  const tokenMeter = createTokenMeter()
  let lastUsageWritten = null, usageWrites = 0
  const recordUsage = ev => {
    const snap = usageSnapshot(ev, nowSec())
    if (!shouldRecordUsage(lastUsageWritten, snap)) return
    lastUsageWritten = snap
    usageWrites++
    ensureDirs()
    fs.appendFileSync(P.usage, JSON.stringify({ ...snap, session_id: sessionId }) + '\n')
    // Bounded, because checkUsage reads this file whole and `harness ui` calls
    // it twice a second. Only the tail is ever consulted; the rest is history
    // no reader has. Trimmed rarely so the rewrite cost stays negligible.
    if (usageWrites % 100 === 0) trimUsageLog()
  }
  const ctxWatcher = createCtxWatcher({
    warnTokens: CONFIG.maxCtxWarnTokens,
    handoffTokens: CONFIG.maxCtxHandoffTokens,
    onWarn: ctx => {
      const k = Math.round(ctx / 1000)
      say(`CONTEXT WARNING (${k}k of ${Math.round(CONFIG.maxCtxHandoffTokens / 1000)}k). `
        + `From here on, avoid pulling source files into this context. Where the agent `
        + `org table gives a file area an owner, brief that specialist and work from `
        + `what it returns. Everything you read yourself stays in context for the rest `
        + `of the session and is re-read on every subsequent turn.`, { supervisor: true })
      logLine(`context warning ${k}k — delegation nudge sent`)
    },
    onHandoff: ctx => {
      const k = Math.round(ctx / 1000)
      say(`CONTEXT CEILING (${k}k). Stop taking on new work now. Finish only what is `
        + `already in flight, run verify, commit if green, append the `
        + `logs/build-scheduler.jsonl line with a precise "next", and end the session. `
        + `Do not start another unit — the supervisor restarts immediately and a fresh `
        + `session is cheaper per turn than this one now is.`, { supervisor: true })
      logLine(`context ceiling ${k}k — handoff requested`)
    },
  })

  // ── runaway guardrail ────────────────────────────────────────────────────
  // Fed from the stream (tool calls, errors) and from the PreCompact marker the
  // hook drops, then evaluated on a timer. Enforcement is deliberately gentle:
  // `steer` and `constrain` are MESSAGES, delivered through the same inbox path
  // a human `harness say` uses, so the agent can answer or disagree. Only a
  // `stop` — off unless hardStop is set — touches the process.
  const breaker = createBreaker(CONFIG.breaker)
  fs.rmSync(P.compacting, { force: true })
  let breakerLevel = 'healthy', killedByBreaker = false
  const breakerTimer = setInterval(() => {
    const t = Date.now()
    // Cross-process compaction signal. The marker is consumed, so one
    // compaction grants one exemption window.
    if (exists(P.compacting)) {
      fs.rmSync(P.compacting, { force: true })
      breaker.recordCompactStart(t)
    }
    const d = breaker.beat({
      outputTokens: tokenMeter.snapshot().output,
      usd: result?.total_cost_usd ?? null,
      now: t,
    })
    if (d.changed) {
      breakerLevel = d.level
      logLine(`  breaker ${d.level}${d.reason ? ` — ${d.reason}` : ' — recovered'}`)
    }
    if (d.action === 'steer' || d.action === 'constrain') {
      // Supervisor-authored, so it is not delivered in Adi's voice.
      say(breakerMessage(d.level, d.reason), { supervisor: true })
    } else if (d.action === 'stop') {
      killedByBreaker = true
      logLine(`  breaker HALTING the session — ${d.reason}`)
      try { child.kill('SIGTERM') } catch {}
    }
  }, CONFIG.breakerBeatSec * 1000)
  breakerTimer.unref?.()
  child.stdout.on('data', chunk => {
    sink.write(chunk)
    buf += chunk.toString('utf8')
    const lines = buf.split('\n'); buf = lines.pop() ?? ''
    for (const ln of lines) {
      if (!ln.trim()) continue
      let ev; try { ev = JSON.parse(ln) } catch { continue }

      if (ev.type === 'result') result = ev
      else if (ev.type === 'system' && ev.subtype === 'api_retry') {
        retries++; if (ev.error === 'rate_limit') rateLimited++
        // A rate limit is the harness's own gate working, not a fault. Only
        // other errors count toward the storm arm.
        if (ev.error !== 'rate_limit') breaker.recordError()
      }
      // The structured limit signal. Carries resetsAt as a unix timestamp, so
      // the resume time is exact and never parsed out of prose like
      // "resets 2:20pm (Australia/Melbourne)".
      else if (ev.type === 'rate_limit_event') {
        const info = ev.rate_limit_info || {}
        if (info.status === 'rejected') {
          rateLimited++
          limitKind = info.rateLimitType || 'unknown'
          if (info.resetsAt > limitResetsAt) limitResetsAt = info.resetsAt
        }
        const sig = overageSignal(ev)
        recordUsage(ev)

        // The included allowance is nearly gone. Everything after this point
        // is either paid or waited for, so ask for a clean landing while the
        // work is still free.
        if (sig?.utilization >= 0.9 && !warnedNearLimit && !sig.usingOverage) {
          warnedNearLimit = true
          say(`SESSION ALLOWANCE ${Math.round(sig.utilization * 100)}% USED — the included `
            + `5-hour window is nearly spent. Land what you are holding: run verify, commit if `
            + `green, write the journal line with a precise "next", and stop. Work past the `
            + `limit costs paid credits; work after the reset costs nothing.`, { supervisor: true })
          logLine(`session allowance ${Math.round(sig.utilization * 100)}% — landing requested`)
        }

        // Crossed into paid credits. Unless explicitly permitted, this is
        // money being spent on work that waiting would have got for free.
        if (sig?.usingOverage && !overageSeen) {
          overageSeen = true
          if (CONFIG.allowOverage) {
            // Deliberately NOT an instruction to wind down. Adi bought this
            // spend to remove the wait, so telling the agent to stop the moment
            // it starts spending buys the credits and then throws the work
            // away. Two consecutive sessions did exactly that — orientation
            // reads, hook fires, agent stops, ~$0.35 spent for nothing — and
            // the agent correctly flagged the gate as firing too early.
            logLine('on paid credits — authorised, continuing')
            say('FYI only, no action needed: this session is drawing on paid usage credits '
              + 'rather than the included allowance. That is authorised and expected — it is '
              + 'what removes the wait between sessions. Keep working to the normal budget: '
              + 'the context ceiling and unit cap still apply, and the supervisor stops you '
              + 'at the credit cap. Do NOT wind down early on account of this message.',
            { supervisor: true })
          } else {
            logLine('NOW ON PAID CREDITS — not permitted, requesting immediate stop')
            say('STOP NOW. You have crossed from the included plan allowance onto PAID usage '
              + 'credits. Do not start anything further: commit only what is already verify-green, '
              + 'write the journal line, and end the session. The scheduler will resume free of '
              + 'charge when the window resets.', { supervisor: true })
          }
        }
      }
      else if (ev.type === 'assistant') {
        ctxWatcher.feed(ev); peakCtx = ctxWatcher.peak()
        // A NEW (name+input) is forward progress; the same one again is the
        // loop signal. Subagent calls count too — a subagent spinning is a
        // runaway just as surely as the main thread doing it.
        for (const c of ev.message?.content || []) {
          if (c?.type === 'tool_use') breaker.recordToolUse(c.name, c.input, Date.now())
        }
      }
      // Not an else-branch: the meter needs the `result` event, which is
      // matched further up.
      tokenMeter.feed(ev)
    }
  })

  const code = await new Promise(res => child.on('close', res))
  clearInterval(breakerTimer)
  fs.rmSync(P.compacting, { force: true })
  sink.end(); errSink.end()
  try { fs.rmSync(P.currentSession, { force: true }) } catch {}

  const rec = {
    ts: new Date().toISOString(),
    session_id: sessionId,
    cost_usd: result?.total_cost_usd ?? 0,
    turns: result?.num_turns ?? 0,
    duration_ms: result?.duration_ms ?? 0,
    exit: code,
    subtype: result?.subtype ?? 'none',
    rate_limit_events: rateLimited,
    peak_ctx_tokens: peakCtx,
    tokens: tokenMeter.snapshot(),
    used_paid_credits: overageSeen,
    breaker: breakerLevel === 'healthy' ? null : { level: breakerLevel, halted: killedByBreaker },
    // Where the account stood when this run ended — the only usage reading that
    // is certainly current for this run, and the one `usage` reports between
    // runs rather than re-reading a cache of unknown age.
    usage_at_end: lastUsageWritten,
    model: CONFIG.model,
    log: path.relative(REPO, runLogPath),
  }
  fs.appendFileSync(P.cost, JSON.stringify(rec) + '\n')

  // A run killed by the usage window is NOT an error and must not get the
  // generic backoff. See classify.mjs for why `subtype` and a bare
  // `terminal_reason` are both untrustworthy here. `classifyRun` returns
  // exactly one of ok | window_limit | transient | error | incomplete, so a
  // failure mode nobody has seen yet lands in `error` — the conservative
  // bucket — rather than in whichever branch happens to be last.
  const outcome = classifyRun({ result, rateLimited })
  const hitLimit = outcome === 'window_limit'

  if (code === 0) {
    const t = rec.tokens
    logLine(`tick ok — $${rec.cost_usd.toFixed(4)}, ${rec.turns} turns, `
      + `${retries} retries, peak ctx ${Math.round(peakCtx / 1000)}k`)
    logLine(`  tokens ${t.measured ? `${t.output} out, cache hit ${Math.round(t.cache_hit * 100)}%` : 'not measured (no result event)'}`
      + `, ${t.subagents} subagent(s), ${usageWrites} usage reading(s)`)

    const evicted = boundMemory()
    if (evicted) logLine(`  memory bounded — ${evicted} section(s) moved to ${path.basename(P.memoryArchive)}`)

    // ── rotation ───────────────────────────────────────────────────────────
    // Persistence must not be allowed to defeat the context discipline the rest
    // of this file exists to enforce. Past the ceiling the conversation is
    // retired: the next tick opens a fresh session with the full brief, which
    // re-orients from the journal line this session just wrote.
    //
    // Retiring only AFTER a clean exit is deliberate. A session that died to the
    // usage window has lost nothing and should be resumed, not thrown away.
    if (CONFIG.persistentSession && peakCtx >= CONFIG.rotateCtxTokens) {
      fs.rmSync(P.orchestrator, { force: true })
      logLine(`  orchestrator retired at ${Math.round(peakCtx / 1000)}k context `
        + `(ceiling ${Math.round(CONFIG.rotateCtxTokens / 1000)}k) — next tick starts a fresh one, `
        + `carrying ${path.basename(P.memory)} and the journal`)
    }

    // Did this session actually ship anything? The git tree answers; the
    // agent's own summary does not. A session that only committed its journal
    // line is idle no matter how confidently it reports otherwise.
    const changed = gitChangedPaths(headBefore, gitHead())
    if (changed === null) {
      // Could not read git. Treat as work — refusing to back off is the safe
      // direction, since the only cost is the status quo.
      fs.rmSync(P.cooldown, { force: true })
      writeIdleStreak(0)
    } else if (producedWork(changed, CONFIG.bookkeepingPaths)) {
      fs.rmSync(P.cooldown, { force: true })
      writeIdleStreak(0)
    } else {
      const streak = readIdleStreak() + 1
      writeIdleStreak(streak)
      const wait = idleBackoffSec({
        streak, baseSec: CONFIG.intervalSec, capSec: CONFIG.idleBackoffCapSec,
      })
      writeCooldown(nowSec() + wait, 'idle')
      logLine(`  no work shipped (${streak} in a row) — next tick in ${Math.round(wait / 60)}m`)
    }
  } else if (hitLimit) {
    // Expected outcome of a productive session, not a fault. Resume when the
    // window actually resets rather than adding a punitive backoff on top.
    // Tagging the reason is what lets the next tick trust this wake-up time
    // over the stale cache and start again the moment the limit resets.
    // resetsAt off the stream is the window's own number and outranks both the
    // local cache and any guessed backoff — but only when the terminal result
    // agrees this was a limit. A transient 429 the CLI recovered from can leave
    // a 5h resetsAt behind on a run that later failed for an unrelated reason;
    // trusting it there would park the scheduler for hours over nothing.
    const trustReset = result?.api_error_status === 429
    const authoritative = trustReset
      ? resolveLimitResume({ resetsAt: limitResetsAt, now: nowSec() })
      : null
    let resume, how
    if (authoritative !== null) {
      resume = authoritative
      how = `${limitKind} window`
    } else {
      const re = checkUsage()
      resume = Math.max(re.resumeAt || 0, nowSec() + CONFIG.intervalSec)
      how = 'cached estimate'
    }
    writeCooldown(resume, 'window_reset')
    logLine(`tick hit the usage window ($${rec.cost_usd.toFixed(4)}, ${rec.turns} turns, `
      + `peak ctx ${Math.round(peakCtx / 1000)}k) — ${how}, resuming `
      + `${new Date(resume * 1000).toLocaleTimeString()}`)
  } else if (killedByBreaker) {
    // Not an API fault and not a usage limit — the harness killed this itself.
    // It gets the error backoff because whatever caused it will still be there
    // in fifteen minutes, but it is logged as its own thing so it can never be
    // mistaken for a network problem when someone reads the log later.
    writeCooldown(nowSec() + CONFIG.errorBackoffSec, 'breaker')
    logLine(`tick HALTED by the breaker — retry in ${CONFIG.errorBackoffSec / 60}m. `
      + `Read the run log before re-arming; the breaker does not fire on healthy sessions.`)
  } else if (outcome === 'transient') {
    // The stream dropped. Nothing is wrong with the account, and the work the
    // session had already committed is still committed — so retry soon rather
    // than paying the error backoff, which exists to contain a broken key.
    const wait = Math.max(CONFIG.transientBackoffSec, 0)
    writeCooldown(nowSec() + wait, 'transient')
    logLine(`tick dropped its connection (exit ${code}) — not an account fault, retry in ${Math.round(wait / 60)}m`)
  } else {
    writeCooldown(nowSec() + CONFIG.errorBackoffSec, 'error')
    logLine(`tick errored (exit ${code}, subtype=${rec.subtype}) — retry in ${CONFIG.errorBackoffSec / 60}m`)
  }
}

// ───────────────────────────────────────────────────────────────── hook
// Two jobs: record every event, and deliver queued messages into a running
// session via PreToolUse additionalContext.
async function cmdHook() {
  let payload = {}
  try {
    const chunks = []
    for await (const c of process.stdin) chunks.push(c)
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch { process.exit(0) }

  const sid = payload.session_id || 'unknown'
  try {
    ensureDirs()
    fs.appendFileSync(path.join(P.events, `${sid}.jsonl`), JSON.stringify({
      ts: new Date().toISOString(),
      session_id: sid,
      event: payload.hook_event_name,
      agent_id: payload.agent_id ?? null,
      agent_type: payload.agent_type ?? null,
      tool: payload.tool_name ?? null,
      summary: summarise(payload).slice(0, 300),
    }) + '\n')
  } catch { /* observation must never break a build */ }

  if (payload.hook_event_name === 'PreToolUse') {
    // Order matters: the re-pin re-establishes ground truth, and any queued
    // instruction should be read against it rather than before it.
    const parts = [takeRepin(sid), drainInbox(payload)].filter(Boolean)
    if (parts.length) process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: parts.join('\n\n') },
    }))
  }

  // Constraint pinning. Reaching here means the ceiling nudge was ignored and
  // the session is about to compact anyway — so make the summary keep the
  // things whose loss is unrecoverable. Compaction is lossy summarisation, and
  // a constraint that does not survive the summary stops being obeyed: the
  // agent keeps working, confidently, without the rule. For this repo that
  // means shipping a transcript-based pronunciation scorer, or weakening an
  // assertion to reach green — both explicitly forbidden, both invisible once
  // the rule is gone.
  if (payload.hook_event_name === 'PreCompact') {
    // This used to answer with hookSpecificOutput.customInstructions, and that
    // silently did nothing: this Claude Code build validates hook output
    // against a schema with no PreCompact case at all, so every reply was
    // rejected wholesale. The pinning had never once run — the failure only
    // became visible because a manual /compact printed the validation error.
    //
    // So the constraints are no longer aimed at the summariser. They are armed
    // here and delivered AFTER the compaction, through PreToolUse
    // additionalContext — the one channel proven to reach a running session.
    // That is the stronger position anyway: instructing a summariser to keep a
    // rule is a request, while injecting it into the live context afterwards is
    // the rule being present.
    try { fs.writeFileSync(path.join(P.events, `${sid}.repin`), String(nowSec())) } catch {}
    try { fs.writeFileSync(P.compacting, String(nowSec())) } catch {}
  }
  // Not process.exit(0): when stdout is a pipe the write above may still be
  // queued, and exiting truncates it. Truncated JSON on a hook's stdout is
  // itself a fail-open violation. Setting the code and returning lets node
  // flush and exit 0 on its own.
  process.exitCode = 0
}

/**
 * Consume a pending re-pin for this session, if a compaction armed one.
 *
 * Fires at most once per compaction: the marker is deleted as it is read, so a
 * long session pays for this on one tool call rather than every one.
 */
function takeRepin(sid) {
  const marker = path.join(P.events, `${sid}.repin`)
  try {
    if (!fs.existsSync(marker)) return null
    fs.rmSync(marker, { force: true })
    return COMPACT_INSTRUCTIONS
  } catch { return null }
}

// What a summary loses is not the rules — CLAUDE.md is re-injected after a
// compaction and comes back intact. What it loses is the session's own ground
// truth: which files are half-written, which assertion was failing, what "next"
// actually said. The dangerous state after a compaction is an agent that
// remembers the gist confidently enough not to re-check.
//
// So this asks for re-derivation from disk, not recall — and restates verbatim
// only the rules whose violation is both forbidden and invisible in a diff.
// The generic half applies to every project: after a compaction the summary is
// the only thing left, and a summary is a claim rather than evidence. The
// project half comes from `.harness.json`'s `compactRules`, because the rules
// worth paying for here are exactly the ones a diff cannot show — and those are
// always project-specific.
const COMPACT_INSTRUCTIONS = (() => {
  const generic = [
    '[supervisor] Your context was just compacted. A summary is not evidence.',
    'Before your next substantive action, re-establish ground truth from disk:',
    '',
    `1. Read the last line of ${CONFIG.journalPath} for the exact "next" value.`,
    '   Work that, not what you remember planning.',
    '2. Run `git status --short`. Files you had in flight may not be in the summary.',
    '3. Report nothing as done that you have not re-verified. If you are about to',
    '   claim green, run the verify command first and quote its actual output.',
    '4. If a file matters to your next edit, re-read it. Do not edit from memory of',
    '   a file you read before the compaction.',
    '',
    'These rules hold regardless of what the summary says about them:',
    '',
    '  - Never delete, .skip or weaken a failing test to go green.',
    '  - Never commit a secrets file. Never add API keys to the harness environment.',
  ]
  const project = CONFIG.compactRules.map(r => `  - ${String(r).trim()}`)
  return generic.concat(project).join('\n')
})()

function summarise(p) {
  const t = p.tool_name || '', i = p.tool_input || {}
  switch (p.hook_event_name) {
    case 'SubagentStart': return `started ${p.agent_type ?? '?'}`
    case 'SubagentStop': return `finished ${p.agent_type ?? '?'}`
    case 'SessionStart': return p.source || 'start'
    case 'SessionEnd': return 'session ended'
  }
  if (t === 'Bash') return `$ ${i.command ?? ''}`
  if (['Read', 'Edit', 'Write'].includes(t)) return `${t} ${i.file_path ?? ''}`
  if (['Grep', 'Glob'].includes(t)) return `${t} ${i.pattern ?? ''}`
  if (['Agent', 'Task'].includes(t)) return `spawn ${i.subagent_type ?? '?'}: ${i.description ?? ''}`
  return t || p.hook_event_name || ''
}

// Messages are addressed: a bare line goes to the main agent, "@reviewer: ..."
// goes only to a subagent of that type. Lines belonging to someone else must
// survive, so the file is rewritten rather than truncated.
function drainInbox(payload) {
  let lines
  try { lines = fs.readFileSync(P.inbox, 'utf8').split('\n').filter(l => l.trim()) } catch { return null }
  if (!lines.length) return null

  // Only the build session the harness launched may take unaddressed lines.
  // With no tick in flight, nobody does — a message queued for the build must
  // wait for it rather than being eaten by whoever calls a tool first.
  let current = null
  try { current = fs.readFileSync(P.currentSession, 'utf8').trim() } catch {}
  const isBuildSession = Boolean(current) && payload.session_id === current

  const isSub = Boolean(payload.agent_id)
  const myType = (payload.agent_type || '').trim().toLowerCase()
  const mine = [], theirs = []
  for (const ln of lines) {
    if (ln.startsWith('@')) {
      const idx = ln.indexOf(':')
      const target = (idx < 0 ? ln.slice(1) : ln.slice(1, idx)).trim().toLowerCase()
      if (isSub && target === myType) mine.push(ln.slice(idx + 1).trim()); else theirs.push(ln)
    } else if (!isSub && isBuildSession) mine.push(ln)
    else theirs.push(ln)
  }
  if (!mine.length) return null

  try { fs.writeFileSync(P.inbox, theirs.length ? theirs.join('\n') + '\n' : '') } catch { return null }
  const who = isSub ? `the ${myType} subagent` : 'you'

  // Supervisor advisories must not be delivered in Adi's voice. They are
  // generated by the harness from measured context size, and attributing them
  // to the human both misrepresents their authority and makes a machine
  // heuristic unfalsifiable.
  const human = mine.filter(m => !m.startsWith(SUPERVISOR_PREFIX))
  const auto = mine.filter(m => m.startsWith(SUPERVISOR_PREFIX))
    .map(m => m.slice(SUPERVISOR_PREFIX.length))

  const blocks = []
  if (human.length) {
    blocks.push(`[LIVE MESSAGE FROM ADI — addressed to ${who}, sent while this session was running. `
      + `Treat it as a direct instruction that overrides the current plan where they conflict, then carry on.]\n\n`
      + human.map(m => `- ${m}`).join('\n'))
  }
  if (auto.length) {
    blocks.push(`[AUTOMATED MESSAGE FROM THE BUILD SUPERVISOR — not from Adi. Generated from `
      + `measured context size. Act on it as an operating constraint, not as a change of plan.]\n\n`
      + auto.map(m => `- ${m}`).join('\n'))
  }
  return blocks.join('\n\n')
}

// ─────────────────────────────────────────────────── stream → agent tree
const MAX_ENTRIES = 40, MAX_TEXT = 600
const sessions = new Map()
const offsets = new Map(), partials = new Map()

function newSession(id, label) {
  return {
    id, label, model: null, status: 'running', cost: 0, turns: 0, rateLimited: 0, hasStream: false,
    nodes: { main: { id: 'main', type: `${CONFIG.project} (main)`, desc: null, status: 'running', entries: [] } },
    order: ['main'],
  }
}
function push(node, kind, text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
  if (!t) return
  node.entries.push({ kind, text: t })
  if (node.entries.length > MAX_ENTRIES) node.entries.shift()
}
function toolLine(name, i = {}) {
  if (name === 'Bash') return `$ ${i.command ?? ''}`
  if (['Read', 'Edit', 'Write'].includes(name)) return `${name} ${i.file_path ?? ''}`
  if (['Grep', 'Glob'].includes(name)) return `${name} ${i.pattern ?? ''}`
  if (name === 'TodoWrite') return 'updated todos'
  return `${name} ${JSON.stringify(i).slice(0, 180)}`
}

// A message carrying parent_tool_use_id belongs to the subagent spawned by
// that Agent tool call, at any nesting depth. That is the whole tree.
function ingestStream(s, ev) {
  if (ev.type === 'system' && ev.subtype === 'init') { s.model = ev.model ?? s.model; return }
  if (ev.type === 'system' && ev.subtype === 'api_retry') {
    if (ev.error === 'rate_limit') s.rateLimited++
    push(s.nodes.main, 'retry', `api retry ${ev.attempt}/${ev.max_retries} — ${ev.error}`); return
  }
  if (ev.type === 'result') {
    s.cost = ev.total_cost_usd ?? s.cost; s.turns = ev.num_turns ?? s.turns
    s.status = ev.is_error ? 'error' : 'done'
    for (const k of s.order) s.nodes[k].status = 'done'
    push(s.nodes.main, 'result', ev.result); return
  }
  const node = s.nodes[ev.parent_tool_use_id || 'main'] ?? s.nodes.main
  const content = ev.message?.content
  if (!Array.isArray(content)) return
  for (const b of content) {
    if (b.type === 'text') push(node, 'text', b.text)
    else if (b.type === 'thinking') push(node, 'thinking', b.thinking)
    else if (b.type === 'tool_use') {
      if (b.name === 'Agent' || b.name === 'Task') {
        if (!s.nodes[b.id]) {
          s.nodes[b.id] = {
            id: b.id, type: b.input?.subagent_type || 'subagent',
            desc: b.input?.description || null, status: 'running', entries: [],
          }
          s.order.push(b.id)
        }
        push(node, 'spawn', `spawned ${s.nodes[b.id].type}: ${s.nodes[b.id].desc ?? ''}`)
      } else push(node, 'tool', toolLine(b.name, b.input))
    } else if (b.type === 'tool_result' && s.nodes[b.tool_use_id]) {
      s.nodes[b.tool_use_id].status = 'done'
      push(s.nodes[b.tool_use_id], 'done', 'returned to parent')
    }
  }
}

// Hook events are the only source for sessions the scheduler did not launch
// (an interactive terminal), which have no stream-json transcript.
function ingestHook(s, ev) {
  if (s.hasStream) return
  if (ev.event === 'SubagentStart' && ev.agent_id) {
    if (!s.nodes[ev.agent_id]) {
      s.nodes[ev.agent_id] = { id: ev.agent_id, type: ev.agent_type || 'subagent', desc: null, status: 'running', entries: [] }
      s.order.push(ev.agent_id)
    }
    return
  }
  if (ev.event === 'SubagentStop' && s.nodes[ev.agent_id]) { s.nodes[ev.agent_id].status = 'done'; return }
  if (ev.event === 'SessionEnd') { s.status = 'done'; for (const k of s.order) s.nodes[k].status = 'done'; return }
  push((ev.agent_id && s.nodes[ev.agent_id]) || s.nodes.main, 'tool', ev.summary)
}

async function readNew(file) {
  let st; try { st = await fsp.stat(file) } catch { return [] }
  const prev = offsets.get(file) || 0
  if (st.size <= prev) { if (st.size < prev) offsets.set(file, 0); return [] }
  const fh = await fsp.open(file, 'r')
  const buf = Buffer.alloc(st.size - prev)
  await fh.read(buf, 0, buf.length, prev)
  await fh.close()
  offsets.set(file, st.size)
  const lines = ((partials.get(file) || '') + buf.toString('utf8')).split('\n')
  partials.set(file, lines.pop() ?? '')
  const out = []
  for (const ln of lines) { if (ln.trim()) { try { out.push(JSON.parse(ln)) } catch {} } }
  return out
}

async function poll() {
  let dirty = false
  for (const [dir, isStream] of [[P.runs, true], [P.events, false]]) {
    let files = []
    try { files = (await fsp.readdir(dir)).filter(f => f.endsWith('.jsonl')) } catch { continue }
    for (const f of files) {
      const evs = await readNew(path.join(dir, f))
      if (!evs.length) continue
      const label = f.replace(/\.jsonl$/, '')
      const id = isStream ? (evs.find(e => e.session_id)?.session_id || label) : label
      let s = sessions.get(id)
      if (!s) { s = newSession(id, isStream ? label : label.slice(0, 8)); sessions.set(id, s) }
      if (isStream) { s.hasStream = true; s.label = label }
      for (const e of evs) isStream ? ingestStream(s, e) : ingestHook(s, e)
      dirty = true
    }
  }
  return dirty
}

function schedulerState() {
  if (exists(P.stopped)) return 'stopped'
  if (exists(P.paused)) return 'paused'
  try { return execFileSync('launchctl', ['list'], { encoding: 'utf8' }).includes(CONFIG.label) ? 'armed' : 'unloaded' }
  catch { return 'unknown' }
}
function readCostRecords() {
  try {
    return fs.readFileSync(P.cost, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}
function todayCost() {
  const day = new Date().toISOString().slice(0, 10)
  try {
    return fs.readFileSync(P.cost, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l) } catch { return null } })
      .filter(r => r?.ts?.startsWith(day)).reduce((a, r) => a + (r.cost_usd || 0), 0)
  } catch { return 0 }
}
// Cumulative spend against the credit balance.
//
// Runs killed by the usage window report a ROLLING ACCOUNT TOTAL in
// total_cost_usd rather than that run's cost — an 816ms run once reported
// $4.22 — so counting them would massively overstate spend and trip the cap
// early. Only sessions that exited cleanly and did real work are counted.
function spentTotal() {
  try {
    return fs.readFileSync(P.cost, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l) } catch { return null } })
      .filter(r => r && r.exit === 0 && (r.turns || 0) >= 5 && r.cost_usd > 0)
      .reduce((a, r) => a + r.cost_usd, 0)
  } catch { return 0 }
}
// REAL paid-credit spend, straight from the account's own meter — not the
// notional API-equivalent figure in cost.jsonl. Those are different numbers by
// orders of magnitude: work done inside the included plan allowance records a
// dollar cost in cost.jsonl while consuming zero credits.
//
// extra_usage.used_credits and monthly_limit are in MINOR units of `currency`
// (AUD cents here), per decimal_places.
// Estimated paid-credit spend, computed from OUR OWN records.
//
// The account's extra_usage.used_credits field is NOT usable: it read 0 while
// the billing UI showed A$31.14 spent, on a cache fetched seconds earlier. So
// it is treated as advisory only, and the real figure is reconstructed from
// runs the stream itself flagged as having crossed onto credits
// (used_paid_credits, set from isUsingOverage — a signal that is populated and
// has been observed true).
//
// This is an ESTIMATE in USD-equivalent, not a billing figure. It exists to
// stop an unattended run before it eats a month's allowance, and it errs
// toward stopping early.
function paidCreditSpendUsd() {
  try {
    return fs.readFileSync(P.cost, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l) } catch { return null } })
      .filter(r => r?.used_paid_credits && r.cost_usd > 0 && (r.turns || 0) >= 5)
      .reduce((a, r) => a + r.cost_usd, 0)
  } catch { return 0 }
}

function creditState() {
  let ex
  try {
    ex = JSON.parse(fs.readFileSync(P.claudeConfig, 'utf8'))
      ?.cachedUsageUtilization?.utilization?.extra_usage
  } catch { /* fresh install */ }
  if (!ex) return { known: false, enabled: false, usedMinor: 0, limitMinor: 0, currency: 'USD', places: 2 }
  const places = ex.decimal_places ?? 2
  return {
    known: true,
    enabled: ex.is_enabled === true && ex.user_disabled !== true,
    usedMinor: ex.used_credits ?? 0,
    limitMinor: ex.monthly_limit ?? 0,
    currency: ex.currency || 'USD',
    places,
    limitReached: ex.spend_limit_reached === true,
    fmt(minor) { return `${this.currency} ${(minor / 10 ** places).toFixed(places)}` },
  }
}

// Spend since the baseline was stamped, and what remains of the allowance.
// With no baseline the whole history counts, which is the safe default: it can
// only stop sooner, never later.
function budgetState() {
  const total = spentTotal()
  let baseline = 0
  try { baseline = parseFloat(fs.readFileSync(P.budgetBaseline, 'utf8').trim()) || 0 } catch {}
  const since = Math.max(0, total - baseline)
  return {
    total, baseline, since,
    cap: CONFIG.budgetCapUsd,
    remaining: Math.max(0, CONFIG.budgetCapUsd - since),
    exhausted: since >= CONFIG.budgetCapUsd,
  }
}
// Back-to-back sessions until a guard stops it.
//
// launchd's StartInterval exists to sit out the 5-hour refill: a 15-minute gap
// after a 3-minute session is correct when the next session would be free
// anyway. Once paid overage is permitted that wait is bought and thrown away,
// so this drives ticks continuously instead.
//
// It adds no new permissions: every guard cmdTick already applies — stop
// marker, pause, blocker, cooldown, usage floor, budget cap, credit cap —
// still applies on every pass. This only removes the idle.
async function cmdSprint() {
  const started = Date.now()
  let pass = 0
  logLine(`SPRINT start — overage ${CONFIG.allowOverage ? `ALLOWED to est $${CONFIG.creditCapUsd}` : 'refused'}`)
  console.log(`sprint — ctrl-C to stop. Guards: budget $${CONFIG.budgetCapUsd}, `
    + `credits ${CONFIG.allowOverage ? '$' + CONFIG.creditCapUsd : 'refused'}, ctx `
    + `${Math.round(CONFIG.maxCtxHandoffTokens / 1000)}k, ${CONFIG.maxUnits} units/session`)

  for (;;) {
    if (exists(P.stopped)) { console.log('sprint — stop marker, ending'); break }
    if (exists(P.paused)) { console.log('sprint — paused, ending'); break }
    if (exists(P.blocked)) {
      console.log(`sprint — ${path.relative(REPO, P.blocked)} present; the agent halts at step 1. Ending.`)
      break
    }
    const bud = budgetState()
    if (bud.exhausted) { console.log(`sprint — budget cap $${bud.cap} reached, ending`); break }
    const paid = paidCreditSpendUsd()
    if (CONFIG.allowOverage && paid >= CONFIG.creditCapUsd) {
      console.log(`sprint — credit cap est $${paid.toFixed(2)}/$${CONFIG.creditCapUsd} reached, ending`)
      break
    }

    // A cooldown here USED TO mean the window was spent and overage refused, so
    // the only options were to wait or stop. That stopped being true when the
    // buy-through landed: cmdTick will clear a window_reset cooldown and keep
    // going on paid credits, so breaking here handed the sprint back to a
    // scheduler that was about to run anyway — and the sprint ended after zero
    // passes while credits sat authorised and unused. cmdTick owns the
    // decision; this loop must ask it the same question rather than assume.
    const cd = readCooldown()
    if (cooldownHolds(cd)) {
      const mins = Math.ceil((cd.until - nowSec()) / 60)
      console.log(`sprint — cooldown ${mins}m (${cd.reason}). Handing back to the scheduler.`)
      break
    }

    pass++
    const t0 = Date.now()
    await cmdTick()
    const secs = ((Date.now() - t0) / 1000).toFixed(0)
    console.log(`sprint — pass ${pass} done in ${secs}s · est paid $${paidCreditSpendUsd().toFixed(2)} `
      + `· budget $${budgetState().since.toFixed(2)}/$${CONFIG.budgetCapUsd}`)

    // A tick that returns in under a second did no work — it was gated. Backing
    // off avoids a hot loop that spins on the same refusal hundreds of times.
    if (Date.now() - t0 < 1000) {
      console.log('sprint — tick returned immediately (gated), ending rather than spinning')
      break
    }
    await new Promise(r => setTimeout(r, 5000))
  }
  const mins = ((Date.now() - started) / 6e4).toFixed(0)
  logLine(`SPRINT end — ${pass} pass(es) over ${mins}m, est paid $${paidCreditSpendUsd().toFixed(2)}`)
  console.log(`sprint — ended after ${pass} pass(es), ${mins}m.`)
}

// ─────────────────────────────────────────────────────────────────── chat
//
// The command this whole persistent-session change exists for.
//
// Before it, steering the build meant opening a SECOND interactive Claude Code
// session, which read the run log, worked out what had happened, and ran
// `harness say` on your behalf. A translator between you and your own agent.
//
// It is unnecessary because a headless session is not a special kind of
// session. `claude -p` writes an ordinary transcript to ~/.claude/projects, the
// same place an interactive one does — so the orchestrator can simply be
// RESUMED interactively. What you get is the real Claude Code TUI, with its
// slash commands and its history, attached to the exact conversation the
// scheduler has been driving. You talk to the orchestrator. There is no
// middle man, because there is nothing left for one to do.
//
// The scheduler is held off for the duration. Two processes appending to one
// transcript would interleave the conversation into nonsense, so cmdTick
// refuses to start while the attach marker names a live PID, and this releases
// the marker on every exit path including a signal.
async function cmdChat(argv) {
  ensureDirs()

  const held = attachedPid()
  if (held) {
    console.error(`already attached in another terminal (pid ${held}).`)
    console.error('One conversation, one keyboard — close that one first.')
    process.exit(1)
  }

  const running = readInt(P.lock)
  if (running) {
    try {
      process.kill(running, 0)
      console.error(`a tick is running right now (pid ${running}).`)
      console.error('Wait for it, or `harness say "..."` to queue a message into it,')
      console.error('or `harness pause` then retry once it lands.')
      process.exit(1)
    } catch { /* stale lock, carry on */ }
  }

  let sid = CONFIG.persistentSession ? readOrchestrator() : null
  const fresh = !sid
  if (fresh) {
    // Nothing has run yet, or the conversation was rotated. Opening the brief
    // as a new session is the right move: it is the same thing the next tick
    // would have done, and it means `harness chat` works on a cold install.
    sid = randomUUID()
    writeOrchestrator(sid)
  }

  fs.writeFileSync(P.attached, String(process.pid))
  const release = () => { try { fs.rmSync(P.attached, { force: true }) } catch {} }
  process.on('exit', release)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { release(); process.exit(0) })
  }

  console.log(fresh
    ? `starting the orchestrator conversation (${sid.slice(0, 8)}) — the scheduler will resume THIS session`
    : `attaching to the orchestrator (${sid.slice(0, 8)}) — the same session the scheduler drives`)
  console.log('scheduler is held off while you are attached. Exit to hand it back.\n')

  const args = fresh
    ? ['--session-id', sid, fs.readFileSync(P.prompt, 'utf8')]
    : ['--resume', sid]
  // Same flags the tick uses, minus the headless ones: this is a real TUI.
  args.push('--model', CONFIG.model, '--dangerously-skip-permissions', '--strict-mcp-config')
  args.push(...argv)

  // stdio inherit is the whole trick — the child owns the terminal and renders
  // the genuine Claude Code interface. Nothing here proxies or reimplements it.
  const child = spawn('claude', args, { cwd: REPO, env: childEnv(), stdio: 'inherit' })
  const code = await new Promise(res => child.on('close', res))
  release()
  console.log(`\ndetached — scheduler resumes at the next tick (${CONFIG.intervalSec / 60}m).`)
  process.exit(code ?? 0)
}

function cmdBudget(arg) {
  ensureDirs()
  const total = spentTotal()
  if (arg === 'reset' || arg === undefined) {
    fs.writeFileSync(P.budgetBaseline, String(total))
    console.log(`baseline stamped at $${total.toFixed(2)} — the $${CONFIG.budgetCapUsd} allowance now counts from here`)
  } else {
    console.log('usage: harness budget [reset]   (set the cap with BUDGET_CAP=<dollars>)')
  }
  const b = budgetState()
  console.log(`spent since baseline $${b.since.toFixed(2)} · remaining $${b.remaining.toFixed(2)}`)
}
function pendingInbox() {
  try { return fs.readFileSync(P.inbox, 'utf8').split('\n').filter(l => l.trim()) } catch { return [] }
}
function snapshot() {
  const u = checkUsage()
  return {
    scheduler: schedulerState(),
    usage: { five: u.fivePct, seven: u.sevenPct, floor: CONFIG.usageFloorPct },
    todayCost: todayCost(),
    pending: pendingInbox(),
    sessions: [...sessions.values()].sort((a, b) => (b.label > a.label ? 1 : -1)).slice(0, 25)
      .map(s => ({
        id: s.id, label: s.label, model: s.model, status: s.status,
        cost: s.cost, turns: s.turns, rateLimited: s.rateLimited,
        nodes: s.order.map(k => s.nodes[k]),
      })),
  }
}

// ───────────────────────────────────────────────────────────────── ui
async function cmdUi() {
  ensureDirs()
  const clients = new Set()
  // The page is generic; the project name is injected at serve time so one
  // copy of ui.html serves every project the harness is pointed at. Escaped
  // because a repo directory name is not trusted markup.
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const html = fs.readFileSync(P.ui, 'utf8')
    .replace('<title>build harness</title>', `<title>${esc(CONFIG.project)} — build harness</title>`)
    .replace('>build harness</h1>', `>${esc(CONFIG.project)} build harness</h1>`)
  const body = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(JSON.parse(b || '{}')) } catch { r({}) } }) })
  const broadcast = () => {
    const d = `data: ${JSON.stringify(snapshot())}\n\n`
    for (const c of clients) { try { c.write(d) } catch { clients.delete(c) } }
  }

  http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`)
      clients.add(res); req.on('close', () => clients.delete(res)); return
    }
    if (url.pathname === '/inbox' && req.method === 'POST') {
      const { message } = await body(req)
      if (message?.trim()) say(message)
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); broadcast(); return
    }
    if (url.pathname === '/control' && req.method === 'POST') {
      const { action } = await body(req)
      try {
        if (action === 'pause') fs.writeFileSync(P.paused, '')
        else if (action === 'resume') fs.rmSync(P.paused, { force: true })
        else if (action === 'clear-inbox') fs.rmSync(P.inbox, { force: true })
        else if (action === 'start') cmdStart()
        else if (action === 'stop') cmdStop()
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); broadcast(); return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html)
  }).listen(CONFIG.uiPort, () => console.log(`harness ui → http://localhost:${CONFIG.uiPort}`))

  await poll()
  setInterval(async () => { if (await poll()) broadcast() }, 500)
}

// ──────────────────────────────────────────────────────────── control
function say(message, { supervisor = false } = {}) {
  ensureDirs()
  const line = message.trim().replace(/\n/g, ' ')
  fs.appendFileSync(P.inbox, (supervisor ? SUPERVISOR_PREFIX : '') + line + '\n')
}

// A context nudge is only meaningful to the session that earned it. If the
// ceiling is crossed on the last assistant turn there is no further PreToolUse
// to drain it, and the line would otherwise be delivered to the NEXT session —
// which would receive "CONTEXT CEILING (140k)" while sitting at 5k and, per
// drainInbox's framing, dutifully stop. Dropped at tick start; anything Adi
// actually typed is left alone.
function dropStaleSupervisorLines() {
  let lines
  try { lines = fs.readFileSync(P.inbox, 'utf8').split('\n').filter(l => l.trim()) } catch { return 0 }
  const keep = lines.filter(l => !isStaleSupervisorLine(l))
  if (keep.length === lines.length) return 0
  fs.writeFileSync(P.inbox, keep.length ? keep.join('\n') + '\n' : '')
  return lines.length - keep.length
}

function plistXml() {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const argv = [process.execPath, path.join(HERE, 'harness.mjs'), 'tick']
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${CONFIG.label}</string>
  <key>ProgramArguments</key>
  <array>
${argv.map(a => `    <string>${esc(a)}</string>`).join('\n')}
  </array>
  <key>StartInterval</key><integer>${CONFIG.intervalSec}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${esc(P.launchdOut)}</string>
  <key>StandardErrorPath</key><string>${esc(P.launchdErr)}</string>
</dict>
</plist>
`
}
function cmdInstall() {
  ensureDirs()
  fs.mkdirSync(path.dirname(P.plist), { recursive: true })
  fs.writeFileSync(P.plist, plistXml())
  console.log(`wrote ${P.plist}`)
}
function launchctl(...args) { try { execFileSync('launchctl', args, { stdio: 'pipe' }) } catch {} }
function cmdStart() { fs.rmSync(P.stopped, { force: true }); cmdInstall(); launchctl('unload', P.plist); launchctl('load', '-w', P.plist); console.log('scheduler armed') }
function cmdStop() { ensureDirs(); fs.writeFileSync(P.stopped, ''); launchctl('unload', '-w', P.plist); console.log('scheduler stopped') }

// Exactly the gate cmdTick applies, with no side effects — so the decision can
// be inspected before trusting it, and the post-reset resume path can be
// verified without spending a session to find out.
function nextTickDecision() {
  // Whether launchd is loaded is a separate fact from what the gate would
  // decide, and reporting it as a short-circuit hides the thing worth seeing.
  const note = schedulerState() === 'unloaded' ? ' [launchd not loaded — harness start]' : ''
  // A blocker halts the agent at step 1 regardless of what the gate decides, so
  // reporting the gate alone would be a lie: `status` would say RUN while every
  // session started, re-read the blocker and stopped.
  const bud = budgetState()
  if (bud.exhausted) return `never — budget cap reached ($${bud.since.toFixed(2)} of $${bud.cap})${note}`
  if (exists(P.blocked)) return `RUNS BUT HALTS — ${path.relative(REPO, P.blocked)} present${note}`
  if (exists(P.stopped)) return `never — stop marker set${note}`
  if (exists(P.paused)) return `never — paused (harness resume)${note}`
  const cd = readCooldown()
  // Mirrors cmdTick's cooldown gate, including the window_reset buy-through.
  if (cooldownHolds(cd)) {
    return `skip — in cooldown until ${new Date(cd.until * 1000).toLocaleTimeString()} (${cd.reason})${note}`
  }
  // Must use the same trust rule as cmdTick (:~246). It previously hardcoded
  // the pre-rename 'rate_limit' spelling, so `status` could report a skip where
  // the real tick would run — and the post-change validation now depends on
  // this line being right.
  const trust = cd.until > 0 && isAuthoritativeReason(cd.reason)
  const u = checkUsage({ trustExpiredCooldown: trust })
  if (!u.ok && canBuyThrough(u)) {
    return `RUN — 5h window spent (${u.fivePct}%), buying through on paid credits`
      + `, free again ${new Date(u.resumeAt * 1000).toLocaleTimeString()}${note}`
  }
  return (u.ok
    ? `RUN — ${u.reason || `5h ${u.fivePct}% under floor ${CONFIG.usageFloorPct}%`}`
    : `skip — ${u.reason}, until ${new Date(u.resumeAt * 1000).toLocaleTimeString()}`) + note
}

// ────────────────────────────────────────────────────────── live metering
const ago = sec => sec < 90 ? `${sec}s ago` : sec < 5400 ? `${Math.round(sec / 60)}m ago` : `${(sec / 3600).toFixed(1)}h ago`
const clock = sec => sec ? new Date(sec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'

/**
 * Everything knowable about the current cost position, in one object.
 *
 * Deliberately shared between `harness usage` (for Adi) and the session
 * preamble (for the agent). They were never going to stay in step as two
 * implementations, and an agent told a different number than the dashboard
 * shows is worse than an agent told nothing.
 */
function meterState() {
  const u = checkUsage()
  const now = nowSec()
  const runs = readCostRecords().filter(r => r.exit === 0 && (r.turns || 0) >= 5)
  const recent = runs.slice(-10)
  const sum = (rs, f) => rs.reduce((a, r) => a + (f(r) || 0), 0)
  // Only runs that produced a settled `result` usage block are counted. A run
  // that died mid-flight has zeros, and averaging those in would report the
  // fleet as cheaper than it is.
  const tok = recent.map(r => r.tokens).filter(t => t?.measured)
  const billedIn = sum(tok, t => t.input) + sum(tok, t => t.cache_read) + sum(tok, t => t.cache_write)
  return {
    u,
    ageSec: u.readingAt ? now - u.readingAt : null,
    runs: runs.length,
    recent: recent.length,
    measured: tok.length,
    out: sum(tok, t => t.output),
    subagents: sum(tok, t => t.subagents),
    cacheHit: billedIn ? sum(tok, t => t.cache_read) / billedIn : null,
    costPerRun: recent.length ? sum(recent, r => r.cost_usd) / recent.length : 0,
    paid: paidCreditSpendUsd(),
    budget: budgetState(),
  }
}

function cmdUsage(argv) {
  const m = meterState()
  if (argv.includes('--json')) { console.log(JSON.stringify(m)); return }
  const stale = m.ageSec === null ? 'NO READING'
    : m.ageSec > 3600 ? `${ago(m.ageSec)} — STALE, treat as a floor not a fact`
    : ago(m.ageSec)
  console.log(`reading     ${stale}, from the ${m.u.source === 'stream' ? 'live stream' : m.u.source}`)
  console.log(`5-hour      ${m.u.fivePct}% used, resets ${clock(m.u.fiveResetsAt)}   (included — free)`)
  console.log(`7-day       ${m.u.sevenPct}% used, resets ${clock(m.u.sevenResetsAt)}`)
  console.log(`paid        est $${m.paid.toFixed(2)} of $${CONFIG.creditCapUsd} credit cap`
    + `${CONFIG.allowOverage ? '' : '  (overage refused — sessions wait for the reset)'}`)
  console.log(`budget      $${m.budget.since.toFixed(2)} of $${m.budget.cap} notional`)
  if (!m.measured) { console.log(`tokens      not yet measured (${m.recent} recent run(s) predate metering)`); return }
  const pct = n => `${Math.round(n * 100)}%`
  console.log(`tokens      ${(m.out / 1000).toFixed(0)}k out over ${m.measured} measured run(s)`)
  console.log(`cache       ${m.cacheHit === null ? '—' : pct(m.cacheHit)} of input served from cache`
    + `${m.cacheHit !== null && m.cacheHit < 0.8 ? '  ← LOW, something is busting the prefix' : ''}`)
  console.log(`subagents   ${m.subagents} spawned — the dominant cost driver, ~$0.86 each`)
  console.log(`cost/run    $${m.costPerRun.toFixed(2)} average`)
}

/**
 * The same numbers, compressed to what the agent needs to make one decision:
 * whether the next unit of work is free, paid, or should not be started.
 *
 * Kept short on purpose. This block is prepended to every session prompt, and
 * a preamble that grows is a preamble that costs on every turn.
 */
function meterPreamble() {
  const m = meterState()
  const age = m.ageSec === null ? 'no reading' : ago(m.ageSec)
  const free = !m.u.ok ? 'the window is spent'
    : m.u.fivePct >= 90 ? `only ${100 - m.u.fivePct}% of the free 5-hour allowance is left`
    : `${100 - m.u.fivePct}% of the free 5-hour allowance remains`
  return `LIVE ACCOUNT POSITION (${age}, source: ${m.u.source})

  5-hour ${m.u.fivePct}% used, resets ${clock(m.u.fiveResetsAt)} · 7-day ${m.u.sevenPct}% used
  Paid credits: est $${m.paid.toFixed(2)} of the $${CONFIG.creditCapUsd} cap.
  Right now, ${free}.

  Run \`node scripts/harness/harness.mjs usage\` at any point to re-read this.
  It is the real meter, not an estimate — spend accordingly. Work done inside
  the 5-hour allowance is free; work past it is billed against the cap above.
  Subagents are the dominant cost driver here, measured at roughly $0.86 each,
  so delegate to protect this context, not out of habit.`
}

function cmdStatus() {
  const u = checkUsage()
  const cd = readCooldown()
  const runs = (() => { try { return fs.readdirSync(P.runs).length } catch { return 0 } })()
  console.log(`scheduler   ${schedulerState()}`)
  console.log(`usage       5h ${u.fivePct}%  7d ${u.sevenPct}%  (floor ${CONFIG.usageFloorPct}%)`)
  console.log(`cooldown    ${cd.until > nowSec() ? `${new Date(cd.until * 1000).toLocaleTimeString()} (${cd.reason})` : 'none'}`)
  if (CONFIG.persistentSession) {
    const sid = readOrchestrator()
    const who = attachedPid()
    console.log(`orchestrator ${sid ? `${sid.slice(0, 8)} (harness chat to talk to it)` : 'none yet — first tick or `harness chat` opens one'}`
      + (who ? `  ATTACHED pid ${who}, scheduler held off` : ''))
  }
  const idle = readIdleStreak()
  if (idle > 0) {
    const wait = idleBackoffSec({ streak: idle, baseSec: CONFIG.intervalSec, capSec: CONFIG.idleBackoffCapSec })
    console.log(`idle streak ${idle} session(s) shipped nothing — backing off to ${Math.round(wait / 60)}m`
      + (wait >= CONFIG.idleBackoffCapSec ? ' (at cap; the backlog is probably empty)' : ''))
  }
  console.log(`model       ${CONFIG.model} → ${CONFIG.fallbackModel}, max ${CONFIG.maxUnits} unit(s)/session`)
  console.log(`today       $${todayCost().toFixed(4)} across ${runs} run(s)`)
  const bud = budgetState()
  const pctBudget = Math.round((bud.since / bud.cap) * 100)
  const flag = bud.exhausted ? '  ← CAP REACHED, will not start'
    : pctBudget >= 80 ? '  ← approaching cap' : ''
  console.log(`budget      $${bud.since.toFixed(2)} of $${bud.cap} allowance (${pctBudget}%), `
    + `$${bud.remaining.toFixed(2)} left${flag}`)
  console.log(`            lifetime $${bud.total.toFixed(2)}${bud.baseline ? `, baseline $${bud.baseline.toFixed(2)}` : ' (no baseline set)'} (notional API-equivalent, NOT credits)`)
  const cr = creditState()
  if (cr.known) {
    const mode = CONFIG.allowOverage
      ? `allowed up to est $${CONFIG.creditCapUsd} USD`
      : 'REFUSED — sessions stop at the plan limit and resume free after reset'
    const paid = paidCreditSpendUsd()
    console.log(`credits     est $${paid.toFixed(2)} USD spent on paid credits by this harness `
      + `${cr.enabled ? '(enabled)' : '(disabled)'}`)
    console.log(`            account meter reads ${cr.fmt(cr.usedMinor)} of ${cr.fmt(cr.limitMinor)} `
      + `— UNRELIABLE, check billing UI for the real figure`)
    console.log(`            paid overage: ${mode}`)
  }
  if (exists(P.blocked)) {
    let age = ''
    try {
      const hrs = (Date.now() - fs.statSync(P.blocked).mtimeMs) / 3.6e6
      age = hrs >= 1 ? ` (${hrs.toFixed(1)}h old)` : ` (${Math.round(hrs * 60)}m old)`
    } catch {}
    let first = ''
    try { first = (fs.readFileSync(P.blocked, 'utf8').split('\n')[0] || '').replace(/^#+\s*/, '').slice(0, 60) } catch {}
    console.log(`BLOCKED     ${path.relative(REPO, P.blocked)}${age} — ${first}`)
    console.log(`            every session will halt at step 1 until this file is deleted`)
  }
  const pend = pendingInbox()
  if (pend.length) console.log(`inbox       ${pend.length} undelivered: ${pend.join(' · ')}`)
  console.log(`next tick   ${nextTickDecision()}`)
}

// ─────────────────────────────────────────────────────────────── dispatch
const [cmd, ...rest] = process.argv.slice(2)
switch (cmd) {
  case 'tick': await cmdTick(); break
  case 'hook': await cmdHook(); break
  case 'ui': await cmdUi(); break
  case 'chat': case 'attach': await cmdChat(rest); break
  case 'say': say(rest.join(' ')); console.log('queued for delivery'); break
  case 'sprint': await cmdSprint(); break
  case 'budget': cmdBudget(rest[0]); break
  case 'status': cmdStatus(); break
  case 'usage': cmdUsage(process.argv.slice(3)); break
  case 'pause': ensureDirs(); fs.writeFileSync(P.paused, ''); console.log('paused'); break
  case 'resume': fs.rmSync(P.paused, { force: true }); console.log('resumed'); break
  case 'start': cmdStart(); break
  case 'stop': cmdStop(); break
  case 'install': cmdInstall(); break
  default:
    console.log(`usage: harness <command>

  chat            talk to the orchestrator — the real Claude Code TUI, on the
                  same session the scheduler drives
  tick            run one build session   (launchd calls this)
  hook            Claude Code hook target (settings.json calls this)
  ui              live dashboard on :${CONFIG.uiPort} + message channel
  say <message>   send a message to the running agent
  status          one-screen summary
  usage           live cost meter — window, credits, tokens, cache (--json)
  pause | resume  skip ticks without unloading launchd
  start | stop    load / unload the launchd job
  install         (re)write the launchd plist from CONFIG`)
    process.exit(cmd ? 1 : 0)
}
