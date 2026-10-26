import { createStore } from 'zustand/vanilla'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { AgentStatusPayload } from '@/store/slices/agent-status/agent-status-contract'
import { createAgentStatusSlice } from '@/store/slices/agent-status'
import { createTerminalTabPresentationActions } from '@/store/terminals/terminal-tab-presentation'

export function createCommandFinishedStatusStore(): {
  acceptStatus: (paneKey: string, payload: AgentStatusPayload) => AgentStatusEntry
  acceptWorkingClaudeStatus: (paneKey: string) => AgentStatusEntry
  dropAgentStatus: (paneKey: string) => void
  getStatus: (paneKey: string) => AgentStatusEntry | undefined
} {
  const store = createStore<AppState>()((...args) => {
    const state = {
      settings: null,
      tabsByWorktree: {},
      sortEpoch: 0,
      acknowledgedAgentsByPaneKey: {},
      activityClearedAtByPaneKey: {},
      manuallyUnreadTurnsByPaneKey: {},
      ...createAgentStatusSlice(...args),
      ...createTerminalTabPresentationActions(args[0], args[1])
    } satisfies Partial<AppState>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only hook acceptance, row reads, and drop are exposed; their external fields and real title action are composed above.
    return state as AppState
  })
  const acceptStatus = (paneKey: string, payload: AgentStatusPayload): AgentStatusEntry => {
    store.getState().setAgentStatus(paneKey, payload)
    const row = store.getState().agentStatusByPaneKey[paneKey]
    if (!row) {
      throw new Error('Agent status was not accepted')
    }
    return row
  }
  return {
    acceptStatus,
    acceptWorkingClaudeStatus: (paneKey) =>
      acceptStatus(paneKey, {
        state: 'working',
        prompt: 'ship it',
        agentType: 'claude'
      }),
    dropAgentStatus: (paneKey) => store.getState().dropAgentStatus(paneKey),
    getStatus: (paneKey) => store.getState().agentStatusByPaneKey[paneKey]
  }
}
