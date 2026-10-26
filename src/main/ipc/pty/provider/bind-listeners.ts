import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import { isCurrentPtyExit, ptyOwnership } from './ownership-state'
import {
  localBackgroundStreamUnsub,
  localDataUnsub,
  localExitUnsub,
  localWriteUnavailableUnsub,
  setLocalBackgroundStreamUnsub,
  setLocalDataUnsub,
  setLocalExitUnsub,
  setLocalWriteUnavailableUnsub
} from './listener-lifecycle'
import { localProvider } from './registry'
import { clearProviderPtyState } from './state-cleanup'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { providerSnapshotRequiredPtys, visibleRendererPtys } from '../delivery/visibility-state'
import type { PtyIpcSession } from '../session'
import { publishPtyEndpointLoss } from '../../../runtime/terminal/pty-endpoint-loss-signal'
import { agentHookServer } from '../../../agent-hooks/server'
import { consumeAmplifierAgentTurnSettlementOutput } from '../../../../shared/amplifier-agent-turn-settlement'
import { ptyPaneKey, getPtyIdForPaneKey } from '../pane/key-state'
import { ptyIncarnationById } from './ownership-state'

export function bindProviderListeners(session: PtyIpcSession): void {
  const turnOutputByPty = new Map<
    string,
    { paneKey: string; incarnation?: string; pending: string }
  >()
  const turnWorkByPty = new Map<string, Promise<void>>()
  localDataUnsub?.()
  localExitUnsub?.()
  localBackgroundStreamUnsub?.()
  localWriteUnavailableUnsub?.()

  // Daemon death invalidates every session; notify background panes too so they can remount (STA-2373).
  setLocalWriteUnavailableUnsub(
    localProvider.onWriteUnavailable?.((payload) => {
      // Before the window check: a headless host has no window, only remote streams.
      publishPtyEndpointLoss(payload.id)
      if (
        !session.mainWindow ||
        session.mainWindow.isDestroyed() ||
        (typeof session.mainWindow.webContents.isDestroyed === 'function' &&
          session.mainWindow.webContents.isDestroyed())
      ) {
        return
      }
      session.mainWindow.webContents.send('pty:writeUnavailable', { id: payload.id })
    }) ?? null
  )

  // Apply thinning facts in stream order; gaps require snapshot restore and change transient-scan authority.
  setLocalBackgroundStreamUnsub(
    localProvider.onBackgroundStreamEvent?.((payload) => {
      if (payload.kind === 'backgroundMarker') {
        session.runtime?.setPtyTransientFactDelegation(
          payload.id,
          payload.background,
          payload.scanSeedAnsi,
          payload.mode2031PendingSubscribe
        )
        return
      }
      if (payload.kind === 'dataGap') {
        providerSnapshotRequiredPtys.add(payload.id)
        session.runtime?.notePtyDataGap(payload.id, payload.sequenceChars ?? payload.droppedChars)
        session.sendModelRestoreNeededMarker(
          payload.id,
          'hidden-drop',
          session.runtime?.getPtyOutputSequence(payload.id)
        )
        return
      }
      session.runtime?.emitDaemonPtyTransientFact(payload.id, payload.fact)
    }) ?? null
  )

  // Daemon providers lack configure().onData; feed runtime records/streams here.
  const isLocalProvider = localProvider instanceof LocalPtyProvider

  setLocalDataUnsub(
    localProvider.onData((payload) => {
      const paneKey = ptyPaneKey.get(payload.id)
      if (paneKey && getPtyIdForPaneKey(paneKey) === payload.id) {
        const incarnation = ptyIncarnationById.get(payload.id)
        const previous = turnOutputByPty.get(payload.id)
        const pending =
          previous?.paneKey === paneKey && previous.incarnation === incarnation
            ? previous.pending
            : ''
        const output = consumeAmplifierAgentTurnSettlementOutput(pending, payload.data)
        turnOutputByPty.set(payload.id, { paneKey, incarnation, pending: output.pending })
        if (output.bindings.length || output.settlements.length) {
          const isCurrent = () =>
            getPtyIdForPaneKey(paneKey) === payload.id &&
            ptyIncarnationById.get(payload.id) === incarnation
          const work = (turnWorkByPty.get(payload.id) ?? Promise.resolve())
            .then(async () => {
              if (!isCurrent()) {
                return
              }
              for (const binding of output.bindings) {
                if (incarnation) {
                  await agentHookServer.observeAmplifierAgentWrapper(
                    paneKey,
                    binding,
                    { ptyId: payload.id, incarnationId: incarnation },
                    isCurrent
                  )
                }
              }
              for (const settlement of output.settlements) {
                if (!isCurrent()) {
                  return
                }
                await agentHookServer.settleAmplifierAgentTurnForPane(
                  paneKey,
                  settlement.failed,
                  settlement.sessionId,
                  settlement
                )
              }
            })
            .catch((error: unknown) => console.warn('[agent-hooks] turn settlement failed', error))
          turnWorkByPty.set(payload.id, work)
          void work.finally(() => {
            if (turnWorkByPty.get(payload.id) === work) {
              turnWorkByPty.delete(payload.id)
            }
          })
        }
      } else {
        turnOutputByPty.delete(payload.id)
      }
      const rawLength = payload.sequenceChars ?? payload.data.length
      const outputSeq = isLocalProvider
        ? session.runtime?.getPtyOutputSequence(payload.id)
        : session.runtime?.onPtyData(
            payload.id,
            payload.data,
            Date.now(),
            rawLength,
            payload.transformed
          )
      session.acceptPtyDataForRenderer(payload, outputSeq)
    })
  )
  setLocalExitUnsub(
    localProvider.onExit((payload) => {
      if (!isCurrentPtyExit(payload)) {
        return
      }
      turnOutputByPty.delete(payload.id)
      const syntheticExit = session.consumeSyntheticKillExit(payload.id, payload.incarnationId)
      // Daemon restart replaces processes while their panes survive.
      const settleRestartStop = payload.replacedByRestart
        ? session.runtime?.intentionalPtyStops?.mark(
            payload.id,
            'replaced',
            payload.incarnationId ?? null
          )
        : undefined
      try {
        if (!isLocalProvider) {
          const viewShown = ORCA_LAYOUT_OWNER_IS_MAIN && visibleRendererPtys.has(payload.id)
          clearProviderPtyState(payload.id)
          ptyOwnership.delete(payload.id)
          if (syntheticExit) {
            session.runtime?.markPtyStopRequested(payload.id)
          }
          session.runtime?.onPtyExit(payload.id, payload.code, payload.incarnationId, {
            providerExitObserved: true,
            ...(viewShown ? { viewShown } : {}),
            ...(payload.cause ? { cause: payload.cause } : {})
          })
        }
        // Control replies may overtake stream data; physical exit must still retire late output.
        if (syntheticExit) {
          return
        }
        // Exit cause belongs to runtime records; preserve the renderer event contract.
        session.sendPtyExitToRenderer({
          id: payload.id,
          code: payload.code,
          ...(payload.incarnationId ? { incarnationId: payload.incarnationId } : {})
        })
      } finally {
        settleRestartStop?.(true)
      }
    })
  )
}
