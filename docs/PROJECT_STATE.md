# Project state

Updated: 2026-09-24

## Current phase

**Harness v2 complete (2026-09-24): F3–F8 done.** Next: production ApplyPilot, track A in
`docs/UNIT-QUEUE.md`. The factory runs at the monorepo root (`Cowork OS/.harness.json`,
queue `engine/unit-queue.json`).

## Completed in v2

- F4 unit queue (`src/units.mjs`): owners, dependencies, required acceptance command (refused without).
- F5 event-driven runner (`src/runner.mjs`, `harness run`): no interval; per-provider gate;
  Claude→Codex on a spent window; park until the earliest reset. Codex headroom read live from
  `~/.codex/sessions` rollouts (`codexWindowReading`); Codex usage-limit failures classify as
  window limits, not errors.
- F6 control tower (`src/mcp.mjs`, `harness mcp`): registered in `Cowork OS/.mcp.json` and the
  Codex config. Operator-only actions refuse under `HARNESS_AGENT_SESSION=1`; Codex build
  sessions run with the tower disabled.
- F7 `harness attach`: asks the live session to land, holds the runner, attaches, resumes on detach.
  VS Code tasks in `Cowork OS/.vscode/tasks.json`.
- F8 tiered notifications (`src/notify.mjs`): Mac + Claude-app push (headless one-tool
  PushNotification call, ~$0.004/push, withheld by Claude while the operator is active).
  ntfy/Telegram also wired. Config: `~/.config/harness/notify.json`.
- F3 `harness mirror` + leak gate (`src/mirror.mjs`): history-wide blob scan, private
  denylist at `Cowork OS/.leakgate-deny`. Harness, Skill Builder and dataviz dry runs are clean.
  ApplyPilot is blocked (home paths + email in docs history, plus the known fake-key fixture),
  which is A13's work.

## ECC hybrid track (added 2026-09-24)

ECC (github.com/affaan-m/ECC) is ingested weekly by `src/ecc-ingest.mjs` and merged into this
harness unit by unit. Guide: `docs/ecc/GUIDE.md`. Plan and unit queue: `docs/ecc/HYBRID-PLAN.md`.
H0 done; next H1. Current validated release: v2.2.1.

## Next

1. Private remote live (aditya-029/cowork-os). Skill-foundry and dataviz mirrors already match
   public. The harness mirror diverged from public (9 vs 12 commits), so publishing needs the
   operator's decision (force or snapshot).
2. Operator: `products/MOCK_PTE/.env.local` still blocks every tick (sensitive-path gate).
3. MOCK_PTE's old scheduler is removed (scripts/harness, hooks, launchd job).
4. `harness run` from the monorepo root: A1, A3 and A8 are ready. A0/A4 are Adi's.

## Deliberately not done

- Scheduler not installed, started, resumed, or run. The runner has not been started against the real queue.
- Docker, DigitalOcean CLI, Tailscale, and GitHub CLI not installed.
- No production deployment and no credential access.

## Verification

- `npm run test:all`: 377 + stress + 25 ECC + 98 v2 assertions passed (2026-09-24).
- Read-only against the real monorepo: `units check` (22 valid), `gate` for both providers
  (Claude headroom; Codex 99% of 5h, parked until its reset), `status`, `notify test` (Mac
  notification delivered), and MCP initialize/tools/list over stdio.
- Leak gate dry runs on a scratch clone with v2 overlaid; the real repo was not committed to.
