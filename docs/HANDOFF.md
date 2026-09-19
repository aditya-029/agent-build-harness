# Handoff log

Newest entry first. Keep entries concise and evidence-based.

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
