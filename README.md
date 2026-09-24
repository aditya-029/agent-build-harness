# agent-build-harness

An unattended, cross-model build harness for Claude Code and OpenAI Codex. Point it at a git
repository and it can run a governed development session, preserve handoff context, observe
what shipped, accept human steering, and park itself with a reason when it should stop.

Zero runtime dependencies. Node ≥ 22 plus the provider CLI you select are the whole install.

```
harness install     # write the launchd job
harness start       # arm it
harness chat        # TALK TO IT — the provider's real TUI, on the session
                    # the scheduler is driving. No second reasoning agent.
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

## One orchestrator you can talk to

Most unattended harnesses spawn a fresh agent per tick and let it exit. That leaves nothing
to *address*: to steer the build you open a **second** interactive session that reads the
logs and relays on your behalf — a translator between you and your own agent.

This one keeps a single orchestrator conversation. Every tick resumes it, so context carries
over and no tick pays a cold start. Both supported CLIs persist headless sessions, so the
harness can resume the same provider thread interactively:

```
$ harness chat
attaching to the orchestrator (1d9f1792) — the same session the scheduler drives
scheduler is held off while you are attached. Exit to hand it back.
```

That is the provider's **real TUI**, with its own commands and history, on the exact
conversation the harness has been driving. Nothing here proxies or reimplements the interface.
Claude can create a fresh session from `harness chat`; Codex assigns thread IDs itself, so one
manual `harness tick` must create the thread before the first Codex attachment.

The scheduler and the keyboard are mutually exclusive: a tick will not run while you are
attached, and `chat` refuses to start on top of a running tick. Two writers on one transcript
would interleave the conversation into nonsense. A crashed `chat` cannot wedge the scheduler,
because the marker carries a PID that is checked for liveness.

Measured on two consecutive ticks against the same repo:

```
tick 1  new session   $0.0277   2 turns    ← cold start: read the brief, orient
tick 2  resumed       $0.0063   1 turn     ← already knew where it was
```

**Rotation.** Persistence must not defeat the context discipline the rest of the harness
enforces. Past `rotateCtxTokens` the conversation is retired and the next tick opens a fresh
one, which re-orients from the journal line the old one wrote. The conversation is a stable
address; the session behind it rotates, and `harness chat` never has to know which is live.

Set `"persistentSession": false` to go back to spawn-per-tick.

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
| **Talks back** | `harness chat` opens the provider's real TUI on the orchestrator's own session — see above |

### Provider capabilities

The adapter does not pretend the two CLIs expose identical telemetry:

| Capability | Claude Code | Codex CLI |
|---|---:|---:|
| Persistent headless session + interactive resume | yes | yes |
| Live human steer while a run is active | hook inbox | native `codex queue` |
| Subscription-window and settled USD telemetry | yes | unavailable |
| Provider-native remote phone control | yes | not exposed here |
| Default unattended safety | `--permission-mode auto` | `--sandbox workspace-write` |

When telemetry is unavailable, status says **unavailable**, never `$0`. Unit, context,
verification, breaker, approval, and idle gates still operate. See
[the cross-model operating model](docs/CROSS-MODEL-OPERATING-MODEL.md).

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
  "provider": "codex",
  "providers": {
    "claude": { "model": "sonnet", "fallbackModel": "haiku" },
    "codex": { "model": null, "sandbox": "workspace-write" }
  },
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
harness budget reset   # Claude only: stamp the spend baseline
harness install && harness start
```

The harness finds its target from `$HARNESS_REPO`, else the git root of `$PWD`. It never
writes to its own checkout — all state lives in `<target>/.harness/`.

### Wire up the Claude hook (Claude only; optional but recommended)

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

## Runaway guardrail

Every other gate here is **pre-flight** (usage floor, budget cap, cooldown — should a session
start?) or **post-mortem** (what did that session turn out to be?). Between them a running
session was unsupervised: it could spin on one tool call, or burn output at several times its
normal rate, for a whole context window, and the first the harness knew was the bill.

The breaker watches a live session and escalates one rung per beat:

| | |
|---|---|
| `healthy` | nothing to say |
| `steering` | a message asking what is going on — the agent may have a good reason |
| `constrained` | an instruction to land: commit what is verified, journal, stop |
| `stopped` | kill the process — **off unless `hardStop` is set** |

It trips on a tool call repeated identically, an api-error storm, no distinct tool call for
ten minutes, a per-session dollar cap, or sustained output velocity. It de-escalates a rung
per healthy beat, so a blip does not stick.

Three details that are easy to get wrong and are therefore tested:

