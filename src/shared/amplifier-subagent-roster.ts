// Why: Amplifier's delegate() model reports sub-agents via hooks-orca-bridge's
// own agent_start/agent_end feed records (subsession_id, agent_name), not a
// push-hook payload shaped like Claude's or Codex's. This tracker is
// deliberately minimal for v1 -- no idle/liveness expiry, no lead-turn
// gating -- just enough to populate the generic AgentSubagentSnapshot[]
// wire field the sidebar (WorktreeCardAgents) already renders for any
// provider. See claude-subagent-roster.ts for the fuller-featured sibling
// this intentionally does not copy in full.

import type { AgentSubagentSnapshot, AgentSubagentState } from './agent-status-types'
import type { HookListenerState } from './agent-hook-listener/listener-state'

export type TrackedAmplifierSubagent = {
  id: string
  agentType?: string
  state: AgentSubagentState
  startedAt: number
}

export type AmplifierSubagentRoster = Map<string, TrackedAmplifierSubagent>

function readStringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Record an agent_start: adds (or refreshes) one roster entry for this pane. */
export function applyAmplifierAgentStart(
  state: HookListenerState,
  paneKey: string,
  data: Record<string, unknown>
): void {
  const id = readStringField(data, 'subsession_id')
  if (!id) {
    return
  }
  let roster = state.amplifierSubagentRosterByPaneKey.get(paneKey)
  if (!roster) {
    roster = new Map()
    state.amplifierSubagentRosterByPaneKey.set(paneKey, roster)
  }
  roster.set(id, {
    id,
    agentType: readStringField(data, 'agent_name'),
    state: 'working',
    startedAt: Date.now()
  })
}

/** Record an agent_end: marks the entry idle rather than removing it, so a
 *  just-finished agent is still visible in the sidebar briefly instead of
 *  disappearing the instant it completes. */
export function applyAmplifierAgentEnd(
  state: HookListenerState,
  paneKey: string,
  data: Record<string, unknown>
): void {
  const id = readStringField(data, 'subsession_id')
  if (!id) {
    return
  }
  const roster = state.amplifierSubagentRosterByPaneKey.get(paneKey)
  const existing = roster?.get(id)
  if (!roster || !existing) {
    return
  }
  const success = data.success
  roster.set(id, {
    ...existing,
    state: success === false ? 'unverifiable' : 'idle'
  })
}

export function getAmplifierRoster(
  state: HookListenerState,
  paneKey: string
): AmplifierSubagentRoster | undefined {
  return state.amplifierSubagentRosterByPaneKey.get(paneKey)
}

/** Converts the internal tracker to the generic wire shape every provider's
 *  status payload carries. Returns undefined (not an empty array) when
 *  there's nothing to report, matching AgentSubagentSnapshot[]'s own
 *  "absent means none tracked" convention. */
export function amplifierRosterToSnapshots(
  roster: AmplifierSubagentRoster | undefined
): AgentSubagentSnapshot[] | undefined {
  if (!roster || roster.size === 0) {
    return undefined
  }
  return Array.from(roster.values()).map(({ id, agentType, state, startedAt }) => ({
    id,
    agentType,
    state,
    startedAt
  }))
}
