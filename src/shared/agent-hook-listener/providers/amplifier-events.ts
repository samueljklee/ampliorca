// Why: Amplifier is not a push-hook agent like Claude/Codex -- there is no
// hook script calling out to Orca. Its events arrive via a live-tailed
// hooks-orca-bridge JSONL feed (see the tailer that constructs the
// canonical envelope this provider receives `eventName`/`hookPayload` from).
// `eventName` here is one of that feed's own record `type` values:
// turn_start, turn_end, tool_start, tool_end, agent_start, agent_end, usage.

import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import {
  amplifierRosterToSnapshots,
  applyAmplifierAgentEnd,
  applyAmplifierAgentStart,
  getAmplifierRoster
} from '../../amplifier-subagent-roster'
import type { HookListenerState } from '../listener-state'
import { isNewTurnEvent } from '../provider-event-routing'
import { resolvePrompt } from '../prompt-fields'

export function normalizeAmplifierEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  // Roster mutation happens regardless of whether this event also yields a
  // status payload below -- an agent_end with no other visible state change
  // must still update the sidebar's subagents list.
  if (eventName === 'agent_start') {
    applyAmplifierAgentStart(state, paneKey, hookPayload)
  } else if (eventName === 'agent_end') {
    applyAmplifierAgentEnd(state, paneKey, hookPayload)
  }

  const stateName =
    eventName === 'turn_end'
      ? 'done'
      : eventName === 'turn_start' ||
          eventName === 'tool_start' ||
          eventName === 'tool_end' ||
          eventName === 'agent_start' ||
          eventName === 'agent_end'
        ? 'working'
        : null

  if (!stateName) {
    // usage (and any future informational-only record type) reports no
    // state transition of its own.
    return null
  }

  const toolName =
    eventName === 'tool_start' && typeof hookPayload.tool_name === 'string'
      ? hookPayload.tool_name
      : undefined

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, promptText, {
      resetOnNewTurn: isNewTurnEvent('amplifier', eventName)
    }),
    agentType: 'amplifier',
    toolName,
    subagents: amplifierRosterToSnapshots(getAmplifierRoster(state, paneKey))
  })
}
