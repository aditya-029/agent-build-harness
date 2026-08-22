// Durable memory that outlives a session.
//
// This exists because of a hole opened by persistent sessions. The orchestrator
// now rotates at the context ceiling: the old conversation is retired and a
// fresh one starts. Everything the retired session had in its head goes with
// it, and all that carried over was one journal line's "next" value. That is
// enough to resume a task and not nearly enough to remember a decision.
//
// The shape is ported from Munder Difflin's per-agent `memory.md` (MIT,
// Chaitanya Giri — src/main/memory.ts, src/main/reflect.ts): a markdown file
// the agent reads at start and appends to as it learns, held to a bounded
// three-region form so it cannot grow until it costs more to read than it is
// worth.
//
//   ## Pinned          durable facts. NEVER evicted, never rewritten.
//   ## Notes           newest-first working memory. Bounded.
//   (archive)          everything evicted, appended to a sibling file.
//
// Two deliberate departures from theirs.
//
// They also carry a rolling LLM-written recursive summary, condensed by a
// headless `claude -p` pass with backup → verify → atomic swap. That is real
// engineering and it is not right here. This harness has zero dependencies and
// one agent; spending a model call and a three-stage safety dance to compress
// a file that a `tail` would serve is the wrong trade. Eviction here is
// LOSSLESS and deterministic: evicted sections move to `<memory>.archive.md`,
// which the agent can grep when it actually needs history. Nothing is
// summarised, so nothing can be summarised wrongly.
//
// And they depend on the MemPalace CLI for semantic recall, which their own
// docs note has "public benchmarks overstated per independent audit", degrading
// to no-op when absent. At one agent, grep is the retrieval layer.
//
// Pure functions only — no I/O, no clock.

const PINNED = '## Pinned'
const NOTES = '## Notes'

export const MEMORY_TEMPLATE = `# Orchestrator memory

Durable across session rotations. You read this at the start of every session
and append to it as you learn. The harness keeps it bounded; you do not have to.

${PINNED}

Facts that must survive everything. Never evicted. Keep this short — an
architectural decision and its reason, a constraint that is not obvious from the
code, a thing that was tried and did not work. Not status.

${NOTES}

Newest first. What you learned this session, in one or two lines each. The
harness evicts the oldest of these into the archive when there are too many.
`

/**
 * Split a memory file into its regions.
 *
 * A file that does not have the headings is not mangled into the shape — it is
 * returned wholly as `preamble`, so a hand-written file the agent has been
 * treating as memory is never silently restructured out from under it.
 */
export function parseMemory(text) {
  const src = String(text ?? '')
  const pinnedAt = src.indexOf(PINNED)
  const notesAt = src.indexOf(NOTES)
  if (pinnedAt < 0 || notesAt < 0 || notesAt < pinnedAt) {
    return { wellFormed: false, preamble: src, pinned: '', notes: [] }
  }
  return {
    wellFormed: true,
    preamble: src.slice(0, pinnedAt).trimEnd(),
    pinned: src.slice(pinnedAt + PINNED.length, notesAt).trim(),
    notes: splitSections(src.slice(notesAt + NOTES.length)),
  }
}

/** Notes are `### heading` blocks; anything before the first one is one block. */
function splitSections(body) {
  const out = []
  let cur = []
  for (const line of String(body).split('\n')) {
    if (line.startsWith('### ')) { if (cur.join('\n').trim()) out.push(cur.join('\n').trim()); cur = [line] }
    else cur.push(line)
  }
  if (cur.join('\n').trim()) out.push(cur.join('\n').trim())
  return out
}

/**
 * Hold the file to `keepNotes` newest sections and `maxBytes` overall.
 *
 * Returns `{ text, archived }`. `archived` is the evicted sections, oldest
 * first, for appending to the archive — never dropped.
 *
 * Pinned is never counted against `keepNotes` and never evicted. A pinned
 * region that alone exceeds `maxBytes` is left intact and over budget: it was
 * declared durable, and silently deleting a durable fact to satisfy a size
 * limit is worse than an oversized file.
 */
export function trimMemory(text, { keepNotes = 20, maxBytes = 24_000 } = {}) {
  const m = parseMemory(text)
  if (!m.wellFormed) return { text: String(text ?? ''), archived: [] }

  let notes = m.notes.slice()
  const archived = []
  // Notes are newest-first, so the oldest are at the end.
  while (notes.length > keepNotes) archived.unshift(notes.pop())

  const render = ns => [
    m.preamble, '', PINNED, '', m.pinned, '', NOTES, '', ns.join('\n\n'), '',
  ].join('\n').replace(/\n{4,}/g, '\n\n\n')

  while (notes.length > 1 && Buffer.byteLength(render(notes), 'utf8') > maxBytes) {
    archived.unshift(notes.pop())
  }
  return { text: render(notes), archived }
}

/** The block handed to a session at start. Empty string when there is nothing
 *  worth saying, so a fresh project does not get a paragraph about an empty file. */
export function memoryBrief(text) {
  const m = parseMemory(text)
  const body = String(text ?? '').trim()
  if (!body) return ''
  if (!m.wellFormed) return `Your durable memory:\n\n${body}`
  if (!m.pinned && !m.notes.length) return ''
  return `Your durable memory, carried across session rotations. `
    + `Treat it as established, and append what you learn:\n\n${body}`
}
