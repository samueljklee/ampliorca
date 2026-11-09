import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonlFile, type isolatedScanRoots } from '../../session-scanner-test-fixtures'
import { writeAmplifierAgentScannerFixture } from '../amplifier-agent/session-scanner-amplifier-agent-fixtures'

export async function writeAmplifierScannerFixtures(
  roots: ReturnType<typeof isolatedScanRoots>
): Promise<void> {
  const amplifierDir = join(roots.amplifierProjectsDir, 'project', 'sessions', 'amplifier-session')
  await mkdir(amplifierDir, { recursive: true })
  await writeFile(
    join(amplifierDir, 'metadata.json'),
    JSON.stringify({
      session_id: 'amplifier-session',
      working_dir: '/tmp/amplifier',
      created: '2026-05-01T10:13:00.000Z',
      name: 'Amplifier title'
    })
  )
  await writeJsonlFile(join(amplifierDir, 'transcript.jsonl'), [
    { role: 'user', content: 'Amplifier prompt', timestamp: '2026-05-01T10:13:01.000Z' }
  ])
  await writeAmplifierAgentScannerFixture(roots.amplifierAgentStateDir)
}
