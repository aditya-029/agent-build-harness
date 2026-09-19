# Agent build harness — shared instructions

This file is the common entry point for Codex, Claude Code, and future coding agents. Do not put
provider-specific project facts in a second instruction file; `CLAUDE.md` routes here.

## Read first

1. `docs/PROJECT_STATE.md` — current status and next work.
2. `docs/HANDOFF.md` — newest session handoff.
3. `docs/CROSS-MODEL-OPERATING-MODEL.md` — architecture, roles, context, and evidence.
4. `README.md` — operator behavior and configuration.

## Repository contract

- Node 22+, ESM, and zero runtime dependencies.
- Provider-specific behavior belongs in `src/providers.mjs`; invariant scheduling policy belongs
  in `src/harness.mjs` or a provider-neutral module.
- Never turn an unavailable provider signal into zero. State the capability gap explicitly.
- Never forward secret-shaped environment variables to an agent. Do not print or inspect values.
- Never make dangerous permission bypass the default.
- Autonomous commits must be path-scoped. `--all` is a human recovery option.
- Do not start, install, or arm the scheduler unless the operator explicitly requests it.
- Do not perform outward-facing or destructive operations without the approval boundary.

## Verification

Run before and after a change:

```bash
npm run test:all
```

For provider CLI changes, also run syntax checks and the read-only `status` command for both
providers. Do not run `tick`, `sprint`, `install`, or `start` as a test.

## Context discipline

Work on one bounded unit. Read the current state and newest handoff before exploring source. Keep
decisions and status on disk; do not rely on conversation memory. Report what was not tested.

At session end, update `docs/PROJECT_STATE.md` and prepend a concise entry to `docs/HANDOFF.md`.
