import { describe, expect, it } from 'vitest'
import { buildAgentStartupPlan } from './tui-agent-startup'

describe('Amplifier startup delivery', () => {
  it('keeps flag-shaped prompts behind -- in interactive chat mode', () => {
    expect(
      buildAgentStartupPlan({
        agent: 'amplifier',
        prompt: '--version',
        cmdOverrides: {},
        platform: 'linux'
      })
    ).toEqual({
      agent: 'amplifier',
      launchCommand: "amplifier run --mode chat -- '--version'",
      expectedProcess: 'amplifier',
      followupPrompt: null,
      launchConfig: { agentCommand: 'amplifier run --mode chat', agentArgs: '', agentEnv: {} }
    })
  })

  it('starts the persistent wrapper before delivering an engine prompt', () => {
    expect(
      buildAgentStartupPlan({
        agent: 'amplifier-agent',
        prompt: 'Review the parser\nAdd regression tests',
        cmdOverrides: {},
        platform: 'linux'
      })
    ).toEqual({
      agent: 'amplifier-agent',
      launchCommand: 'amplifier-agent-repl',
      expectedProcess: 'amplifier-agent-repl',
      followupPrompt: 'Review the parser\nAdd regression tests',
      launchConfig: { agentCommand: 'amplifier-agent-repl', agentArgs: '', agentEnv: {} }
    })
  })
})
