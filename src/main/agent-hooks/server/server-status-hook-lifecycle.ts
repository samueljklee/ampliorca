import {
  drainAgentHookSpoolAsync,
  type SpoolRecord
} from '../../../shared/agent-hook-listener/transport/agent-hook-spool'
import { hookRootAnswerDeadline } from '../../../shared/agent-hook-listener/presence/hook-root-attempts'
import { AgentHookServerAmplifierAgentSettlement } from './server-amplifier-agent-settlement'
import { ClaudeAgentViewBridge } from '../../claude/agent-view/agent-view-bridge'
import { AmplifierBridgeTailer } from '../amplifier-bridge-tailer'
import type { AmplifierAgentFeedOptions } from '../amplifier-agent-feed'
import type { AmplifierAgentWrapperBinding } from '../../../shared/amplifier-agent-turn-settlement'
import {
  persistAmplifierAgentWrapperBinding,
  restoreAmplifierAgentWrapperBinding,
  type AmplifierAgentTerminalBinding
} from '../amplifier-agent-wrapper-bindings'
import { paneCacheKeyMatchesTab } from './server-status-identity'

export abstract class AgentHookServerStatusHookLifecycle extends AgentHookServerAmplifierAgentSettlement {
  override dropStatusEntriesByTabPrefix(tabId: string): void {
    this.amplifierAgentBridgeTailer.unregisterTab(tabId)
    for (const paneKey of this.amplifierAgentWrappers.keys()) {
      if (paneCacheKeyMatchesTab(paneKey, tabId)) {
        this.amplifierAgentWrappers.delete(paneKey)
      }
    }
    super.dropStatusEntriesByTabPrefix(tabId)
  }

  override clearPaneState(
    paneKey: string,
    options?: Parameters<AgentHookServerAmplifierAgentSettlement['clearPaneState']>[1]
  ): void {
    this.unregisterAmplifierAgentSession(this.resolvePaneKeyAlias(paneKey))
    super.clearPaneState(paneKey, options)
  }

  readonly claudeAgentViews = new ClaudeAgentViewBridge()
  private statusHookInitialization: Promise<void> | null = null

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
      previous.isCurrent = isCurrent
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
      this.amplifierAgentWrappers.set(paneKey, {
        wrapperId: wrapper.wrapperId,
        lastSettledTurn: 0,
        isCurrent
      })
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
    const previous = this.amplifierAgentWrappers.get(paneKey)
    const wrapper = await restoreAmplifierAgentWrapperBinding(this.endpointDir, paneKey, terminal)
    if (
      !wrapper ||
      !isCurrent() ||
      generation !== this.statusHookGeneration ||
      this.amplifierAgentWrappers.get(paneKey) !== previous ||
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
    this.amplifierAgentWrappers.set(paneKey, {
      wrapperId: wrapper.wrapperId,
      lastSettledTurn: 0,
      isCurrent
    })
  }
  private readonly amplifierBridgeTailer = new AmplifierBridgeTailer((record, isCurrent) =>
    this.ingestLiveFileRecord(record, isCurrent)
  )

  registerAmplifierAgentSession(
    paneKey: string,
    cwd: string,
    sessionId: string,
    options?: AmplifierAgentFeedOptions
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

  protected stopLiveFileTailers(clearSessions = false): void {
    this.statusHookInitialization = null
    this.amplifierBridgeTailer.stop()
    this.amplifierAgentBridgeTailer.stop(clearSessions)
    if (clearSessions) {
      this.statusHookGeneration += 1
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
        // Why: records replay in order, so a per-record allowance would add up across panes.
        const answerBy = hookRootAnswerDeadline()
        await drainAgentHookSpoolAsync({
          endpointDir: this.endpointDir,
          getPersistedLaunchTokenHash: (paneKey) =>
            this.hydratedLaunchTokenHashByPaneKey.get(this.resolvePaneKeyAlias(paneKey)),
          ingest: async (record: SpoolRecord) => {
            if (this.token !== token || this.statusHookGeneration !== statusHookGeneration) {
              throw new Error('Status hook spool replay interrupted')
            }
            await this.ingestSpoolRecord(record, answerBy)
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
      this.activateClaudeHelperObservations()
    }
    if (isCurrent()) {
      // Existing bytes are history, not observations of this enabled lifecycle.
      this.amplifierBridgeTailer.start({ skipExisting: true })
      this.amplifierAgentBridgeTailer.start({ skipExisting: true })
    }
  }
}
