import type { AmplifierAgentTurnSettlement } from '../../../shared/amplifier-agent-turn-settlement'
import {
  amplifierAgentRosterToSnapshots,
  settleAmplifierAgentRosterForPane
} from '../../../shared/amplifier-agent-subagent-roster'
import { isLocalHookConnectionId } from '../../../shared/wsl-hook-relay-contract'
import { AmplifierAgentBridgeTailer } from '../amplifier-agent-bridge-tailer'
import { AgentHookServerRuntimeEnv } from './server-runtime-env'
import type { EnrichedAgentHookEventPayload } from './server-types'

export abstract class AgentHookServerAmplifierAgentSettlement extends AgentHookServerRuntimeEnv {
  protected readonly amplifierAgentWrappers = new Map<
    string,
    {
      wrapperId: string
      lastSettledTurn: number
      isCurrent: () => boolean
    }
  >()
  protected readonly amplifierAgentBridgeTailer = new AmplifierAgentBridgeTailer(
    (record, isCurrent) => this.ingestLiveFileRecord(record, isCurrent)
  )

  async settleAmplifierAgentTurnForPane(
    paneKey: string,
    failed: boolean,
    sessionId?: string,
    settlement?: AmplifierAgentTurnSettlement
  ): Promise<void> {
    const generation = this.statusHookGeneration
    const resolved = this.resolvePaneKeyAlias(paneKey)
    const wrapper = this.amplifierAgentWrappers.get(resolved)
    const boundSessionId = this.currentAmplifierAgentSessionId(resolved)
    if (
      !settlement ||
      !wrapper ||
      !wrapper.isCurrent() ||
      wrapper.wrapperId !== settlement.wrapperId ||
      wrapper.lastSettledTurn >= settlement.turn ||
      boundSessionId !== sessionId ||
      settlement.sessionId !== sessionId ||
      settlement.failed !== failed
    ) {
      return
    }
    // The child can exit before the next file poll observes its final delegate events.
    await this.amplifierAgentBridgeTailer.flush()
    if (
      this.statusHooksEnabled &&
      this.statusHookGeneration === generation &&
      this.amplifierAgentWrappers.get(resolved) === wrapper &&
      wrapper.isCurrent() &&
      wrapper.lastSettledTurn < settlement.turn
    ) {
      wrapper.lastSettledTurn = settlement.turn
      this.settleAmplifierAgentDelegatesForPane(
        resolved,
        failed,
        this.amplifierAgentBridgeTailer.delegatesThrough(
          resolved,
          settlement.from,
          settlement.through
        )
      )
    }
  }

  private settleAmplifierAgentDelegatesForPane(
    paneKey: string,
    failed: boolean,
    delegateIds: ReadonlySet<string>
  ): void {
    const current = this.state.lastStatusByPaneKey.get(paneKey)
    if (
      current?.payload.agentType !== 'amplifier-agent' ||
      !('receivedAt' in current) ||
      typeof current.receivedAt !== 'number' ||
      !('stateStartedAt' in current) ||
      typeof current.stateStartedAt !== 'number' ||
      !isLocalHookConnectionId(current.connectionId) ||
      current.providerSessionOnly ||
      !settleAmplifierAgentRosterForPane(this.state, paneKey, { failed, delegateIds })
    ) {
      return
    }
    const previous: EnrichedAgentHookEventPayload = {
      ...current,
      receivedAt: current.receivedAt,
      stateStartedAt: current.stateStartedAt
    }
    const settled = {
      ...previous,
      payload: {
        ...current.payload,
        subagents: amplifierAgentRosterToSnapshots(
          this.state.amplifierAgentSubagentRosterByPaneKey.get(paneKey)
        )
      }
    }
    if (!this.writeLegacyStatusRow(settled)) {
      return
    }
    this.commitStatusRowMutation(previous, settled)
    this.scheduleStatusPersist()
    this.notifyStatusChangeListeners()
    this.emitEnrichedStatus(settled)
  }

  private currentAmplifierAgentSessionId(paneKey: string): string | undefined {
    const row = this.state.lastStatusByPaneKey.get(paneKey)
    return (
      this.amplifierAgentBridgeTailer.sessionIdForPane(paneKey, (key) =>
        this.resolvePaneKeyAlias(key)
      ) ?? (row?.payload.agentType === 'amplifier-agent' ? row.providerSession?.id : undefined)
    )
  }
}
