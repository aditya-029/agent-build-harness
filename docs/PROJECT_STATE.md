# Project state

Updated: 2026-09-20

## Current phase

Cross-model hardening. Claude remains the backward-compatible default; Codex is a supported
provider through the adapter in `src/providers.mjs`.

## Completed in this phase

- Provider capability model and Claude/Codex command adapters.
- Codex JSONL normalization, persistent-thread discovery, native queue steering, and TUI attach.
- Safe defaults: Claude auto permissions, Codex workspace-write sandbox, secret-free child env.
- Scoped autonomous commits; broad staging requires explicit `--all`.
- Cross-model operating model, CI, examples, and provider tests.

## Next

1. Review the control boundaries with the operator.
2. Move ApplyPilot runtime secrets outside its coding workspace; the harness correctly refuses
   to start while its existing `.env` remains there.
3. Run one operator-triggered, bounded manual tick only after the secret gate is clear.
4. Keep the scheduler stopped until the operator explicitly approves scheduling.

## Deliberately not done

- Scheduler not installed, started, resumed, or run.
- Docker, DigitalOcean CLI, Tailscale, and GitHub CLI not installed.
- No production deployment and no credential access.

## Verification

- `npm run test:all`: 377 assertions passed; usage-gate stress suite passed.
- `harness status`: checked for Claude and Codex against ApplyPilot; both reported scheduler
  unloaded and refused a next tick because `.env` is present, without reading its values.
