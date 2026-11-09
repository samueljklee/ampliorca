import { describe, expect, it } from 'vitest'
import { normalizeDisabledTuiAgents, pickTuiAgent } from './tui-agent-selection'

describe('pickTuiAgent', () => {
  it('allows Amplifier fallback without displacing installed upstream agents', () => {
    expect(pickTuiAgent(null, ['amplifier-agent', 'amplifier'], ['amplifier'])).toBe(
      'amplifier-agent'
    )
    expect(pickTuiAgent(null, ['amplifier', 'jcode'])).toBe('jcode')
  })

  it('respects the explicit blank terminal preference', () => {
    expect(pickTuiAgent('blank', ['cursor', 'claude'])).toBeNull()
  })

  it('ignores disabled preferred and fallback agents', () => {
    expect(pickTuiAgent('codex', ['claude', 'codex'], ['codex'])).toBe('claude')
    expect(pickTuiAgent(null, ['claude', 'codex'], ['claude', 'codex'])).toBeNull()
  })
})

describe('normalizeDisabledTuiAgents', () => {
  it('dedupes supported agent ids and drops unsupported values', () => {
    expect(normalizeDisabledTuiAgents(['codex', 'unknown', 'codex', null, 'claude'])).toEqual([
      'codex',
      'claude'
    ])
  })
})
