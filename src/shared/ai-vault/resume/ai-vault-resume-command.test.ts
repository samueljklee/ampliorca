import { describe, expect, it } from 'vitest'

import {
  buildAiVaultResumeCommand,
  buildAiVaultResumeShellCommand
} from './ai-vault-resume-command'

describe('Amplifier history resumes', () => {
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

  it('uses the persistent Amplifier Agent wrapper rather than the raw engine', () => {
    expect(
      buildAiVaultResumeCommand({
        agent: 'amplifier-agent',
        sessionId: 'session-1',
        cwd: '/repo/app',
        platform: 'linux'
      })
    ).toBe("cd '/repo/app' && amplifier-agent-repl --resume 'session-1'")
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

  it('preserves user command overrides for Amplifier Agent', () => {
    expect(
      buildAiVaultResumeCommand({
        agent: 'amplifier-agent',
        sessionId: 'session-1',
        cwd: null,
        commandOverride: 'custom-repl --profile work',
        platform: 'darwin'
      })
    ).toBe("custom-repl --profile work --resume 'session-1'")
  })
})

describe('buildAiVaultResumeShellCommand env removal', () => {
  const base = {
    resumeCommand: "codex 'resume' 'sid'",
    cwd: '/repo',
    clearEnvNames: ['CODEX_HOME', 'ORCA_CODEX_HOME']
  }

  // Filter assigned variables from env -u or the pinned home silently becomes real-home resume.
  it('keeps a pinned CODEX_HOME authoritative instead of stripping it', () => {
    const command = buildAiVaultResumeShellCommand({
      ...base,
      platform: 'darwin',
      codexHome: '/home/a/.codex-work'
    })

    expect(command).toBe(
      "cd '/repo' && CODEX_HOME='/home/a/.codex-work' env -u ORCA_CODEX_HOME codex 'resume' 'sid'"
    )
    expect(command).not.toContain('-u CODEX_HOME')
  })

  it('keeps a pinned CODEX_HOME authoritative under a git-bash shell too', () => {
    expect(
      buildAiVaultResumeShellCommand({
        ...base,
        platform: 'win32',
        shell: 'posix',
        codexHome: '/c/users/a/.codex-work'
      })
    ).toBe(
      "cd '/repo' && CODEX_HOME='/c/users/a/.codex-work' env -u ORCA_CODEX_HOME codex 'resume' 'sid'"
    )
  })

  // Shell grammar wins over host platform; platform routing emitted POSIX env -u into PowerShell.
  it('uses PowerShell grammar for a PowerShell shell on a non-Windows host', () => {
    const command = buildAiVaultResumeShellCommand({
      ...base,
      platform: 'linux',
      shell: 'powershell'
    })

    expect(command).not.toContain('env -u')
    expect(command).toBe(
      'Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue; ' +
        'Remove-Item Env:ORCA_CODEX_HOME -ErrorAction SilentlyContinue; ' +
        "Set-Location -LiteralPath '/repo'; codex 'resume' 'sid'"
    )
  })

  it('keeps the cmd clear ahead of the cd so a failed cd cannot launch the agent', () => {
    expect(
      buildAiVaultResumeShellCommand({
        ...base,
        cwd: 'C:\\repo',
        platform: 'win32',
        shell: 'cmd'
      })
    ).toBe(
      'set "CODEX_HOME=" & set "ORCA_CODEX_HOME=" & cd /d "C:\\repo" && codex \'resume\' \'sid\''
    )
  })
})
