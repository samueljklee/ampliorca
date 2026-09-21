import { describe, expect, it } from 'vitest'

import { createHookListenerState } from './agent-hook-listener/listener-state'
import {
  amplifierAgentRosterToSnapshots,
  applyAmplifierAgentSubagentEnd,
  applyAmplifierAgentSubagentStart,
  getAmplifierAgentRoster,
  settleAmplifierAgentRosterForPane
} from './amplifier-agent-subagent-roster'

const PANE = 'tab-1:0'

describe('amplifier-agent subagent roster', () => {
  it.each([
    { failed: false, expected: 'idle' },
    { failed: true, expected: 'unverifiable' }
  ] as const)(
    'settles only working delegates to $expected after a turn exits',
    ({ failed, expected }) => {
      const state = createHookListenerState()
      applyAmplifierAgentSubagentStart(state, PANE, {
        sub_session_id: 'working-delegate',
        agent: 'builder'
      })
      applyAmplifierAgentSubagentStart(state, PANE, {
        sub_session_id: 'already-finished',
        agent: 'reviewer'
      })
      applyAmplifierAgentSubagentEnd(state, PANE, { sub_session_id: 'already-finished' }, false)

      expect(settleAmplifierAgentRosterForPane(state, PANE, { failed })).toBe(true)
      expect(amplifierAgentRosterToSnapshots(getAmplifierAgentRoster(state, PANE))).toEqual([
        expect.objectContaining({ id: 'working-delegate', state: expected }),
        expect.objectContaining({ id: 'already-finished', state: 'idle' })
      ])
    }
  )

  it('adds a working entry keyed by sub_session_id and preserves the agent type', () => {
    const state = createHookListenerState()
    applyAmplifierAgentSubagentStart(state, PANE, {
      sub_session_id: 'sub-1',
      agent: 'explorer'
    })

    expect(getAmplifierAgentRoster(state, PANE)?.get('sub-1')).toMatchObject({
      id: 'sub-1',
      agentType: 'explorer',
      state: 'working'
    })
  })

  it('marks completed children idle and cancelled children unverifiable', () => {
    const state = createHookListenerState()
    applyAmplifierAgentSubagentStart(state, PANE, {
      sub_session_id: 'completed',
      agent: 'explorer'
    })
    applyAmplifierAgentSubagentStart(state, PANE, { sub_session_id: 'cancelled' })

    applyAmplifierAgentSubagentEnd(state, PANE, { sub_session_id: 'completed' }, false)
    applyAmplifierAgentSubagentEnd(state, PANE, { sub_session_id: 'cancelled' }, true)

    expect(amplifierAgentRosterToSnapshots(getAmplifierAgentRoster(state, PANE))).toEqual([
      expect.objectContaining({ id: 'completed', agentType: 'explorer', state: 'idle' }),
      expect.objectContaining({ id: 'cancelled', state: 'unverifiable' })
    ])
  })

  it('ignores incomplete or unknown child records', () => {
    const state = createHookListenerState()
    applyAmplifierAgentSubagentStart(state, PANE, { agent: 'explorer' })
    applyAmplifierAgentSubagentEnd(state, PANE, { sub_session_id: 'missing' }, false)

    expect(getAmplifierAgentRoster(state, PANE)).toBeUndefined()
  })
})
