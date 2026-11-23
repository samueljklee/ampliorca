import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import { ORCA_CLI_POSIX_PATH_RESTORE } from '../../../shared/shell/launch/orca-cli-shell-path'
import { prependOrcaCliDirToChildPath } from './orca-cli-child-path'

const shim = vi.hoisted(() => ({ ensureLinuxTerminalOrcaCliShimDir: vi.fn() }))
vi.mock('./linux-terminal-orca-cli-shim', () => shim)

beforeEach(() => {
  installFakeAppEnvironment()
  shim.ensureLinuxTerminalOrcaCliShimDir.mockReset()
})

afterEach(() => installFakeAppEnvironment())

it.skipIf(process.platform === 'win32')(
  'restores packaged agent PATH after Linux login-shell overrides',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-child-agent-path-'))
    try {
      const binDir = join(root, 'bin')
      const shimDir = join(root, 'linux-orca-cli-shim')
      shim.ensureLinuxTerminalOrcaCliShimDir.mockReturnValue(shimDir)
      mkdirSync(binDir)
      writeFileSync(join(binDir, 'amplifier-agent-repl'), '#!/bin/sh\nprintf delivered', {
        mode: 0o755
      })
      const env: Record<string, string> = { PATH: `/usr/bin:${binDir}::/bin` }
      prependOrcaCliDirToChildPath(env, {
        isPackaged: true,
        userDataPath: root,
        resourcesPath: root,
        platform: 'linux'
      })
      expect(env.PATH).toBe(`${shimDir}:${binDir}:/usr/bin:/bin`)
      expect(env.ORCA_CLI_BIN_DIR).toBe(`${shimDir}:${binDir}`)
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
  }
)

it('preserves the Windows host Path key and removes cwd search segments', () => {
  const binDir = join('/data/orca', 'cli', 'bin')
  const launcher = join(binDir, 'orca.exe')
  installFakeAppEnvironment({ getCliLauncherPath: () => launcher })
  const env: Record<string, string> = {
    Path: `C:\\Windows;${binDir};;C:\\Tools`,
    ORCA_CLI_BIN_DIR: '/parent/bin'
  }
  prependOrcaCliDirToChildPath(env, {
    isPackaged: true,
    userDataPath: '/data/orca',
    platform: 'win32'
  })
  expect(env).toEqual({
    Path: `${binDir};C:\\Windows;C:\\Tools`,
    ORCA_USER_DATA_PATH: '/data/orca',
    ORCA_CLI_COMMAND: launcher
  })
})

it('uses semicolons and the inherited Path spelling for Windows desktop bins', () => {
  const env: Record<string, string> = { Path: 'C:\\Windows;C:\\Tools' }
  prependOrcaCliDirToChildPath(env, {
    isPackaged: true,
    userDataPath: '/data/orca',
    resourcesPath: '/app/resources',
    platform: 'win32'
  })
  expect(env).toEqual({
    Path: `${join('/app/resources', 'bin')};C:\\Windows;C:\\Tools`
  })
})
