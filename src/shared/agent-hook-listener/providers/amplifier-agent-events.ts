import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import {
  amplifierAgentRosterToSnapshots,
  applyAmplifierAgentSubagentEnd,
  applyAmplifierAgentSubagentStart,
  getAmplifierAgentRoster
} from '../../amplifier-agent-subagent-roster'
import type { HookListenerState } from '../listener-state'
import { isNewTurnEvent } from '../provider-event-routing'
import { resolvePrompt } from '../prompt-fields'

function readToolName(payload: Record<string, unknown>): string | undefined {
  for (const key of ['tool_name', 'name', 'tool']) {
    const value = payload[key]
    if (typeof value === 'string') {
      return value
    }
  }
  return undefined
}

export function normalizeAmplifierAgentEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  if (eventName === 'delegate:agent_spawned') {
    applyAmplifierAgentSubagentStart(state, paneKey, hookPayload)
  } else if (eventName === 'delegate:agent_completed') {
    applyAmplifierAgentSubagentEnd(state, paneKey, hookPayload, false)
  } else if (eventName === 'delegate:agent_cancelled') {
    applyAmplifierAgentSubagentEnd(state, paneKey, hookPayload, true)
  }

  const stateName =
    eventName === 'orchestrator:complete'
      ? 'done'
      : eventName === 'session:start' ||
          eventName === 'session:resume' ||
          eventName === 'prompt:submit' ||
          eventName === 'execution:start' ||
          eventName === 'execution:end' ||
          eventName === 'llm:request' ||
          eventName === 'llm:response' ||
          eventName === 'tool:pre' ||
          eventName === 'tool:post' ||
          eventName === 'delegate:agent_spawned' ||
          eventName === 'delegate:agent_resumed' ||
          eventName === 'delegate:agent_completed' ||
          eventName === 'delegate:agent_cancelled'
        ? 'working'
        : null

  if (!stateName) {
    return null
  }

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, promptText, {
      resetOnNewTurn: isNewTurnEvent('amplifier-agent', eventName)
    }),
    agentType: 'amplifier-agent',
    toolName: eventName === 'tool:pre' ? readToolName(hookPayload) : undefined,
    subagents: amplifierAgentRosterToSnapshots(getAmplifierAgentRoster(state, paneKey))
  })
}
