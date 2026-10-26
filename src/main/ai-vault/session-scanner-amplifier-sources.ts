import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { resolveAbsoluteDirOverride } from '../../shared/absolute-dir-override'
import type { AiVaultAgentSource } from './session-scanner-agent-sources'
import { amplifierTranscriptPathForMetadata } from './session-scanner-amplifier-parser'
import { amplifierAgentTranscriptPathForContextIntelligenceMetadata } from './session-scanner-amplifier-agent-parser'
import { sessionRootDirs } from './session-scanner-roots'

const AMPLIFIER_PROJECTS_DIR = join(homedir(), '.amplifier', 'projects')
const AMPLIFIER_AGENT_WORKSPACES_DIR = join(
  resolveAbsoluteDirOverride(process.env.AMPLIFIER_AGENT_HOME, join(homedir(), '.amplifier-agent')),
  'state',
  'workspaces'
)

export const AMPLIFIER_AGENT_SOURCES = {
  amplifier: {
    rootDirs: (options, wslHomeDirs) =>
      sessionRootDirs(options.amplifierProjectsDir ?? AMPLIFIER_PROJECTS_DIR, wslHomeDirs, [
        '.amplifier',
        'projects'
      ]),
    extensions: ['.json'],
    // Delegate sessions are not independently resumable.
    filePredicate: (filePath) =>
      basename(filePath) === 'metadata.json' &&
      !basename(dirname(filePath)).startsWith('0000000000000000-'),
    contentDependencyPath: amplifierTranscriptPathForMetadata,
    // Nested event-log metadata is not another conversation.
    directoryPredicate: (name) => name !== 'context-intelligence'
  },
  'amplifier-agent': {
    rootDirs: (options, wslHomeDirs) =>
      sessionRootDirs(
        options.amplifierAgentStateDir ?? AMPLIFIER_AGENT_WORKSPACES_DIR,
        wslHomeDirs,
        ['.amplifier-agent', 'state', 'workspaces']
      ),
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
} satisfies Record<'amplifier' | 'amplifier-agent', AiVaultAgentSource>
