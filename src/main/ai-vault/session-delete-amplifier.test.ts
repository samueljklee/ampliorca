import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateAiVaultSessionDeleteTarget } from './session-delete-target'

const ROOT = join('/tmp', 'orca-amplifier-delete-fixture')

describe('Amplifier session deletion', () => {
  it('removes the complete session directory rather than stranding transcripts beside metadata', () => {
    const sessionDir = join(ROOT, 'project', 'sessions', 'session-1')
    const filePath = join(sessionDir, 'metadata.json')
    expect(
      validateAiVaultSessionDeleteTarget({
        agent: 'amplifier',
        filePath,
        executionHostId: 'local',
        rootOptions: { amplifierProjectsDir: ROOT }
      })
    ).toEqual({
      allowed: true,
      agent: 'amplifier',
      resolvedPath: filePath,
      removals: [{ path: sessionDir, kind: 'directory', roots: [ROOT] }]
    })
  })

  it.each([
    ['project', 'sessions', '0000000000000000-delegate', 'metadata.json'],
    ['project', 'sessions', 'session-1', 'context-intelligence', 'metadata.json'],
    ['project', 'sessions', 'session-1', 'transcript.jsonl']
  ])('rejects undiscoverable deletion targets: %j', (...segments) => {
    expect(
      validateAiVaultSessionDeleteTarget({
        agent: 'amplifier',
        filePath: join(ROOT, ...segments),
        executionHostId: 'local',
        rootOptions: { amplifierProjectsDir: ROOT }
      })
    ).toEqual({ allowed: false, agent: 'amplifier', reason: 'undiscoverable-path' })
  })

  it('does not generically enable deletion for Amplifier Agent nested metadata', () => {
    expect(
      validateAiVaultSessionDeleteTarget({
        agent: 'amplifier-agent',
        filePath: join(
          ROOT,
          'workspace',
          'sessions',
          's1',
          'context-intelligence',
          'metadata.json'
        ),
        executionHostId: 'local',
        rootOptions: { amplifierAgentStateDir: ROOT }
      })
    ).toEqual({ allowed: false, agent: 'amplifier-agent', reason: 'unsupported-agent' })
  })
})
