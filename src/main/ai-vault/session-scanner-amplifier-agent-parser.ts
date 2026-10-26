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

export function amplifierAgentTranscriptPathForContextIntelligenceMetadata(
  contextIntelligenceMetadataPath: string
): string {
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
    // Only a missing transcript is a valid empty session; WSL refusals remain visible.
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
  // Identity is anchored one level below the session directory.
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
    accumulator.logFilePath = amplifierAgentTranscriptPathForContextIntelligenceMetadata(file.path)
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
  // Injected ephemeral reminders are not user prompts or conversation turns.
  const recordMetadata = asRecord(record.metadata)
  if (recordMetadata?.ephemeral === true) {
    return
  }
  accumulator.messageCount++
  if (role === 'user' && !accumulator.fallbackTitle) {
    accumulator.fallbackTitle = normalizeTitleText(extractContentText(record.content) ?? '')
  }
  addSessionContent(accumulator, role, record.content, recordMetadata?.timestamp)
}

function parseJsonRecord(content: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(content))
  } catch {
    return null
  }
}
