import { appendFile, mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { parseAmplifierSessionContent } from './session-scanner-amplifier-parser'
import { parseAmplifierAgentSessionContent } from './session-scanner-amplifier-agent-parser'
import { AI_VAULT_AGENT_SOURCES } from './session-scanner-agent-sources'
import { discoverFiles } from './session-scanner-discovery'
import {
  createSessionParseStats,
  parseAgentSessionFileCached,
  resetSessionParseCacheForTests
} from './session-scanner-parse-cache'
import {
  isolatedScanRoots,
  jsonLines,
  writeAmplifierScannerFixtures
} from './session-scanner-test-fixtures'
import { withFullFirstUserPromptCapture } from './session-scanner-first-user-prompt-capture'
import type { FileWithMtime, SessionFileCandidate } from './session-scanner-types'
import type { TranscriptMessage } from './session-transcript-consumers'

const AGENTS = ['amplifier', 'amplifier-agent'] as const
type AmplifierAgent = (typeof AGENTS)[number]
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

function sessionDir(roots: ReturnType<typeof isolatedScanRoots>, agent: AmplifierAgent): string {
  return agent === 'amplifier'
    ? join(roots.amplifierProjectsDir, 'project', 'sessions', 'amplifier-session')
    : join(roots.amplifierAgentStateDir, 'workspace', 'sessions', 'amplifier-agent-session')
}

function metadataPath(roots: ReturnType<typeof isolatedScanRoots>, agent: AmplifierAgent): string {
  const dir = sessionDir(roots, agent)
  return agent === 'amplifier'
    ? join(dir, 'metadata.json')
    : join(dir, 'context-intelligence', 'metadata.json')
}

async function discover(
  roots: ReturnType<typeof isolatedScanRoots>,
  agent: AmplifierAgent
): Promise<SessionFileCandidate> {
  const source = AI_VAULT_AGENT_SOURCES[agent]
  if (!source) {
    throw new Error(`Missing source for ${agent}`)
  }
  const issues: AiVaultScanIssue[] = []
  const discovery = await discoverFiles({
    ...source,
    extensions: [...source.extensions],
    agent,
    rootDir: source.rootDirs(roots, [])[0]!,
    limit: 100,
    issues
  })
  expect(issues).toEqual([])
  expect(discovery.files.map((file) => file.path)).toEqual([metadataPath(roots, agent)])
  return { agent, file: discovery.files[0]!, codexHome: null }
}

describe.each([
  { agent: 'amplifier', parse: parseAmplifierSessionContent },
  { agent: 'amplifier-agent', parse: parseAmplifierAgentSessionContent }
] as const)('$agent transcript content', ({ agent, parse }) => {
  function file(): FileWithMtime {
    return {
      path:
        agent === 'amplifier'
          ? join('/fixtures', 'session-id', 'metadata.json')
          : join('/fixtures', 'session-id', 'context-intelligence', 'metadata.json'),
      mtimeMs: Date.parse(CREATED_AT),
      modifiedAt: CREATED_AT
    }
  }

  it('keeps metadata identity and publishes full content through the upstream sink', () => {
    const answer = 'A detailed answer. '.repeat(40)
    const messages: TranscriptMessage[] = []
    const session = parse(
      file(),
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
      filePath: file().path,
      logFilePath: join('/fixtures', 'session-id', 'transcript.jsonl'),
      title: agent === 'amplifier' ? 'Generated title' : 'Explain the change',
      messageCount: 2,
      createdAt: CREATED_AT
    })
    expect(session?.previewMessages).toHaveLength(2)
    expect(session?.previewMessages[1]?.text.length).toBeLessThan(answer.length)
    expect(messages).toEqual([
      { role: 'user', text: 'Explain the change', timestamp: CREATED_AT },
      { role: 'assistant', text: answer, timestamp: null }
    ])
  })

  it('accepts metadata-only sessions and rejects malformed metadata', () => {
    const session = parse(file(), '{}', null, 'darwin')
    expect(session).toMatchObject({ sessionId: 'session-id', messageCount: 0, previewMessages: [] })
    expect(session?.logFilePath).toBeUndefined()
    expect(parse(file(), '{', null, 'darwin')).toBeNull()
  })
})

