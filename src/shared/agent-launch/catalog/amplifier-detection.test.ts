import { expect, it } from 'vitest'
import {
  KNOWN_TUI_AGENT_DETECTION_COMMANDS,
  resolveDetectedTuiAgentIds
} from './tui-agent-detection-commands'

it('does not offer Amplifier Agent when only its bundled wrapper is present', () => {
  expect(
    resolveDetectedTuiAgentIds(
      KNOWN_TUI_AGENT_DETECTION_COMMANDS,
      new Set(['amplifier-agent-repl']),
      'linux'
    )
  ).toEqual([])
  expect(
    resolveDetectedTuiAgentIds(
      KNOWN_TUI_AGENT_DETECTION_COMMANDS,
      new Set(['amplifier', 'amplifier-agent']),
      'linux'
    )
  ).toEqual(['amplifier', 'amplifier-agent'])
})
