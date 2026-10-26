import { describe, expect, it } from 'vitest'
import {
  clearAllListenerCaches,
  clearPaneCacheState,
  createHookListenerState,
  movePaneCacheState,
  paneHasStateClaims
} from './listener-state'
import { applyAmplifierAgentStart } from '../amplifier-subagent-roster'
import { applyAmplifierAgentSubagentStart } from '../amplifier-agent-subagent-roster'

describe('Amplifier roster listener lifecycle', () => {
  it.each(['amplifier', 'amplifier-agent'] as const)(
    'moves and clears %s claims without losing sibling or upstream provider state',
    (provider) => {
      const state = createHookListenerState()
      const other = createHookListenerState()
      const start = (paneKey: string) => {
        if (provider === 'amplifier') {
          applyAmplifierAgentStart(state, paneKey, {
            subsession_id: 'child',
            agent_name: 'builder'
          })
        } else {
          applyAmplifierAgentSubagentStart(state, paneKey, {
            sub_session_id: 'child',
            agent: 'builder'
          })
        }
      }
      start('source')
      start('sibling')
      state.claudeRunningNonAgentTaskPaneKeys.add('source')
      expect(paneHasStateClaims(state, 'source')).toBe(true)
      expect(paneHasStateClaims(other, 'source')).toBe(false)
      const rosters =
        provider === 'amplifier'
          ? state.amplifierSubagentRosterByPaneKey
          : state.amplifierAgentSubagentRosterByPaneKey
      const original = rosters.get('source')
      movePaneCacheState(state, 'source', 'destination')
      expect(rosters.get('destination')).toBe(original)
      expect(paneHasStateClaims(state, 'source')).toBe(false)
      expect(state.claudeRunningNonAgentTaskPaneKeys.has('destination')).toBe(true)
      clearPaneCacheState(state, 'destination')
      expect(paneHasStateClaims(state, 'destination')).toBe(false)
      expect(rosters.has('destination')).toBe(false)
      expect(paneHasStateClaims(state, 'sibling')).toBe(true)
      clearAllListenerCaches(state)
      expect(paneHasStateClaims(state, 'sibling')).toBe(false)
      expect(rosters.size).toBe(0)
    }
  )
})
