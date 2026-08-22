// The brief: what the orchestrator is told to build.
//
// The harness used to accept any prose at all as `.harness-prompt.md` and hand
// it straight to a session that would then run unattended for hours. That is
// the single cheapest place to lose a night of tokens, because the failure is
// silent: the agent does not stall, it confidently builds the wrong thing and
// reports success.
//
// So a brief has four parts and one of them is load-bearing:
//
//   Goal        — the OUTCOME, not the steps. Steps make the orchestrator a
//                 slow keyboard and hand you ownership of every mistake in
//                 your own plan.
//   Constraints — what must not change, where the work lives, conventions.
//                 Cheap to write, expensive to omit.
//   Budget      — what the work is worth. A budget in the brief becomes a
//                 budget on the floor.
//   Deliverable — the ARTIFACT that proves done. "Done" with no artifact is a
//                 vibe, and agents ship vibes enthusiastically.
//
// Goal and Deliverable are required. Constraints and Budget are warned about,
// not refused: "no constraints" is a legitimate answer and the harness already
// carries a dollar cap, so refusing on those would be a false gate.

export const BRIEF_SECTIONS = ['goal', 'constraints', 'budget', 'deliverable']
export const REQUIRED_SECTIONS = ['goal', 'deliverable']

// Aliases people actually type. Anything not on this list is kept as an extra
// section rather than dropped — a brief may carry context the harness has no
// opinion about, and silently discarding it would be worse than ignoring it.
const ALIASES = {
  goal: ['goal', 'goals', 'objective', 'outcome', 'what', 'mission'],
  constraints: ['constraints', 'constraint', 'boundaries', 'rules', 'guardrails', 'scope'],
  budget: ['budget', 'cost', 'spend', 'limits', 'limit'],
  deliverable: ['deliverable', 'deliverables', 'artifact', 'artefact', 'definition of done', 'done', 'output'],
}

const CANON = new Map()
for (const [key, names] of Object.entries(ALIASES)) {
  for (const n of names) CANON.set(n, key)
}

/**
 * Split a markdown brief into its sections.
 *
 * Accepts any heading level (`#` through `######`) and also `Goal:` on its own
 * line, because that is what people type when they are in a hurry and there is
 * no reason to be pedantic about it.
 *
 * @param {string} text
 * @returns {{sections: Record<string,string>, extra: Record<string,string>, order: string[]}}
 */
export function parseBrief(text) {
  const sections = {}
  const extra = {}
  const order = []
  if (typeof text !== 'string') return { sections, extra, order }

  const lines = text.split('\n')
  let current = null
  let buf = []

  const flush = () => {
    if (!current) { buf = []; return }
    const body = buf.join('\n').trim()
    if (current.canon) {
      // First occurrence wins. A brief with two Goal headings is a brief being
      // edited, and the top one is the one the writer is looking at.
      if (!(current.canon in sections)) { sections[current.canon] = body; order.push(current.canon) }
    } else {
      if (!(current.raw in extra)) extra[current.raw] = body
    }
    buf = []
  }

  for (const line of lines) {
    const heading = matchHeading(line)
    if (heading !== null) {
      flush()
      const key = heading.toLowerCase().replace(/[^a-z ]/g, '').trim()
      current = { raw: heading.trim(), canon: CANON.get(key) || null }
      continue
    }
    if (current) buf.push(line)
  }
  flush()

  return { sections, extra, order }
}

/** `## Goal`, `Goal:` or `**Goal**` on its own line -> "Goal". Otherwise null. */
function matchHeading(line) {
  const md = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
  if (md) return md[1].replace(/\*\*/g, '').trim()
  const colon = /^\s*(?:\*\*)?([A-Za-z][A-Za-z ]{1,24}?)(?:\*\*)?\s*:\s*$/.exec(line)
  if (colon) return colon[1].trim()
  return null
}

