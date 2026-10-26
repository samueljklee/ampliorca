import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonlFile, type isolatedScanRoots } from './session-scanner-test-fixtures'

export async function writeAmplifierScannerFixtures(
  roots: ReturnType<typeof isolatedScanRoots>
): Promise<void> {
  const amplifierDir = join(roots.amplifierProjectsDir, 'project', 'sessions', 'amplifier-session')
  const agentDir = join(
    roots.amplifierAgentStateDir,
    'workspace',
    'sessions',
    'amplifier-agent-session'
  )
  await mkdir(amplifierDir, { recursive: true })
  await mkdir(join(agentDir, 'context-intelligence'), { recursive: true })
  await writeFile(
    join(amplifierDir, 'metadata.json'),
    JSON.stringify({
      session_id: 'amplifier-session',
      working_dir: '/tmp/amplifier',
      created: '2026-05-01T10:13:00.000Z',
      name: 'Amplifier title'
    })
  )
  await writeFile(join(agentDir, 'metadata.json'), JSON.stringify({ last_turn: 'complete' }))
  await writeFile(
    join(agentDir, 'context-intelligence', 'metadata.json'),
    JSON.stringify({
      session_id: 'amplifier-agent-session',
      working_dir: '/tmp/amplifier-agent',
      started_at: '2026-05-01T10:14:00.000Z'
    })
  )
  await writeJsonlFile(join(amplifierDir, 'transcript.jsonl'), [
    { role: 'user', content: 'Amplifier prompt', timestamp: '2026-05-01T10:13:01.000Z' }
  ])
  await writeJsonlFile(join(agentDir, 'transcript.jsonl'), [
    {
      role: 'user',
      content: '<system-reminder>injected</system-reminder>',
      metadata: { ephemeral: true }
    },
    {
      role: 'user',
      content: 'Amplifier Agent prompt',
      metadata: { timestamp: '2026-05-01T10:14:01.000Z' }
    }
  ])
}
