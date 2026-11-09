import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import { ORCA_CLI_POSIX_PATH_RESTORE } from '../../shared/orca-cli-shell-path'

const shim = vi.hoisted(() => ({ ensureLinuxTerminalOrcaCliShimDir: vi.fn() }))
vi.mock('./linux-terminal-orca-cli-shim', () => shim)

import { prependOrcaCliDirToChildPath } from './orca-cli-child-path'

const USER_DATA = '/data/orca'
const SHIM_DIR = join(USER_DATA, 'linux-orca-cli-shim')
const itUnix = process.platform === 'win32' ? it.skip : it

beforeEach(() => {
  installFakeAppEnvironment()
  shim.ensureLinuxTerminalOrcaCliShimDir.mockReset()
  shim.ensureLinuxTerminalOrcaCliShimDir.mockReturnValue(SHIM_DIR)
})

afterEach(() => installFakeAppEnvironment())

describe('prependOrcaCliDirToChildPath', () => {
  itUnix('restores packaged agent PATH after Linux login-shell overrides', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-child-agent-path-'))
    try {
      const binDir = join(root, 'bin')
      mkdirSync(binDir)
      writeFileSync(join(binDir, 'amplifier-agent-repl'), '#!/bin/sh\nprintf delivered', {
        mode: 0o755
      })
      const env: Record<string, string> = { PATH: `/usr/bin:${binDir}` }
      prependOrcaCliDirToChildPath(env, {
        isPackaged: true,
        userDataPath: USER_DATA,
        resourcesPath: root,
        platform: 'linux'
      })
      expect(env.PATH).toBe(`${SHIM_DIR}:${binDir}:/usr/bin`)
      expect(env.ORCA_CLI_BIN_DIR).toBe(`${SHIM_DIR}:${binDir}`)
      const result = await runProcess({
        program: '/bin/bash',
        args: ['-c', `PATH=/usr/bin:/bin\n${ORCA_CLI_POSIX_PATH_RESTORE}\namplifier-agent-repl`],
        env: { ...process.env, ...env },
        timeoutMs: 10_000
      })
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout).toBe('delivered')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each(['linux', 'darwin'] as const)(
    'uses the %s execution host CLI and profile over inherited values',
    (platform) => {
      const launcher = join(USER_DATA, 'cli', 'bin', 'orca')
      installFakeAppEnvironment({ getCliLauncherPath: () => launcher })
      const env: Record<string, string> = {
        PATH: `/usr/bin:${join(USER_DATA, 'cli', 'bin')}::/bin`,
        ORCA_USER_DATA_PATH: '/parent/profile',
        ORCA_CLI_COMMAND: '/parent/orca',
        ORCA_CLI_BIN_DIR: '/parent/bin'
      }
      expect(
        prependOrcaCliDirToChildPath(env, {
          isPackaged: true,
          userDataPath: USER_DATA,
          resourcesPath: null,
          platform
        })
      ).toBe(launcher)
      expect(env.PATH).toBe(`${join(USER_DATA, 'cli', 'bin')}:/usr/bin:/bin`)
      expect(env.ORCA_USER_DATA_PATH).toBe(USER_DATA)
      expect(env.ORCA_CLI_COMMAND).toBe(launcher)
      expect(env.ORCA_CLI_BIN_DIR).toBe(join(USER_DATA, 'cli', 'bin'))
      expect(shim.ensureLinuxTerminalOrcaCliShimDir).not.toHaveBeenCalled()
    }
  )
  it('exports the owning packaged Linux launcher and profile together with PATH', () => {
    const env = {
      PATH: `/usr/bin:${SHIM_DIR}::/bin`,
      ORCA_CLI_COMMAND: '/other/orca',
      ORCA_USER_DATA_PATH: '/other/profile'
    }
    const launcher = prependOrcaCliDirToChildPath(env, {
      isPackaged: true,
      userDataPath: USER_DATA,
      platform: 'linux'
    })

    expect(launcher).toBe(join(SHIM_DIR, 'orca'))
    expect(env.ORCA_CLI_COMMAND).toBe(launcher)
    expect(env.ORCA_USER_DATA_PATH).toBe(USER_DATA)
    expect(env.PATH).toBe(`${SHIM_DIR}:/usr/bin:/bin`)
  })

  it('puts a Windows execution host CLI first on Path without a POSIX restore dir', () => {
    const binDir = join(USER_DATA, 'cli', 'bin')
    const launcher = join(binDir, 'orca.exe')
    installFakeAppEnvironment({ getCliLauncherPath: () => launcher })
    const env: Record<string, string> = {
      Path: `C:\\Windows;${binDir};;C:\\Tools`,
      ORCA_USER_DATA_PATH: 'C:\\parent\\profile',
      ORCA_CLI_COMMAND: 'C:\\parent\\orca.exe',
      ORCA_CLI_BIN_DIR: '/parent/bin'
    }
    expect(
      prependOrcaCliDirToChildPath(env, {
        isPackaged: true,
        userDataPath: USER_DATA,
        resourcesPath: null,
        platform: 'win32'
      })
    ).toBe(launcher)
    expect(env).toEqual({
      Path: `${binDir};C:\\Windows;C:\\Tools`,
      ORCA_USER_DATA_PATH: USER_DATA,
      ORCA_CLI_COMMAND: launcher
    })
  })

  it('writes no trailing delimiter when nothing was inherited', () => {
    const env: Record<string, string> = { PATH: '' }
    const inheritedPath = process.env.PATH
    delete process.env.PATH
    try {
      prependOrcaCliDirToChildPath(env, {
        isPackaged: false,
        userDataPath: USER_DATA,
        platform: 'linux'
      })
    } finally {
      if (inheritedPath !== undefined) {
        process.env.PATH = inheritedPath
      }
    }
    // Why: an empty trailing segment resolves as `.` in some shells.
    expect(env.PATH).toBe(join(USER_DATA, 'cli', 'bin'))
  })
})
