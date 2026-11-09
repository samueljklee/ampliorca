import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

export const AMPLIFIER_AGENT_DEFAULT_HOME = join(homedir(), '.amplifier-agent')

export function amplifierAgentWorkspaceSlug(cwd: string): string {
  // The REPL passes --workspace basename(cwd), not the Python CLI's full-path slug.
  return basename(cwd.replaceAll('\\', '/')) || 'amplifier-agent-orca'
}

export function amplifierAgentEventsPath(
  amplifierAgentHome: string,
  cwd: string,
  sessionId: string
): string {
  return join(
    amplifierAgentHome,
    'state',
    'workspaces',
    amplifierAgentWorkspaceSlug(cwd),
    'sessions',
    sessionId,
    'context-intelligence',
    'events.jsonl'
  )
}

export type AmplifierAgentFeed = { path: string; offset: number }
export type AmplifierAgentFeedOptions = {
  home?: string
  launchToken?: string
  resume?: boolean
  workspace?: string
  feed?: AmplifierAgentFeed
}

/** Capture resume history before execution, not after the binding's durable save. */
export function prepareAmplifierAgentFeed(
  cwd: string,
  sessionId: string,
  options: AmplifierAgentFeedOptions = {}
): AmplifierAgentFeed {
  const home = resolve(cwd, options.home ?? AMPLIFIER_AGENT_DEFAULT_HOME)
  let path = amplifierAgentEventsPath(home, cwd, sessionId)
  if (options.workspace && !/[/\\]/.test(options.workspace) && options.workspace !== '..') {
    path = join(
      home,
      'state',
      'workspaces',
      options.workspace,
      'sessions',
      sessionId,
      'context-intelligence',
      'events.jsonl'
    )
  } else if (options.resume) {
    const root = join(home, 'state', 'workspaces')
    try {
      const workspace = readdirSync(root).find((name) =>
        existsSync(join(root, name, 'sessions', sessionId))
      )
      if (workspace) {
        path = join(root, workspace, 'sessions', sessionId, 'context-intelligence', 'events.jsonl')
      }
    } catch {
      // Match the REPL's basename fallback when the resumed session is missing.
    }
  }
  let offset = 0
  if (options.resume) {
    try {
      offset = statSync(path).size
    } catch {
      /* Session has no feed yet. */
    }
  }
  return { path, offset }
}
