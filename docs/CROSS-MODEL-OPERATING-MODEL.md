# Cross-model development operating model

This harness is the development control plane. The product it builds may have its own runtime
agents; those are a separate system with separate permissions, prompts, logs, and deployment.
Do not let a runtime role such as ApplyPilot Scout or Writer become a software-development role.

## Control plane and providers

The control plane owns the invariant behavior: brief validation, context and unit ceilings,
human approvals, git serialization, verification evidence, durable memory, idle backoff, and
run records. A provider adapter owns only CLI-specific facts: argv, session discovery, JSONL
normalization, interactive attachment, live steering, and declared telemetry capabilities.

Adding a provider means implementing that adapter contract and fixtures. It must not add
provider branches throughout the scheduler.

Provider sessions, cooldowns, probes, and usage observations have separate state files. Switching
the configured provider does not overwrite the other provider's thread address or inherit its
account cooldown. Models and safety options can be stored under the `providers` map in
`.harness.json`; `AGENT_PROVIDER` remains a one-command override.

One provider owns a tick. Claude and Codex collaborate through the repository's state, decisions,
review artifacts, and handoff—not by writing the same working tree concurrently. The shared run
lock and scoped committer keep that boundary enforceable.

The pattern matches established agent tooling: Cursor runs background agents in isolated
remote environments and works on separate branches, while repository rules provide durable
instructions. Claude Code exposes scoped subagents with separate context and tool access.
Codex uses `AGENTS.md`, sandbox modes, and non-interactive `codex exec` for repeatable workflows.

Primary references:

- [Cursor background agents](https://docs.cursor.com/background-agent)
- [Cursor rules](https://cursor.com/docs/rules)
- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents)
- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Codex approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security)

## Development roles

Roles are bounded review perspectives, not permanent personalities and not an excuse to spawn
agents for every task.

| Role | Owns | Must not own |
|---|---|---|
| Product architect | product boundary, acceptance criteria, ADRs | implementation commits |
| Research analyst | primary-source evidence, options, uncertainty | product decisions |
| Implementer | one scoped change and its tests | approving its own design/security |
| Reviewer | actual diff, regressions, evidence gaps | rewriting the patch while reviewing |
| Security operator | threat model, dependency/secrets checks, least privilege | production credentials or silent destructive remediation |
| Release engineer | reproducible build, CI, deployment and rollback evidence | changing product scope to make a release pass |

Use the smallest set needed. For a normal code change: implementer, deterministic tests, then
reviewer. Add the architect for ambiguous product boundaries, the research analyst when a
decision depends on external facts, security for trust-boundary changes, and release engineering
for deployment artifacts.

## Context contract

1. Read the target repository's routing file (`AGENTS.md` and/or `CLAUDE.md`).
2. Read its current state and newest handoff. Do not reconstruct project history from the tree.
3. Load only the files needed for the current unit. Delegate bounded exploration when it keeps
   the orchestrator context smaller.
4. Put decisions, state, evidence, and handoff facts in their canonical files. Conversation
   context is disposable.
5. End each unit with the real verification output, a scoped commit, and a precise next action.

Longer sessions are not automatically cheaper. Repeatedly carrying a large context makes every
later turn more expensive. Rotate before compaction erases constraints; preserve only durable
facts and the next action.

## Model routing

Do not encode folklore such as “Claude researches; Codex codes” as policy. Both products change,
and public leaderboards measure a model plus its scaffold, tools, prompts, and task mix. Route by
the work and by measured results in this repository:

- research-heavy work: require primary sources and an evidence note, whichever provider runs it;
- code-heavy work: require a bounded diff, tests, and independent review;
- high-risk work: use the provider with the required sandbox/approval capability and keep the
  human gate; do not choose on benchmark rank alone;
- recurring work: compare pass rate, rework, tokens, elapsed time, and escaped defects on a small
  local evaluation set before changing the default.

[SWE-bench](https://www.swebench.com/) and the [Aider leaderboards](https://aider.chat/docs/leaderboards/)
are useful external signals, not procurement answers. METR's randomized study found experienced
open-source developers were 19% slower on its early-2025 task sample when allowed to use AI tools;
that result is a warning to measure the complete workflow, not a claim that agents never help.
See the [METR paper](https://metr.org/Early_2025_AI_Experienced_OS_Devs_Study-paper.pdf).
The [2025 DORA report](https://dora.dev/research/2025/dora-report/) likewise frames AI as an
amplifier of the surrounding engineering system: tests, review, platform quality, feedback loops,
and product clarity remain load-bearing.

## Security and human control

- Provider processes receive a minimal environment. Secret-shaped variables are refused even if
  added to `envAllowlist`; use CLI sign-in/keychain authentication.
- A tick refuses to start while configured secret files such as `.env` are inside the target
  workspace. Runtime secrets belong outside the coding agent's filesystem boundary or in the
  deployment platform's secret store.
- Claude defaults to `--permission-mode auto`; Codex defaults to `--sandbox workspace-write`.
  Dangerous bypass is never a default.
- Autonomous commits are path-scoped. `--all` is a human recovery escape hatch.
- Destructive actions, new spend, scope changes, and conflicting requirements go through the
  append-only approval queue.
- The harness may build deployment artifacts, but it must not publish, purchase, submit, or send
  on behalf of a user without a separate explicit gate.

## Honest capability gaps

Claude currently supplies subscription-window and settled USD telemetry used by the original
meter. Codex JSONL supplies token usage but not an equivalent account-window or reliable USD-cost
event. The Codex adapter therefore says “unavailable,” keeps structural limits active, and sends
the operator to the billing UI. Treating an absent signal as zero would be a control failure.
