import { describe, expect, it } from 'vitest'
import { createHookListenerState } from './agent-hook-listener/listener-state'
import {
  amplifierRosterToSnapshots,
  applyAmplifierAgentEnd,
  applyAmplifierAgentStart,
  getAmplifierRoster
} from './amplifier-subagent-roster'

const PANE = 'tab-1:0'

describe('amplifier subagent roster', () => {
  it('adds a working entry on agent_start, keyed by subsession_id', () => {
    const state = createHookListenerState()
    applyAmplifierAgentStart(state, PANE, {
      subsession_id: 'sub-1',
      agent_name: 'anchors:explorer'
    })
    const roster = getAmplifierRoster(state, PANE)
    expect(roster?.get('sub-1')).toMatchObject({
      id: 'sub-1',
      agentType: 'anchors:explorer',
      state: 'working'
    })
  })

  it('ignores agent_start with no subsession_id (nothing to key the row on)', () => {
    const state = createHookListenerState()
    applyAmplifierAgentStart(state, PANE, { agent_name: 'anchors:explorer' })
    expect(getAmplifierRoster(state, PANE)).toBeUndefined()
  })

  it('marks the entry idle on a successful agent_end, keeping it (not deleting)', () => {
    const state = createHookListenerState()
    applyAmplifierAgentStart(state, PANE, { subsession_id: 'sub-1', agent_name: 'self' })
    applyAmplifierAgentEnd(state, PANE, { subsession_id: 'sub-1', success: true })
    const entry = getAmplifierRoster(state, PANE)?.get('sub-1')
    expect(entry?.state).toBe('idle')
    expect(entry?.agentType).toBe('self') // Why: end data carries no agent_name -- start's identity must survive.
  })

  it('marks the entry unverifiable when success is explicitly false', () => {
    const state = createHookListenerState()
    applyAmplifierAgentStart(state, PANE, { subsession_id: 'sub-1' })
    applyAmplifierAgentEnd(state, PANE, { subsession_id: 'sub-1', success: false })
    expect(getAmplifierRoster(state, PANE)?.get('sub-1')?.state).toBe('unverifiable')
  })

  it('ignores agent_end for a subsession_id with no matching agent_start', () => {
    const state = createHookListenerState()
    applyAmplifierAgentEnd(state, PANE, { subsession_id: 'never-started', success: true })
    expect(getAmplifierRoster(state, PANE)).toBeUndefined()
  })

  it('tracks multiple concurrent subagents independently, e.g. a parallel dispatch', () => {
    const state = createHookListenerState()
    applyAmplifierAgentStart(state, PANE, { subsession_id: 'sub-a', agent_name: 'self' })
    applyAmplifierAgentStart(state, PANE, {
      subsession_id: 'sub-b',
      agent_name: 'anchors:explorer'
    })
    applyAmplifierAgentEnd(state, PANE, { subsession_id: 'sub-a', success: true })
    const roster = getAmplifierRoster(state, PANE)
    expect(roster?.get('sub-a')?.state).toBe('idle')
    expect(roster?.get('sub-b')?.state).toBe('working') // still running -- unaffected by sub-a's end
  })

  it('keeps rosters isolated per pane', () => {
    const state = createHookListenerState()
    applyAmplifierAgentStart(state, 'tab-1:0', { subsession_id: 'sub-1' })
    expect(getAmplifierRoster(state, 'tab-2:0')).toBeUndefined()
  })

  describe('amplifierRosterToSnapshots', () => {
    it('returns undefined (not an empty array) for an empty or missing roster', () => {
      expect(amplifierRosterToSnapshots(undefined)).toBeUndefined()
      expect(amplifierRosterToSnapshots(new Map())).toBeUndefined()
    })

    it('projects tracked entries to the generic wire shape', () => {
      const state = createHookListenerState()
      applyAmplifierAgentStart(state, PANE, { subsession_id: 'sub-1', agent_name: 'self' })
      const snapshots = amplifierRosterToSnapshots(getAmplifierRoster(state, PANE))
      expect(snapshots).toEqual([
        expect.objectContaining({ id: 'sub-1', agentType: 'self', state: 'working' })
      ])
    })
  })
})
