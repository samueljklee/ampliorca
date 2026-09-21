import { describe, expect, it } from 'vitest'

import { createHookListenerState } from '../listener-state'
import { normalizeAmplifierAgentEvent } from './amplifier-agent-events'

const PANE = 'tab-1:0'

function normalize(eventName: string, payload: Record<string, unknown> = {}) {
  return normalizeAmplifierAgentEvent(
    createHookListenerState(),
    eventName,
    'Fix the bug',
    PANE,
    payload
  )
}

describe('normalizeAmplifierAgentEvent', () => {
  it.each([
    'session:start',
    'session:resume',
    'prompt:submit',
    'execution:start',
    'execution:end',
    'llm:request',
    'llm:response',
    'tool:pre',
    'tool:post',
    'delegate:agent_spawned',
    'delegate:agent_resumed',
    'delegate:agent_completed',
    'delegate:agent_cancelled'
  ])('maps %s to working', (eventName) => {
    expect(normalize(eventName)).toMatchObject({ state: 'working', agentType: 'amplifier-agent' })
  })

  it('maps orchestrator:complete to done', () => {
    expect(normalize('orchestrator:complete')).toMatchObject({
      state: 'done',
      agentType: 'amplifier-agent'
    })
  })

  it.each([
    'session:end',
    'provider:resolve',
    'provider:request',
    'provider:retry',
    'provider:error',
    'content_block:start',
    'content_block:end',
    'context:compaction',
    'mentions:resolved',
    'routing:matrix-loaded',
    'session:config'
  ])('leaves %s informational', (eventName) => {
    expect(normalize(eventName)).toBeNull()
  })

  it.each([
    ['tool_name', 'Bash'],
    ['name', 'Read'],
    ['tool', 'delegate']
  ])('defensively reads a tool name from %s', (key, toolName) => {
    expect(normalize('tool:pre', { [key]: toolName })).toMatchObject({ toolName })
  })

  it('mutates the child roster from spawn and completion events', () => {
    const state = createHookListenerState()
    const spawned = normalizeAmplifierAgentEvent(
      state,
      'delegate:agent_spawned',
      'Fix the bug',
      PANE,
      {
        sub_session_id: 'child-1',
        agent: 'explorer'
      }
    )
    const completed = normalizeAmplifierAgentEvent(
      state,
      'delegate:agent_completed',
      'Fix the bug',
      PANE,
      { sub_session_id: 'child-1', agent: 'explorer' }
    )

    expect(spawned?.subagents).toEqual([
      expect.objectContaining({ id: 'child-1', agentType: 'explorer', state: 'working' })
    ])
    expect(completed?.subagents).toEqual([
      expect.objectContaining({ id: 'child-1', agentType: 'explorer', state: 'idle' })
    ])
  })
})
