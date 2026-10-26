import type { TuiAgentConfigSource } from './tui-agent-config-types'

export const AMPLIFIER_TUI_AGENT_CONFIG = {
  amplifier: {
    detectCmd: 'amplifier',
    // Chat mode keeps a positional startup prompt interactive.
    launchCmd: 'amplifier run --mode chat',
    promptInjectionMode: 'argv',
    argvPromptSeparator: '--'
  },
  'amplifier-agent': {
    // Detect the one-turn engine but host the persistent wrapper.
    detectCmd: 'amplifier-agent',
    launchCmd: 'amplifier-agent-repl',
    expectedProcess: 'amplifier-agent-repl',
    promptInjectionMode: 'stdin-after-start'
  }
} satisfies Record<'amplifier' | 'amplifier-agent', TuiAgentConfigSource>
