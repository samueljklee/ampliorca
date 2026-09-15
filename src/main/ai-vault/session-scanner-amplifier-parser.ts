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

// amplifier's on-disk layout: ~/.amplifier/projects/<sanitized-cwd>/sessions/<id>/
// holds metadata.json (session_id, working_dir, created, ...) plus a sibling
// transcript.jsonl (one {"role", "content"} record per line). Sub-agent
// (delegate()) sessions share the same shape but their directory name is
// prefixed `0000000000000000-`; those are filtered out at discovery time in
// session-scanner-agent-sources.ts, same rationale as Claude's pruned
// Task-subagent transcripts -- not independently resumable, would just
// duplicate the parent as an untitled row.

export function amplifierTranscriptPathForMetadata(metadataFilePath: string): string {
  return join(dirname(metadataFilePath), 'transcript.jsonl')
}

export async function parseAmplifierSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  messageSink?: TranscriptMessageSink
): Promise<AiVaultSession | null> {
  const metadataContent = await wslGatedReadFile(file.path, 'utf-8', 'scan')
  let transcriptContent: string | null = null
  try {
    transcriptContent = await wslGatedReadFile(
      amplifierTranscriptPathForMetadata(file.path),
      'utf-8',
      'scan'
    )
  } catch (error) {
    // metadata.json is written before the first turn; a missing transcript is a
    // valid metadata-only session, while a WSL gate refusal must stay visible.
    if (error instanceof WslTranscriptFsError || !isMissingSessionPathError(error)) {
      throw error
    }
  }
  return parseAmplifierSessionContent(
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

export function parseAmplifierSessionContent(
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
  const sessionId = extractString(metadata.session_id) ?? basename(dirname(file.path))
  const accumulator = createAccumulator({
    agent: 'amplifier',
    file,
    sessionId,
    messages: messageSink
  })
  accumulator.cwd = extractString(metadata.working_dir)
  // Why: amplifier generates an AI summary title asynchronously after enough of
  // the conversation exists (metadata.name / name_generated_at); prefer it over
  // the first-message fallback below when present, same layering finalizeSession
  // already gives every other parser (title beats fallbackTitle beats generated).
  const generatedName = extractString(metadata.name)
  if (generatedName) {
    accumulator.title = normalizeTitleText(generatedName)
  }
  updateTimeline(accumulator, metadata.created)

  if (transcriptContent) {
    for (const line of transcriptContent.split('\n')) {
      if (!line.trim()) {
        continue
      }
      const record = parseJsonRecord(line)
      if (record) {
        consumeAmplifierTranscriptLine(accumulator, record)
      }
    }
  }

  return finalizeSession(accumulator, platform, {})
}

function consumeAmplifierTranscriptLine(
  accumulator: SessionAccumulator,
  record: Record<string, unknown>
): void {
  const role = record.role
  if (role !== 'user' && role !== 'assistant') {
    return
  }
  accumulator.messageCount++
  if (role === 'user' && !accumulator.fallbackTitle) {
    accumulator.fallbackTitle = normalizeTitleText(extractContentText(record.content) ?? '')
  }
  addPreviewContent(accumulator, role, record.content, record.timestamp)
}

function parseJsonRecord(content: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(content))
  } catch {
    return null
  }
}
