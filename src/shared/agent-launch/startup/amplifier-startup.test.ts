import { expect, it } from 'vitest'
import { buildAgentStartupPlan } from './tui-agent-startup'

it('keeps flag-shaped Amplifier prompts behind the option terminator', () => {
  expect(
    buildAgentStartupPlan({
      agent: 'amplifier',
      prompt: '--version',
      cmdOverrides: {},
      platform: 'linux'
    }).launchCommand
  ).toBe("amplifier run --mode chat -- '--version'")
})
