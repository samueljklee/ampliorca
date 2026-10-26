import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { IPtyProvider } from '../../../providers/pty-provider-contract'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { agentHookServer } from '../../../agent-hooks/server'
import { amplifierAgentEventsPath } from '../../../agent-hooks/amplifier-agent-bridge-tailer'
import { rememberPaneKeyForPty, ptyPaneKey, paneKeyPtyId } from '../pane/key-state'
import { ptyIncarnationById } from './ownership-state'
import { bindProviderListeners } from './bind-listeners'
import { createPtyIpcSession } from '../session'

const hooks = vi.hoisted(() => ({
  onData: vi.fn<IPtyProvider['onData']>(),
  onExit: vi.fn<IPtyProvider['onExit']>()
}))
vi.mock('./registry', () => ({
  localProvider: { onData: hooks.onData, onExit: hooks.onExit }
}))
let directory: string | undefined
afterEach(() => {
  agentHookServer.stop()
  ptyPaneKey.clear()
  paneKeyPtyId.clear()
  ptyIncarnationById.delete('pty-headless')
  if (directory) {
    rmSync(directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

describe('headless amplifier-agent child-exit ingress', () => {
  it('settles only the ended turn with no renderer and ignores duplicate delivery', async () => {
    directory = mkdtempSync(join(tmpdir(), 'orca-wrapper-ingress-'))
    await agentHookServer.start({ userDataPath: directory })
    const paneKey = makePaneKey('tab-headless', '11111111-1111-4111-8111-111111111111')
    rememberPaneKeyForPty('pty-headless', paneKey)
    ptyIncarnationById.set('pty-headless', 'inc-1')
    agentHookServer.registerAmplifierAgentSession(paneKey, directory, 'current-session', {
      home: directory
    })
    const file = amplifierAgentEventsPath(directory, directory, 'current-session')
    mkdirSync(dirname(file), { recursive: true })
    const delegate = (id: string) =>
      `${JSON.stringify({
        event: 'delegate:agent_spawned',
        data: { sub_session_id: id, agent: 'builder' }
      })}\n`
    writeFileSync(file, delegate('turn-a'))
    const endA = statSync(file).size
    const rendererDelivery = vi.fn()
    hooks.onData.mockReturnValue(() => {})
    hooks.onExit.mockReturnValue(() => {})
    const session = createPtyIpcSession({})
    session.acceptPtyDataForRenderer = rendererDelivery
    bindProviderListeners(session)
    const onData = hooks.onData.mock.calls.at(-1)![0]
    onData({
      id: 'pty-headless',
      data: `[amplifier-agent-repl] bound ${JSON.stringify({
        paneKey,
        pid: process.pid,
        cwd: directory,
        home: directory,
        workspace: basename(directory),
        sessionId: 'current-session',
        wrapperId: 'run-1'
      })}\n`
    })
    const original = agentHookServer.settleAmplifierAgentTurnForPane.bind(agentHookServer)
    let completed!: () => void
    let done = new Promise<void>((resolve) => {
      completed = resolve
    })
    vi.spyOn(agentHookServer, 'settleAmplifierAgentTurnForPane').mockImplementation(
      async (...args) => {
        await original(...args)
        completed()
      }
    )
    const marker = `[amplifier-agent-repl] turn-settled session=current-session wrapper=run-1 turn=1 from=0 through=${endA} code=7\n`
    onData({ id: 'pty-headless', data: marker.slice(0, 30) })
    onData({ id: 'pty-headless', data: marker.slice(30) })
    await done
    expect(agentHookServer.getStatusSnapshotForPane(paneKey)[0]).toMatchObject({
      state: 'working',
      subagents: [expect.objectContaining({ id: 'turn-a', state: 'unverifiable' })]
    })
    appendFileSync(file, delegate('turn-b'))
    done = new Promise<void>((resolve) => {
      completed = resolve
    })
    onData({ id: 'pty-headless', data: marker })
    await done
    // A valid next boundary drains B, whose state must survive the older duplicate.
    const next = {
      sessionId: 'current-session',
      wrapperId: 'run-1',
      turn: 2,
      from: 0,
      through: endA,
      failed: false
    }
    await original(paneKey, false, 'current-session', next)
    expect(agentHookServer.getStatusSnapshotForPane(paneKey)[0]).toMatchObject({
      state: 'working',
      subagents: expect.arrayContaining([
        expect.objectContaining({ id: 'turn-b', state: 'working' })
      ])
    })
    expect(rendererDelivery).toHaveBeenCalledTimes(4)
  })
})
