import type { AgentSubagentSnapshot, AgentSubagentState } from './agent-status-types'
import type { HookListenerState } from './agent-hook-listener/listener-state'

export type TrackedAmplifierAgentSubagent = {
  id: string
  agentType?: string
  state: AgentSubagentState
  startedAt: number
}

export type AmplifierAgentSubagentRoster = Map<string, TrackedAmplifierAgentSubagent>

function readStringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function applyAmplifierAgentSubagentStart(
  state: HookListenerState,
  paneKey: string,
  data: Record<string, unknown>
): void {
  const id = readStringField(data, 'sub_session_id')
  if (!id) {
    return
  }
  let roster = state.amplifierAgentSubagentRosterByPaneKey.get(paneKey)
  if (!roster) {
    roster = new Map()
    state.amplifierAgentSubagentRosterByPaneKey.set(paneKey, roster)
  }
  roster.set(id, {
    id,
    agentType: readStringField(data, 'agent'),
    state: 'working',
    startedAt: Date.now()
  })
}

export function applyAmplifierAgentSubagentEnd(
  state: HookListenerState,
  paneKey: string,
  data: Record<string, unknown>,
  failed: boolean
): void {
  const id = readStringField(data, 'sub_session_id')
  if (!id) {
    return
  }
  const roster = state.amplifierAgentSubagentRosterByPaneKey.get(paneKey)
  const existing = roster?.get(id)
  if (!roster || !existing) {
    return
  }
  roster.set(id, { ...existing, state: failed ? 'unverifiable' : 'idle' })
}

/** Settle only delegates left working when the persistent REPL's one-turn child ends.
 * The wrapper remains alive, so this must not clear any pane-wide state. */
export function settleAmplifierAgentRosterForPane(
  state: HookListenerState,
  paneKey: string,
  options: { failed: boolean; delegateIds?: ReadonlySet<string> }
): boolean {
  const roster = state.amplifierAgentSubagentRosterByPaneKey.get(paneKey)
  if (!roster) {
    return false
  }
  let changed = false
  for (const [id, entry] of roster) {
    if (entry.state !== 'working' || (options.delegateIds && !options.delegateIds.has(id))) {
      continue
    }
    roster.set(id, { ...entry, state: options.failed ? 'unverifiable' : 'idle' })
    changed = true
  }
  return changed
}

export function getAmplifierAgentRoster(
  state: HookListenerState,
  paneKey: string
): AmplifierAgentSubagentRoster | undefined {
  return state.amplifierAgentSubagentRosterByPaneKey.get(paneKey)
}

export function amplifierAgentRosterToSnapshots(
  roster: AmplifierAgentSubagentRoster | undefined
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
