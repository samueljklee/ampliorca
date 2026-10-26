import { describe, expect, it } from 'vitest'
import {
  noCodexResumeLaunch,
  prepareCodexResumeHome,
  reconcileSharedRuntimeResumeHome,
  resolveCodexResumeLaunch,
  stripSequencedStartupResumeArgv
} from './host-env/codex-resume'
import { resolvePtySpawnHostEnv } from './spawn-host-env'

type HostEnvArgs = Parameters<typeof resolvePtySpawnHostEnv>[0]

function resolve(overrides: Partial<HostEnvArgs> = {}) {
  return resolvePtySpawnHostEnv({
    launchAgent: 'amplifier-agent',
    command: 'amplifier-agent-repl',
    resumeProviderSession: undefined,
    env: { AMPLIFIER_AGENT_HOME: '/isolated/agent-home' },
    cwd: '/repo/project',
    shellOverride: undefined,
    expectedWslDistro: null,
    codexSelectionTarget: { runtime: 'host' },
    preAdopted: false,
    isDaemonHostSpawn: false,
    sessionId: undefined,
    callerNamedSession: false,
    mintedSessionId: true,
    resumeOnSelectedAccount: false,
    emptySessionIdSkipsHostEnv: false,
    requestedAgentTeamsPath: undefined,
    provider: {},
    deps: {
      prepareCodexResumeHome: (args) => prepareCodexResumeHome(undefined, args),
      noCodexResumeLaunch,
      reconcileSharedRuntimeResumeHome,
      resolveCodexResumeLaunch,
      stripSequencedStartupResumeArgv
    },
    ...overrides
  })
}

describe('upstream host env amplifier-agent identity', () => {
  it('mints one fresh wrapper/feed identity per launch and preserves its custom home', async () => {
    const first = await resolve()
    const second = await resolve()
    expect(first.amplifierAgentSessionId).toMatch(/^[a-f0-9-]{36}$/)
    expect(second.amplifierAgentSessionId).not.toBe(first.amplifierAgentSessionId)
    expect(first.launchCommand).toBe(
      `amplifier-agent-repl --session-id ${first.amplifierAgentSessionId}`
    )
    expect(first.env?.AMPLIFIER_AGENT_HOME).toBe('/isolated/agent-home')
  })

  it.each([
    'amplifier-agent-repl --resume retained-session',
    "amplifier-agent-repl --resume 'retained-session'",
    'amplifier-agent-repl --resume "retained-session"'
  ])('retains the actual resume identity in %s', async (command) => {
    const result = await resolve({ command })
    expect(result.amplifierAgentSessionId).toBe('retained-session')
    expect(result.launchCommand).toBe(command)
  })

  it('keeps metadata-only resume and wrapper argv aligned', async () => {
    const result = await resolve({
      resumeProviderSession: { key: 'session_id', id: 'retained-session' }
    })
    expect(result.amplifierAgentSessionId).toBe('retained-session')
    expect(result.launchCommand).toBe('amplifier-agent-repl --resume retained-session')
  })

  it('does not freshen an unverifiable custom resume command', async () => {
    const command = 'amplifier-agent-repl --resume "$SESSION_ID"'
    const result = await resolve({ command })
    expect(result.amplifierAgentSessionId).toBeUndefined()
    expect(result.launchCommand).toBe(command)
  })

  it.each([
    { preAdopted: true },
    { connectionId: 'remote-host' },
    { codexSelectionTarget: { runtime: 'wsl' as const } },
    { launchAgent: 'amplifier' as const },
    { command: undefined }
  ])('does not invent a local feed identity for $0', async (overrides) => {
    const result = await resolve(overrides)
    expect(result.amplifierAgentSessionId).toBeUndefined()
  })
})
