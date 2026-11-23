import { appendFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetTranscriptConsumersForTests } from '../../ai-vault/transcripts/session-transcript-consumers'
import {
  isolatedScanRoots,
  writeAmplifierScannerFixtures
} from '../../ai-vault/scanner-fixtures/session-scanner-test-fixtures'
import { readWholeTranscript } from '../../ai-vault/transcripts/session-transcript-reader'
import type { SessionFileCandidate } from '../../ai-vault/session-scanner-types'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import {
  openSessionSearchIndexFile,
  type SessionSearchIndexFile
} from '../storage/session-search-index-test-fixture'
import { SessionSearchStore } from '../storage/session-search-store'

let index: SessionSearchIndexFile
let store: SessionSearchStore
let errors: unknown[]

beforeEach(async () => {
  index = await openSessionSearchIndexFile('ss-amplifier-sidecar')
  errors = []
  store = new SessionSearchStore(index.path, (error) => errors.push(error))
  registerSessionSearchIndexConsumer(store)
})

afterEach(async () => {
  resetTranscriptConsumersForTests()
  store.close()
  await index.close()
})

it.each(['amplifier', 'amplifier-agent'] as const)(
  'reindexes %s transcript appends despite complete coverage of unchanged metadata',
  async (agent) => {
    const roots = isolatedScanRoots(dirname(index.path))
    await writeAmplifierScannerFixtures(roots)
    const sessionDir =
      agent === 'amplifier'
        ? join(roots.amplifierProjectsDir, 'project', 'sessions', 'amplifier-session')
        : join(roots.amplifierAgentStateDir, 'workspace', 'sessions', 'amplifier-agent-session')
    const path =
      agent === 'amplifier'
        ? join(sessionDir, 'metadata.json')
        : join(sessionDir, 'context-intelligence', 'metadata.json')
    const fileStat = await stat(path)
    // On-demand candidates can carry metadata stats without discovery's sidecar observation.
    const candidate: SessionFileCandidate = {
      agent,
      codexHome: null,
      file: {
        path,
        mtimeMs: fileStat.mtimeMs,
        modifiedAt: fileStat.mtime.toISOString(),
        sizeBytes: fileStat.size
      }
    }
    await readWholeTranscript({ candidate, platform: process.platform })
    expect(store.coversTranscript(candidate)).toBe(true)

    await appendFile(
      join(sessionDir, 'transcript.jsonl'),
      `${JSON.stringify({ role: 'assistant', content: 'New searchable transcript answer' })}\n`
    )
    await readWholeTranscript({ candidate, platform: process.platform })

    expect(
      index.db
        .prepare(
          `SELECT user_text, assistant_text FROM messages_fts
           JOIN messages m ON m.id = messages_fts.rowid
           JOIN sessions s ON s.id = m.session_row_id ORDER BY messages_fts.rowid`
        )
        .all()
    ).toEqual([
      {
        user_text: agent === 'amplifier' ? 'Amplifier prompt' : 'Amplifier Agent prompt',
        assistant_text: ''
      },
      { user_text: '', assistant_text: 'New searchable transcript answer' }
    ])
    expect(errors).toEqual([])
  }
)
