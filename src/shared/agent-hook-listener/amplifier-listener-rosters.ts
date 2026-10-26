import type { AmplifierSubagentRoster } from '../amplifier-subagent-roster'
import type { AmplifierAgentSubagentRoster } from '../amplifier-agent-subagent-roster'
import { movePaneScopedMapEntries } from './pane-scoped-cache-entries'

export type AmplifierListenerRosters = {
  amplifierSubagentRosterByPaneKey: Map<string, AmplifierSubagentRoster>
  amplifierAgentSubagentRosterByPaneKey: Map<string, AmplifierAgentSubagentRoster>
}

export function create(): AmplifierListenerRosters {
  return {
    amplifierSubagentRosterByPaneKey: new Map(),
    amplifierAgentSubagentRosterByPaneKey: new Map()
  }
}

export function deletePane(state: AmplifierListenerRosters, paneKey: string): void {
  state.amplifierSubagentRosterByPaneKey.delete(paneKey)
  state.amplifierAgentSubagentRosterByPaneKey.delete(paneKey)
}

export function paneHasClaims(state: AmplifierListenerRosters, paneKey: string): boolean {
  return (
    state.amplifierSubagentRosterByPaneKey.has(paneKey) ||
    state.amplifierAgentSubagentRosterByPaneKey.has(paneKey)
  )
}

export function movePane(
  state: AmplifierListenerRosters,
  fromPaneKey: string,
  toPaneKey: string
): void {
  movePaneScopedMapEntries(state.amplifierSubagentRosterByPaneKey, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(state.amplifierAgentSubagentRosterByPaneKey, fromPaneKey, toPaneKey)
}

export function clear(state: AmplifierListenerRosters): void {
  state.amplifierSubagentRosterByPaneKey.clear()
  state.amplifierAgentSubagentRosterByPaneKey.clear()
}
