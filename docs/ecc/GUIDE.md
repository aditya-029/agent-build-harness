# ECC, part by part — and what each part means for this harness

Reviewed against **ECC v2.2.1** (commit `5064474d4d76`, 3,538 files), 2026-09-24.
Security verdict and the reviewed findings: `docs/ecc/releases/v2.2.1.md`.
How new releases arrive: `src/ecc-ingest.mjs` (see the last section).

## The one-paragraph version

ECC ("Everything Claude Code", MIT) is **a content layer for coding agents**: 292 skills, 68
subagents, 94 slash commands, 24 hooks, and language rule packs, plus an installer that copies them
into Claude Code (and ports them to 14 other tools: Codex, Cursor, Gemini, OpenCode, Kiro, and so
on). It also ships three experimental runtimes on top: a Rust session control plane (`ecc2/`), a
Python LLM library (`src/llm/`), and localhost dashboards. This harness is the opposite shape:
**a runtime with almost no content**. It schedules governed, budget-capped sessions, verifies
their claims, and hands off state, but it has no skill library, no eval suite, and no reviewer
specialists. The hybrid keeps this harness as the runtime and imports the ECC content that closes
its gaps.

## Mental model: four layers

```
 ┌──────────────────────────────────────────────────────────────┐
 │ 4. RUNTIME / ORCHESTRATION  who runs sessions, when, at what  │
 │    cost, and how they stop                                    │
 │    yours: harness.mjs, breaker, budgets, verify, approvals    │  ← keep yours
 │    ECC:   ecc2 (alpha), loop-operator, orch-*, claw, tmux     │
 ├──────────────────────────────────────────────────────────────┤
 │ 3. HOOKS  code that fires on agent events (every tool call)   │  ← adopt 2–3, opt-in
 ├──────────────────────────────────────────────────────────────┤
 │ 2. AGENTS + COMMANDS  roles and entry points                  │  ← merge
 ├──────────────────────────────────────────────────────────────┤
 │ 1. SKILLS + RULES  knowledge, checklists, and procedures      │  ← adopt the relevant ~25
 └──────────────────────────────────────────────────────────────┘
```

---

## 1. Skills (`skills/`, 292) — knowledge that loads on demand

**What a skill is:** a folder with `SKILL.md` (a front-matter `description` plus instructions),
sometimes with scripts and references. The agent sees only the description until the skill
triggers, so an unused skill costs a line of context, not a file. That makes skills the cheapest
thing in ECC to adopt, and the easiest to adopt too many of: 292 descriptions in context add up
to real tokens.

About two-thirds are irrelevant to you: language stacks you don't use (Kotlin, Swift, Rust, PHP,
Laravel, Quarkus, Perl, Flutter), unrelated domains (homelab/network, healthcare, logistics,
prediction markets, DeFi, video editing), and the sponsor's `ito-*` compute skills.

**The relevant ones, grouped by your goals:**

| Group | Skills | What they give you |
|---|---|---|
| **Evals (your biggest gap)** | `eval-harness`, `agent-eval`, `ai-regression-testing`, `benchmark-methodology`, `skill-comply` | Eval-driven development: define pass/fail cases *before* trusting a workflow; compare agents on pass rate, cost and time; catch the blind spot where one model writes and reviews its own code. ApplyPilot's `review_content()` anti-fabrication gate is one hand-written eval. This group turns it into a suite. |
| **AI product engineering** | `cost-aware-llm-pipeline`, `regex-vs-llm-structured-text`, `iterative-retrieval`, `prompt-optimizer`, `mle-workflow`, `agent-harness-construction`, `mcp-server-patterns` | Model routing by task difficulty, budget tracking, prompt caching; when a regex beats an LLM; multi-pass retrieval for RAG; data contracts, evaluation, monitoring and rollback for ML systems; tool/action-space design. This is the P2 (Climate Disclosure Workbench) toolkit. |
| **Production / freelance delivery** | `fastapi-patterns`, `api-design`, `python-patterns`, `python-testing`, `tdd-workflow`, `docker-patterns`, `deployment-patterns`, `database-migrations`, `postgres-patterns`, `production-audit`, `security-review`, `e2e-testing` | The "ship it to a client" checklist: service structure, Pydantic schemas, auth, pagination and errors, pytest fixtures, container hardening, CI/CD with health checks and rollback, and a local-evidence production-readiness audit. |
| **Agent discipline** | `verification-loop`, `search-first`, `context-budget`, `strategic-compact`, `safety-guard`, `gateguard`, `council` | Verify before claiming done; search for an existing library before writing one; audit what is eating the context window; a four-voice debate for go/no-go calls. |
| **Research** | `deep-research`, `exa-search`, `market-research`, `scientific-thinking-literature-review` | Cited multi-source research. `deep-research` needs Firecrawl/Exa MCP keys, and those are paid; your money hard stop applies. |
| **Job-search adjacent** | `data-scraper-agent`, `lead-intelligence`, `article-writing`, `brand-voice` | `data-scraper-agent` is explicitly pitched at job boards. **Do not adopt it for ApplyPilot**: your rules forbid bulk-scraping SEEK/LinkedIn/Indeed, and that rule protects your accounts. `article-writing` and `brand-voice` can help with LinkedIn post drafts. |

