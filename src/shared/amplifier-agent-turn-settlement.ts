const TURN_SETTLED_PREFIX = '[amplifier-agent-repl] turn-settled session='
const BINDING_PREFIX = '[amplifier-agent-repl] bound '
const TURN_SETTLED_LINE =
  /^\[amplifier-agent-repl\] turn-settled session=(\S+) wrapper=(\S+) turn=(\d+) from=(\d+) through=(\d+) code=(null|-?\d+)\r?$/

export type AmplifierAgentTurnSettlement = {
  sessionId: string
  wrapperId: string
  turn: number
  from: number
  through: number
  failed: boolean
}

export type AmplifierAgentWrapperBinding = {
  sessionId: string
  wrapperId: string
  pid: number
  cwd: string
  home: string
  workspace: string
  paneKey: string
  launchToken?: string
}

export function readAmplifierAgentWrapperBinding(
  value: unknown
): AmplifierAgentWrapperBinding | undefined {
  if (!value || typeof value !== 'object') {
    return
  }
  if (
    !('sessionId' in value) ||
    !('wrapperId' in value) ||
    !('pid' in value) ||
    !('cwd' in value) ||
    !('home' in value) ||
    !('workspace' in value) ||
    !('paneKey' in value)
  ) {
    return
  }
  const { sessionId, wrapperId, pid, cwd, home, workspace, paneKey } = value
  if (
    typeof sessionId !== 'string' ||
    !/^[\w-]{1,256}$/.test(sessionId) ||
    typeof wrapperId !== 'string' ||
    !/^[\w-]{1,256}$/.test(wrapperId) ||
    typeof pid !== 'number' ||
    !Number.isSafeInteger(pid) ||
    pid <= 1 ||
    typeof cwd !== 'string' ||
    !cwd ||
    cwd.length > 4096 ||
    typeof home !== 'string' ||
    !home ||
    home.length > 4096 ||
    typeof workspace !== 'string' ||
    !workspace ||
    workspace.length > 255 ||
    /[/\\]/.test(workspace) ||
    workspace === '..' ||
    workspace === '.' ||
    typeof paneKey !== 'string' ||
    !paneKey ||
    paneKey.length > 256
  ) {
    return
  }
  const launchToken =
    'launchToken' in value && typeof value.launchToken === 'string' ? value.launchToken : undefined
  return { sessionId, wrapperId, pid, cwd, home, workspace, paneKey, launchToken }
}

/** Consume complete REPL stderr lines without treating ordinary agent output as lifecycle data. */
export function consumeAmplifierAgentTurnSettlementOutput(
  pending: string,
  chunk: string
): {
  pending: string
  settlements: AmplifierAgentTurnSettlement[]
  bindings: AmplifierAgentWrapperBinding[]
} {
  const output = `${pending}${chunk}`
  const lines = output.split('\n')
  const remainder = lines.pop() ?? ''
  const settlements: AmplifierAgentTurnSettlement[] = []
  const bindings: AmplifierAgentWrapperBinding[] = []
  for (const line of lines) {
    if (line.startsWith(BINDING_PREFIX)) {
      try {
        const binding = readAmplifierAgentWrapperBinding(
          JSON.parse(line.slice(BINDING_PREFIX.length))
        )
        if (binding) {
          bindings.push(binding)
        }
      } catch {
        /* Not a complete binding. */
      }
    }
    if (!line.startsWith(TURN_SETTLED_PREFIX)) {
      continue
    }
    const match = TURN_SETTLED_LINE.exec(line)
    if (!match) {
      continue
    }
    const turn = Number(match[3]),
      from = Number(match[4]),
      through = Number(match[5])
    if (![turn, from, through].every(Number.isSafeInteger) || turn < 1 || through < from) {
      continue
    }
    settlements.push({
      sessionId: match[1],
      wrapperId: match[2],
      turn,
      from,
      through,
      failed: match[6] !== '0'
    })
  }
  return { pending: remainder.slice(-16384), settlements, bindings }
}
