import { expect, it } from 'vitest'
import { aiVaultSessionLogFilePath } from './ai-vault-session-log-resource'

it('resolves both Amplifier metadata layouts to the conversation rather than metadata', () => {
  expect(
    aiVaultSessionLogFilePath({
      agent: 'amplifier',
      filePath: '/home/user/.amplifier/projects/repo/sessions/s1/metadata.json'
    })
  ).toBe('/home/user/.amplifier/projects/repo/sessions/s1/transcript.jsonl')
  expect(
    aiVaultSessionLogFilePath({
      agent: 'amplifier-agent',
      filePath:
        '/home/user/.amplifier-agent/state/workspaces/repo/sessions/s2/context-intelligence/metadata.json'
    })
  ).toBe('/home/user/.amplifier-agent/state/workspaces/repo/sessions/s2/transcript.jsonl')
})

it('keeps Windows and WSL separators when resolving nested Amplifier Agent metadata', () => {
  expect(
    aiVaultSessionLogFilePath({
      agent: 'amplifier-agent',
      filePath: '\\\\wsl.localhost\\Ubuntu\\sessions\\s2\\context-intelligence\\metadata.json'
    })
  ).toBe('\\\\wsl.localhost\\Ubuntu\\sessions\\s2\\transcript.jsonl')
})

it('honors a real transcript override but refuses blank or synthetic override locators', () => {
  const session = { agent: 'amplifier', filePath: '/sessions/s1/metadata.json' } as const
  expect(aiVaultSessionLogFilePath({ ...session, logFilePath: ' /logs/session.jsonl ' })).toBe(
    '/logs/session.jsonl'
  )
  expect(aiVaultSessionLogFilePath({ ...session, logFilePath: '   ' })).toBeNull()
  expect(aiVaultSessionLogFilePath({ ...session, logFilePath: '/db.sqlite#s1' })).toBeNull()
})

it('does not reinterpret crash-recovery metadata or a shared database as a session log', () => {
  expect(
    aiVaultSessionLogFilePath({
      agent: 'amplifier-agent',
      filePath: '/sessions/s2/metadata.json'
    })
  ).toBeNull()
  expect(aiVaultSessionLogFilePath({ agent: 'opencode', filePath: '/db.sqlite#s1' })).toBeNull()
})