- **Velocity is the diff of two cumulative samples**, never one sample read as an increment.
- **Compaction is exempt.** It burns a burst of output while touching nothing — the exact
  shape of a false positive.
- **Enforcement below `stopped` is a message**, delivered through the same inbox a human
  `harness say` uses, so the agent can answer or disagree rather than being cut off.

## Durable memory

Sessions rotate at the context ceiling, so everything the retired session knew is lost —
previously all that carried over was one journal line. `.harness-memory.md` is a bounded
markdown file the agent reads at session start and appends to as it learns:

```
## Pinned     durable facts. Never evicted, never rewritten, never trimmed to fit.
## Notes      newest-first working memory. Bounded by count and by bytes.
```

Eviction is **lossless** — overflow moves to `.harness-memory.archive.md`, which the agent
can grep. Nothing is summarised, so nothing can be summarised wrongly. A memory file that
does not have these headings is left byte-for-byte alone rather than restructured.

## Reaching it from your phone

`harness chat` spawns a real interactive Claude Code session, so it can carry Claude Code's
own Remote Control flag. That is the whole answer to "I am not at my Mac" — the orchestrator
registers itself and the Claude app reaches **this** session, the same one the scheduler
drives. No bespoke UI, no auth layer, nothing listening on a non-loopback port.

```json
{ "remoteControl": true, "remoteName": "JARVIS" }
```

Off by default. The harness no longer enables `--dangerously-skip-permissions` by default;
an unsafe bypass requires the explicit `unsafeBypass` project setting.

## The brief

A brief has four parts, and one of them is load-bearing:

| | |
|---|---|
| **Goal** | the outcome, not the steps. Steps make the orchestrator a slow keyboard |
| **Constraints** | what must not change, where the work lives, conventions to follow |
| **Budget** | what the work is worth |
| **Deliverable** | the artifact that proves done |

```bash
harness brief init     # writes the template
harness brief          # refuses if Goal or Deliverable is missing
```

Goal and Deliverable are required; the other two warn, because "none" is a real answer and
the harness already carries its own dollar cap. A brief with no artifact in it is the
cheapest way to lose a night of tokens — the agent does not stall, it confidently builds the
wrong thing and reports success. Free-prose briefs warn rather than block, so an existing
install still runs after upgrading.

## Claims cost a command

Generating a claim is cheaper than checking one, so an unpressured agent drifts to the cheap
path — not from dishonesty, from economics. A confident "✅ all tests pass" that nobody ran
is more expensive than an error, because you trust it.

Every session is given the checklist (*did you run it or imagine it; did you verify the
symptom or just the change; what did you NOT check*), and the harness watches what a run
**claims** against what it actually **ran**. A green that nothing could have produced is
flagged on the run record and printed at the end.

Advisory, not blocking. A false positive that kills a good session costs more than the claim
it caught, and the breaker and the budget cap already own the hard stops.

## One writer for git

Git takes an exclusive `.git/index.lock` to stage or commit. That is fine for a person typing
one command; two agents finishing in the same second get contention, half-applied state, or —
worst — an orphaned lock from a killed process that blocks **every** future commit by anyone.

So agents write plain files and never run git. One process commits:

```bash
harness commit --path src/thing.mjs --path test/thing.test.mjs -- "feat: the thing"
```

Serialised, with retry and growing backoff, and **age-based stale-lock recovery** — a lock
untouched for ten seconds belongs to a dead process and is cleared before the attempt rather
than after the failure. A fixed identity with `commit.gpgsign=false`, so an unattended
committer can never hang on a signing prompt.

Autonomous workers must declare their paths. Broad `git add -A` is available only through an
explicit human-controlled `--all`, so one agent cannot silently sweep another agent's or the
operator's unrelated working-tree changes into its commit.

## Approvals

Every other stop here is the machine deciding it should not continue. This is the other case:
where it has no business deciding at all.

```bash
harness approvals                  # what is waiting on you
harness approve a001 "under $20"   # the condition travels to the agent
harness reject a001 "not this way"
```

Four things escalate — **destructive**, **spend**, **scope**, **conflict** — and everything
else stays autonomous, because a queue that catches everything is a queue nobody answers and
a stalled approval is a stalled build. The default when a case is genuinely ambiguous is
*ask*: a build that waits is recoverable, and `rm -rf` on the wrong directory at 3am is not.

The agent files a request with `harness ask` and is told explicitly **not** to block on it.
The queue is append-only — an answer is a new line, never an edit — so two terminals
answering at once cannot clobber each other.

## v2: a factory, not a timer

The launchd scheduler above wakes on an interval. v2 adds an event-driven runner that works
through an approved **unit queue** and is steered from any chat.

