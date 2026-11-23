import {
  drainAgentHookSpoolAsync,
  type SpoolRecord
} from '../../../shared/agent-hook-listener/transport/agent-hook-spool'
import { hookRootAnswerDeadline } from '../../../shared/agent-hook-listener/presence/hook-root-attempts'
import { AgentHookServerAmplifierAgentSettlement } from './server-amplifier-agent-settlement'
import { ClaudeAgentViewBridge } from '../../claude/agent-view/agent-view-bridge'
import { AmplifierBridgeTailer } from '../amplifier-bridge-tailer'
import { prepareAmplifierAgentFeed, type AmplifierAgentFeedOptions } from '../amplifier-agent-feed'
import {
  restoreAmplifierAgentWrapperBinding,
  type AmplifierAgentTerminalBinding
} from '../amplifier-agent-wrapper-bindings'
import { paneCacheKeyMatchesTab } from './server-status-identity'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AgentHookSource } from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { EnrichedAgentHookEventPayload } from './server-types'
import { respondAfterAgentToolPluginHooks } from '../tool-events/agent-tool-plugin-hooks'
import { ClaudePermissionHookHolds } from './claude-permission-hook-hold'

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

  readonly claudeAgentViews = this.createClaudeAgentViews()
  protected readonly claudePermissionHooks = new ClaudePermissionHookHolds()
  private statusHookInitialization: Promise<void> | null = null
  private restoredOwnersChecked: Promise<void> = Promise.resolve()

  /** Settles once replayed hooks are in and each replayed pane's agent was probed once. */
  whenRestoredOwnersChecked(): Promise<void> {
    return (this.statusHookInitialization ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.restoredOwnersChecked)
  }

  /** Answers a hook post: a worker's PermissionRequest waits for its coordinator's or person's answer;
   *  plugins see only calls status accepted, so a fenced or reused pane's old agent is skipped. */
  protected async respondToHook(
    req: IncomingMessage,
    res: ServerResponse,
    source: AgentHookSource,
    body: unknown,
    accepted: AgentHookEventPayload | null
  ): Promise<void> {
    if (accepted && source === 'claude' && this.claudePermissionHooks.hold(req, res, accepted)) {
      return
    }
    await respondAfterAgentToolPluginHooks(res, source, body, req.headers, accepted)
  }

  /** Restored entries count only for panes whose hydrated status still shows a live Claude. The
   *  session may lag the registry after a crash; a click still needs the session to match. */
  protected restoreClaudeAgentViews(filePath: string): Promise<void> {
    // Without hydrated status (hooks off, or the store failed to load) a missing row proves nothing.
    const unchecked =
      !this.statusHooksEnabled ||
      this.statusHydrationFailed ||
      this.state.lastStatusByPaneKey.size === 0
    return this.claudeAgentViews.restore(
      filePath,
      (view) =>
        unchecked ||
        (!this.claudeAgentEnded(view.paneKey) &&
          // The mod keeps its launch pane key; a moved pane's row lives under the alias target.
          this.getStatusSnapshotForPane(this.resolvePaneKeyAlias(view.paneKey)).some(
            (row) => row.agentType === 'claude'
          ))
    )
  }

  private createClaudeAgentViews(): ClaudeAgentViewBridge {
    const bridge = new ClaudeAgentViewBridge()
    bridge.isLive = (paneKey, sessionId) =>
      !this.statusHooksEnabled ||
      (!this.claudeAgentEnded(paneKey) &&
        this.getStatusSnapshotForPane(this.resolvePaneKeyAlias(paneKey)).some(
          (row) =>
            row.agentType === 'claude' &&
            (!row.providerSession?.id || row.providerSession.id === sessionId)
        ))
    return bridge
  }

  /** A mod may stop checking in only where a click can probe its Claude process (a local pane with a
   *  recorded process; Windows hooks record none). Elsewhere it keeps the 5 s check-in and 15 s rule. */
  protected claudeViewMayGoQuiet(body: unknown): boolean {
    const paneKey =
      body && typeof body === 'object' && 'paneKey' in body && typeof body.paneKey === 'string'
        ? body.paneKey
        : undefined
    const row = paneKey && this.state.lastStatusByPaneKey.get(this.resolvePaneKeyAlias(paneKey))
    return Boolean(row && row.connectionId === null && row.agentPresence?.process)
  }

  /** Whether the pane's agent can take typed input now: its process runs and isn't stopped by job
   *  control (Ctrl-Z, then another program in front). A silent idle mod proves neither. */
  async agentAcceptsInput(paneKey: string): Promise<boolean> {
    if ((await this.checkAgentPresence(paneKey)) === 'exited') {
      return false
    }
    const row = this.state.lastStatusByPaneKey.get(this.resolvePaneKeyAlias(paneKey))
    return row?.agentPresence?.suspended !== true && row?.agentPresence?.ended !== true
  }

  private claudeAgentEnded(paneKey: string): boolean {
    return (
      this.state.lastStatusByPaneKey.get(this.resolvePaneKeyAlias(paneKey))?.agentPresence
        ?.ended === true
    )
  }

  // A pane's agent-view entry goes with its status row, the row's recorded exit, or another agent taking it.
  protected override commitStatusRowMutation(
    before: EnrichedAgentHookEventPayload | null | undefined,
    after: EnrichedAgentHookEventPayload | null | undefined,
    emit = true
  ): boolean {
    const committed = super.commitStatusRowMutation(before, after, emit)
    // A row moving to another pane is not its Claude ending; the mod keeps its original pane key.
    const replaced =
      before?.payload.agentType === 'claude' && after && after.payload.agentType !== 'claude'
    if (before && (!after || after.agentPresence?.ended || replaced)) {
      const sessionId = before.providerSession?.id
      const forgotten = this.claudeAgentViews.forget(before.paneKey, sessionId)
      // A moved pane's entry stays under the mod's launch key: find it by session, sparing any
      // other pane still running that session (two panes can resume one conversation).
      if (!forgotten && sessionId && before.payload.agentType === 'claude') {
        this.claudeAgentViews.forgetSession(
          sessionId,
          (paneKey) =>
            !this.claudeAgentEnded(paneKey) &&
            this.getStatusSnapshotForPane(this.resolvePaneKeyAlias(paneKey)).some(
              (row) => row.agentType === 'claude' && row.providerSession?.id === sessionId
            )
        )
      }
    }
    return committed
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
    const feed = wrapper
      ? await prepareAmplifierAgentFeed(wrapper.cwd, wrapper.sessionId, {
          home: wrapper.home,
          workspace: wrapper.workspace,
          resume: true
        })
      : undefined
    if (
      !wrapper ||
      !isCurrent() ||
      generation !== this.statusHookGeneration ||
      this.amplifierAgentWrappers.get(paneKey) !== previous ||
      !this.statusHooksEnabled
    ) {
      return
    }
    await this.registerAmplifierAgentSession(paneKey, wrapper.cwd, wrapper.sessionId, {
      home: wrapper.home,
      workspace: wrapper.workspace,
      resume: true,
      launchToken: wrapper.launchToken,
      feed
    })
    if (
      !isCurrent() ||
      generation !== this.statusHookGeneration ||
      this.amplifierAgentWrappers.has(paneKey) ||
      this.amplifierAgentBridgeTailer.admitWrapper(paneKey, wrapper.sessionId)?.launchToken !==
        wrapper.launchToken
    ) {
      return
    }
    this.amplifierAgentWrappers.set(paneKey, {
      wrapperId: wrapper.wrapperId,
      lastSettledTurn: 0,
      isCurrent
    })
  }
  private readonly amplifierBridgeTailer = new AmplifierBridgeTailer((record, isCurrent) =>
    this.ingestLiveFileRecord(record, isCurrent)
  )

  async registerAmplifierAgentSession(
    paneKey: string,
    cwd: string,
    sessionId: string,
    options?: AmplifierAgentFeedOptions
  ): Promise<void> {
    const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey)
    this.unregisterAmplifierAgentSession(resolvedPaneKey)
    await this.amplifierAgentBridgeTailer.registerSession(resolvedPaneKey, cwd, sessionId, options)
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
      this.claudeAgentViews.release()
      this.flushStatusPersistSync()
      this.stopOpenCodeBinderLoop()
      this.clearAllAssistantMessageRetries()
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
        this.restoredOwnersChecked = Promise.allSettled(
          [...replayedPaneKeys].map((paneKey) => this.checkAgentPresence(paneKey))
        ).then(() => undefined)
      }
      this.ownerStateInitialized = true
      this.activateClaudeHelperObservations()
    }
    if (isCurrent()) {
      // Existing bytes are history, not observations of this enabled lifecycle.
      await this.amplifierBridgeTailer.start({ skipExisting: true })
      if (isCurrent()) {
        await this.amplifierAgentBridgeTailer.start({ skipExisting: true })
      }
    }
  }
}
