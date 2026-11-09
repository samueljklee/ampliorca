import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { amplifierTranscriptPathForMetadata } from '../../../../shared/ai-vault/session-display/ai-vault-session-log-resource'
import type { AiVaultAgentSource } from '../../session-scanner-agent-sources'
import { sessionRootDirs } from '../../session-scanner-roots'

const AMPLIFIER_PROJECTS_DIR = join(homedir(), '.amplifier', 'projects')

export const AMPLIFIER_SOURCE: AiVaultAgentSource = {
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
}
