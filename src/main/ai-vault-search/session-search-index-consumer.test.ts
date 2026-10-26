import { appendFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import {
  isolatedScanRoots,
  writeAmplifierScannerFixtures
} from '../ai-vault/session-scanner-test-fixtures'
import { readWholeTranscript } from '../ai-vault/session-transcript-reader'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import {
  openSessionSearchIndexFile,
  replayTranscriptRead,
  syntheticCandidate,
  syntheticSession,
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

function indexedMessages(): number {
  return (
    index.db.prepare('SELECT count(*) AS n FROM messages').get() as {
      n: number
    }
  ).n
}

function cursor(): number | null | undefined {
  return store.indexedFile(SYNTHETIC_TRANSCRIPT, null)?.byteOffset
}

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
    expect(indexedMessages()).toBe(1)
    expect(store.coversTranscript(candidate)).toBe(true)

    await appendFile(
      join(sessionDir, 'transcript.jsonl'),
      `${JSON.stringify({ role: 'assistant', content: 'New searchable transcript answer' })}\n`
    )
    const unchangedMetadata = await stat(path)
    expect(unchangedMetadata.mtimeMs).toBe(fileStat.mtimeMs)
    expect(unchangedMetadata.size).toBe(fileStat.size)
    await readWholeTranscript({ candidate, platform: process.platform })

    expect(indexedMessages()).toBe(2)
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

it('appends onto its own cursor and carries the content hash forward', async () => {
  replayTranscriptRead({
    messages: userMessages('first half', 3),
    outcome: { byteOffset: 100 }
  })
  const first = index.db
    .prepare('SELECT content_hash AS hash, content_hash_count AS count FROM sessions')
    .get() as { hash: string; count: number }

  replayTranscriptRead({
    mode: 'append',
    previousByteOffset: 100,
    messages: userMessages('second half', 2),
    outcome: { byteOffset: 220 }
  })

  expect(indexedMessages()).toBe(5)
  expect(cursor()).toBe(220)
  const second = index.db
    .prepare('SELECT content_hash AS hash, content_hash_count AS count FROM sessions')
    .get() as { hash: string; count: number }
  expect(second.count).toBe(first.count + 2)
  expect(second.hash).not.toBe(first.hash)
  expect(owed()).toMatchObject({ state: 'current', fail_count: 0 })
})

it('appends onto a file it read through and decoded no session from', async () => {
  replayTranscriptRead({
    messages: userMessages('excluded span', 3),
    outcome: { session: null, byteOffset: 100 }
  })
  expect(cursor()).toBe(100)
  expect(owed()).toMatchObject({ state: 'current', fail_count: 0 })

  replayTranscriptRead({
    mode: 'append',
    previousByteOffset: 100,
    messages: userMessages('decoded at last', 2),
    outcome: { byteOffset: 220 }
  })

  expect(indexedMessages()).toBe(2)
  expect(cursor()).toBe(220)
  expect(owed()).toMatchObject({ state: 'current', fail_count: 0 })
})

it('declines an append that starts past its own cursor and records the file', async () => {
  replayTranscriptRead({
    messages: userMessages('indexed span', 3),
    outcome: { byteOffset: 100 }
  })

  replayTranscriptRead({
    mode: 'append',
    previousByteOffset: 900,
    messages: userMessages('unseen span', 4),
    outcome: { byteOffset: 1200 }
  })

  expect(indexedMessages()).toBe(3)
  expect(cursor()).toBe(100)
  expect(owed()).toMatchObject({ state: 'due' })
})

it('declines a file whose identity changed under the same path', async () => {
  const original = syntheticCandidate({ dev: 1, ino: 10 })
  replayTranscriptRead({
    candidate: original,
    messages: userMessages('original file', 2),
    outcome: { byteOffset: 100 }
  })

  replayTranscriptRead({
    candidate: syntheticCandidate({ dev: 1, ino: 77 }),
    mode: 'append',
    previousByteOffset: 100,
    messages: userMessages('replacement file', 2),
    outcome: { byteOffset: 200 }
  })

  expect(indexedMessages()).toBe(2)
  expect(owed()?.state).not.toBe('current')
})

it('never advances the cursor for an incomplete read', async () => {
  replayTranscriptRead({
    messages: userMessages('complete span', 3),
    outcome: { byteOffset: 100 }
  })

  replayTranscriptRead({
    mode: 'append',
    previousByteOffset: 100,
    messages: userMessages('partial span', 5),
    outcome: { byteOffset: 400, incomplete: true }
  })

  expect(indexedMessages()).toBe(3)
  expect(cursor()).toBe(100)
  expect(
    (
      index.db.prepare('SELECT count(*) AS n FROM messages').get() as {
        n: number
      }
    ).n
  ).toBe(3)
  expect(owed()?.state).not.toBe('current')
})

it('indexes nothing at all from a read that was incomplete from the start', async () => {
  replayTranscriptRead({
    messages: userMessages('unreachable', 4),
    outcome: { byteOffset: 0, incomplete: true }
  })

  expect(index.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({
    n: 0
  })
  expect(index.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({
    n: 0
  })
  expect(cursor()).toBe(0)
  expect(owed()).toMatchObject({ state: 'failed', fail_count: 1 })
})

it('leaves the row untouched when the read was cancelled', async () => {
  replayTranscriptRead({
    messages: userMessages('complete span', 3),
    outcome: { byteOffset: 100 }
  })
  for (let attempt = 0; attempt < 4; attempt += 1) {
    replayTranscriptRead({
      mode: 'append',
      previousByteOffset: 100,
      messages: userMessages('cut short', 5),
      outcome: { session: null, byteOffset: 100, incomplete: true, cancelled: true }
    })
  }

  expect(indexedMessages()).toBe(3)
  expect(cursor()).toBe(100)
  expect(owed()).toMatchObject({ state: 'current', fail_count: 0 })
})

it('records no row for a first read that was cancelled', async () => {
  replayTranscriptRead({
    messages: userMessages('cut short', 2),
    outcome: { session: null, byteOffset: 0, incomplete: true, cancelled: true }
  })

  expect(indexedMessages()).toBe(0)
  expect(owed()).toBeUndefined()
})

it('drops a file whose parser returned no session', async () => {
  replayTranscriptRead({
    messages: userMessages('was indexed', 3),
    outcome: { byteOffset: 100 }
  })

  replayTranscriptRead({
    messages: userMessages('now rejected', 2),
    outcome: { session: null, byteOffset: 300 }
  })

  expect(index.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({
    n: 0
  })
  expect(index.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({
    n: 0
  })
  expect(cursor()).toBe(300)
})

it('writes nothing for a source whose parser cannot reach the channel', async () => {
  const candidate = {
    ...syntheticCandidate({ path: '/opencode/opencode.db#session-1' }),
    agent: 'opencode' as const
  }
  replayTranscriptRead({
    candidate,
    messages: [],
    outcome: { byteOffset: 0, incomplete: true }
  })

  expect(index.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({
    n: 0
  })
  expect(owed()).toBeUndefined()
})

it('ignores a candidate older than the retention cutoff', async () => {
  store.setRetentionCutoffMs(Date.now())
  replayTranscriptRead({ messages: userMessages('too old', 3) })

  expect(index.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({
    n: 0
  })
  expect(owed()).toBeUndefined()
})

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

it('unregisters cleanly, leaving later reads unindexed', async () => {
  resetTranscriptConsumersForTests()
  replayTranscriptRead({ messages: userMessages('after unregister', 3) })

  expect(index.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({
    n: 0
  })
})

it('drops a removed source and keeps its cursor gone', async () => {
  replayTranscriptRead({
    messages: userMessages('present', 3),
    outcome: { byteOffset: 100 }
  })
  store.removeFile(SYNTHETIC_TRANSCRIPT)

  expect(cursor()).toBeUndefined()
  expect(index.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({
    n: 0
  })
  expect(index.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({
    n: 0
  })
})

it('writes the session metadata the read decoded', async () => {
  replayTranscriptRead({
    messages: userMessages('metadata', 1),
    outcome: {
      session: syntheticSession({
        sessionId: 'abc-123',
        title: 'a titled session',
        cwd: '/repo/app',
        branch: 'main',
        messageCount: 1,
        resumeCommand: 'claude --resume abc-123'
      }),
      byteOffset: 42
    }
  })

  expect(
    index.db
      .prepare('SELECT session_id, title, cwd, cwd_key, branch, resume_command FROM sessions')
      .get()
  ).toEqual({
    session_id: 'abc-123',
    title: 'a titled session',
    cwd: '/repo/app',
    cwd_key: '/repo/app',
    branch: 'main',
    resume_command: 'claude --resume abc-123'
  })
})

it('keeps a proven file identity when a later read cannot stat it', async () => {
  const withIdentity = syntheticCandidate({ dev: 1, ino: 10 })
  replayTranscriptRead({
    candidate: withIdentity,
    messages: userMessages('first', 2),
    outcome: { byteOffset: 100 }
  })

  replayTranscriptRead({
    candidate: syntheticCandidate(),
    mode: 'append',
    previousByteOffset: 100,
    messages: userMessages('second', 2),
    outcome: { byteOffset: 200 }
  })
  expect(indexedMessages()).toBe(4)

  replayTranscriptRead({
    candidate: syntheticCandidate({ dev: 1, ino: 99 }),
    mode: 'append',
    previousByteOffset: 200,
    messages: userMessages('replacement', 2),
    outcome: { byteOffset: 300 }
  })

  expect(indexedMessages()).toBe(4)
  expect(cursor()).toBe(200)
  expect(owed()?.state).not.toBe('current')
})
