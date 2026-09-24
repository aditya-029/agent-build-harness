# Handoff log

Newest entry first. Keep entries concise and evidence-based.

## 2026-09-24 — Claude — harness v2 (F3–F8): done

- New modules: `units.mjs`, `runner.mjs`, `notify.mjs`, `mcp.mjs`, `mirror.mjs`. Commands: `units`, `run`,
  `runner`, `attach`, `gate`, `history`, `mcp`, `notify`, `mirror`. Suite: `test/v2.test.mjs` (98, fake providers).
- Codex: the CLI ships inside ChatGPT.app (now on the harness PATH). Its live window is read from rollouts,
  and a usage-limit failure maps to a 429-shaped window limit.
- Monorepo wiring: `.harness.json` (factory), `engine/unit-queue.json`, `.mcp.json`, `.vscode/tasks.json`,
  `.leakgate-deny`, `.harness/` gitignored. The tower is also registered in the Codex config (`codex mcp remove harness` undoes it).
- Security: operator-only actions refuse under `HARNESS_AGENT_SESSION=1`, and Codex builders get
  `mcp_servers.harness.enabled=false`. Honest limit: an agent that deliberately unsets the variable
  could still call the CLI. The real key is OS-level separation, and that is not in place.
- Not done / needs Adi: `gh auth login`; move MOCK_PTE `.env.local` (it blocks every tick); phone
  channel config; the first mirror pushes (`--force` over the old public histories). No commit was made.

## 2026-09-24 — Claude — F2 cut-over: done

- `~/Documents/Claude/Projects` now holds only `Cowork OS`: one repo, and each project in `engine/ products/ portfolio/ research/ archive/` with its full history at its final path (filter-repo path rewrite; the old history is on branch `backup/pre-path-rewrite`).
- Originals are untouched in `~/Documents/Claude/Archive/pre-monorepo-2026-09-24/` (incl. PrivacyOps from `~/Documents/project`).
- Verified from the final paths: ApplyPilot 24/24, harness 377 + 25, MOCK_PTE 579, Skill Builder exit 0. Local state (DBs, private/, vault/) carried; no DB committed.
- launchd: ecc-ingest reinstalled at the new path; mockpte plist re-pointed (still not loaded). Claude memory copied to the new project paths.
- Pending: private GitHub remote (`gh` not logged in → Adi runs `gh auth login`); F3 public mirrors.

## 2026-09-24 — Claude — F1 monorepo dry run: PASS

- Unit queue approved by Aditya (`docs/UNIT-QUEUE.md`). F1 done; evidence in `docs/units/F1-monorepo-dry-run.md`.
- Script: `Cowork OS/scripts/monorepo_migrate.sh` (filter-repo history rewrite, snapshot overlay, `LOCAL_STATE=1`).
- All 9 projects byte-identical; history + blame preserved; every project's tests pass in the monorepo.
- Colima Docker installed and running (hello-world OK).
- Next: F2 cut-over, which needs Aditya's explicit approval (destructive). Scratch copy with personal data deleted.

## 2026-09-24 — Claude — ECC release ingestion (hybrid unit H0)

- Static sandbox review of ECC v2.2.1 (no code executed). Verdict and reviewed findings:
  `docs/ecc/releases/v2.2.1.md`; baseline in `docs/ecc/baseline.json`.
- Added `src/ecc-scan.mjs` (scanner, pure) and `src/ecc-ingest.mjs` (status/check/ingest/approve/
  install-schedule). Releases live in gitignored `vendor/ecc/`; `current` -> v2.2.1.
- Installed launchd `com.harness.ecc-ingest` (Sundays 10:00, operator-requested). It runs `ingest`
  only; it is not the build scheduler. Plist pins the nvm node path; reinstall after a node upgrade.
- `npm run test:all`: 377 + stress suite + 25 new ECC assertions passed.
- Next: `docs/ecc/HYBRID-PLAN.md` unit H1 (kit + provenance), or H2 from the ApplyPilot side.

## 2026-09-20 — Codex — cross-model hardening

- Added an explicit Claude/Codex provider boundary rather than provider conditionals spread across
  the control plane.
- Removed the default dangerous Claude permission bypass; Codex is workspace-write by default.
- Prevented provider children from inheriting API keys/tokens from the parent environment.
- Made autonomous git commits path-scoped and documented roles/context/model-routing evidence.
- Added CI and coverage for provider commands, JSONL normalization, queue steering, environment
  filtering, and commit scope.
- `npm run test:all` passed 377 assertions plus the stress suite. After ApplyPilot's local runtime
  file was moved outside its repository without being read, Claude and Codex read-only status
  checks both reported a clear sensitive-file gate and stayed unloaded.
- Scheduler was not run. Commit/push and operator review are the remaining handoff actions.
