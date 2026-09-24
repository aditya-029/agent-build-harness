# Unit queue — factory + production ApplyPilot

Status: **APPROVED by Aditya 2026-09-24** (D11). Sources: Cowork OS
`brainstorms/2026-09-24-hybrid-build-system.md` (D1–D18) and
`brainstorms/2026-09-24-applypilot-production-spec.md` (P1–P8).

Each unit: one session, one runnable acceptance command, an owner. `agent` units run through the
harness; `adi` units are hands-on and tutored. An agent unit that depends on an adi unit waits;
the runner picks another unblocked unit meanwhile. No dates.

## Track F — the factory (the harness builds itself; operator-triggered ticks until F6 exists)

| # | Unit | Owner | Depends | Acceptance |
|---|---|---|---|---|
| F1 ✅ | Monorepo **dry run** (done 2026-09-24, `docs/units/F1-monorepo-dry-run.md`): inventory every project, diff the duplicate `Job Application Agent`, import all histories with subtree into a *scratch* monorepo | agent | none | Each project's own test command passes inside the scratch repo; originals untouched (checksums) |
| F2 ✅ | **Cut-over** (done 2026-09-24; layout engine/ products/ portfolio/ research/ archive/; private remote aditya-029/cowork-os): move into the real OS repo, re-point launchd (`ecc-ingest`), fix paths/venvs, private remote, archive the originals | agent + **approval** (destructive) | F1 | Every test command passes from the new paths; `launchctl print` points at new paths; archive is restorable |
| F3 ✅ | Public mirror pipeline + leak gate (done 2026-09-24: `harness mirror`, history-wide scan; harness/Skill Builder/dataviz clean, ApplyPilot blocked: 54 findings, home paths + email in docs history + the known fake-key fixture → A13)| agent | F2 | A mirror push is blocked by a planted fake secret and passes when it's removed |
| F4 ✅ | Unit queue format (done 2026-09-24: `engine/unit-queue.json`, `harness units`)| agent | F2 | A unit with no acceptance command is refused in the tests |
| F5 ✅ | Event-driven runner (done 2026-09-24: `harness run`; Codex headroom read live from its rollouts)| agent | F4 | Simulated finish → next unit starts with no timer; simulated limit → park + switch |
| F6 ✅ | **Control-tower tool** (done 2026-09-24: `harness mcp`, registered in `.mcp.json` + Codex config)| agent | F5 | From a VS Code chat: read status, queue a message the running session receives, approve an item |
| F7 ✅ | Attach to a running session (done 2026-09-24: `harness attach` + VS Code tasks)| agent | F6 | Attach, type, detach; the scheduler holds off during and resumes after |
| F8 ✅ | Tiered notifications (done 2026-09-24: Mac + Claude-app push live)| agent | F6 | Approval/failure → instant push; 3 finishes in quick succession → one batched push |

**Harness v2 = F4–F8 done** (D18) — **complete 2026-09-24.** The machine-readable queue the runner uses is `engine/unit-queue.json` (runnable acceptance commands); this table is the human view.

## Track A — production ApplyPilot (autonomous once v2 exists; `adi` units can start now)

| # | Unit | Owner | Depends | Acceptance |
|---|---|---|---|---|
| A0 | **Complete the verified evidence base** (tutored interview; every fact sourced) | **adi** | none | `self_test.py` evidence checks pass; one real render succeeds |
| A1 | Refresh router models and prices (verify current IDs first); **$10/month** cap + monthly ledger | agent | none | Ledger test: the cap trips at $10 and LLM stages pause with a Telegram notice |
| A2 | Close the full-loop gaps: Writer auto-invoked after `/pick`, readable draft preview, submit/skip/outcome dialog | agent | A0 | End-to-end offline test: pick → draft → revise → render → approve → record outcome |
| A3 | Trace table (OTel GenAI fields) + structured logs + `/health` + `/costs` + error alerts | agent | none | Each LLM call leaves one trace row; a forced error reaches Telegram |
| A4 | **Eval cases + pass thresholds + SLO numbers** | **adi** | A0 | The case set and threshold file exist and have been reviewed |
| A5 | Eval runner (about 20 postings × 5 samples, pass rates) + CI regression gate | agent | A3, A4 | A deliberately worse prompt fails CI |
| A6 | OWASP LLM Top 10 suite: hostile-posting corpus, Telegram chat-ID lock, secret/PII scans, pip-audit + image scan | agent | A3 | Every injection case leaves claims and tools unchanged; scans are green |
| A7 | Reliability: failure injection (crash mid-render, duplicate messages, outage, cap hit) + nightly backup/restore rehearsal | agent | A2 | Every injected failure resumes without duplicate work or charges; the restore rehearsal passes |
| A8 | Dual builders: headroom routing, per-builder worktrees, cross-review gate (hybrid item 6) | agent | F8 | A task routes to Codex when Claude is capped; a merge is blocked without the other lab's review |
| A9 | Container + CI + staging on Colima + approvals for the 5 reasons (hybrid item 7) | agent | A7 | CI builds the image; staging deploy + health check pass; a prod deploy request lands in approvals |
| A10 | Langfuse on the Mac + trace sync over Tailscale | agent | A3, A9 | Production traces appear in local Langfuse after a sync |
| A11 | **Lightsail Sydney** deploy + rollback rehearsal | agent + **approval** (money) | A9 | Live health check green; rollback rehearsed |
| A12 | Cross-lab red-team before launch | agent | A6, A11 | Findings are fixed or accepted in writing |
| A13 | Public mirror + synthetic demo persona + README metrics from real data | agent | F3, A5 | `docker compose up` on a fresh clone runs the demo; the leak gate passes |
