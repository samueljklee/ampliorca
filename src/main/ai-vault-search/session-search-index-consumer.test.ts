import { appendFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetTranscriptConsumersForTests } from '../ai-vault/transcripts/session-transcript-consumers'
import {
  isolatedScanRoots,
  writeAmplifierScannerFixtures
} from '../ai-vault/session-scanner-test-fixtures'
import { readWholeTranscript } from '../ai-vault/transcripts/session-transcript-reader'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import {
  openSessionSearchIndexFile,
  replayTranscriptRead,
  SYNTHETIC_TRANSCRIPT,
  userMessages,
  type SessionSearchIndexFile
} from './session-search-index-test-fixture'
import { SessionSearchStore } from './session-search-store'

let index: SessionSearchIndexFile
let store: SessionSearchStore
let errors: unknown[]

beforeEach(async () => {
  index = await openSessionSearchIndexFile('ss-index-consumer')
  errors = []
  store = new SessionSearchStore(index.path, (error) => errors.push(error))
  registerSessionSearchIndexConsumer(store)
})

afterEach(async () => {
  resetTranscriptConsumersForTests()
  store.close()
  await index.close()
})

function owed(): { state: string; fail_count: number } | undefined {
  return index.db
    .prepare('SELECT state, fail_count FROM files WHERE path = ?')
    .get(SYNTHETIC_TRANSCRIPT) as { state: string; fail_count: number } | undefined
}

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
      index.db.prepare('SELECT user_text, assistant_text FROM messages_fts ORDER BY rowid').all()
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

it('keeps the session list running when the index write fails', async () => {
  replayTranscriptRead({
    messages: userMessages('healthy', 2),
    outcome: { byteOffset: 100 }
  })
  index.db.exec('DROP TABLE messages_fts')

  expect(() =>
    replayTranscriptRead({
      mode: 'append',
      previousByteOffset: 100,
      messages: userMessages('broken', 400),
      outcome: { byteOffset: 500 }
    })
  ).not.toThrow()
  expect(errors.length).toBeGreaterThan(0)
  expect(owed()?.state).not.toBe('current')
})
