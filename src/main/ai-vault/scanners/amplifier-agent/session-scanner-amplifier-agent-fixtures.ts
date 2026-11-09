import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonlFile } from '../../session-scanner-test-fixtures'

export async function writeAmplifierAgentScannerFixture(stateDir: string): Promise<void> {
  const agentDir = join(stateDir, 'workspace', 'sessions', 'amplifier-agent-session')
  await mkdir(join(agentDir, 'context-intelligence'), { recursive: true })
  await writeFile(join(agentDir, 'metadata.json'), JSON.stringify({ last_turn: 'complete' }))
  await writeFile(
    join(agentDir, 'context-intelligence', 'metadata.json'),
    JSON.stringify({
      session_id: 'amplifier-agent-session',
      working_dir: '/tmp/amplifier-agent',
      started_at: '2026-05-01T10:14:00.000Z'
    })
  )
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
