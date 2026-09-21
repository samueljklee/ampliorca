const TURN_SETTLED_PREFIX = '[amplifier-agent-repl] turn-settled session='
const TURN_SETTLED_LINE = /^\[amplifier-agent-repl\] turn-settled session=\S+ code=(null|-?\d+)\r?$/

export type AmplifierAgentTurnSettlement = { failed: boolean }

/** Consume complete REPL stderr lines without treating ordinary agent output as lifecycle data. */
export function consumeAmplifierAgentTurnSettlementOutput(
  pending: string,
  chunk: string
): { pending: string; settlements: AmplifierAgentTurnSettlement[] } {
  const output = `${pending}${chunk}`
  const lines = output.split('\n')
  const remainder = lines.pop() ?? ''
  const settlements: AmplifierAgentTurnSettlement[] = []
  for (const line of lines) {
    if (!line.startsWith(TURN_SETTLED_PREFIX)) {
      continue
    }
    const match = TURN_SETTLED_LINE.exec(line)
    if (!match) {
      continue
    }
    settlements.push({ failed: match[1] !== '0' })
  }
  return { pending: remainder.slice(-512), settlements }
}
