# Session Observability Contract — v1 (DRAFT)

**Who builds against this:** the Chief of Staff agent, whose `list_sessions` and
`read_session` tools are the reference implementation; any manager or dashboard
surface that reads other sessions; the agent hook pipeline and the ai-vault
session parsers, which are what these tools read from. The check is the two
tools run against two live panes, one Amplifier and one amplifier-agent.

## What it looks like

The operator asks the Chief of Staff what is going on. It calls the snapshot
once, gets one small record per live pane, and answers. When asked for detail on
one pane it calls the paginated read and gets whole turns back.

```
list_sessions() ->
  [{ paneKey, agentType: "amplifier", state: "working", model,
     prompt: "fix the flaky test in...", toolName: "Bash",
     lastAssistantMessage: "Running the suite...",
     subagents: [{ id, agentType, state }],
     stateStartedAt, updatedAt, sessionRef }, ...]

read_session(sessionRef, cursor=null, turns=5) ->
  { turns: [{ index, startedAt, userPrompt: "<full text>",
              assistantText: "<full text>",
              toolCalls: [{ name, input, output }] }],
    nextCursor: "..." }
```

## Purpose

An agent that speaks for every session has to see every session, and see it
without disturbing it. Without this contract the Chief of Staff either guesses
from what is on screen or reaches into each session's internals its own way, per
agent. Because of it, one bounded snapshot and one complete read exist for every
agent Orca runs, and neither of them can change anything in the session it reads.

## Core (the teeth)

1. **The snapshot covers every live pane, every agent type, in one call.**
   Broken: a running Amplifier or amplifier-agent pane missing from
   `list_sessions` while a Claude pane is present. It affects the operator, who
   is told the room is quieter than it is. The record is the pane's
   `AgentStatusEntry` as the hook pipeline already holds it — state, prompt,
   tool, last message, sub-agents, model — nothing invented.
2. **Snapshot fields stay bounded.** Every text field in a snapshot record is at
   most `AGENT_STATUS_MAX_FIELD_LENGTH` (200) characters, and the snapshot never
   carries history beyond the pipeline's own capped state log. Broken: a
   snapshot that grows with the length of a session. Depth is clause 3's job.
3. **The paginated read returns whole turns, untruncated.** `read_session`
   returns complete user prompts, complete assistant text and each tool call for
   `n` turns from a cursor, with a cursor for the next page, reading the same
   session files the session-history panel reads. Broken: a prompt the snapshot
   truncated that the read also truncates, or turns returned out of order.
4. **The read works for every agent that has a session parser.** Amplifier,
   amplifier-agent, Claude, Codex and every other agent with an ai-vault parser
   is readable; an agent without one returns a stated "no transcript source",
   never an empty success. Broken: an empty page for a session that has a log.
5. **Neither tool mutates the session.** No input written, no focus change, no
   resume, no file touched in the session's own directory. Broken: any
   observable change in a pane after a snapshot or a read.
6. **The snapshot never blocks on an agent.** It is served from the status the
   pipeline already holds and returns even when every agent is mid-tool.
   Broken: a `list_sessions` call that waits for a turn to end.

## What v1 deliberately does NOT freeze

- The transport (renderer IPC, an MCP server, or local HTTP) — promoted when a
  second consumer besides the Chief of Staff needs it.
- Exact tool names and parameter shapes — promoted once the Chief of Staff has
  run against them for a week.
- What counts as one "turn" for agents whose logs interleave sub-agent output —
  promoted when a parser's turn count disagrees with the panel's.
- Sessions on relay-connected remote hosts — promoted when the Chief of Staff is
  asked about a remote pane.

## Conformance kit asserts

- With one Amplifier and one amplifier-agent pane live, `list_sessions` returns
  both, each with the state the sidebar shows.
- No string in any snapshot record exceeds 200 characters.
- For a pane whose last prompt exceeded 200 characters, `read_session` returns
  that prompt whole.
- `read_session` with `turns=2` called twice, chaining the cursor, returns four
  distinct consecutive turns.
- A pane's PTY receives zero bytes and its status row does not change across a
  snapshot and a read (human check until instrumented; recorded by name and
  date).

## Reserved / open questions (NOT frozen)

- Whether a snapshot record may carry a one-line summary written by the Chief of
  Staff, or only raw pipeline fields.
- Whether raw PTY scrollback is ever an acceptable fallback when no parser
  exists.
