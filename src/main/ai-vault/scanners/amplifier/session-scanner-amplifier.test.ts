import { appendFile, mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseAmplifierSessionContent } from './session-scanner-amplifier-parser'
import { parseAmplifierAgentSessionContent } from '../amplifier-agent/session-scanner-amplifier-agent-parser'
import { resetSessionParseCacheForTests } from '../../parse-cache/session-parse-cache-store'
import { scanAiVaultSessions } from '../../session-scanner'
import {
  isolatedScanRoots,
  jsonLines,
  writeAmplifierScannerFixtures
} from '../../session-scanner-test-fixtures'
import type { FileWithMtime } from '../../session-scanner-types'
import type { TranscriptMessage } from '../../transcripts/session-transcript-consumers'

const CREATED_AT = '2026-05-01T10:00:00.000Z'
let tempRoots: string[] = []

beforeEach(() => resetSessionParseCacheForTests())

afterEach(async () => {
  resetSessionParseCacheForTests()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function makeRoots() {
  const root = await mkdtemp(join(tmpdir(), 'orca-amplifier-history-'))
  tempRoots.push(root)
  return isolatedScanRoots(root)
}

describe.each([
  { agent: 'amplifier', parse: parseAmplifierSessionContent },
  { agent: 'amplifier-agent', parse: parseAmplifierAgentSessionContent }
] as const)('$agent transcript content', ({ agent, parse }) => {
  const file: FileWithMtime = {
    path:
      agent === 'amplifier'
        ? join('/fixtures', 'session-id', 'metadata.json')
        : join('/fixtures', 'session-id', 'context-intelligence', 'metadata.json'),
    mtimeMs: Date.parse(CREATED_AT),
    modifiedAt: CREATED_AT
  }

  it('keeps metadata identity and publishes full content through the upstream sink', () => {
    const answer = 'A detailed answer. '.repeat(40)
    const messages: TranscriptMessage[] = []
    const session = parse(
      file,
      JSON.stringify({
        session_id: 'session-id',
        working_dir: '/repo/app',
        created: CREATED_AT,
        started_at: CREATED_AT,
        name: 'Generated title'
      }),
      `${jsonLines([
        { role: 'system', content: 'Not a conversation turn' },
        {
          role: 'user',
          content: 'Explain the change',
          timestamp: CREATED_AT,
          metadata: { timestamp: CREATED_AT }
        },
        { role: 'assistant', content: [{ type: 'text', text: answer }] }
      ])}\n{"role":`,
      'darwin',
      { active: true, push: (message) => messages.push(message) }
    )
    expect(session).toMatchObject({
      agent,
      sessionId: 'session-id',
      cwd: '/repo/app',
      filePath: file.path,
      logFilePath: join('/fixtures', 'session-id', 'transcript.jsonl'),
      title: agent === 'amplifier' ? 'Generated title' : 'Explain the change',
      messageCount: 2,
      createdAt: CREATED_AT
    })
    expect(session?.previewMessages[1]?.text.length).toBeLessThan(answer.length)
    expect(messages).toEqual([
      { role: 'user', text: 'Explain the change', timestamp: CREATED_AT },
      { role: 'assistant', text: answer, timestamp: null }
    ])
  })

  it('accepts metadata-only sessions and rejects malformed metadata', () => {
    expect(parse(file, '{}', null, 'darwin')).toMatchObject({
      sessionId: 'session-id',
      messageCount: 0,
      previewMessages: []
    })
    expect(parse(file, '{', null, 'darwin')).toBeNull()
  })
})

describe.each(['amplifier', 'amplifier-agent'] as const)('%s discovery and cache', (agent) => {
  async function fixture() {
    const roots = await makeRoots()
    await writeAmplifierScannerFixtures(roots)
    const sessionDir =
      agent === 'amplifier'
        ? join(roots.amplifierProjectsDir, 'project', 'sessions', 'amplifier-session')
        : join(roots.amplifierAgentStateDir, 'workspace', 'sessions', 'amplifier-agent-session')
    const metadataPath =
      agent === 'amplifier'
        ? join(sessionDir, 'metadata.json')
        : join(sessionDir, 'context-intelligence', 'metadata.json')
    return { roots, sessionDir, metadataPath, transcriptPath: join(sessionDir, 'transcript.jsonl') }
  }

  it('refreshes transcript appends without surfacing delegates or duplicate metadata', async () => {
    const { roots, sessionDir, metadataPath, transcriptPath } = await fixture()
    const delegateDir = join(dirname(sessionDir), '0000000000000000-delegate')
    const delegatePath =
      agent === 'amplifier'
        ? join(delegateDir, 'metadata.json')
        : join(delegateDir, 'context-intelligence', 'metadata.json')
    await mkdir(dirname(delegatePath), { recursive: true })
    await writeFile(delegatePath, JSON.stringify({ session_id: 'delegate' }))
    if (agent === 'amplifier') {
      const nestedPath = join(sessionDir, 'context-intelligence', 'metadata.json')
      await mkdir(dirname(nestedPath), { recursive: true })
      await writeFile(nestedPath, JSON.stringify({ session_id: 'duplicate' }))
    }
    const first = await scanAiVaultSessions({ ...roots, platform: 'darwin' })
    expect(first.issues).toEqual([])
    expect(first.sessions.filter((session) => session.agent === agent)).toMatchObject([
      { filePath: metadataPath, logFilePath: transcriptPath, messageCount: 1 }
    ])

    const previous = await stat(transcriptPath)
    await appendFile(
      transcriptPath,
      `${JSON.stringify({ role: 'assistant', content: 'Appended answer' })}\n`
    )
    await utimes(transcriptPath, previous.atime, previous.mtime)
    const refreshed = await scanAiVaultSessions({ ...roots, platform: 'darwin' })
    expect(refreshed.sessions.filter((session) => session.agent === agent)).toMatchObject([
      { filePath: metadataPath, logFilePath: transcriptPath, messageCount: 2 }
    ])
    expect(
      refreshed.sessions.find((session) => session.agent === agent)?.previewMessages.at(-1)?.text
    ).toBe('Appended answer')
  })

  it('refreshes a metadata-only cache row when its transcript appears or disappears', async () => {
    const { roots, transcriptPath } = await fixture()
    const scan = async () =>
      (await scanAiVaultSessions({ ...roots, platform: 'darwin' })).sessions.find(
        (session) => session.agent === agent
      )
    await rm(transcriptPath)
    expect(await scan()).toMatchObject({ messageCount: 0, previewMessages: [] })
    await writeFile(transcriptPath, `${JSON.stringify({ role: 'user', content: 'First turn' })}\n`)
    expect(await scan()).toMatchObject({
      messageCount: 1,
      logFilePath: transcriptPath,
      previewMessages: [{ role: 'user', text: 'First turn' }]
    })
    await rm(transcriptPath)
    expect(await scan()).toMatchObject({ messageCount: 0, previewMessages: [] })
  })
})
