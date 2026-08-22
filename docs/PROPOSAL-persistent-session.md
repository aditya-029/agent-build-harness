# Proposal: make the session you talk to the session that builds

**Status: IMPLEMENTED 2026-08-22.** Shipped as `persistentSession` (default on) plus
`harness chat`. Raised by Aditya, who described the problem exactly and whose phrasing —
"a Claude Code chat" — produced a better design than the one first proposed here: the section
below originally called for a custom REPL fed over stdin. That turned out to be unnecessary.
A headless session writes an ordinary transcript, so the orchestrator can just be resumed
interactively and you get the genuine TUI for free. The stdin/streaming design is kept below
because its `steer` verb (interrupt mid-turn) is still worth having and is not yet built.
**Problem:** the harness spawns a fresh one-shot `claude -p` per tick, so there is no session
to talk *to*. Steering it means opening a second interactive Claude Code session that reads
logs and runs `harness say` on your behalf — a middle man between you and the build.

---

## What the harness does today

```
launchd ──15m──▶ harness tick ──▶ claude -p "<prompt>"  ──▶ exits
                                   (cold start, every time)
                 harness say ──▶ inbox.md ──▶ PreToolUse hook ──▶ additionalContext
```

Three consequences, all of them the same root cause:

1. **No continuity.** Every tick re-reads CLAUDE.md, `git log` and the tree. That is most of
   the $0.399 an idle session costs, and a large part of a working one.
2. **The channel is one-way and second-class.** `harness say` writes a file; the hook injects
   it as `additionalContext` on the agent's next tool call. That is a *nudge*, not a turn. The
   agent cannot answer you.
3. **So you need a middle man.** A second session that reads `run.log`, interprets it, and
   relays. It is the only thing in the system with no reason to exist.

## What the CLI can actually do

All four verified on **Claude Code 2.1.220**, on this machine, on 2026-08-22.

| Claim | Test | Result |
|---|---|---|
| One process serves many turns, context persists | told it a number, closed the turn, asked for it back | same `session_id`, recalled `4097` ✓ |
| Hooks still fire in `--print` streaming mode | logging hook on `PreToolUse` + `SessionStart` | both fired ✓ |
| A message can be **queued** mid-turn | injected while it ran 4 sequential Bash calls | finished all 4, then answered ✓ |
| A message can **interrupt** mid-turn | `{"type":"interrupt"}` + user message | dropped the work after call 1, obeyed ✓ |
| A session survives the parent process dying | new process, `--resume <id>` | same session, full recall ✓ |

The primitive is **bidirectional stream-json**:

```bash
claude -p --input-format stream-json --output-format stream-json --verbose \
       --dangerously-skip-permissions --model sonnet
```

stdin takes one JSON object per line, forever:

```json
{"type":"user","message":{"role":"user","content":"continue the build"}}
{"type":"interrupt"}
```

The Agent SDK calls this "streaming input mode" and documents it as the **preferred** mode.
The harness has been using the one-shot mode it calls "more limited".

## Prior art — and why nobody's repo looks like the reels

Three families, from a scan of the ecosystem:

**1. PTY / tmux wrappers.** `awslabs/cli-agent-orchestrator`, `agent-manager`,
`claude_code_agent_farm`, and the mobile clients **Happy** and **Omnara**. They run the *real
interactive* `claude` inside a pty and either attach you to it or relay keystrokes from a
phone. This is what most of the impressive short-form demos actually are, and it is why the
repos disappoint: the orchestration is `tmux send-keys`, and the agent's state lives in a
terminal scrollback buffer rather than in anything structured. It demos beautifully and it
cannot be reasoned about.

**2. Supervisor-plus-workers.** CAO, `claude-code-orchestrator`, Maestro. A supervisor agent
delegates to worker agents. Worth noting: in CAO the human still talks to a supervisor that is
*distinct* from the workers. That is the same middle man, promoted to an architecture.

**3. Bidirectional stream-json.** One long-lived process, messages pushed over stdin. Rare in
the demo ecosystem because it needs a real host process to own the pipe — which is precisely
what this harness already is. The harness is one spawn call away from the good architecture
and nobody would guess it from the outside.

## The proposal

Keep everything the harness already knows. Change what `tick` does.

```
                    ┌──────────────────────────────────────┐
launchd ──15m──────▶│                                      │
harness say  ──────▶│   ONE long-lived claude process      │──▶ stream ──▶ dashboard
harness steer ─────▶│   (streaming stdin, context alive)   │            └▶ your terminal
you, from a REPL ──▶│                                      │            └▶ your phone
                    └──────────────────────────────────────┘
```

### Four changes

**1. `tick` sends a turn instead of spawning a process.** If no session is live, start one and
send the prompt. If one is live, send `"continue — next unit"`. The scheduler stops being a
process launcher and becomes a *heartbeat into a conversation*.

**2. `say` becomes a real user turn; add `steer`.** Two verbs, because the test showed two
genuinely different behaviours:
- `harness say "..."` — queued. Lands after the current unit finishes. The default.
- `harness steer "..."` — `interrupt` + turn. Lands now. For "stop, you're on the wrong thing".

The `inbox.md` + `additionalContext` path stays *only* for supervisor advisories (context
warnings), which genuinely are out-of-band nudges rather than things you said.

**3. `harness chat` — the thing that removes the middle man.** A REPL attached to the live
session: you type, it goes in as a user turn, the agent's replies stream back. Same session
the scheduler is driving. No second Claude Code session anywhere.

**4. Session rotation, so persistence does not fight the context ceiling.** This is the part
that must not be got wrong. The harness's existing design deliberately restarts to keep
context small — 70k warn, 90k handoff. A permanently persistent session grows without bound
and would undo that.

So: **the conversation is a stable address; the session behind it rotates.** At the handoff
ceiling the harness tells the agent to write its journal line, ends that session, and starts a
fresh one seeded with the journal — exactly what happens today, except `harness chat` never
notices. You keep talking to "the build". The harness manages which session that currently is.

### What this costs

- **`--print` mode has no interactive UI.** No slash commands, no permission prompts. The
  harness already runs `--dangerously-skip-permissions`, so nothing changes in practice, but
  `harness chat` is a plain REPL, not the Claude Code TUI.
- **A long-lived process is a thing that can die.** Mitigated, and cheaply: `--resume <id>`
  was verified to recover a session from a dead process with full recall, and the harness
  already persists the id in `.harness/current_session`.
- **Two people typing into one session will interleave.** Single-operator tool; worth a lock
  on `harness chat` rather than a design.

### What it is worth

Removes the middle-man session. Removes the cold start on every tick — which is the same
$0.399/session the idle backoff was built to stop wasting, attacked from the other end. And it
makes the agent answerable: today it can be nudged, but it cannot reply.

## Recommended sequencing

1. `--input-format stream-json` behind a `persistentSession` config flag, default off. `tick`
   learns to send a turn into a live session.
2. `harness chat`. This is the point at which the middle man disappears — ship it early.
3. `say` / `steer` split.
4. Rotation at the context ceiling. **Do not skip this**, and do not ship 1–3 to an unattended
   build without it.
5. Default the flag on once a real build has run a week on it.

Steps 1–3 are the fix Aditya asked for. Step 4 is what keeps it from regressing the thing the
harness was built to get right.
