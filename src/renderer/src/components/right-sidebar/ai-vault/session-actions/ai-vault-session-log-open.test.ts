import { afterEach, expect, it, vi } from 'vitest'

const { getStateMock } = vi.hoisted(() => ({ getStateMock: vi.fn() }))

vi.mock('@/store/index', () => ({ useAppStore: { getState: getStateMock } }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))

import { openAiVaultSessionLogInOrca } from './ai-vault-session-log-open'
import { canOpenAiVaultSessionLogInOrca } from './ai-vault-session-path-actions'

afterEach(() => {
  vi.clearAllMocks()
})

it('opens an explicit transcript read-only on the client without granting remote path authority', async () => {
  const openFile = vi.fn()
  getStateMock.mockReturnValue({
    activeWorktreeId: 'wt-1',
    activeGroupIdByWorktree: { 'wt-1': 'group-1' },
    openFiles: [],
    worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] },
    folderWorkspaces: [],
    openFile
  })
  const session = {
    agent: 'amplifier',
    filePath: '/sessions/s1/metadata.json',
    logFilePath: '/logs/transcript.jsonl',
    executionHostId: 'local'
  } as const

  expect(canOpenAiVaultSessionLogInOrca(session)).toBe(true)
  await openAiVaultSessionLogInOrca(session)
  expect(openFile).toHaveBeenCalledWith(
    {
      filePath: '/logs/transcript.jsonl',
      relativePath: '/logs/transcript.jsonl',
      worktreeId: 'wt-1',
      runtimeEnvironmentId: null,
      language: 'jsonl',
      mode: 'edit',
      readOnly: true,
      liveTail: true
    },
    {
      preview: false,
      forceContentReload: true,
      suppressActiveRuntimeFallback: true,
      targetGroupId: 'group-1'
    }
  )

  openFile.mockClear()
  const remote = { ...session, executionHostId: 'ssh:dev-box' } as const
  expect(canOpenAiVaultSessionLogInOrca(remote)).toBe(false)
  await openAiVaultSessionLogInOrca(remote)
  await openAiVaultSessionLogInOrca({ ...session, logFilePath: '/db.sqlite#s1' })
  expect(openFile).not.toHaveBeenCalled()
})
