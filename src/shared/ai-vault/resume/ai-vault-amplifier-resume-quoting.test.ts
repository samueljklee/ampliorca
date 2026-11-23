import { describe, expect, it } from 'vitest'
import { buildAiVaultResumeCommand } from './ai-vault-resume-command'

describe('Amplifier history resume quoting', () => {
  it('uses interactive Amplifier resume with quoted identity and cwd', () => {
    expect(
      buildAiVaultResumeCommand({
        agent: 'amplifier',
        sessionId: "session'id",
        cwd: "/repo/Ada's $(work)",
        platform: 'linux'
      })
    ).toBe(`cd '/repo/Ada'"'"'s $(work)' && amplifier resume 'session'"'"'id'`)
  })

  it('retains PowerShell quoting for Amplifier Agent resumes', () => {
    expect(
      buildAiVaultResumeCommand({
        agent: 'amplifier-agent',
        sessionId: "session'id",
        cwd: "C:\\Ada's repo",
        platform: 'win32',
        shell: 'powershell'
      })
    ).toBe(
      "Set-Location -LiteralPath 'C:\\Ada''s repo'; amplifier-agent-repl --resume 'session''id'"
    )
  })

  it('retains the self-contained cmd wrapper for shell-less Windows resumes', () => {
    expect(
      buildAiVaultResumeCommand({
        agent: 'amplifier',
        sessionId: 'session-1',
        cwd: 'C:\\A&B repo',
        platform: 'win32'
      })
    ).toBe('cmd /d /s /c "cd /d ""C:\\A&B repo"" && amplifier resume ""session-1"""')
  })
})
