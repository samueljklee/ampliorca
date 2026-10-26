import { drainAgentHookSpoolAsync, type SpoolRecord } from '../../../shared/agent-hook-spool'
import { AgentHookServerRuntimeEnv } from './server-runtime-env'
import { ClaudeAgentViewBridge } from '../../claude/agent-view-bridge'
import { AmplifierBridgeTailer } from '../amplifier-bridge-tailer'
import { AmplifierAgentBridgeTailer } from '../amplifier-agent-bridge-tailer'
import type {
  AmplifierAgentTurnSettlement,
  AmplifierAgentWrapperBinding
} from '../../../shared/amplifier-agent-turn-settlement'
import {
  persistAmplifierAgentWrapperBinding,
  restoreAmplifierAgentWrapperBinding,
  type AmplifierAgentTerminalBinding
} from '../amplifier-agent-wrapper-bindings'
import {
  amplifierAgentRosterToSnapshots,
  settleAmplifierAgentRosterForPane
} from '../../../shared/amplifier-agent-subagent-roster'
import { isLocalHookConnectionId } from '../../../shared/wsl-hook-relay-contract'
import type { EnrichedAgentHookEventPayload } from './server-types'

export abstract class AgentHookServerStatusHookLifecycle extends AgentHookServerRuntimeEnv {
  override clearPaneState(
    paneKey: string,
    options?: Parameters<AgentHookServerRuntimeEnv['clearPaneState']>[1]
  ): void {
    this.unregisterAmplifierAgentSession(this.resolvePaneKeyAlias(paneKey))
    super.clearPaneState(paneKey, options)
  }

  readonly claudeAgentViews = new ClaudeAgentViewBridge()
  private statusHookInitialization: Promise<void> | null = null
  private readonly amplifierAgentWrappers = new Map<
    string,
    {
      wrapperId: string
      lastSettledTurn: number
    }
  >()

  async observeAmplifierAgentWrapper(
    paneKey: string,
    wrapper: AmplifierAgentWrapperBinding,
    terminal: AmplifierAgentTerminalBinding,
    isCurrent: () => boolean
  ): Promise<void> {
    const admission = this.amplifierAgentBridgeTailer.admitWrapper(paneKey, wrapper.sessionId)
    if (!this.statusHooksEnabled || !isCurrent() || wrapper.paneKey !== paneKey || !admission) {
      return
    }
    const previous = this.amplifierAgentWrappers.get(paneKey)
    if (previous?.wrapperId === wrapper.wrapperId) {
      return
    }
    const generation = this.statusHookGeneration
    const current = () =>
      isCurrent() &&
      generation === this.statusHookGeneration &&
      this.amplifierAgentWrappers.get(paneKey) === previous
    const proven = this.endpointDir
      ? await persistAmplifierAgentWrapperBinding(
          this.endpointDir,
          { ...wrapper, launchToken: admission.launchToken },
          terminal,
          () => current()
        )
      : false
    if (current() && (!previous || proven)) {
      this.amplifierAgentWrappers.set(paneKey, { wrapperId: wrapper.wrapperId, lastSettledTurn: 0 })
    }
  }

  async restoreAmplifierAgentSessionForPty(
    paneKey: string,
    terminal: AmplifierAgentTerminalBinding,
    isCurrent: () => boolean
  ): Promise<void> {
    if (!this.endpointDir || !isCurrent()) {
      return
    }
    const generation = this.statusHookGeneration
    const wrapper = await restoreAmplifierAgentWrapperBinding(this.endpointDir, paneKey, terminal)
    if (
      !wrapper ||
      !isCurrent() ||
      generation !== this.statusHookGeneration ||
      !this.statusHooksEnabled
    ) {
      return
    }
    this.registerAmplifierAgentSession(paneKey, wrapper.cwd, wrapper.sessionId, {
      home: wrapper.home,
      workspace: wrapper.workspace,
      resume: true,
      launchToken: wrapper.launchToken
    })
    this.amplifierAgentWrappers.set(paneKey, { wrapperId: wrapper.wrapperId, lastSettledTurn: 0 })
  }
  private readonly amplifierBridgeTailer = new AmplifierBridgeTailer((record, isCurrent) =>
    this.ingestLiveFileRecord(record, isCurrent)
  )
  private readonly amplifierAgentBridgeTailer = new AmplifierAgentBridgeTailer(
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

  registerAmplifierAgentSession(
    paneKey: string,
    cwd: string,
    sessionId: string,
    options?: { home?: string; launchToken?: string; resume?: boolean; workspace?: string }
  ): void {
    const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey)
    this.unregisterAmplifierAgentSession(resolvedPaneKey)
    this.amplifierAgentBridgeTailer.registerSession(resolvedPaneKey, cwd, sessionId, options)
  }

