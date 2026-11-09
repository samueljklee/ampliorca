import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { IPtyProvider, PtySpawnOptions } from '../../../providers/pty-provider-contract'
import { agentHookServer } from '../../../agent-hooks/server/agent-hook-server'
import { amplifierAgentEventsPath } from '../../../agent-hooks/amplifier-agent-bridge-tailer'
import { restoreAmplifierAgentWrapperBinding } from '../../../agent-hooks/amplifier-agent-wrapper-bindings'
import { setLocalPtyProvider } from '../provider/registry'
import { bindProviderListeners } from '../provider/bind-listeners'
import { clearAmplifierAgentPtyIngress } from '../provider/amplifier-agent-turn-ingress'
import { ptyIncarnationById, ptyOwnership } from '../provider/ownership-state'
import { paneKeyPtyId, ptyPaneKey } from '../pane/key-state'
import { createPtyIpcSession } from '../session'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import {
  noCodexResumeLaunch,
  prepareCodexResumeHome,
  reconcileSharedRuntimeResumeHome,
  resolveCodexResumeLaunch,
  stripSequencedStartupResumeArgv
} from '../host-env/codex-resume'
import { runPtyIpcSpawn } from './spawn-run'
import type { PtySpawnIpcDeps } from './spawn-types'
import { spawnPtyFromRuntimeController } from '../runtime/spawn'
import type { PtyRuntimeControllerDeps } from '../runtime/controller-deps'
import { LocalPtyProvider } from '../../../providers/local-pty/local-pty-provider'

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = makePaneKey('tab-admission', LEAF)
const PTY = 'pty-early-wrapper'
let directory: string

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'orca-early-wrapper-'))
  await agentHookServer.start({ userDataPath: directory })
})

