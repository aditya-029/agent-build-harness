# Replay fixtures

58 recorded Claude Code runs from a real unattended build (MOCK_PTE, Jul–Aug 2026),
**scrubbed**. `test/harness.test.mjs` replays them through the real `classifyRun()`.

## Why they are committed

The classifier's whole reason for existing is a bug that unit tests could not
catch: the rule was misread for weeks, and every test agreed with it because
every test had been derived from the same misreading. Replaying real recorded
runs is the only check that does not share that blind spot.

The originals live in `<repo>/.harness/runs`, which is machine-local and
gitignored. A replay suite that skips itself on a fresh clone is a suite nobody
runs, so a scrubbed set ships with the repo instead.

## What was removed

Each event was reduced to the fields the classifier actually reads:

- `result` → `is_error`, `subtype`, `terminal_reason`, `api_error_status`,
  `num_turns`, `result`
- `rate_limit_event` → `status`, `resetsAt`, `rateLimitType`, `isUsingOverage`,
  `overageStatus`, `utilization`

Everything else — assistant text, thinking, tool calls, file paths, diffs, costs,
session ids, and all project content — was dropped, not redacted.

`result` messages are replaced with `[scrubbed: session output]` **except** the
two that carry classification meaning, which are kept verbatim to the first 90
characters:

- `API Error: Connection closed mid-response.` — the transient bucket
- `You've hit your session limit · resets <time>` — the window bucket

A fixture whose message has been paraphrased no longer tests the regex that
reads it, which would make the suite pass for the wrong reason.

## What is in the set

| Bucket | Runs | Why kept |
|---|---|---|
| `window_limit` | 30 | the common failure; every one carries a real `resetsAt` |
| `transient` | 5 | the 07–11 Aug dropped connections that motivated the third bucket |
| `incomplete` | 1 | a run that died before emitting a `result` event |
| `ok` | 15 | evenly sampled, so a false positive in the classifier shows up |

Failures are kept in full. Successes are sampled — 107 near-identical clean runs
prove nothing 15 do not.
