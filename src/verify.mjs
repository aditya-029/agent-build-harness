// The self-verification gate.
//
// The premise, stated plainly: generating a claim is cheaper than checking one.
// A model asked whether the build passes can write a fluent "typecheck clean,
// build green" having run nothing, because the sentence is LIKELY, not because
// it is true. Left alone, an agent drifts to the cheap path — not from
// dishonesty, but from economics.
//
// The fix is structural, not motivational. You do not ask the agent to be
// careful. You make every factual claim cost a command, and you check that it
// did. This module is that check.
//
// It is deliberately a WARNING layer, not a blocker. A false positive that
// halts a good session costs more than the claim it caught, and the harness
// already has hard stops (breaker, budget, usage floor) for things that must
// not continue. This one puts the doubt in front of a human instead.

// Phrases that assert a verified outcome. Matching one means the run must also
// show a command that could have produced it.
const CLAIM_PATTERNS = [
  /\b(all\s+)?tests?\s+(are\s+)?(pass|passing|passed|green)\b/i,
  /\b(the\s+)?(build|suite|typecheck|lint|type\s?check)\s+(is\s+)?(pass|passing|passed|green|clean|succeeds?|succeeded)\b/i,
  /\bno\s+(errors?|failures?|regressions?)\b/i,
  /\bverified\b/i,
  /\bconfirmed\s+(working|fixed|passing)\b/i,
  /\bworks?\s+(now|correctly|as\s+expected)\b/i,
  /\b(everything|it)\s+(is\s+)?(working|fixed|done)\b/i,
  /✅/,
]

// Tools whose use constitutes running something. A claim backed by one of
// these is a claim with a command behind it.
const EVIDENCE_TOOLS = new Set(['Bash', 'BashOutput', 'Task', 'NotebookEdit'])

// Commands that actually execute a check, as opposed to merely looking around.
// `cat` and `ls` are not evidence that a suite passed.
const EVIDENCE_COMMANDS = [
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|typecheck|check)/i,
  /\bnode\s+(--test|.*\.test\.)/i,
  /\b(pytest|tox|nox|unittest)\b/i,
  /\b(cargo|go)\s+(test|build|vet)\b/i,
  /\bmake\s+(test|check|build)\b/i,
  /\btsc\b/i,
  /\bgit\s+diff\s+--stat\b/i,
  /\bgit\s+status\b/i,
]

/**
 * Does this text assert a verified outcome?
 * @returns {string[]} the claim phrases found (empty if none)
 */
export function findClaims(text) {
  if (typeof text !== 'string' || !text) return []
  const found = []
  for (const re of CLAIM_PATTERNS) {
    const m = re.exec(text)
    if (m) found.push(m[0].trim())
  }
  return found
}

/** Did this tool use actually run a check? */
export function isEvidence(toolName, input) {
  if (!EVIDENCE_TOOLS.has(toolName)) return false
  const cmd = typeof input === 'string' ? input : (input?.command ?? '')
  if (!cmd) return toolName === 'Task'
  return EVIDENCE_COMMANDS.some(re => re.test(cmd))
}

/**
 * Watch a run and decide, at the end, whether its claims were earned.
 *
 * Feed it every assistant text block and every tool use as they stream past;
 * ask it for a verdict when the run closes.
 */
export function createVerifier() {
  const claims = []
  const evidence = []
  let statedLimits = false

  return {
    /** An assistant text block. */
    text(t) {
      for (const c of findClaims(t)) claims.push(c)
      // "I did not check X" / "not verified" / "untested" — a stated limitation
      // is itself a form of verification, and an agent that names its gaps is
      // more trustworthy than one claiming everything is perfect.
      if (/\b(did\s+not|didn't|could\s+not|couldn't|unable\s+to)\s+(check|verify|test|run)\b/i.test(t)
        || /\b(not\s+verified|untested|unverified|needs\s+manual)\b/i.test(t)) {
        statedLimits = true
      }
    },
    /** A tool use. */
    tool(name, input) {
      if (isEvidence(name, input)) {
        const cmd = typeof input === 'string' ? input : (input?.command ?? name)
        evidence.push(String(cmd).slice(0, 120))
      }
    },
    verdict() {
      const unearned = claims.length > 0 && evidence.length === 0
      return {
        claims,
        evidence,
        statedLimits,
        // The one case worth interrupting a human for: the run said it works
        // and never ran anything that could have shown that.
        unearned,
        ok: !unearned,
      }
    },
  }
}

/** The line to surface when a verdict comes back unearned. */
export function verifierMessage(v) {
  if (!v || v.ok) return null
  const first = v.claims[0] ? `"${v.claims[0]}"` : 'a success claim'
  return `UNVERIFIED CLAIM — the session reported ${first} without running anything that checks it. `
    + 'Treat the result as unconfirmed until you run the check yourself.'
}

// The checklist injected into every session. Kept short on purpose: a long
// preamble is one the model skims. Each line is a thing that has actually gone
// wrong in a real run of this harness.
export const VERIFY_CHECKLIST = `Before you write "done":
- Did you RUN it, or imagine it? Every factual claim needs a command and its visible output.
- Did you verify the SYMPTOM, not just the change? A fix is proven by the absence of the
  problem, not by the edit that was meant to remove it. Show before and after.
- Can someone else reproduce your green? No leftover state, no uninstalled deps, no dirty tree.
- Is the diff exactly what you claimed? Check it, do not recall it.
- What did you NOT check? Name it. A stated limitation is worth more than a silent one.
Reporting a real failure is a correct outcome. Reporting a green you did not observe is not.`