afterEach(() => {
  clearAmplifierAgentPtyIngress()
  agentHookServer.stop()
  paneKeyPtyId.delete(PANE)
  ptyPaneKey.delete(PTY)
  ptyIncarnationById.delete(PTY)
  ptyOwnership.delete(PTY)
  rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function event(id: string): string {
  return `${JSON.stringify({
    event: 'delegate:agent_spawned',
    data: { sub_session_id: id, agent: 'builder' }
  })}\n`
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function launch(resume = false, lane: 'ipc' | 'runtime' = 'ipc') {
  const save = deferred<boolean>()
  const saving = deferred<void>()
  let onData!: Parameters<IPtyProvider['onData']>[0]
  let sessionId = ''
  let file = ''
  let through = 0
  const provider = {
    spawn: vi.fn(async (args: PtySpawnOptions) => {
      sessionId = /--(?:session-id|resume) ([\w-]+)/.exec(args.command ?? '')![1]
      file = amplifierAgentEventsPath(directory, directory, sessionId)
      mkdirSync(dirname(file), { recursive: true })
      if (!resume) {
        writeFileSync(file, '')
      }
      onData({
        id: PTY,
        data: `[amplifier-agent-repl] bound ${JSON.stringify({
          paneKey: PANE,
          pid: process.pid,
          cwd: directory,
          home: directory,
          workspace: basename(directory),
          sessionId,
          wrapperId: 'early-wrapper',
          launchToken: args.env?.ORCA_AGENT_LAUNCH_TOKEN
        })}\n`
      })
      appendFileSync(file, event('early-delegate'))
      through = statSync(file).size
      onData({
        id: PTY,
        data: `[amplifier-agent-repl] turn-settled session=${sessionId} wrapper=early-wrapper turn=1 from=0 through=${through} code=7\n`
      })
      return { id: PTY, incarnationId: 'inc-early' }
    }),
    onData: (callback: typeof onData) => {
      onData = callback
      return () => {}
    },
    onExit: () => () => {},
    shutdown: vi.fn(async () => {}),
    listProcesses: vi.fn(async () => [])
  }
  // Native IO is mocked; the real provider class retains the window's unnamed-PTY preparation path.
  setLocalPtyProvider(Object.assign(new LocalPtyProvider(), provider))
  const session = createPtyIpcSession({})
  session.acceptPtyDataForRenderer = () => {}
  bindProviderListeners(session)
  const store = {
    getWorkspaceSession: () => ({ terminalLayoutsByTabId: {}, tabsByWorktree: {} }),
    persistPtyBinding: async () => {
      saving.resolve()
      return save.promise
    }
  }
  const ports = {
    store,
    getLocalPtyStartupPromise: () => undefined,
    getLocalPtyProviderStartupPromise: () => undefined,
    assertWorkspaceAcceptsNewPty: () => {},
    resolvePtySpawnStartupCwd: (_id: string, cwd: string) => cwd,
    adoptStablePane: async (args: Parameters<PtySpawnIpcDeps['adoptStablePane']>[0]) => {
      await args.spawnFresh!({ mustExist: false })
      return null
    },
    transitionSpawnHiddenRendererPtyDeliveryState: () => {},
    syncPtyBackgroundedDelivery: () => {},
    trustedTerminalHandleEnv: new Set<string>(),
    sendPtySpawnedToRenderer: () => {},
    prepareCodexResumeHome: (args: Parameters<typeof prepareCodexResumeHome>[1]) =>
      prepareCodexResumeHome(undefined, args),
    noCodexResumeLaunch,
    reconcileSharedRuntimeResumeHome,
    resolveCodexResumeLaunch,
    stripSequencedStartupResumeArgv
  }
  const args = {
    cols: 80,
    rows: 24,
    cwd: directory,
    worktreeId: 'folder:admission',
    tabId: 'tab-admission',
    leafId: LEAF,
    launchAgent: 'amplifier-agent' as const,
    launchToken: 'launch-early',
    command: resume ? 'amplifier-agent-repl --resume retained-session' : 'amplifier-agent-repl',
    env: { AMPLIFIER_AGENT_HOME: directory, ORCA_AGENT_LAUNCH_TOKEN: 'launch-early' }
  }
  const pending =
    lane === 'ipc'
      ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture provides storage and host ports; no runtime or native PTY is loaded.
        runPtyIpcSpawn(ports as unknown as PtySpawnIpcDeps, args)
      : spawnPtyFromRuntimeController(
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the same host ports serve the runtime lane; the test does not load a native PTY.
          ports as unknown as PtyRuntimeControllerDeps,
          { ...args, persistHostSessionBinding: true }
        )
  await Promise.race([saving.promise, pending])
  return {
    pending,
    save,
    sessionId,
    file,
    through,
    onData,
    terminal: { ptyId: PTY, incarnationId: 'inc-early' }
  }
}

describe('amplifier-agent startup output admission', () => {
  it('admits early markers only after save, settles the turn and writes recoverable wrapper proof', async () => {
    const spawned = await launch()
    expect(agentHookServer.getStatusSnapshotForPane(PANE)).toEqual([])
    expect(paneKeyPtyId.get(PANE)).toBeUndefined()
    spawned.save.resolve(true)
    await spawned.pending
    expect(agentHookServer.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      state: 'working',
      subagents: [{ id: 'early-delegate', state: 'unverifiable' }]
    })
    expect(
      await restoreAmplifierAgentWrapperBinding(
        join(directory, 'agent-hooks'),
        PANE,
        spawned.terminal
      )
    ).toMatchObject({ sessionId: spawned.sessionId, wrapperId: 'early-wrapper' })
    expect(
      await restoreAmplifierAgentWrapperBinding(join(directory, 'agent-hooks'), PANE, {
        ...spawned.terminal,
        incarnationId: 'replacement'
      })
    ).toBeUndefined()
  })

  it('never admits buffered output after a refused durable save', async () => {
    const spawned = await launch()
    const rejected = expect(spawned.pending).rejects.toThrow('terminal_pane_owner_changed')
    spawned.save.resolve(false)
    await rejected
    expect(agentHookServer.getStatusSnapshotForPane(PANE)).toEqual([])
    expect(
      await restoreAmplifierAgentWrapperBinding(
        join(directory, 'agent-hooks'),
        PANE,
        spawned.terminal
      )
    ).toBeUndefined()
  })

  it('discards startup output if a replacement incarnation wins while save is pending', async () => {
    const spawned = await launch()
    ptyIncarnationById.set(PTY, 'inc-replacement')
    spawned.save.resolve(true)
    await spawned.pending
    expect(agentHookServer.getStatusSnapshotForPane(PANE)).toEqual([])
    expect(
      await restoreAmplifierAgentWrapperBinding(
        join(directory, 'agent-hooks'),
        PANE,
        spawned.terminal
      )
    ).toBeUndefined()
  })

  it('retains a runtime resume turn appended during save without replaying its history', async () => {
    const file = amplifierAgentEventsPath(directory, directory, 'retained-session')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, event('historical-delegate'))
    const spawned = await launch(true, 'runtime')
    spawned.save.resolve(true)
    await spawned.pending
    expect(agentHookServer.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      state: 'working',
      subagents: [{ id: 'early-delegate', state: 'unverifiable' }]
    })
  })
})
