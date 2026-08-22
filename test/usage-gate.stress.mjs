/**
 * Acceptance test for the usage gate.  `npm run harness:stress`
 *
 * WHY THIS EXISTS. On 2026-08-03 the build sat idle for nine hours while six
 * consecutive ticks started, checked usage, refused, and stopped — about $0.36
 * each, producing nothing. The window was not actually spent. The gate was
 * deadlocked against itself:
 *
 *   cmdTick calls checkUsage({ consumeProbe: true }) and, being the only caller
 *   permitted to spend the probe, writes `last_probe = now` to authorise the
 *   launch. The session it launches then runs `harness.mjs usage` — which reads
 *   that same stamp, finds the 30-minute throttle freshly spent, and returns
 *   `ok:false, reason: "stale cache, probe throttled"`. The act of authorising
 *   the session is the act that guarantees the session's own gate refuses.
 *
 * Nothing clears it, because only a real session refreshes the cached reading
 * and that is exactly what is being withheld. It is the same shape as the two
 * livelocks already documented in checkUsage() — a verdict that renews itself.
 *
 * These scenarios drive the REAL harness in a sandbox with a crafted
 * $HOME/.claude.json, so every verdict is the shipped code path. Fixtures use
 * observedUsage()'s actual record shape ({at, util 0-1, kind, resets_at}); an
 * earlier draft of this file guessed the shape, every line was skipped, and the
 * safety rows passed vacuously. If you change the fixtures, re-read
 * observedUsage() first.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '../src')
const HOUR = 3600
const NOW = () => Math.floor(Date.now() / 1000)

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-gate-'))
  const hdir = path.join(root, 'harness')
  fs.mkdirSync(hdir, { recursive: true })
  for (const f of ['harness.mjs', 'classify.mjs']) {
    fs.copyFileSync(path.join(SRC, f), path.join(hdir, f))
  }
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  // The harness targets HARNESS_REPO; `root` is a throwaway tree, so nothing
  // this test does can reach a real project.
  fs.writeFileSync(path.join(root, '.harness-prompt.md'), 'test\n')
  return { root, home, h: path.join(hdir, 'harness.mjs') }
}

function writeCache(home, { five, seven, fiveResetsIn, sevenResetsIn, ageSec }) {
  const now = NOW()
  const iso = (o) => new Date((now + o) * 1000).toISOString()
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    cachedUsageUtilization: {
      fetchedAtMs: (now - ageSec) * 1000,
      utilization: {
        five_hour: { utilization: five, resets_at: iso(fiveResetsIn) },
        seven_day: { utilization: seven, resets_at: iso(sevenResetsIn) },
      },
    },
  }))
}

function setProbe(root, agoSec) {
  const d = path.join(root, '.harness')
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'last_probe'), String(NOW() - agoSec))
}

/** Shape MUST match observedUsage(): {at, util 0-1, kind, resets_at}. */
function writeObserved(root, rows) {
  const d = path.join(root, '.harness')
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'usage.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

function ask(sb) {
  try {
    const out = execFileSync('node', [sb.h, 'usage', '--json'], {
      encoding: 'utf8', env: { ...process.env, HOME: sb.home, HARNESS_REPO: sb.root }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    return JSON.parse(out).u
  } catch (e) {
    return { ok: 'ERROR', reason: String(e.message).slice(0, 80) }
  }
}

const STALE_ROLLED_OVER = { five: 100, seven: 86, fiveResetsIn: -2 * HOUR, sevenResetsIn: 4 * 24 * HOUR, ageSec: 5.8 * HOUR }

const CASES = [
  {
    name: 'deadlock: stale cache, reset passed, probe just spent by our launcher',
    cache: STALE_ROLLED_OVER, probeAgo: 0, want: true,
    why: 'the window\'s own reset passed 2h ago and nothing has run since — it rolled over',
  },
  {
    name: 'deadlock persists at step 9, 25 min into the same session',
    cache: STALE_ROLLED_OVER, probeAgo: 1500, want: true,
    why: 'a fix that only covers the first seconds of a session still truncates it',
  },
  {
    name: 'safety: 5h genuinely spent, reset still ahead',
    cache: { five: 100, seven: 50, fiveResetsIn: 2 * HOUR, sevenResetsIn: 4 * 24 * HOUR, ageSec: 60 },
    probeAgo: 0, want: false, why: 'must never launch into a window that has not rolled over',
  },
  {
    name: 'safety: 7-day limit spent, days from reset',
    cache: { five: 10, seven: 100, fiveResetsIn: HOUR, sevenResetsIn: 3 * 24 * HOUR, ageSec: 60 },
    probeAgo: 0, want: false, why: 'the weekly limit is the one paid credits cannot remove',
  },
  {
    name: 'safety: reset passed BUT metering recorded a refill after it',
    cache: STALE_ROLLED_OVER, probeAgo: 0, want: false,
    observed: () => {
      const now = NOW()
      return [
        { at: now - 600, util: 1.0, kind: 'five_hour', resets_at: now + 4 * HOUR, session_id: 'refill' },
        { at: now - 600, util: 0.86, kind: 'seven_day', resets_at: now + 4 * 24 * HOUR, session_id: 'refill' },
      ]
    },
    why: 'a newer whole reading outranks the stale one and its reset is ahead',
  },
  {
    name: 'unchanged: fresh cache whose reset just passed',
    cache: { five: 100, seven: 50, fiveResetsIn: -30, sevenResetsIn: 4 * 24 * HOUR, ageSec: 60 },
    probeAgo: 0, want: true, why: 'existing freshCacheSec branch must keep working',
  },
  {
    name: 'unchanged: ample headroom',
    cache: { five: 20, seven: 30, fiveResetsIn: 3 * HOUR, sevenResetsIn: 4 * 24 * HOUR, ageSec: 60 },
    probeAgo: 0, want: true, why: 'nothing tripped',
  },
  {
    name: 'unchanged: stale cache with the 30-min probe available',
    cache: STALE_ROLLED_OVER, probeAgo: 2000, want: true, why: 'the pre-existing escape hatch',
  },
]

let failed = 0
console.log('\nusage gate — acceptance\n')
for (const c of CASES) {
  const sb = sandbox()
  writeCache(sb.home, c.cache)
  setProbe(sb.root, c.probeAgo)
  if (c.observed) writeObserved(sb.root, c.observed())
  const u = ask(sb)
  const ok = u.ok === c.want
  if (!ok) failed++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.name}`)
  if (!ok) console.log(`        want ok:${c.want}, got ok:${u.ok} (${u.reason})\n        ${c.why}`)
  fs.rmSync(sb.root, { recursive: true, force: true })
}

// A gate that recovers once is not fixed — the cache stays stale until a session
// actually runs, so every tick in the dead window must be able to work.
const sb = sandbox()
writeCache(sb.home, STALE_ROLLED_OVER)
let worked = 0
for (let i = 0; i < 10; i++) {
  setProbe(sb.root, 0) // the supervisor spends the probe on every launch
  if (ask(sb).ok === true) worked++
}
fs.rmSync(sb.root, { recursive: true, force: true })
const sustained = worked === 10
if (!sustained) failed++
console.log(`  ${sustained ? 'PASS' : 'FAIL'}  sustained: 10 consecutive ticks in a dead window`)
if (!sustained) console.log(`        ${worked}/10 could work; a one-shot recovery leaves the build idle`)

console.log(`\n  ${failed === 0 ? 'usage gate OK' : `${failed} FAILING`}\n`)
process.exit(failed === 0 ? 0 : 1)
