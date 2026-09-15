import { basename, dirname, join } from 'node:path'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { wslGatedReadFile } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import {
  addPreviewContent,
  createAccumulator,
  finalizeSession,
  updateTimeline
} from './session-scanner-accumulator'
import type { FileWithMtime, SessionAccumulator } from './session-scanner-types'
import type { TranscriptMessageSink } from './session-transcript-consumers'
import {
  asRecord,
  extractContentText,
  extractString,
  normalizeTitleText
} from './session-scanner-values'

// amplifier-agent's on-disk layout: $AMPLIFIER_AGENT_HOME/state/workspaces/<workspace>/
// sessions/<id>/ -- same transcript.jsonl + context-intelligence/ shape as amplifier,
// EXCEPT its own top-level metadata.json is sparse crash-recovery state
// (observed: literally `{"last_turn": "complete"}`, confirmed on both a fresh probe
// session and a real 20k-line production one -- not an edge case). The identity
// fields (session_id, working_dir, started_at) live one level down, in the same
// context-intelligence/metadata.json format amplifier also writes. So unlike
// amplifier's parser, THIS one's anchor/candidate file is the nested one on
// purpose: `file.path` here is `.../sessions/<id>/context-intelligence/metadata.json`,
// and the sibling transcript.jsonl lives one level up, in the session dir itself.
//
// Sub-agent (delegate()) sessions share the same shape but their <id> directory is
// prefixed `0000000000000000-`; excluded at discovery time in
// session-scanner-agent-sources.ts, same rationale as amplifier's and Claude's own
// pruned Task-subagent transcripts.

export function amplifierAgentTranscriptPathForContextIntelligenceMetadata(
  contextIntelligenceMetadataPath: string
): string {
  // .../sessions/<id>/context-intelligence/metadata.json -> .../sessions/<id>/transcript.jsonl
  return join(dirname(dirname(contextIntelligenceMetadataPath)), 'transcript.jsonl')
}

export async function parseAmplifierAgentSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  messageSink?: TranscriptMessageSink
): Promise<AiVaultSession | null> {
  const metadataContent = await wslGatedReadFile(file.path, 'utf-8', 'scan')
  let transcriptContent: string | null = null
  try {
    transcriptContent = await wslGatedReadFile(
      amplifierAgentTranscriptPathForContextIntelligenceMetadata(file.path),
      'utf-8',
      'scan'
    )
  } catch (error) {
    // A session that has not completed a turn yet may have no transcript; a WSL
    // gate refusal must stay visible.
    if (error instanceof WslTranscriptFsError || !isMissingSessionPathError(error)) {
      throw error
    }
  }
  return parseAmplifierAgentSessionContent(
    file,
    metadataContent,
    transcriptContent,
    platform,
    messageSink
  )
}

function isMissingSessionPathError(error: unknown): boolean {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : null
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export function parseAmplifierAgentSessionContent(
  file: FileWithMtime,
  metadataContent: string,
  transcriptContent: string | null,
  platform: NodeJS.Platform = process.platform,
  messageSink?: TranscriptMessageSink
): AiVaultSession | null {
  const metadata = parseJsonRecord(metadataContent)
  if (!metadata) {
    return null
  }
  // file.path is .../sessions/<id>/context-intelligence/metadata.json; the session
  // id directory is two levels up.
  const sessionId = extractString(metadata.session_id) ?? basename(dirname(dirname(file.path)))
  const accumulator = createAccumulator({
    agent: 'amplifier-agent',
    file,
    sessionId,
    messages: messageSink
  })
  accumulator.cwd = extractString(metadata.working_dir)
  updateTimeline(accumulator, metadata.started_at)

  if (transcriptContent) {
    for (const line of transcriptContent.split('\n')) {
      if (!line.trim()) {
        continue
      }
      const record = parseJsonRecord(line)
      if (record) {
        consumeAmplifierAgentTranscriptLine(accumulator, record)
      }
    }
  }

  return finalizeSession(accumulator, platform, {})
}

function consumeAmplifierAgentTranscriptLine(
  accumulator: SessionAccumulator,
  record: Record<string, unknown>
): void {
  const role = record.role
  if (role !== 'user' && role !== 'assistant') {
    return
  }
  // Why: the first turn's prompt is prefixed with an injected system-reminder
  // wrapper recorded as its own 'user' line, marked metadata.ephemeral -- skip it
  // so it never becomes the fallback title or the first preview line instead of
  // what was actually typed.
  const recordMetadata = asRecord(record.metadata)
  if (recordMetadata?.ephemeral === true) {
    return
  }
  accumulator.messageCount++
  if (role === 'user' && !accumulator.fallbackTitle) {
    accumulator.fallbackTitle = normalizeTitleText(extractContentText(record.content) ?? '')
  }
  addPreviewContent(accumulator, role, record.content, recordMetadata?.timestamp)
}

function parseJsonRecord(content: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(content))
  } catch {
    return null
  }
}