  unregisterAmplifierAgentSession(paneKey: string): void {
    this.amplifierAgentWrappers.delete(paneKey)
    this.amplifierAgentBridgeTailer.unregisterSession(paneKey, (key) =>
      this.resolvePaneKeyAlias(key)
    )
  }

  private currentAmplifierAgentSessionId(paneKey: string): string | undefined {
    const row = this.state.lastStatusByPaneKey.get(paneKey)
    return (
      this.amplifierAgentBridgeTailer.sessionIdForPane(paneKey, (key) =>
        this.resolvePaneKeyAlias(key)
      ) ?? (row?.payload.agentType === 'amplifier-agent' ? row.providerSession?.id : undefined)
    )
  }

  protected stopLiveFileTailers(clearSessions = false): void {
    this.statusHookInitialization = null
    this.amplifierBridgeTailer.stop()
    this.amplifierAgentBridgeTailer.stop(clearSessions)
    if (clearSessions) {
      this.amplifierAgentWrappers.clear()
    }
  }

  setStatusHooksEnabled(enabled: boolean): void {
    if (enabled === this.statusHooksEnabled) {
      return
    }
    this.statusHookGeneration += 1
    if (!enabled) {
      this.stopLiveFileTailers()
      this.claudeAgentViews.clear()
      this.flushStatusPersistSync()
      this.stopOpenCodeBinderLoop()
      for (const timer of this.assistantMessageRetryTimers.values()) {
        clearTimeout(timer)
      }
      this.assistantMessageRetryTimers.clear()
      this.clearAllTranscriptPolls()
    }
    this.statusHooksEnabled = enabled
    if (enabled && this.server) {
      void this.initializeStatusHookOwner().catch((error: unknown) => {
        console.error('[agent-hooks] status initialization failed', error)
      })
      this.startOpenCodeBinderLoop()
    }
  }

  protected initializeStatusHookOwner(): Promise<void> {
    if (!this.statusHookInitialization) {
      const pending = this.loadStatusHookOwner().finally(() => {
        if (this.statusHookInitialization === pending) {
          this.statusHookInitialization = null
        }
      })
      this.statusHookInitialization = pending
    }
    return this.statusHookInitialization
  }

  private async loadStatusHookOwner(): Promise<void> {
    const token = this.token
    const statusHookGeneration = this.statusHookGeneration
    const isCurrent = () =>
      this.statusHooksEnabled &&
      this.token === token &&
      this.statusHookGeneration === statusHookGeneration
    if (!isCurrent()) {
      return
    }
    if (!this.ownerStateInitialized) {
      // Hydrate before binding so the first live hook sees restored ownership.
      if (this.lastStatusFilePath) {
        this.hydrateLastStatusFromDisk()
      }
      this.captureHydratedAuthorityCommitments()
      // Drain before binding so replay cannot race live hooks.
      if (this.endpointDir) {
        const replayedPaneKeys = new Set<string>()
        await drainAgentHookSpoolAsync({
          endpointDir: this.endpointDir,
          getPersistedLaunchTokenHash: (paneKey) =>
            this.hydratedLaunchTokenHashByPaneKey.get(this.resolvePaneKeyAlias(paneKey)),
          ingest: async (record: SpoolRecord) => {
            if (this.token !== token || this.statusHookGeneration !== statusHookGeneration) {
              throw new Error('Status hook spool replay interrupted')
            }
            await this.ingestSpoolRecord(record)
            replayedPaneKeys.add(this.resolvePaneKeyAlias(record.paneKey))
          }
        })
        if (this.token !== token || this.statusHookGeneration !== statusHookGeneration) {
          return
        }
        // Replayed owners may have died while Orca was down; probe each pane once.
        for (const paneKey of replayedPaneKeys) {
          void this.checkAgentPresence(paneKey)
        }
      }
      this.ownerStateInitialized = true
    }
    if (isCurrent()) {
      // Existing bytes are history, not observations of this enabled lifecycle.
      this.amplifierBridgeTailer.start({ skipExisting: true })
      this.amplifierAgentBridgeTailer.start({ skipExisting: true })
    }
  }
}