/**
 * Decide whether a brief may be handed to a session.
 *
 * Returns `{ok, missing, thin, problems}`. `missing` is required sections that
 * are absent or empty; `thin` is present-but-suspiciously-short sections;
 * `problems` is the human-readable list to print.
 */
export function validateBrief(text) {
  const { sections } = parseBrief(text)
  const missing = []
  const thin = []
  const unfilled = []
  const problems = []

  const looksUnstructured = Object.keys(sections).length === 0
  if (looksUnstructured) {
    return {
      ok: false,
      unstructured: true,
      missing: [...REQUIRED_SECTIONS],
      thin: [],
      problems: ['the brief has no Goal/Constraints/Budget/Deliverable sections at all'],
      sections,
    }
  }

  for (const key of REQUIRED_SECTIONS) {
    const body = (sections[key] || '').trim()
    if (!body) { missing.push(key); continue }
    // The template's own placeholders. Caught by running `harness brief` on a
    // freshly-initialised template and watching it report "complete" — the
    // placeholder text is long enough to clear the word count below, so
    // without this check the gate waves through a brief whose Deliverable is
    // literally "<the artifact that proves this is done>". That is the exact
    // failure the gate exists to prevent, dressed as a pass.
    if (isPlaceholder(body)) { unfilled.push(key); continue }
    // A one-word deliverable ("done", "it works") is the failure this gate
    // exists to catch, so shortness is reported rather than accepted.
    if (body.split(/\s+/).length < 3) thin.push(key)
  }

  for (const key of missing) {
    problems.push(key === 'deliverable'
      ? 'no Deliverable — name the artifact that proves this is done (a PR, a green suite, a file)'
      : `no ${cap(key)} section`)
  }
  for (const key of unfilled) {
    problems.push(`${cap(key)} is still the template placeholder — replace the <angle brackets> with a real answer`)
  }
  for (const key of thin) {
    problems.push(`${cap(key)} is one or two words — that is a label, not a ${key === 'goal' ? 'goal' : 'deliverable'}`)
  }
  for (const key of ['constraints', 'budget']) {
    if (!(sections[key] || '').trim()) {
      problems.push(`no ${cap(key)} section (allowed, but say "none" so it reads as a decision rather than an omission)`)
    }
  }

  return {
    ok: missing.length === 0 && thin.length === 0 && unfilled.length === 0,
    unstructured: false, missing, thin, unfilled, problems, sections,
  }
}

const cap = s => s.charAt(0).toUpperCase() + s.slice(1)

// A section body that is still, wholly or mostly, the angle-bracket prompt the
// template shipped with. Substring-tolerant on purpose: people fill in one
// bullet and leave the rest, and a half-filled Deliverable is not a Deliverable.
function isPlaceholder(body) {
  const stripped = body.replace(/<[^>]*>/gs, '').trim()
  return stripped.length === 0 || stripped.length < body.length * 0.4
}

/** The starter a `harness brief --init` writes. */
export const BRIEF_TEMPLATE = `# Brief

## Goal
<The outcome, in one or two sentences. Not the steps — the end state.>

## Constraints
<What must not change. Where the work lives. Conventions to follow.
If there genuinely are none, write "none".>

## Budget
<What this work is worth: a dollar cap, a token cap, or "overnight, not a sprint".
The harness has its own cap; this is the intent behind it.>

## Deliverable
<The artifact that proves this is done. A merged PR. A green test suite.
A file at a named path. Something someone else could point at.>
`

/**
 * Render the brief back as the instruction block a session is opened with.
 * Adjacent-discovery handling is appended because it is the one line that keeps
 * scope fixed WITHOUT losing what the agent noticed on the way past.
 */
export function briefPreamble(text) {
  const { sections } = parseBrief(text)
  const lines = []
  for (const key of BRIEF_SECTIONS) {
    const body = (sections[key] || '').trim()
    if (body) lines.push(`${cap(key)}: ${body}`)
  }
  lines.push('')
  lines.push('If you find problems adjacent to this goal, record them as tasks. Do not fix them.')
  return lines.join('\n')
}
