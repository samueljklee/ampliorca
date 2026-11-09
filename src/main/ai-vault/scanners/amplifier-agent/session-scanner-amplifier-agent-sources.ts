import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { resolveAbsoluteDirOverride } from '../../../../shared/absolute-dir-override'
import { amplifierAgentTranscriptPathForContextIntelligenceMetadata } from '../../../../shared/ai-vault/session-display/ai-vault-session-log-resource'
import type { AiVaultAgentSource } from '../../session-scanner-agent-sources'
import { sessionRootDirs } from '../../session-scanner-roots'

const AMPLIFIER_AGENT_WORKSPACES_DIR = join(
  resolveAbsoluteDirOverride(process.env.AMPLIFIER_AGENT_HOME, join(homedir(), '.amplifier-agent')),
  'state',
  'workspaces'
)

export const AMPLIFIER_AGENT_SOURCE: AiVaultAgentSource = {
  rootDirs: (options, wslHomeDirs) =>
    sessionRootDirs(options.amplifierAgentStateDir ?? AMPLIFIER_AGENT_WORKSPACES_DIR, wslHomeDirs, [
      '.amplifier-agent',
      'state',
      'workspaces'
    ]),
  extensions: ['.json'],
  // Identity lives in nested metadata, not the sparse top-level crash-recovery state.
  filePredicate: (filePath) => {
    if (basename(filePath) !== 'metadata.json') {
      return false
    }
    if (basename(dirname(filePath)) !== 'context-intelligence') {
      return false
    }
    return !basename(dirname(dirname(filePath))).startsWith('0000000000000000-')
  },
  contentDependencyPath: amplifierAgentTranscriptPathForContextIntelligenceMetadata
}
