import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { AgentHookServer } from '../../agent-hook-server'
import { amplifierAgentEventsPath } from '../../../amplifier-agent-bridge-tailer'

const PANE = makePaneKey('tab-settlement', '11111111-1111-4111-8111-111111111111')
const LAUNCH_TOKEN = 'settlement-launch'
let directory: string
const servers: AgentHookServer[] = []

async function startServer(): Promise<AgentHookServer> {
  const server = new AgentHookServer()
  servers.push(server)
  await server.start({ env: 'production', userDataPath: directory })
  return server
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-settlement-'))
})

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  await rm(directory, { recursive: true, force: true })
})

async function registerWrapper(
  server: AgentHookServer,
  isCurrent = () => true,
  bindingToken = LAUNCH_TOKEN
) {
  const file = amplifierAgentEventsPath(directory, directory, 'current-session')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, '')
  await server.registerAmplifierAgentSession(PANE, directory, 'current-session', {
    home: directory,
    launchToken: LAUNCH_TOKEN
  })
  const wrapper = {
    sessionId: 'current-session',
    wrapperId: 'wrapper-1',
    pid: process.pid,
    cwd: directory,
    home: directory,
    workspace: basename(directory),
    paneKey: PANE,
    launchToken: bindingToken
  }
  await server.observeAmplifierAgentWrapper(
    PANE,
    wrapper,
    { ptyId: 'pty-1', incarnationId: 'inc-1' },
    isCurrent
  )
  return { file, wrapper }
}

async function spawnDelegate(file: string, id: string) {
  await appendFile(
    file,
    `${JSON.stringify({
      event: 'delegate:agent_spawned',
      data: { sub_session_id: id, agent: 'builder' }
    })}\n`
  )
  return (await stat(file)).size
}

function settle(server: AgentHookServer, through: number, turn = 1, from = 0) {
  return server.settleAmplifierAgentTurnForPane(PANE, true, 'current-session', {
    sessionId: 'current-session',
    wrapperId: 'wrapper-1',
    turn,
    from,
    through,
    failed: true
  })
}

describe('host-owned Amplifier delegate settlement', () => {
  it('persists and fans out delegate settlement without changing the lead verdict', async () => {
    const server = await startServer()
    const { file } = await registerWrapper(server)
    const through = await spawnDelegate(file, 'last-delegate')
    await appendFile(file, `${JSON.stringify({ event: 'orchestrator:complete', data: {} })}\n`)
    const pushed: unknown[] = []
    server.setListener((row) => pushed.push(row.payload))
    await settle(server, through)
    const expected = {
      state: 'done',
      subagents: [expect.objectContaining({ id: 'last-delegate', state: 'unverifiable' })]
    }
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject(expected)
    expect(pushed.at(-1)).toMatchObject(expected)
    expect(server.flushStatusPersistSync()).toBe(true)
    server.stop()
    expect((await startServer()).getStatusSnapshotForPane(PANE)[0]).toMatchObject(expected)
  })

  it('rejects duplicate and stale byte ranges without settling the next turn', async () => {
    const server = await startServer()
    const { file } = await registerWrapper(server)
    const endA = await spawnDelegate(file, 'turn-a')
    await settle(server, endA)
    const endB = await spawnDelegate(file, 'turn-b')
    await settle(server, endA)
    await settle(server, endA, 2)
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      state: 'working',
      subagents: expect.arrayContaining([
        expect.objectContaining({ id: 'turn-b', state: 'working' })
      ])
    })
    await settle(server, endB, 3, endA)
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      state: 'working',
      subagents: expect.arrayContaining([
        expect.objectContaining({ id: 'turn-b', state: 'unverifiable' })
      ])
    })
  })

  it('does not settle after its wrapper loses the PTY incarnation', async () => {
    const server = await startServer()
    let current = true
    const { file } = await registerWrapper(server, () => current)
    const through = await spawnDelegate(file, 'unclaimed')
    await server.ingestLiveFileRecord({
      paneKey: PANE,
      source: 'amplifier-agent',
      hookEventName: 'delegate:agent_spawned',
      payload: { sub_session_id: 'unclaimed', agent: 'builder' },
      launchToken: LAUNCH_TOKEN,
      receivedAt: Date.now()
    })
    current = false
    await settle(server, through)
    await server.settleAmplifierAgentTurnForPane(PANE, true, 'old-session', {
      sessionId: 'old-session',
      wrapperId: 'old-wrapper',
      turn: 1,
      from: 0,
      through,
      failed: true
    })
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      state: 'working',
      subagents: [expect.objectContaining({ id: 'unclaimed', state: 'working' })]
    })
  })

  it.each(['', 'unrelated-launch'])('rejects wrapper launch proof %j', async (bindingToken) => {
    const server = await startServer()
    const { file } = await registerWrapper(server, () => true, bindingToken)
    const through = await spawnDelegate(file, 'untrusted')
    await server.ingestLiveFileRecord({
      paneKey: PANE,
      source: 'amplifier-agent',
      hookEventName: 'delegate:agent_spawned',
      payload: { sub_session_id: 'untrusted', agent: 'builder' },
      launchToken: LAUNCH_TOKEN,
      receivedAt: Date.now()
    })
    await settle(server, through)
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      state: 'working',
      subagents: [expect.objectContaining({ id: 'untrusted', state: 'working' })]
    })
  })
})