## 2. Rules (`rules/`, 122 files) — always-on guidance

`rules/common/` (coding style, security, testing, git) plus one folder per language. Unlike
skills, **rules load into every session**, so each one costs context on every turn. Adopt
`rules/common/security` and `rules/python` only, and fold them into your existing `AGENTS.md`
contracts rather than adding a parallel rules tree. Your `compactRules` in `.harness.json` already
do this job, better targeted.

## 3. Agents (`agents/`, 68) — specialist subagents

Markdown files with `name`, `description`, `tools` and `model` front matter. The main agent
delegates a bounded job to one and gets a summary back.

- **Relevant:** `python-reviewer`, `fastapi-reviewer`, `rag-pipeline-reviewer`,
  `security-reviewer`, `database-reviewer`, `silent-failure-hunter` (finds swallowed errors),
  `pr-test-analyzer`, `tdd-guide`, `planner`, `architect`, `mle-reviewer`, `agent-evaluator`,
  `doc-updater`, `performance-optimizer`.
- **How they relate to yours:** your roles (`implementer`, `reviewer`, `release-engineer`,
  `security-operator`, `product-architect`; the portfolio's `tutor`, `claim-auditor`,
  `methodologist`) are **process roles**: who owns which step. ECC's are **specialists**: what a
  Python or RAG expert looks for. They don't compete. The merge makes your `reviewer` delegate to
  ECC's `python-reviewer`, `rag-pipeline-reviewer` and `silent-failure-hunter` instead of
  reviewing generically. `claim-auditor` and `tutor` have no ECC equivalent; they stay as they are.
- **Skip:** `gan-*` (generator/evaluator loops, expensive), `marketing-agent`, `seo-specialist`,
  the `opensource-*` trio, and every language you don't use.

## 4. Commands (`commands/`, 94) — slash-command entry points

Each is a prompt template (`/plan`, `/tdd`, `/code-review`, `/build-fix`, `/checkpoint`,
`/quality-gate`, `/prp-*`, `/orch-*`, `/epic-*`, `/save-session`, `/resume-session`...). Two
cautions:

- **Collisions.** `/code-review`, `/security-scan`, `/skill-create` and `/plan` overlap with
  commands you already have (Claude Code's `/code-review` and `/security-review`, your
  `skill-foundry`, `skill-creator`, plan mode). If adopted, they get an `ecc-` prefix.
- **Your harness has `/handoff` and `/pickup`** (ApplyPilot `.claude/commands`), and they already
  beat ECC's `/save-session` and `/resume-session` for your workflow: they're wired to
  `session_handoff.py` and the context check.

Worth taking: `/quality-gate`, `/test-coverage`, `/build-fix`, `/checkpoint`, and the `orch-*`
pipeline (below).

## 5. Hooks (`hooks/hooks.json`, 24) — code that fires on agent events

This is the part that **needs the most caution**, because hooks run code automatically on every
matching event, whether or not you think about them. With a full install, all 24 fire:

| Event | Hooks | What they do |
|---|---|---|
| PreToolUse (9) | `pre-bash-dispatcher`, `gateguard-fact-force` ×2, `doc-file-warning`, `suggest-compact`, `observe-runner`, `governance-capture`, `config-protection`, `mcp-health-check` | Block risky shell commands; **gateguard** refuses Edit/Write/Bash until the agent has investigated first; warn on stray doc files; suggest compaction; **log every tool call** (below); block edits to linter/config files so the agent can't "fix" a failure by loosening the config. |
| PostToolUse (2) | dispatcher (sync + async) | Formatting and quality follow-ups, observation logging. |
| PostToolUseFailure (2) | MCP health, skill-run tracker | Local telemetry on failed skills. |
| PreCompact, SessionStart (3) | save a summary before compaction; bootstrap context; plan-canvas sessions | Continuity across compaction. |
| Stop (7), SessionEnd (1) | format + typecheck, console.log check, session save, evaluate-session, cost-tracker, desktop notify, plan-canvas | End-of-turn quality checks and cost logging. |

**Privacy note:** `observe-runner` → `skills/continuous-learning-v2/hooks/observe.sh` writes
**every tool input and output (up to 5 KB each)** to a local `observations.jsonl`, regex-scrubbed
for secrets. It is local only and never sent anywhere, but in ApplyPilot it would record résumé
content, job data and personal details. It must never run against `Job Application Agent/`.

**Overlap with yours:** you already have a user-level hook (`~/.pixel-agents/hooks/claude-hook.js`
on 12 events) and the harness's own `hook.sh` telemetry. Stacking 24 more on top slows every tool
call and makes failures hard to attribute.

**Adopt, opt-in and measured:** `config-protection` (cheap, pure safety), `gateguard` (ECC claims
+2.25 quality points; verify that with an A/B run before trusting it), and the Stop-time
`format-typecheck`. Skip the rest.

## 6. Orchestration — ECC's answer to "run the whole build"

