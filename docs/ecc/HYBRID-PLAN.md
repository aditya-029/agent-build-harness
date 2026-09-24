# Hybrid plan — this harness + ECC

Decision (Aditya, 2026-09-24): ECC lives in the agent harness, not Cowork OS. Merge it
systematically: adopt what ECC does better, keep what this harness does better, and build one
hybrid. The unit rules are the same as everywhere else: one unit = one 2–4 h session, ends
shippable, no dates.

## Merge matrix

| Concern | This harness | ECC | Decision |
|---|---|---|---|
| Scheduling, unattended runs | launchd tick, usage floors, **hard $ cap**, measured backoffs, runaway breaker, session rotation | loop-operator, autonomous-loops, ecc2 (alpha), no $ cap | **Keep mine** |
| Cross-model | `providers.mjs`: governed Claude + Codex, secret-free env | Content ported to 14 tools | **Keep mine**; take `.codex/` content only |
| Claim verification | `verify.mjs`: claims need evidence | `verification-loop`, `delivery-gate` Stop hook | **Merge**: keep verify.mjs as the gate, fold in the verification-loop checklist |
| Pre-action discipline | brief + compactRules | `gateguard` (investigate before edit) | **Adopt, opt-in, A/B-measured** |
| Human gates | `approvals.mjs` queue | orch-pipeline's two gates | **Keep mine**, map orch gates onto approvals |
| Memory / handoff | `memory.mjs`, HANDOFF.md, `session_handoff.py`, `/handoff` `/pickup` | unified-memory vault, `/save-session` | **Keep mine** (plain files) |
| Learning | none | continuous-learning-v2 instincts | **Adopt later**, this repo only, never ApplyPilot, promotion by hand |
| Safety | sanitized env, sensitivePaths, path-scoped commits, anti-fabrication gate | config-protection, safety-guard, security-review | **Adopt** config-protection + security-review; keep all of mine |
| Roles | process roles (implementer, reviewer, release-engineer, security-operator, product-architect, tutor, claim-auditor, methodologist) | 68 specialists | **Merge**: your roles delegate to ECC specialists |
| Unit anatomy | "do one bounded unit, verify, hand off" | Research → Plan → TDD → Review → Commit, size classifier | **Merge**: orch stages become the inside of a unit |
| Evals | `scorecard.mjs`, `review_content()` | eval-harness, agent-eval, ai-regression-testing | **Adopt**: biggest gap |
| Production delivery | nothing | fastapi / api-design / docker / deployment / production-audit / cost-aware-llm | **Adopt** as the freelance product pack |
| Dashboards | `ui.html`, `harness status` | control-pane, plan-canvas, ecc2 TUI | **Keep mine** |
| Hooks | `hook.sh` telemetry + user-level pixel-agents hook | 24 hooks | **Adopt 2–3 only** (GUIDE §5) |

## How upgrades keep flowing (the "systematic" part)

Every adopted ECC file gets an entry in `docs/ecc/adopted.json`: ECC path, the ECC version and
file hash at adoption, the local path, and whether it was modified locally. The weekly ingestion
compares new releases against that file, so a release report says **"3 components you adopted
changed upstream"**. A resync unit then either pulls the change (unmodified files) or three-way
merges it (modified files). Upstream changes to components you never adopted are noted and
otherwise ignored.

## Units

### H0 — Sandbox inspection + ingestion routine `done 2026-09-24`
Static review of v2.2.1, `src/ecc-scan.mjs`, `src/ecc-ingest.mjs`, 25 tests, weekly launchd job,
baseline recorded, `GUIDE.md` and this plan.

### H1 — The kit skeleton and provenance
- **Goal:** a `kit/` folder in this repo (skills, agents, hooks, commands) that the hybrid is
  assembled in, plus `adopted.json` and the upstream-change check in `ecc-ingest`.
- **Agent writes:** all of it (glue code, per the interview test).
- **Acceptance:** adopting one ECC skill records its provenance; a simulated upstream edit shows up
  in the ingestion report; `npm run test:all` passes.

### H2 — Evals into ApplyPilot `highest leverage`
- **Goal:** turn `review_content()` from one gate into an eval suite (fabrication, ATS format,
  one-page rule, no em dashes) using `eval-harness` + `ai-regression-testing` patterns.
- **Aditya writes:** the eval cases: what counts as fabrication, and the pass threshold. This is
  interview material ("how do you know your agent doesn't lie?").
- **Acceptance:** suite runs offline, reports a pass rate, and catches a planted fabrication.
- **Serves:** ApplyPilot Headhunter P1 directly, so this is not drift.

### H3 — Reviewer specialists
- **Goal:** `reviewer` delegates to `python-reviewer`, `silent-failure-hunter`, and, for P2,
  `rag-pipeline-reviewer`.
- **Acceptance:** one real ApplyPilot diff reviewed both ways; the findings compared and written
  down.

### H4 — Safety hooks, measured
- **Goal:** `config-protection` on; `gateguard` A/B on two equivalent bounded units.
- **Acceptance:** keep gateguard only if the measured cost/quality delta is positive; record the
  numbers in a comment the way `harness.mjs` does.

### H5 — The AI product pack (freelance template)
- **Goal:** a template repo: FastAPI + Pydantic, eval suite, Dockerfile, CI, health check,
  `production-audit` checklist, and cost-aware LLM routing.
- **Aditya writes:** the API contract and the eval cases for the demo product.
- **Acceptance:** `docker build` + tests + evals pass in CI on a fresh clone.
- **Serves:** Portfolio P2's deploy unit and every future freelance build.

### H6 — Unit anatomy
- **Goal:** fold orch-pipeline's size classifier and Research → Plan → TDD → Review stages into
  `.harness-prompt.md` / `brief.mjs`, with the gates mapped onto `approvals.mjs`.

### H7 — Continuous learning (optional, last)
- **Goal:** instincts on this repo only, observer excluded from `Job Application Agent/` and any
  `private/` path, promotion by hand.

## Focus guard

You already have two live tracks: Portfolio **A1** and ApplyPilot **Headhunter P1**. Treat the
hybrid as a *tooling track that feeds them*: take **H2** when working on ApplyPilot and **H5**
when P2 reaches its deploy unit. H1 is the only unit that exists purely for the hybrid.
