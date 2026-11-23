import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  prepareDevCliTerminalWrappers,
  preparePackagedAgentTerminalWrapper
} from './dev-cli-terminal-wrapper.mjs'

const builderConfig = createRequire(import.meta.url)('../../../electron-builder.config.cjs')
const sourceWrapper = new URL('../../amplifier-agent-repl.mjs', import.meta.url)
const itUnix = process.platform === 'win32' ? it.skip : it

function checkFreshAndResume(binDir, root, envOverrides = {}) {
  const cwd = path.join(root, 'workspace')
  const agentHome = path.join(root, 'agent-home')
  mkdirSync(cwd, { recursive: true })
  const env = {
    ...process.env,
    PATH: '/usr/bin:/bin',
    NODE_OPTIONS: '--require=/nonexistent-loader',
    NODE_REPL_EXTERNAL_MODULE: '/nonexistent-repl',
    ELECTRON_RUN_AS_NODE: '1',
    ...envOverrides,
    AMPLIFIER_AGENT_HOME: agentHome,
    ORCA_AGENT_LAUNCH_TOKEN: 'desktop-delivery-proof'
  }
  const executable = path.join(binDir, 'amplifier-agent-repl')
  const fresh = spawnSync(executable, ['--session-id', 'fresh-delivery'], {
    cwd,
    env,
    input: '',
    encoding: 'utf8',
    timeout: 10_000
  })
  expect(fresh.status, fresh.stderr).toBe(0)
  const marker = /^\[amplifier-agent-repl\] bound (.+)$/m.exec(fresh.stderr)
  expect(JSON.parse(marker?.[1] ?? 'null')).toMatchObject({
    sessionId: 'fresh-delivery',
    workspace: 'workspace',
    launchToken: 'desktop-delivery-proof'
  })
  expect(readFileSync(path.join(cwd, '.amplifier-agent-session-id'), 'utf8')).toBe('fresh-delivery')
  mkdirSync(
    path.join(
      agentHome,
      'state',
      'workspaces',
      'original-workspace',
      'sessions',
      'history-delivery'
    ),
    { recursive: true }
  )
  const resumed = spawnSync(executable, ['--resume', 'history-delivery'], {
    cwd,
    env,
    input: '',
    encoding: 'utf8',
    timeout: 10_000
  })
  expect(resumed.status, resumed.stderr).toBe(0)
  const resumedMarker = /^\[amplifier-agent-repl\] bound (.+)$/m.exec(resumed.stderr)
  expect(JSON.parse(resumedMarker?.[1] ?? 'null')).toMatchObject({
    sessionId: 'history-delivery',
    workspace: 'original-workspace',
    launchToken: 'desktop-delivery-proof'
  })
}

describe('Amplifier Agent wrapper delivery', () => {
  itUnix('delivers fresh launches and history resumes from both dev bins', () => {
    const root = mkdtempSync(path.join(tmpdir(), "orca-agent-delivery-'$%-"))
    try {
      const scriptsDir = path.join(root, 'config', 'scripts')
      mkdirSync(scriptsDir, { recursive: true })
      copyFileSync(sourceWrapper, path.join(scriptsDir, 'amplifier-agent-repl.mjs'))
      const { binDir, userDataBinDir } = prepareDevCliTerminalWrappers({
        repoRoot: root,
        userDataPath: path.join(root, 'profile'),
        electronExecutable: process.execPath,
        platform: process.platform
      })
      checkFreshAndResume(binDir, root)
      checkFreshAndResume(userDataBinDir, root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  itUnix.each([
    {
      platform: 'darwin',
      configKey: 'mac',
      executableName: 'Orca',
      resources: ['Contents', 'Resources'],
      executable: ['Contents', 'MacOS', 'Orca']
    },
    {
      platform: 'linux',
      configKey: 'linux',
      executableName: 'orca-ide',
      resources: ['resources'],
      executable: ['orca-ide']
    }
  ])('delivers a relocatable $platform packaged REPL without system Node', (fixture) => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-packaged-agent-'))
    try {
      const appDir = path.join(root, 'before move')
      const resourcesDir = path.join(appDir, ...fixture.resources)
      const mapping = builderConfig[fixture.configKey].extraResources.find(
        (entry) => entry.from === 'config/scripts/amplifier-agent-repl.mjs'
      )
      const scriptPath = path.join(resourcesDir, mapping.to)
      mkdirSync(path.dirname(scriptPath), { recursive: true })
      copyFileSync(sourceWrapper, scriptPath)
      const electronPath = path.join(appDir, ...fixture.executable)
      mkdirSync(path.dirname(electronPath), { recursive: true })
      symlinkSync(process.execPath, electronPath)
      preparePackagedAgentTerminalWrapper({
        resourcesDir,
        platform: fixture.platform,
        executableName: fixture.executableName
      })
      const movedDir = path.join(root, "after move '$%")
      renameSync(appDir, movedDir)
      checkFreshAndResume(path.join(movedDir, ...fixture.resources, 'bin'), root, {
        PATH: '/usr/bin:/bin',
        NODE_OPTIONS: '--require=/nonexistent-loader',
        NODE_REPL_EXTERNAL_MODULE: '/nonexistent-repl'
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