- **`orch-*` skills and commands** (`orch-build-mvp`, `orch-add-feature`, `orch-fix-defect`...)
  sit on `orch-pipeline`: a gated **Research → Plan → TDD → Review → Commit** pipeline with a
  size classifier and **two human gates**. This is the most transferable idea in ECC. It is
  what a "unit" in your `.harness-prompt.md` should look like inside.
- **`loop-operator`, `autonomous-loops`, `continuous-agent-loop`, `santa-method`,
  `ralphinho-rfc-pipeline`** are long-running loop patterns. **Your harness already does this
  better** (measured backoffs, usage floors, a hard dollar cap, a runaway breaker, session
  rotation), and none of the ECC loops has a dollar cap.
- **`scripts/orchestrate-worktrees.js`, `orchestrate-codex-worker.sh`, `claw`, `dmux-workflows`**
  handle parallel sessions in git worktrees and tmux. Your harness deliberately runs one writer
  per tree. Keep that.
- **`ecc2/`** is a Rust TUI and daemon for managing many sessions, described by its own README as
  an **alpha scaffold, "not the finished product"**. Skip it. Revisit if a release marks it stable.

## 7. Memory and learning

- **`continuous-learning-v2`**: the observer hook (above) records sessions, distils "instincts"
  with confidence scores, and `/evolve` promotes them into skills, commands and agents. It's a
  clever idea and the riskiest one to leave running unattended: it rewrites your agent's
  behaviour from its own observations. Adopt only for this harness repo, project-scoped, with
  promotion by hand.
- **`unified-memory` / `ecc-memory-mcp`**: a shared memory vault across Claude, Codex and Cursor.
  Your file-based `memory.mjs` plus `HANDOFF.md` plus `session_handoff.py` does this already, in
  plain files you can read. Keep yours; files are the OS rule.

## 8. Everything else

| Part | What it is | For you |
|---|---|---|
| `scripts/` (296) | Installer (`install-apply.js`, profiles in `manifests/`), hook runtime, 20+ CI validators (`validate-skills`, `check-unicode-safety`...), dashboards, Discord bots | The **validators** are worth borrowing: `validate-skills.js` and `check-unicode-safety.js` would harden your own skills folder. |
| `manifests/install-profiles.json` | `minimal` (no hooks), `core`, `developer`, `security`, `research`, `full` | If you ever install ECC directly, **`minimal`** is the only profile without the hook runtime. |
| `src/llm/` | Python provider-agnostic LLM wrapper (Claude, OpenAI, Ollama, Atlas, Astraflow) | Not needed; call the Anthropic SDK directly. Useful to read as a small example of provider abstraction for interviews. |
| `.codex/`, `.cursor/`, `.gemini/`, `.opencode/`, `.kiro/` and 9 more | The same content ported to other agent tools | Only `.codex/` matters to you, since the harness is cross-model. Note its unpinned MCPs. |
| `mcp-configs/`, `.mcp.json` | MCP server presets (Supabase, Context7, Playwright, chrome-devtools...) | **Six are unpinned `@latest`**: any upstream compromise runs on your machine. Pin a version if you ever adopt one. |
| `contexts/` | `dev`, `research`, `review` mode prompts | Small and optional. |
| `docs/` (1,500+), guides | Translations, release notes, `the-security-guide.md`, `the-longform-guide.md` | The two guides are good reading. |
| `package.json` "welcome" script, `ito-*` skills, `scripts/ito.js` | Sponsor integration (Itô compute), an opt-in bridge that submits authenticated compute RFQs | Never adopt; it touches money. |

---

## How the ingestion routine works

Weekly (launchd `com.harness.ecc-ingest`, Sundays 10:00), with **zero LLM cost**:

1. `check`: one call to GitHub's `/releases/latest` (it excludes drafts and prereleases; the
   `vX.Y.Z` pattern excludes RCs).
2. If it's new, a shallow clone at the tag into `vendor/ecc/quarantine/<tag>`, with git hooks
   disabled, no submodules, and `.git` removed. **Nothing is installed or executed.**
3. `src/ecc-scan.mjs` scans every file: npm lifecycle scripts and `curl | sh` → **BLOCK**;
   network calls, dynamic eval, credential paths, unpinned `@latest`, prompt-injection phrases,
   invisible Unicode, and long base64 blobs → **REVIEW**. Hooks and dependency changes are flagged.
4. The findings are compared with `docs/ecc/baseline.json` (everything already reviewed). Only
   **new** findings need a read.
5. The report goes to `docs/ecc/releases/<tag>.md`, including what changed per skill, agent and
   hook since the last release. That list is the merge queue.
6. **PASS** → promoted to `vendor/ecc/current`, with a macOS notification. **NEEDS_REVIEW or
   BLOCK** → held in quarantine with a notification. You open a session, the findings are read,
   then `npm run ecc -- approve <tag> "<review note>"`. A BLOCK outside `tests/` can never be
   approved.

Promotion **does not** change any live harness. Bringing an upgrade into the hybrid is a
separate merge unit (`docs/ecc/HYBRID-PLAN.md`).
