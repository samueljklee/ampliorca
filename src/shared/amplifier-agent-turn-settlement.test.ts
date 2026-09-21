import { describe, expect, it } from 'vitest'

import { consumeAmplifierAgentTurnSettlementOutput } from './amplifier-agent-turn-settlement'

describe('amplifier-agent turn settlement marker', () => {
  it('accepts only complete, exact stderr markers across PTY chunks', () => {
    const first = consumeAmplifierAgentTurnSettlementOutput(
      '',
      'ordinary output\n[amplifier-agent-repl] turn-settled session=abc code='
    )
    expect(first.settlements).toEqual([])

    const second = consumeAmplifierAgentTurnSettlementOutput(first.pending, '7\n')
    expect(second.settlements).toEqual([{ failed: true }])
  })

  it('treats the clean exit marker as successful', () => {
    expect(
      consumeAmplifierAgentTurnSettlementOutput(
        '',
        '[amplifier-agent-repl] turn-settled session=abc code=0\r\n'
      ).settlements
    ).toEqual([{ failed: false }])
  })
})
