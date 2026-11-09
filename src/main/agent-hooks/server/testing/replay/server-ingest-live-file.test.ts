import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { PANE } from '../server.test-fixtures'
import type { SpoolRecord } from '../../../../../shared/agent-hook-listener/transport/agent-hook-spool'

const OBSERVED_AT = 1_800_000_000_000
const servers: AgentHookServer[] = []

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: OBSERVED_AT })
  _internals.resetCachesForTests()
})

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function createServer(): AgentHookServer {
  const server = new AgentHookServer()
  servers.push(server)
  return server
}

function amplifierRecord(overrides: Partial<SpoolRecord> = {}): SpoolRecord {
  return {
    paneKey: PANE,
    source: 'amplifier',
    hookEventName: 'turn_start',
    payload: {},
    launchToken: 'launch-1',
    receivedAt: OBSERVED_AT,
    ...overrides
  }
}

describe('AgentHookServer ingestLiveFileRecord', () => {
  it('applies execution-host root evidence before accepting a process-bearing live record', async () => {
    const server = createServer()
    server.setHookRootEvidenceReader(async () => ({ verdict: 'nested' }))
    await server.ingestLiveFileRecord({
      paneKey: PANE,
      source: 'claude',
      hookEventName: 'UserPromptSubmit',
      agentProcess: { pid: 4242, platform: 'darwin', startTime: 'process-birth-1' },
      payload: { prompt: 'nested task', session_id: 'nested-session' },
      receivedAt: OBSERVED_AT
    })
    expect(server.getStatusSnapshotForPane(PANE)).toEqual([])
  })

  it('does not apply an ownership answer after its file binding was replaced', async () => {
    const server = createServer()
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    server.setHookRootEvidenceReader(async () => {
      await ready
      return { verdict: 'root', binding: 'inc-1' }
    })
    let current = true
    const pending = server.ingestLiveFileRecord(
      {
        paneKey: PANE,
        source: 'claude',
        hookEventName: 'UserPromptSubmit',
        agentProcess: { pid: 4242, platform: 'darwin', startTime: 'process-birth-1' },
        payload: { prompt: 'replaced task', session_id: 'old-session' },
        receivedAt: OBSERVED_AT
      },
      () => current
    )
    current = false
    release()
    await pending
    expect(server.getStatusSnapshotForPane(PANE)).toEqual([])
  })

  it.each([
    ['amplifier', 'turn_start', 'agent_end', 'turn_end'],
    ['amplifier-agent', 'prompt:submit', 'delegate:agent_completed', 'orchestrator:complete']
  ])(
    'identifies only the %s parent completion and revives only on a live turn',
    (source, start, childEnd, end) => {
      const server = createServer()
      server.ingestLiveFileRecord(
        amplifierRecord({ source, hookEventName: start, payload: { prompt: 'Fix the bug' } })
      )
      server.ingestLiveFileRecord(amplifierRecord({ source, hookEventName: childEnd }))
      expect(server.getStatusSnapshot()[0]).not.toHaveProperty('turnEndedAt')
      server.ingestLiveFileRecord(amplifierRecord({ source, hookEventName: end }))
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'done',
        turnEndedAt: OBSERVED_AT,
        turnEndDisposition: 'identified'
      })
      expect(server.getStatusChangeSnapshot()[0]?.observedInCurrentRuntime).toBe(true)
      server.retirePaneAuthority(PANE)
      server.ingestLiveFileRecord(amplifierRecord({ source, hookEventName: childEnd }))
      expect(server.getStatusSnapshotForPane(PANE)).toEqual([])
      server.ingestLiveFileRecord(
        amplifierRecord({ source, hookEventName: start, payload: { prompt: 'next turn' } })
      )
      expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
        agentType: source,
        state: 'working',
        prompt: 'next turn'
      })
    }
  )

  it('rejects disabled ingress and revoked tailer generations', () => {
    const server = createServer()
    server.ingestLiveFileRecord(amplifierRecord(), () => false)
    expect(server.getStatusSnapshot()).toEqual([])
    server.setStatusHooksEnabled(false)
    server.ingestLiveFileRecord(amplifierRecord())
    expect(server.getStatusSnapshot()).toEqual([])
  })

  it('publishes the live child roster without treating child completion as a parent turn end', () => {
    const server = createServer()
    server.ingestLiveFileRecord(amplifierRecord())
    server.ingestLiveFileRecord(
      amplifierRecord({
        hookEventName: 'agent_start',
        payload: { agent_name: 'anchors:explorer', subsession_id: 'sub-1' }
      })
    )
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      state: 'working',
      subagents: [{ id: 'sub-1', agentType: 'anchors:explorer', state: 'working' }]
    })
    server.ingestLiveFileRecord(
      amplifierRecord({
        hookEventName: 'agent_end',
        payload: { subsession_id: 'sub-1', success: true }
      })
    )
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      state: 'working',
      subagents: [{ id: 'sub-1', state: 'idle' }]
    })
  })
})
