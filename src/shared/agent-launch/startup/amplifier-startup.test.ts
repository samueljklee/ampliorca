import { expect, it } from 'vitest'
import { buildAgentStartupPlan } from './tui-agent-startup'

it('keeps flag-shaped Amplifier prompts behind the option terminator', () => {
  const plan = buildAgentStartupPlan({
    agent: 'amplifier',
    prompt: '--version',
    cmdOverrides: {},
    platform: 'linux'
  })
  if (!plan) {
    throw new Error('Amplifier startup plan was not created')
  }
  expect(plan.launchCommand).toBe("amplifier run --mode chat -- '--version'")
})
