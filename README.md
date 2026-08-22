# agent-build-harness

An unattended build harness for [Claude Code](https://claude.com/claude-code). Point it at a
git repository, and it wakes on a schedule, runs a build session, watches what the session
does, meters what it spends, and parks itself with a reason when it should stop.

Zero dependencies. Node ≥ 22 and the `claude` CLI are the whole install.

```
harness install     # write the launchd job
harness start       # arm it
harness ui          # live dashboard at :4317
harness status      # one screen: usage, budget, cooldown, next tick
```

---

## Why this exists

Running an agent unattended is not hard. Running one unattended *without it quietly wasting
money* is, and most of the difficulty is in questions that only show up after a few hundred
real sessions:

- The run failed — was that a rate limit, a dead connection, or a revoked key? Each wants a
  completely different backoff, and getting it wrong is expensive in both directions.
- The session says it finished the work. Did it? Its own summary is not evidence.
- The backlog is empty. How would the scheduler know, and what should it do about it?
- Context is filling up. Stop now and lose the thread, or continue and pay a worse rate?
- The 5-hour allowance is spent. Wait for the reset, or spend real money to keep going?

Every threshold in `src/harness.mjs` carries a comment recording what it was, what it is,
and what measurement changed it. The interesting parts of this repo are those comments.

## What it does

| | |
|---|---|
| **Schedules** | launchd fires `harness tick`; one session per tick, `sprint` runs them back-to-back |
| **Gates spending** | refuses to start below a usage-window floor, and stops dead at a hard dollar cap measured from a stamped baseline |
| **Refuses paid credits by default** | on a Pro plan the 5-hour allowance is included, so credits buy something that waiting gets for free. `allowOverage` opts in when a deadline is worth the money |
| **Meters honestly** | token counts come from the settled `result` event, not from streaming snapshots — summing those undercounted output by ~87× while double-counting cached input by 2.3× |
| **Watches context** | warns the running session at 70k main-thread tokens and tells it to hand off at 90k, subagent context deliberately excluded |
| **Re-pins rules after compaction** | a summary is a claim, not evidence; the non-negotiables are re-injected through `PreToolUse`, which actually reaches a running session |
| **Backs off when idle** | the wait doubles for every session that ships nothing, so an empty backlog stops costing money |
| **Observes** | a live dashboard with the agent tree, and a message channel — `harness say "..."` reaches the running session |

## Install

```bash
git clone https://github.com/aditya-029/agent-build-harness
cd agent-build-harness && npm link      # or call src/harness.mjs directly
```

In the repository you want built, create `.harness.json` and a prompt:

```jsonc
// .harness.json — every key optional, see examples/harness.json for all of them
{
  "project": "My Project",
  "journalPath": "logs/journal.jsonl",
  "budgetCapUsd": 40,
  "compactRules": [
    "Never delete or weaken a failing test to go green.",
    "src/schema.ts is the single source of truth for every literal."
  ]
}
```

```bash
echo "You are the PM for this repo. Read CLAUDE.md ..." > .harness-prompt.md
harness budget 40      # stamp the spend baseline the cap counts from
harness install && harness start
```

The harness finds its target from `$HARNESS_REPO`, else the git root of `$PWD`. It never
writes to its own checkout — all state lives in `<target>/.harness/`.

### Wire up the hook (optional but recommended)

Without it, the harness sees only the run's final result — no live cost, no context
watching, no message delivery. In the target repo's `.claude/settings.json`:

```json
{ "hooks": { "PreToolUse":  [{ "hooks": [{ "type": "command", "command": "/path/to/src/hook.sh" }] }],
             "PreCompact":  [{ "hooks": [{ "type": "command", "command": "/path/to/src/hook.sh" }] }] } }
```

`hook.sh` fails open by construction — every path exits 0. Claude Code reads hook exit code 2
as "block this tool call", and a missing interpreter exits 2 on its own, which once refused
every tool call in a session including the ones needed to repair the config.

## The three failure buckets

Everything a run can end as, and what each one costs:

| Bucket | Signature | Response |
|---|---|---|
| `ok` | no error | run again next interval — unless nothing shipped, see below |
| `window_limit` | HTTP 429 **and** a rejected `rate_limit_event` | resume at the window's own `resetsAt`. Not a fault; it is the expected end of a productive session |
| `transient` | `api_error`, **no** HTTP status, transport-shaped message | short retry. The connection dropped; the account is fine |
| `error` | anything else | 30-minute backoff. Deliberately the fallback, so an unrecognised failure gets the conservative treatment |

That third bucket was missing for weeks. Five runs died to `Connection closed mid-response`
and each bought a full 30-minute park — about 2.5 hours of dead scheduler time for a fault a
retry clears in seconds. `isTransientFailure()` is deliberately narrow: it requires the
absence of any HTTP status at all, so a 401 or a 500 keeps the long backoff. A new transport
phrasing is treated as a hard error until someone adds it, which is the safe direction to be
wrong in.

## Idle backoff

Measured across 143 recorded runs from the project this was built for: 100 finished
successfully and **21 of them did nothing at all**. They are the tail of the log and they say
so out loud — *"this is the 23rd consecutive session confirming the MVP is complete."*

```
21 idle sessions · $8.38 · 87,632 output tokens spent to say "there is nothing to do"
$0.399 each, against $2.351 for a session that shipped something
```

The dollar figure is not the point. The point is that it does not converge: an empty backlog
costs about $38/day, forever, and nothing in the system could notice. A fixed interval is
right for a busy queue and wrong for an empty one.

So the wait now doubles per session that ships nothing — 15m, 30m, 1h, 2h, 4h — capped at 6h
so a finished project still notices new work within a shift. The first session that ships
something resets it to zero.

Work is measured from the **git tree**, not from the agent's own report. And not merely by
HEAD moving: the loop requires every session to commit a journal line, so a HEAD check alone
would never fire. `bookkeepingPaths` names the paths that do not count as work.

An `idle` cooldown is never bought through with paid credits. Buying through would purchase
the privilege of rediscovering there is no work, sooner.

## Tests

```bash
npm test          # 198 assertions
npm run test:stress
```

Three things worth noting about the suite:

**It imports the real decision logic.** `classify.mjs` exists as a separate module precisely
so the tests cannot re-derive the rule. A test that re-implements the thing it is testing
agrees with whatever it was copied from — which is exactly how the original rate-limit
misclassification survived for weeks.

**It replays real recorded runs.** 58 scrubbed sessions in `test/fixtures/runs`, covering
every bucket above. See `test/fixtures/README.md` for what was removed.

**It proves its own containment.** The harness writes to the same inbox a live session reads.
The last section of the suite asserts that no test wrote anything into a real project's state.

### One test worth reading

The replay suite used to assert *"every failed run is a window limit"*. That was true when it
was written, and it went red the first time a third failure mode reached production. It was
the wrong property to assert: a genuine fatal error **should** classify as an error, so the
assertion could only ever be satisfied by the continued absence of one.

It now asserts the partition is exhaustive, that each bucket is correctly populated, and that
nothing unexamined has accumulated in the punitive bucket — properties that survive new
failure modes appearing, and fail loudly if one is swallowed into the wrong place.

## Limits

- **macOS only** for scheduling. `launchctl` is load-bearing; the rest is portable, and a
  systemd unit or a cron line calling `harness tick` would work on Linux.
- **Requires Claude Code ≥ 2.1.220** for `--strict-mcp-config`, and ≥ 2.1.211 for
  `--forward-subagent-text`.
- **Subscription-shaped.** The gating logic assumes a plan with a rolling allowance plus
  optional paid credits. On pure pay-as-you-go, `budgetCapUsd` is the only limit that means
  anything.
- **Not a substitute for supervision.** It is a good way to run the *build* of a project
  unattended. It should never be the thing that performs an outward-facing, irreversible
  action — sending, publishing, purchasing, submitting. Those want a human at the gate, and
  no scheduler is one.

## Licence

MIT.
