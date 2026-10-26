import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeWithRuntimeId } from '../../../runtime/construction/runtime-identity-state'
import { TerminalIntentionalStops } from '../../../runtime/terminal-intentional-stops'
import { TerminalRunFactsRegister } from '../../../runtime/terminal-run-facts'
import { ptySizes } from '../delivery/visibility-state'
import { ptyIncarnationById, ptyOwnership } from '../provider/ownership-state'
import { commitPtyIpcSpawn } from './spawn-commit'
import { createPtyIpcSpawnState } from './spawn-state'
import type { PtySpawnIpcDeps } from './spawn-types'
import { agentHookServer } from '../../../agent-hooks/server'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { ptyPaneKey, paneKeyPtyId } from '../pane/key-state'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const PTY_ID = 'orca-ipc-pty-run-facts'
const INCARNATION_ID = 'inc-ipc-run-facts'

async function commit(
  persistPtyBinding: ReturnType<typeof vi.fn>,
  prepare?: (ctx: ReturnType<typeof createPtyIpcSpawnState>) => void
) {
  const facts = new TerminalRunFactsRegister()
  const stops = new TerminalIntentionalStops()
  stops.mark(PTY_ID, 'reversible', null)(true)
  const runtime = {
    terminalRunFacts: facts,
    intentionalPtyStops: stops,
    // Exercise real runtime commit handling through the fixture ports.
    noteTerminalSpawnCommit: OrcaRuntimeWithRuntimeId.prototype.noteTerminalSpawnCommit,
    registerPreAllocatedHandleForPty: vi.fn(),
    registerPty: vi.fn(),
    cancelPendingPtyRegistration: vi.fn(),
    reflowHeadlessTerminalToPtyGrid: vi.fn(),
    seedHeadlessTerminal: vi.fn(),
    noteTerminalSpawnCommand: vi.fn()
  }
  const ports = {
    runtime,
    store: { persistPtyBinding },
    options: {},
    sendPtySpawnedToRenderer: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the commit reads only the ports above, and the store only for its binding save.
  const deps = ports as unknown as PtySpawnIpcDeps
  const ctx = createPtyIpcSpawnState(deps, {
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    cols: 120,
    rows: 40
  })
  ctx.validatedLeafId = 'leaf-1'
  ctx.provider = { ...ctx.provider, shutdown: vi.fn().mockResolvedValue(undefined) }
  ctx.result = { id: PTY_ID, incarnationId: INCARNATION_ID }
  prepare?.(ctx)
  let reply: Awaited<ReturnType<typeof commitPtyIpcSpawn>> | undefined
  const outcome = await commitPtyIpcSpawn(ctx).then(
    (result) => {
      reply = result
      return 'committed'
    },
    () => 'discarded'
  )
  return { outcome, facts, stops, reply }
}

describe('renderer spawn commit: run facts', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    ptySizes.delete(PTY_ID)
    ptyOwnership.delete(PTY_ID)
    ptyIncarnationById.delete(PTY_ID)
    const paneKey = ptyPaneKey.get(PTY_ID)
    if (paneKey && paneKeyPtyId.get(paneKey) === PTY_ID) {
      paneKeyPtyId.delete(paneKey)
    }
    ptyPaneKey.delete(PTY_ID)
  })

  it.each([true, false])(
    'publishes the amplifier-agent feed only after a successful binding save (%s)',
    async (saved) => {
      const register = vi
        .spyOn(agentHookServer, 'registerAmplifierAgentSession')
        .mockImplementation(() => {})
      let savedBinding = false
      const persist = vi.fn(async () => {
        expect(register).not.toHaveBeenCalled()
        if (!saved) {
          throw new Error('disk full')
        }
        savedBinding = true
        return true
      })
      const paneKey = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
      const { outcome } = await commit(persist, (ctx) => {
        ctx.args.launchAgent = 'amplifier-agent'
        ctx.args.launchToken = 'launch-1'
        ctx.validatedPaneKey = paneKey
        ctx.cwd = '/repo/project'
        ctx.env = { AMPLIFIER_AGENT_HOME: '/isolated/agent-home' }
        ctx.amplifierAgentSessionId = 'spawned-session'
        register.mockImplementation(() => {
          expect(savedBinding).toBe(true)
        })
      })
      expect(outcome).toBe(saved ? 'committed' : 'discarded')
      if (saved) {
        expect(register).toHaveBeenCalledExactlyOnceWith(
          paneKey,
          '/repo/project',
          'spawned-session',
          { home: '/isolated/agent-home', launchToken: 'launch-1', resume: false }
        )
      } else {
        expect(register).not.toHaveBeenCalled()
      }
    }
  )

  it.each([true, false])(
    'recovers proven feed identity only after the reattach binding is saved (%s)',
    async (saved) => {
      let savedBinding = false
      const restored = vi
        .spyOn(agentHookServer, 'restoreAmplifierAgentSessionForPty')
        .mockImplementation(async (_paneKey, terminal, isCurrent) => {
          expect(savedBinding).toBe(true)
          expect(terminal).toEqual({ ptyId: PTY_ID, incarnationId: INCARNATION_ID })
          expect(isCurrent()).toBe(true)
        })
      const register = vi
        .spyOn(agentHookServer, 'registerAmplifierAgentSession')
        .mockImplementation(() => {})
      const persist = vi.fn(async () => {
        expect(restored).not.toHaveBeenCalled()
        if (!saved) {
          throw new Error('disk full')
        }
        savedBinding = true
        return true
      })
      const { outcome } = await commit(persist, (ctx) => {
        ctx.result.isReattach = true
        ctx.validatedPaneKey = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
        ctx.cwd = '/repo/project'
      })
      expect(outcome).toBe(saved ? 'committed' : 'discarded')
      expect(restored).toHaveBeenCalledTimes(saved ? 1 : 0)
      expect(register).not.toHaveBeenCalled()
    }
  )

  it('records a committed spawn and lets it supersede a landed stop no exit pinned', async () => {
    const { outcome, facts, stops } = await commit(vi.fn().mockResolvedValue(true))

    expect(outcome).toBe('committed')
    expect(facts.read(PTY_ID, INCARNATION_ID).freshSpawn).toBe(true)
    expect(stops.claimExit(PTY_ID, INCARNATION_ID)).toEqual([])
  })

  it.each([false, true])(
    'keeps a refused shell disposition when early exit is %s',
    async (earlyExit) => {
      const refused = {
        agent: 'claude' as const,
        providerSession: { key: 'session_id' as const, id: 'chat-held' }
      }
      const { outcome, reply } = await commit(vi.fn().mockResolvedValue(true), (ctx) => {
        ctx.resumeAdmission = { verdict: 'chat-home', refused }
        if (earlyExit) {
          ctx.metadataLeafId = 'leaf-1'
          ctx.deps.runtime!.getPtyLivenessVerdict = vi.fn(() => ({ status: 'exited' as const }))
          ctx.deps.store!.runDurableMutation = vi.fn().mockResolvedValue(true)
          ctx.deps.runtime!.registerPty = vi.fn(() => {
            throw new Error('agent_session_exited_during_start')
          })
        }
      })
      expect(outcome).toBe('committed')
      expect(reply?.kind).toBe(earlyExit ? 'registration-exited' : 'committed')
      expect(reply?.result).toMatchObject({
        id: PTY_ID,
        incarnationId: INCARNATION_ID,
        agentResumeUnavailable: true,
        agentResumeRefused: 'chat-home',
        refusedResume: refused,
        savedResumeDecision: { ...refused, verdict: 'chat-home' }
      })
    }
  )

  it('records nothing for a spawn discarded because its binding save failed', async () => {
    const persistPtyBinding = vi.fn().mockRejectedValue(new Error('disk full'))
    const { outcome, facts, stops } = await commit(persistPtyBinding)

    expect(outcome).toBe('discarded')
    expect(persistPtyBinding).toHaveBeenCalledOnce()
    expect(facts.read(PTY_ID, INCARNATION_ID).freshSpawn).toBe(false)
    expect(stops.claimExit(PTY_ID, INCARNATION_ID)).toEqual(['replaced'])
  })
})
