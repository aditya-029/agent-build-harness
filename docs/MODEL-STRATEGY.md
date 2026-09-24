# Model and cost strategy

Decided with the operator: pending (see "Decisions for Aditya"). Researched 2026-09-24; prices in
USD unless marked, and they change, so re-check before any spend.

## The constraint that shapes everything

**Subscriptions are subsidised; APIs are not.** Claude Code averages about **$13 per active day on
API pricing ($150–250/month)** ([Finout](https://www.finout.io/blog/claude-code-pricing-2026)),
while Claude Pro is **$20/month** ([morphllm](https://www.morphllm.com/claude-code-pricing)). So
"one API account for every model" would cost **5–10× more** for build work, not less.

**Subscriptions only work in first-party tools.** Since 4 April 2026, Claude Free/Pro/Max OAuth is
banned outside Claude Code and claude.ai; third-party harnesses must use an API key
([The Register](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/)).
This harness drives the real `claude` CLI, so it stays within the rules. A multi-model chat app
cannot use your subscription.

Therefore: **one subscription for heavy building + one capped pay-as-you-go key for every other
model.**

## Architecture: four layers

| Layer | What | Cost | Used for |
|---|---|---|---|
| **A. Build engine** | Claude Pro → Claude Code, driven by this harness | $20/mo flat | All heavy agentic building. Upgrade to Max 5x ($100) only if harness logs show you hitting limits. |
| **B. Model router** | One OpenRouter key: every major lab's models, with new ones appearing automatically | Pay per token + 5.5% fee on credits ([OpenRouter pricing](https://omidsaffari.com/blog/openrouter-pricing)); **hard credit limit on the key** | Second-opinion reviews (GPT, Gemini, DeepSeek...), cross-model evals, multi-model chat, prototype app runtime |
| **C. Shared context** | Files on disk: `AGENTS.md`, `PROJECT_STATE.md`, `HANDOFF.md`, `memory.mjs` | $0 | Every model reads the same files, so context is shared by construction, not by a chat app |
| **D. Local models** | Ollama on the M1 / 16 GB (7–8B class) | $0 | Bulk classification, embeddings, and scrubbing personal data *before* it leaves the machine |

**Self-hosting frontier-class models: no.** An always-on cloud GPU costs more per month than both
current subscriptions combined, and open models still trail the frontier for agentic coding.
Layer D covers the cheap end for free.

**Client data rule (for the Australian small-business work):** OpenRouter routes across providers
and regions, so it's fine for your own code, but it is **not** where client personal data goes.
For client apps, call the provider directly with data-retention terms, or use AWS Bedrock in
Sydney (`ap-southeast-2`) for residency; check which models are available there. That is the
governance story Privacy Act/APP 8 conversations will need, and it lines up with the AWS
certification path.

## Monthly cost

| | Now | Proposed |
|---|---|---|
| Claude | Pro ~$20 | Pro $20 |
| OpenAI | Plus ~$20 | cancelled |
| Every other model | none | OpenRouter, capped at $10 |
| **Total** | **~$40 (≈ A$60–70)** | **≤ $30, usually less** |

**What you give up:** Codex as a second *full* builder on a subscription. Codex CLI can still run
on an API key for occasional use, billed against the same cap. Cross-model review, the part that
actually catches one model's blind spots, moves to Layer B.

## Non-determinism

Multi-model access pays for itself here. LLM output varies run to run, so the harness should
treat a single run as a sample, not an answer:
- Evals run each case N times and report a pass *rate*, not pass/fail.
- A second model from a different lab judges or reviews, because models share fewer blind spots
  across labs than within one.
- Temperature, model version and prompt hash are logged with every production call
  (observability).

## Units (one session each)

- **M1 — Docker.** `/usr/local/bin/docker` points to a Docker.app that no longer exists. Install
  a runtime (OrbStack, Colima, or Docker Desktop, which is free for personal use) and verify
  `docker run hello-world`.
- **M2 — OpenRouter connection** via `/connect`: an account, a key with a hard credit limit, and
  the key pasted into `.env` by Aditya. *Money: needs Aditya's go-ahead.*
- **M3 — `ask-model` tool (one UI).** Claude Code on the subscription stays the only interface. A
  zero-dependency script plus a skill let Claude call any OpenRouter model mid-chat (second
  opinion, other lab, long context, cheap bulk), log the cost of each call, and stop at the cap.
  The harness reuses the same script for cross-model review and multi-sample evals. (Decided
  2026-09-24; replaces the separate multi-model chat app. Never point Claude Code's own
  `ANTHROPIC_BASE_URL` at OpenRouter: every turn would become pay-per-token.)

After M1–M3: the production-grade ApplyPilot build (evals for non-determinism, security tests,
observability), using `HYBRID-PLAN.md` H2 and H5.

## Decisions for Aditya

1. Cancel ChatGPT Plus and keep Claude Pro?
2. Monthly OpenRouter cap: $5, $10 or $20?
3. Docker runtime: OrbStack (lightest on an M1), Colima (free, CLI only), or Docker Desktop?
