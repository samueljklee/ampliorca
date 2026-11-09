import { expect, it } from 'vitest'
import { extractAgentProviderSession } from './agent-session-resume'

it('does not infer hook resume authority for history-only Amplifier providers', () => {
  expect(extractAgentProviderSession('amplifier', { session_id: 'session-1' })).toBeNull()
  expect(extractAgentProviderSession('amplifier-agent', { session_id: 'session-2' })).toBeNull()
})
