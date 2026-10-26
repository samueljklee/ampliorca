import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { PANE } from './server.test-fixtures'
import type { SpoolRecord } from '../../shared/agent-hook-spool'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function amplifierRecord(overrides: Partial<SpoolRecord> = {}): SpoolRecord {
  return {
    paneKey: PANE,
    source: 'amplifier',
    hookEventName: 'turn_start',
    payload: {},
    launchToken: 'token-1',
    receivedAt: Date.now(),
    ...overrides
  }
}

describe('AgentHookServer ingestLiveFileRecord', () => {
  it.each([
    ['amplifier', 'turn_start', 'agent_end', 'turn_end'],
    ['amplifier-agent', 'prompt:submit', 'delegate:agent_completed', 'orchestrator:complete']
  ])('identifies only the %s parent completion as a turn end', (source, start, childEnd, end) => {
    const server = new AgentHookServer()
    server.ingestLiveFileRecord(
      amplifierRecord({
        source,
        hookEventName: start,
        payload: { prompt: 'Fix the bug' }
      })
    )
    server.ingestLiveFileRecord(amplifierRecord({ source, hookEventName: childEnd }))
    expect(server.getStatusSnapshot()[0]).not.toHaveProperty('turnEndedAt')
    server.ingestLiveFileRecord(amplifierRecord({ source, hookEventName: end }))
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'done',
      turnEndedAt: expect.any(Number),
      turnEndDisposition: 'identified'
    })
    expect(server.getStatusChangeSnapshot()[0]?.observedInCurrentRuntime).toBe(true)
    server.stop()
  })

  it('rejects disabled ingress and revoked tailer generations', () => {
    const server = new AgentHookServer()
    server.ingestLiveFileRecord(amplifierRecord(), () => false)
    expect(server.getStatusSnapshot()).toEqual([])
    server.setStatusHooksEnabled(false)
    server.ingestLiveFileRecord(amplifierRecord())
    expect(server.getStatusSnapshot()).toEqual([])
    server.stop()
  })

  it('applies a turn_start as a working status for the amplifier source', () => {
    const server = new AgentHookServer()
    server.ingestLiveFileRecord(amplifierRecord({ hookEventName: 'turn_start' }))

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: PANE, state: 'working', agentType: 'amplifier' })
    ])
  })

  it('moves to done on turn_end', () => {
    const server = new AgentHookServer()
    server.ingestLiveFileRecord(amplifierRecord({ hookEventName: 'turn_start' }))
    server.ingestLiveFileRecord(
      amplifierRecord({ hookEventName: 'turn_end', payload: { outcome: 'completed' } })
    )

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: PANE, state: 'done' })
    ])
  })

  it('populates the subagents roster from agent_start / agent_end, end to end', () => {
    const server = new AgentHookServer()
    server.ingestLiveFileRecord(amplifierRecord({ hookEventName: 'turn_start' }))
    server.ingestLiveFileRecord(
      amplifierRecord({
        hookEventName: 'agent_start',
        payload: { agent_name: 'anchors:explorer', subsession_id: 'sub-1' }
      })
    )

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: PANE,
        subagents: [
          expect.objectContaining({ id: 'sub-1', agentType: 'anchors:explorer', state: 'working' })
        ]
      })
    ])

    server.ingestLiveFileRecord(
      amplifierRecord({
        hookEventName: 'agent_end',
        payload: { subsession_id: 'sub-1', success: true }
      })
    )

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        subagents: [expect.objectContaining({ id: 'sub-1', state: 'idle' })]
      })
    ])
  })

  it('a usage record (no state change of its own) does not create a status row', () => {
    const server = new AgentHookServer()
    server.ingestLiveFileRecord(amplifierRecord({ hookEventName: 'usage', payload: {} }))

    expect(server.getStatusSnapshot()).toEqual([])
  })

  it('is observed as live in the current runtime -- not a replay-of-past-evidence path', () => {
    const server = new AgentHookServer()
    server.ingestLiveFileRecord(amplifierRecord({ hookEventName: 'turn_start' }))

    // Why this check: ingestSpoolRecord's replay path exists precisely so
    // startup-drained history is NOT mistaken for something the current
    // runtime actually witnessed. A genuinely live tailer record must land
    // on the opposite side of that same flag -- this is what actually
    // distinguishes ingestLiveFileRecord from ingestSpoolRecord underneath
    // the near-identical normalize/apply call sequence.
    expect(server.getStatusChangeSnapshot()[0]?.observedInCurrentRuntime).toBe(true)
  })

  it('ignores a record for an unregistered source', () => {
    const server = new AgentHookServer()
    server.ingestLiveFileRecord({ ...amplifierRecord(), source: 'not-a-real-source' })

    expect(server.getStatusSnapshot()).toEqual([])
  })
})
