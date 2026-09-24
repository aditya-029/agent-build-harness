# F1 — Monorepo dry run: result

2026-09-24 · owner: agent · **Acceptance: PASS**

Script: `Cowork OS/scripts/monorepo_migrate.sh <target>` (`LOCAL_STATE=1` also carries git-ignored
local state). It is read-only on the originals: it clones, rewrites history into
`other-worlds/<name>/` with `git filter-repo`, merges, and overlays uncommitted work as one snapshot
commit per project. Build time about 10 s; 220 commits.

## Acceptance evidence

| Check | Result |
|---|---|
| Every committable file identical (SHA-256) to the originals | 9/9 projects match; the one difference is an ignored `.pyc` in Youtube_Automation, which is correct |
| History follows files (`git log -- other-worlds/<name>`, `git blame`) | ApplyPilot 54 (53 + snapshot), MOCK_PTE 136, harness 10, Skill Builder 3; blame shows original authors and dates |
| Originals untouched | Dirty counts unchanged (harness 10, MOCK_PTE 4, OS 65, ApplyPilot 6); no commits made in them |
| No secrets in any commit | Only hit is ApplyPilot's deliberate fake `sk-ant-notarealkey…` test fixture |
| No databases / .env / node_modules / venvs committed | 0 `.db` files committed; carried local state leaves `git status` clean |
| Harness `npm run test:all` | 377 + stress + 25 passed |
| MOCK_PTE `vitest run` (after `npm ci`) | 579 passed (40 files) |
| Skill Builder `tests/run_tests.py` | exit 0; its "provenance: FAILED" line is the intentional tamper case and appears in the original too |
| ApplyPilot `self_test.py` (fresh Python 3.13 venv) | **24/24 with LOCAL_STATE=1**; 17/24 without it (its profile/projects DB is deliberately untracked) |

## Findings F2 must handle

1. **Carry local state.** Databases, `.env`, `deliverables/`, `private/`, `vault/` are git-ignored
   but needed. F2 runs with `LOCAL_STATE=1`, then recreates venvs (Python **3.13** for ApplyPilot:
   `/opt/homebrew/bin/python3.13`) and runs `npm ci` (MOCK_PTE).
2. **The duplicate is empty.** `Projects/Job Application Agent/` is a 0-byte folder; the canonical
   copy is `Cowork OS/other-worlds/Job Application Agent`. Archive the empty one.
3. **PrivacyOps** (`~/Documents/project`) has `git init` but no commits; imported as a snapshot.
   `privacyops.db` is carried as local state, never committed. `_mounts/Projects/PrivacyOps`
   symlink retires.
4. **Paths to re-point after the move** (15 references):
   - Repo files: `other-worlds/MAP.md`, `other-worlds/PrivacyOps.md`, `wiki/current-focus.md`,
     `wiki/who-i-am.md`, `Job Application Agent/docs/harness_assessment_2026-08-22.md`
     (historical, can stay), one Youtube research `frames.json` (data, leave).
   - Machine: `~/Library/LaunchAgents/com.harness.ecc-ingest.plist` (reinstall with
     `npm run ecc -- install-schedule` from the new path), `com.mockpte.buildscheduler.plist`
     (installed, **not loaded**, so re-point only), `~/.claude.json` project entries (Claude Code
     history keyed by old paths).
5. **Uncommitted work lands as snapshot commits.** 65 + 10 + 6 + 4 changed files become one
   commit per project. Adi may prefer to commit in the originals first for cleaner messages.
6. **Public mirrors** (harness, Skill Builder, dataviz, ApplyPilot) are F3. Nothing is pushed
   in F2; the monorepo gets a new **private** remote.

## F2 cut-over plan (needs Adi's approval: destructive)

1. Build with `LOCAL_STATE=1` into `Projects/Cowork OS.new`.
2. Recreate venvs / `npm ci`; run every test command above from the new paths.
3. Swap: `Cowork OS` → `archive/Cowork OS.pre-monorepo-<date>`; `Cowork OS.new` → `Cowork OS`.
   Move the external originals to `archive/` too, **untouched and restorable**.
4. Re-point the 4 path items; reinstall the ecc-ingest schedule; verify `launchctl print`.
5. Create the private GitHub remote and push.
6. Keep the archive until Adi has worked in the monorepo for a while, then delete on his say-so.
