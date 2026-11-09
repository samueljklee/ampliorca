import { agentHookServer } from '../../../agent-hooks/server/agent-hook-server'
import {
  prepareAmplifierAgentFeed,
  type AmplifierAgentFeed
} from '../../../agent-hooks/amplifier-agent-feed'
import {
  consumeAmplifierAgentTurnSettlementOutput,
  type AmplifierAgentWrapperBinding,
  type AmplifierAgentTurnSettlement
} from '../../../../shared/amplifier-agent-turn-settlement'
import { getPtyIdForPaneKey, ptyPaneKey } from '../pane/key-state'
import { ptyIncarnationById } from './ownership-state'

export type AmplifierAgentPtyLaunch = {
  paneKey: string
  sessionId: string
  launchToken: string
  expectedPtyId?: string
  feed: AmplifierAgentFeed
  active: boolean
  published: boolean
}

type Markers = {
  bindings: AmplifierAgentWrapperBinding[]
  settlements: AmplifierAgentTurnSettlement[]
}
type PtyIngress = {
  pending: string
  candidates: AmplifierAgentPtyLaunch[]
  launch?: AmplifierAgentPtyLaunch
  admitted?: { paneKey: string; incarnationId: string }
  buffered: Markers[]
  markerCount: number
  active: boolean
  work: Promise<void>
}

const launches = new Map<string, AmplifierAgentPtyLaunch>()
const ingressByPty = new Map<string, PtyIngress>()

export async function beginAmplifierAgentPtyLaunch(args: {
  paneKey: string
  sessionId: string
  launchToken: string
  expectedPtyId?: string
  cwd: string
  home?: string
  resume: boolean
}): Promise<AmplifierAgentPtyLaunch> {
  const previous = launches.get(args.paneKey)
  if (previous) {
    previous.active = false
  }
  if (args.expectedPtyId) {
    discardAmplifierAgentPtyIngress(args.expectedPtyId)
  }
  const launch: AmplifierAgentPtyLaunch = {
    paneKey: args.paneKey,
    sessionId: args.sessionId,
    launchToken: args.launchToken,
    expectedPtyId: args.expectedPtyId,
    feed: { path: '', offset: 0 },
    active: true,
    published: false
  }
  launches.set(args.paneKey, launch)
  launch.feed = await prepareAmplifierAgentFeed(args.cwd, args.sessionId, args)
  return launch
}

export function releaseAmplifierAgentPtyLaunch(launch: AmplifierAgentPtyLaunch | undefined): void {
  if (launch && !launch.published) {
    launch.active = false
    if (launches.get(launch.paneKey) === launch) {
      launches.delete(launch.paneKey)
    }
    for (const ingress of ingressByPty.values()) {
      ingress.candidates = ingress.candidates.filter((candidate) => candidate !== launch)
      if (!ingress.admitted && !ingress.candidates.length) {
        ingress.active = false
        ingress.buffered = []
      }
    }
  }
}

function newIngress(candidates: AmplifierAgentPtyLaunch[]): PtyIngress {
  return {
    pending: '',
    candidates,
    buffered: [],
    markerCount: 0,
    active: true,
    work: Promise.resolve()
  }
}

/** Only the post-save publication can promote captured startup bytes into hook authority. */
export async function publishAmplifierAgentPtyIngress(
  launch: AmplifierAgentPtyLaunch | undefined,
  ptyId: string,
  paneKey: string,
  incarnationId: string | undefined,
  sessionId: string
): Promise<void> {
  if (
    !launch?.active ||
    launches.get(paneKey) !== launch ||
    launch.paneKey !== paneKey ||
    launch.sessionId !== sessionId ||
    !incarnationId ||
    ptyIncarnationById.get(ptyId) !== incarnationId ||
    getPtyIdForPaneKey(paneKey) !== ptyId
  ) {
    return
  }
  const ingress = ingressByPty.get(ptyId) ?? newIngress([launch])
  if (!ingress.active || !ingress.candidates.includes(launch)) {
    return
  }
  ingressByPty.set(ptyId, ingress)
  launch.published = true
  ingress.candidates = [launch]
  ingress.launch = launch
  ingress.admitted = { paneKey, incarnationId }
  for (const markers of ingress.buffered.splice(0)) {
    queueMarkers(ptyId, ingress, markers)
  }
  ingress.markerCount = 0
  await ingress.work
}

export function consumeAmplifierAgentPtyOutput(ptyId: string, data: string): void {
  let ingress = ingressByPty.get(ptyId)
  if (!ingress) {
    const paneKey = ptyPaneKey.get(ptyId)
    const candidates = [...launches.values()].filter(
      (launch) =>
        launch.active &&
        !launch.published &&
        (!paneKey || launch.paneKey === paneKey) &&
        (!launch.expectedPtyId || launch.expectedPtyId === ptyId)
    )
    const incarnationId = ptyIncarnationById.get(ptyId)
    if (!candidates.length && (!paneKey || !incarnationId)) {
      return
    }
    if (ingressByPty.size >= 256) {
      return
    }
    ingress = newIngress(candidates)
    if (!candidates.length && paneKey && incarnationId) {
      ingress.admitted = { paneKey, incarnationId }
    }
    ingressByPty.set(ptyId, ingress)
  }
  if (!ingress.active) {
    return
  }
  const output = consumeAmplifierAgentTurnSettlementOutput(ingress.pending, data)
  ingress.pending = output.pending
  if (!output.bindings.length && !output.settlements.length) {
    return
  }
  if (ingress.admitted) {
    queueMarkers(ptyId, ingress, output)
  } else {
    ingress.markerCount += output.bindings.length + output.settlements.length
    if (ingress.markerCount > 64) {
      ingress.active = false
      ingress.buffered = []
      return
    }
    ingress.buffered.push({ bindings: output.bindings, settlements: output.settlements })
  }
}

function queueMarkers(ptyId: string, ingress: PtyIngress, markers: Markers): void {
  const admitted = ingress.admitted
  if (!admitted) {
    return
  }
  const { paneKey, incarnationId } = admitted
  const isCurrent = () =>
    ingress.active &&
    ingressByPty.get(ptyId) === ingress &&
    (!ingress.launch || ingress.launch.active) &&
    getPtyIdForPaneKey(paneKey) === ptyId &&
    ptyIncarnationById.get(ptyId) === incarnationId
  ingress.work = ingress.work
    .then(async () => {
      if (!isCurrent()) {
        return
      }
      for (const binding of markers.bindings) {
        if (
          !ingress.launch ||
          (binding.sessionId === ingress.launch.sessionId &&
            binding.launchToken === ingress.launch.launchToken)
        ) {
          await agentHookServer.observeAmplifierAgentWrapper(
            paneKey,
            binding,
            { ptyId, incarnationId },
            isCurrent
          )
        }
      }
      for (const settlement of markers.settlements) {
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
}

export function discardAmplifierAgentPtyIngress(ptyId: string): void {
  const ingress = ingressByPty.get(ptyId)
  if (ingress) {
    ingress.active = false
    if (ingress.launch) {
      ingress.launch.active = false
      if (launches.get(ingress.launch.paneKey) === ingress.launch) {
        launches.delete(ingress.launch.paneKey)
      }
    }
    ingressByPty.delete(ptyId)
  }
}

export function clearAmplifierAgentPtyIngress(): void {
  for (const launch of launches.values()) {
    launch.active = false
  }
  launches.clear()
  for (const id of ingressByPty.keys()) {
    discardAmplifierAgentPtyIngress(id)
  }
}