```bash
harness units                 # the queue: owner, status, what each unit waits on
harness run                   # build agent units in order until stopped
harness attach                # take over the live session (it lands first; autonomy pauses)
harness mcp                   # control-tower MCP server for Claude Code / Codex chats
harness mirror <prefix> --dry-run   # leak-gated public mirror of a monorepo folder
```

- **Unit queue** (`unitsPath`, JSON). Every unit has an owner (`agent` or `adi`),
  dependencies, and a runnable acceptance command. A unit without that command is refused
  when the queue loads. `adi` units are never started. Agent units that depend on one wait,
  and the runner picks something else in the meantime. `approval` gates a unit until
  `harness units approve <id>`.
- **Runner**. The next unit starts the moment the last one's acceptance command passes, with
  no interval. Each provider is asked for its own go/no-go (`harness gate`). If Claude's
  window is spent the unit goes to Codex. If both are spent, the runner parks until the
  **earliest** reset. Codex headroom is read live from its own session rollouts. When no
  reading exists, the gate reports "unknown", never zero. An attempt cut short by a spent
  window doesn't count against the unit's `maxAttempts`.
- **Control tower**. The MCP tools are `status`, `history`, `steer`, `approvals`, `approve`,
  `reject`, `pause`, `resume`, `units` and `approve_unit`. Build sessions run with
  `HARNESS_AGENT_SESSION=1`, and the operator-only actions refuse under it, whether they come
  through MCP or the CLI. Codex build sessions also run with the tower switched off, so an
  agent can't approve its own request.
- **Attach**. `harness attach` asks the running session to land, holds the runner, waits for
  the tick to exit, and then opens the provider TUI on that session. The runner resumes on
  detach. `chat` keeps the v1 behaviour and refuses while a tick is live.
- **Notifications** (`~/.config/harness/notify.json`, outside the repo). Approval, failure,
  blocked and parked events push immediately. A finished unit is batched, so three quick
  finishes arrive as one push. Routine progress only goes to the log. Channels are
  macOS (default), ntfy, and Telegram (the token is read from a file).
- **Mirrors**. `git subtree split` of a folder. The leak gate scans **every blob in history**
  for secrets, home paths, phone numbers and a private denylist. A secret deleted in a later
  commit still blocks the push. Deliberate fakes carry `leakgate:allow`. Dry runs are open to
  agents; pushing is operator-only. `--snapshot` (or `"mode": "snapshot"`) instead publishes the
  folder's current tree as one commit on top of the public branch. Nothing public is rewritten,
  and only that tree is scanned. This is the mode for a public repo whose history predates the
  monorepo.

## Tests

```bash
npm test
npm run test:stress
npm run test:v2      # units, runner, tower, attach, notifications, mirror — fake providers
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
- **Claude-specific metering requires Claude Code ≥ 2.1.220** for `--strict-mcp-config`, and
  ≥ 2.1.211 for `--forward-subagent-text`. Codex does not expose equivalent account-window or
  USD-cost events through `codex exec --json`, so the harness reports those controls as
  unavailable for Codex.
- **Provider auth must use CLI sign-in/keychain state.** The harness deliberately strips
  secret-shaped environment variables before spawning an agent. It never forwards the parent
  shell's API keys or CI tokens. A tick also refuses to start while a configured sensitive path
  such as `.env` exists inside the development workspace; it reports only the path, never values.
- **Not a substitute for supervision.** It is a good way to run the *build* of a project
  unattended. It should never be the thing that performs an outward-facing, irreversible
  action — sending, publishing, purchasing, submitting. Those want a human at the gate, and
  no scheduler is one.

## Prior art and attribution

The circuit-breaker policy in `src/breaker.mjs` and the memory shape in `src/memory.mjs` are
ported from **[Munder Difflin](https://github.com/chaitanyagiri/munder-difflin)** by Chaitanya
Giri (MIT) — a local multi-agent harness that solves the same problems for a floor of agents
rather than one. Its `src/main/breaker.ts` and `src/main/memory.ts` are worth reading. The
escalation ladder, the compaction exemption, the truncated tool key and the pinned/rolling
memory regions are all its ideas; the wiring here is this project's.

Two things were deliberately **not** taken:

- **Stop-hook forced continuation.** Its design doc presents this as the autonomous loop; its
  shipped code has it disabled, with the reason in a comment — it "could spend credits while a
  user was answering a question". A lesson available for free.
- **LLM-condensed memory and a semantic-recall CLI dependency.** Right at a floor of agents,
  wrong at one, and wrong for a tool whose selling point is zero dependencies. Eviction here
  is lossless and deterministic instead.

## Licence

MIT.
