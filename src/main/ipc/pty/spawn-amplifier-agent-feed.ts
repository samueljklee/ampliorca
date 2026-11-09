import type { PtySpawnExecutionFacts, PtySpawnOperationState } from './spawn-operation-state'
import { isWslTerminalSpawn } from './wsl-terminal-spawn'
import {
  beginAmplifierAgentPtyLaunch,
  releaseAmplifierAgentPtyLaunch
} from './provider/amplifier-agent-turn-ingress'

/** Snapshot before dispatch; callers recheck pane and cancellation authority after this await. */
export async function captureAmplifierAgentSpawnFeed(
  ctx: PtySpawnOperationState,
  facts: PtySpawnExecutionFacts,
  expectedPtyId: string | undefined
): Promise<void> {
  const args = ctx.args
  const env = ctx.spawnOptions.env
  const launchToken = args.launchToken
  if (
    args.launchAgent !== 'amplifier-agent' ||
    args.connectionId ||
    ctx.expectedWslDistro ||
    isWslTerminalSpawn(ctx.spawnOptions.shellOverride, ctx.spawnOptions.cwd) ||
    !facts.paneKey ||
    !ctx.cwd ||
    !ctx.amplifierAgentSessionId ||
    typeof launchToken !== 'string' ||
    !launchToken.length ||
    launchToken.length > 128 ||
    env?.ORCA_AGENT_LAUNCH_TOKEN !== launchToken
  ) {
    return
  }
  releaseAmplifierAgentPtyLaunch(ctx.amplifierAgentPtyLaunch)
  ctx.amplifierAgentPtyLaunch = await beginAmplifierAgentPtyLaunch({
    paneKey: facts.paneKey,
    sessionId: ctx.amplifierAgentSessionId,
    launchToken,
    expectedPtyId,
    cwd: ctx.cwd,
    home: env.AMPLIFIER_AGENT_HOME ?? process.env.AMPLIFIER_AGENT_HOME,
    resume:
      Boolean(args.resumeProviderSession) ||
      /(?:^|\s)--resume(?:\s|$)/.test(ctx.spawnOptions.command ?? '')
  })
  if (!ctx.amplifierAgentPtyLaunch.active) {
    throw new Error('client_disconnected')
  }
}
