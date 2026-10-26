import { basename, dirname, join } from 'node:path'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { wslGatedReadFile } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { createAccumulator, finalizeSession, updateTimeline } from './session-scanner-accumulator'
import { addSessionContent } from './session-scanner-messages'
import type { FileWithMtime, SessionAccumulator } from './session-scanner-types'
import type { TranscriptMessageSink } from './session-transcript-consumers'
import {
  asRecord,
  extractContentText,
  extractString,
  normalizeTitleText
} from './session-scanner-values'

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
    // Metadata precedes the first turn; only a missing transcript is a valid empty session.
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
  // Prefer the asynchronously generated name over the first-message fallback.
  const generatedName = extractString(metadata.name)
  if (generatedName) {
    accumulator.title = normalizeTitleText(generatedName)
  }
  updateTimeline(accumulator, metadata.created)

  if (transcriptContent) {
    accumulator.logFilePath = amplifierTranscriptPathForMetadata(file.path)
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
  addSessionContent(accumulator, role, record.content, record.timestamp)
}

function parseJsonRecord(content: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(content))
  } catch {
    return null
  }
}