it('never counts, captures or publishes Amplifier Agent ephemeral reminders as user prompts', async () => {
  const messages: TranscriptMessage[] = []
  const session = await withFullFirstUserPromptCapture(async () =>
    parseAmplifierAgentSessionContent(
      {
        path: join('/fixtures', 's1', 'context-intelligence', 'metadata.json'),
        mtimeMs: 0,
        modifiedAt: CREATED_AT
      },
      JSON.stringify({ session_id: 's1', started_at: CREATED_AT }),
      jsonLines([
        { role: 'user', content: 'Injected reminder', metadata: { ephemeral: true } },
        { role: 'user', content: 'The actual question' },
        { role: 'assistant', content: 'The answer' }
      ]),
      'darwin',
      { active: true, push: (message) => messages.push(message) }
    )
  )
  expect(session).toMatchObject({
    title: 'The actual question',
    firstUserPrompt: 'The actual question',
    messageCount: 2
  })
  expect(session?.previewMessages.map((message) => message.text)).toEqual([
    'The actual question',
    'The answer'
  ])
  expect(messages.map((message) => message.text)).toEqual(['The actual question', 'The answer'])
})

describe.each(AGENTS)('%s discovery and cache', (agent) => {
  it('discovers only the correct metadata anchor and excludes delegate sessions', async () => {
    const roots = await makeRoots()
    await writeAmplifierScannerFixtures(roots)
    const parentDir = sessionDir(roots, agent)
    const delegateDir = join(dirname(parentDir), '0000000000000000-delegate')
    const nestedPath = join(parentDir, 'context-intelligence', 'metadata.json')
    const delegatePath =
      agent === 'amplifier'
        ? join(delegateDir, 'metadata.json')
        : join(delegateDir, 'context-intelligence', 'metadata.json')
    await mkdir(dirname(delegatePath), { recursive: true })
    await writeFile(delegatePath, JSON.stringify({ session_id: 'delegate' }))
    if (agent === 'amplifier') {
      await mkdir(dirname(nestedPath), { recursive: true })
      await writeFile(nestedPath, JSON.stringify({ session_id: 'duplicate' }))
    }
    const candidate = await discover(roots, agent)
    expect(await parseAgentSessionFileCached(candidate, 'darwin')).toMatchObject({
      agent,
      messageCount: 1,
      filePath: metadataPath(roots, agent),
      logFilePath: join(parentDir, 'transcript.jsonl')
    })
  })

  it('reuses unchanged metadata but reparses transcript-only appends even with the same mtime', async () => {
    const roots = await makeRoots()
    await writeAmplifierScannerFixtures(roots)
    const candidate = await discover(roots, agent)
    const stats = createSessionParseStats()
    const first = await parseAgentSessionFileCached(candidate, 'darwin', stats)
    expect(first?.messageCount).toBe(1)
    expect(await parseAgentSessionFileCached(await discover(roots, agent), 'darwin', stats)).toBe(
      first
    )
    const transcriptPath = join(sessionDir(roots, agent), 'transcript.jsonl')
    const previous = await stat(transcriptPath)
    await appendFile(
      transcriptPath,
      `${JSON.stringify({ role: 'assistant', content: 'Appended answer' })}\n`
    )
    await utimes(transcriptPath, previous.atime, previous.mtime)
    const grown = await discover(roots, agent)
    expect(grown.file.mtimeMs).toBe(candidate.file.mtimeMs)
    expect(grown.file.sizeBytes).toBe(candidate.file.sizeBytes)
    const refreshed = await parseAgentSessionFileCached(grown, 'darwin', stats)
    expect(refreshed).toMatchObject({
      messageCount: 2,
      filePath: candidate.file.path,
      logFilePath: transcriptPath
    })
    expect(refreshed?.previewMessages.at(-1)?.text).toBe('Appended answer')
    expect(stats).toMatchObject({ reused: 1, fullParses: 2, incremental: 0 })
  })

  it('refreshes a metadata-only cache row when its transcript appears or disappears', async () => {
    const roots = await makeRoots()
    await writeAmplifierScannerFixtures(roots)
    const transcriptPath = join(sessionDir(roots, agent), 'transcript.jsonl')
    await rm(transcriptPath)
    const empty = await parseAgentSessionFileCached(await discover(roots, agent), 'darwin')
    expect(empty).toMatchObject({ messageCount: 0, previewMessages: [] })
    expect(empty?.logFilePath).toBeUndefined()
    await writeFile(transcriptPath, `${JSON.stringify({ role: 'user', content: 'First turn' })}\n`)
    const started = await parseAgentSessionFileCached(await discover(roots, agent), 'darwin')
    expect(started).toMatchObject({ messageCount: 1, logFilePath: transcriptPath })
    await rm(transcriptPath)
    const missing = await parseAgentSessionFileCached(await discover(roots, agent), 'darwin')
    expect(missing).toEqual(empty)
  })
})
