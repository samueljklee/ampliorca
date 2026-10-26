# Pane Dispatch Contract — v1 (DRAFT)

**Who builds against this:** the Chief of Staff agent, whose `send_to_session`
tool is the reference implementation; Orca's PTY write path
(`src/main/ipc/pty/ipc/write-input.ts` and the agent-session write refusal
report), which is what a dispatch goes through; and the operator, who must be
able to see and stop every message sent on their behalf. The check is a
confirmed dispatch appearing in the target pane and an unconfirmed one never
reaching it.

## What it looks like

The operator says "tell the second pane to run the tests." The Chief of Staff
waits for the sentence to end, reads back "Sending to pane 2 (amplifier-agent,
idle): _run the tests_ — go?", gets a yes, and the text appears in pane 2's
terminal followed by Enter. The agent there treats it as its next prompt.

```
send_to_session(sessionRef, text, confirmation) ->
    { delivered: true,  paneKey, at, echoedInPane: true }
  | { delivered: false, reason: "target is working - not interrupted" }
  | { delivered: false, reason: "no confirmation for this exact text" }
```

## Purpose

An agent that can type into other agents' sessions is either the most useful
thing in the room or the most dangerous, and the difference is entirely in the
gate. Without this contract a misheard half-sentence becomes a prompt in the
wrong pane with nobody watching. Because of it, every dispatch is visible where
it lands, refused when the target is busy, and impossible without a confirmation
tied to the exact text.

## Core (the teeth)

1. **Dispatch is typed input, visible in the pane.** The message enters the
   target through the same PTY write path as the keyboard — text, then Enter —
   so it appears in that pane's terminal and the agent receives it as an
   ordinary prompt. Broken: a message delivered by any side channel the operator
   cannot see in the pane.
2. **A working pane is never interrupted.** Dispatch proceeds only when the
   target's status is `done` or `waiting`; against `working` or `blocked` it
   returns a refusal naming the state. Broken: text landing in a pane mid-turn.
   Whether a refused dispatch is queued for later is not frozen here.
3. **No dispatch without a confirmation bound to the exact text.** The tool
   handler — not the model — checks that a confirmation was issued for this
   target and this text after a read-back, and refuses otherwise. Broken: any
   path by which a model call alone puts bytes in a PTY.
4. **The gate opens only after the operator's turn ends.** No read-back and no
   dispatch is initiated from a partial utterance; end-of-turn comes from the
   voice layer's own detection, not from the model deciding the operator is
   probably done. Broken: a read-back that begins while the operator is still
   speaking.
5. **Every dispatch and every refusal is recorded.** Timestamp, target
   `paneKey`, agent type, text and outcome are written where the operator can
   review them. Broken: a message in a pane that nobody can trace to the request
   that caused it.
6. **Dispatch works for every agent type the snapshot lists.** Amplifier,
   amplifier-agent, Claude, Codex and the rest are addressed the same way.
   Broken: a dispatch that succeeds to one agent type and silently fails to
   another.

## What v1 deliberately does NOT freeze

- Queue-versus-refuse for a busy target — promoted when the operator asks for
  "when it's done" more than once in a session.
- How "clear intent" is judged before the read-back — promoted when a
  mis-dispatch is caught and traced to ambiguity.
- The record's storage location and retention — promoted when a second reader
  besides the operator needs it.
- Dispatch to a pane on a relay-connected remote host — promoted when asked for.

## Conformance kit asserts

- With the target `done`, a confirmed dispatch appears in its terminal and its
  status row moves to `working`.
- With the target `working`, the same dispatch returns a refusal naming
  `working` and zero bytes reach the PTY.
- A dispatch with no confirmation, or with a confirmation issued for different
  text, is refused.
- Each delivered or refused dispatch produces exactly one record with target,
  text and outcome.
- Speaking through the end of a sentence produces no read-back until the
  operator stops (human check; recorded by name and date).

## Reserved / open questions (NOT frozen)

- Whether the operator can pre-authorise a class of messages ("always allow
  'run the tests'") — currently no.
- Whether a dispatch to a pane with an open interactive prompt
  (AskUserQuestion) should answer it or be refused.
