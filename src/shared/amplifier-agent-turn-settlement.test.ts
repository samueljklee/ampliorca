import { describe, expect, it } from 'vitest'

import { consumeAmplifierAgentTurnSettlementOutput } from './amplifier-agent-turn-settlement'

describe('amplifier-agent turn settlement marker', () => {
  it('accepts only complete, exact stderr markers across PTY chunks', () => {
    const first = consumeAmplifierAgentTurnSettlementOutput(
      '',
      'ordinary output\n[amplifier-agent-repl] turn-settled session=abc wrapper=run-1 turn=1 from=0 through=42 code='
    )
    expect(first.settlements).toEqual([])

    const second = consumeAmplifierAgentTurnSettlementOutput(first.pending, '7\n')
    expect(second.settlements).toEqual([
      {
        sessionId: 'abc',
        wrapperId: 'run-1',
        turn: 1,
        from: 0,
        through: 42,
        failed: true
      }
    ])
  })

  it('treats the clean exit marker as successful', () => {
    expect(
      consumeAmplifierAgentTurnSettlementOutput(
        '',
        '[amplifier-agent-repl] turn-settled session=abc wrapper=run-1 turn=1 from=0 through=42 code=0\r\n'
      ).settlements
    ).toEqual([
      {
        sessionId: 'abc',
        wrapperId: 'run-1',
        turn: 1,
        from: 0,
        through: 42,
        failed: false
      }
    ])
  })

  it.each([
    '[amplifier-agent-repl] turn-settled session=abc code=0\n',
    '[amplifier-agent-repl] turn-settled session=abc wrapper=run-1 turn=1 from=43 through=42 code=0\n',
    '[amplifier-agent-repl] turn-settled session=abc wrapper=run-1 turn=999999999999999999 from=0 through=42 code=0\n'
  ])('does not grant authority to unbounded or malformed markers: %s', (line) => {
    expect(consumeAmplifierAgentTurnSettlementOutput('', line).settlements).toEqual([])
  })
})
