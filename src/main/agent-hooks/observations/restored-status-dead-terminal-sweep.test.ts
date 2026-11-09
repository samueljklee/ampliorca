import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../server/agent-hook-server'
import { retireRestoredStatusesWithDeadTerminals } from './restored-status-dead-terminal-sweep'

const PANE = 'tab-restored:11111111-1111-4111-8111-111111111111'
const WRAPPER_PANE = 'tab-wrapper:11111111-1111-4111-8111-111111111111'
const directories: string[] = []
const servers: AgentHookServer[] = []
const OBSERVED_AT = 1_800_000_000_000

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: OBSERVED_AT })
})

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  vi.useRealTimers()
})

async function restoredServer(): Promise<AgentHookServer> {
  const directory = mkdtempSync(join(tmpdir(), 'orca-restored-amplifier-'))
  directories.push(directory)
  mkdirSync(join(directory, 'agent-hooks'))
  writeFileSync(
    join(directory, 'agent-hooks', 'last-status.json'),
    JSON.stringify({
      version: 2,
      authorityCommitments: {},
      entries: {
        [PANE]: {
          paneKey: PANE,
          tabId: 'tab-restored',
          worktreeId: 'folder:project',
          connectionId: null,
          providerSession: { key: 'session_id', id: 'plain-session' },
          payload: { agentType: 'amplifier', state: 'working', prompt: 'review' },
          receivedAt: OBSERVED_AT,
          stateStartedAt: OBSERVED_AT
        },
        [WRAPPER_PANE]: {
          paneKey: WRAPPER_PANE,
          tabId: 'tab-wrapper',
          worktreeId: 'folder:project',
          connectionId: null,
          providerSession: { key: 'session_id', id: 'wrapper-session' },
          payload: { agentType: 'amplifier-agent', state: 'working', prompt: 'build' },
          receivedAt: OBSERVED_AT,
          stateStartedAt: OBSERVED_AT
        }
      }
    })
  )
  const server = new AgentHookServer()
  servers.push(server)
  await server.start({ userDataPath: directory })
  return server
}

function sweep(
  server: AgentHookServer,
  probePtyLiveness: (ptyId: string) => Promise<boolean | null>
) {
  return retireRestoredStatusesWithDeadTerminals({
    server,
    probePtyLiveness,
    isLocalExecutionHost: () => true,
    getBoundPtyIdForPaneKey: () => undefined,
    getPersistedPtyIdForPaneKey: (paneKey) => (paneKey === PANE ? 'pty-plain' : 'pty-wrapper')
  })
}

describe('restored Amplifier terminal reconciliation', () => {
  it('requires terminal absence, not an unavailable probe, and retains resumable conversations', async () => {
    const server = await restoredServer()
    await sweep(server, async (id) => (id === 'pty-plain' ? false : null))
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      providerSessionOnly: true,
      providerSession: { id: 'plain-session' }
    })
    expect(server.getStatusSnapshotForPane(WRAPPER_PANE)[0]).toMatchObject({
      state: 'working',
      restoredUnconfirmed: true
    })
    await sweep(server, async () => false)
    expect(server.getStatusSnapshotForPane(WRAPPER_PANE)[0]).toMatchObject({
      providerSessionOnly: true,
      providerSession: { id: 'wrapper-session' }
    })
  })

  it('does not retire a wrapper that reports a new turn while its absence probe is pending', async () => {
    const server = await restoredServer()
    let release!: (live: boolean) => void
    const answer = new Promise<boolean>((resolve) => {
      release = resolve
    })
    const pending = sweep(server, async () => answer)
    server.ingestTerminalStatus({
      paneKey: WRAPPER_PANE,
      tabId: 'tab-wrapper',
      worktreeId: 'folder:project',
      payload: { agentType: 'amplifier-agent', state: 'working', prompt: 'new turn' }
    })
    release(false)
    await pending
    expect(server.getStatusSnapshotForPane(WRAPPER_PANE)[0]).toMatchObject({
      state: 'working',
      prompt: 'new turn'
    })
    expect(server.getStatusSnapshotForPane(WRAPPER_PANE)[0]?.providerSessionOnly).not.toBe(true)
  })
})
