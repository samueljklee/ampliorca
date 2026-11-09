import type { TuiAgent } from './tui-agent'
import type { TuiAgentConfig, TuiAgentConfigSource } from './tui-agent-config-types'

export function resolveTuiAgentConfigs(
  sources: Record<TuiAgent, TuiAgentConfigSource>
): Record<TuiAgent, TuiAgentConfig> {
  const resolved = Object.fromEntries<TuiAgentConfig>(
    Object.entries(sources).map(([agent, source]) => [
      agent,
      {
        ...source,
        launchCmd: source.launchCmd ?? source.detectCmd,
        expectedProcess: source.expectedProcess ?? source.detectCmd
      }
    ])
  )
  const isComplete = (
    configs: Record<string, TuiAgentConfig>
  ): configs is Record<TuiAgent, TuiAgentConfig> =>
    Object.keys(sources).every((agent) => Object.hasOwn(configs, agent))
  if (!isComplete(resolved)) {
    throw new Error('Incomplete TUI agent configuration')
  }
  return resolved
}
