import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
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

const builderConfig = createRequire(import.meta.url)('../electron-builder.config.cjs')
const sourceWrapper = new URL('./amplifier-agent-repl.mjs', import.meta.url)
const itUnix = process.platform === 'win32' ? it.skip : it

function checkFreshAndResume(binDir, root, envOverrides = {}) {
  const cwd = path.join(root, 'workspace')
  const agentHome = path.join(root, 'agent-home')
  mkdirSync(cwd, { recursive: true })
  const env = { ...process.env, ...envOverrides, AMPLIFIER_AGENT_HOME: agentHome }
  const executable = path.join(binDir, 'amplifier-agent-repl')
  expect(statSync(executable).mode & 0o111).not.toBe(0)
  const fresh = execFileSync(executable, ['--session-id', 'fresh-delivery'], {
    cwd,
    env,
    input: '',
    encoding: 'utf8',
    timeout: 10_000
  })
  expect(fresh).toContain('session fresh-delivery')
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
  const resumed = execFileSync(executable, ['--resume', 'history-delivery'], {
    cwd,
    env,
    input: '',
    encoding: 'utf8',
    timeout: 10_000
  })
  expect(resumed).toContain('session history-delivery (workspace: original-workspace)')
}

describe('dev CLI terminal wrappers', () => {
  itUnix('delivers the real REPL for fresh launches and history resumes in both dev bins', () => {
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
      let appDir = path.join(root, 'before move')
      const resourcesDir = path.join(appDir, ...fixture.resources)
      const mapping = builderConfig[fixture.configKey].extraResources.find(
        (entry) => entry.from === 'config/scripts/amplifier-agent-repl.mjs'
      )
      expect(mapping).toBeDefined()
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
      appDir = movedDir
      checkFreshAndResume(path.join(appDir, ...fixture.resources, 'bin'), root, {
        PATH: '/usr/bin:/bin',
        NODE_OPTIONS: '--require=/nonexistent-loader',
        NODE_REPL_EXTERNAL_MODULE: '/nonexistent-repl'
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('delivers the Windows packaged script and cmd shim through the same resource mapping', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-packaged-agent-win-'))
    try {
      const mapping = builderConfig.win.extraResources.find(
        (entry) => entry.from === 'config/scripts/amplifier-agent-repl.mjs'
      )
      const scriptPath = path.join(root, mapping.to)
      mkdirSync(path.dirname(scriptPath), { recursive: true })
      copyFileSync(sourceWrapper, scriptPath)
      preparePackagedAgentTerminalWrapper({
        resourcesDir: root,
        platform: 'win32',
        executableName: 'Orca'
      })
      expect(readFileSync(scriptPath)).toEqual(readFileSync(sourceWrapper))
      const shim = readFileSync(path.join(root, 'bin', 'amplifier-agent-repl.cmd'), 'utf8')
      expect(shim).toContain('"%~dp0..\\..\\Orca.exe"')
      expect(shim).toContain('"%~dp0..\\agent-wrappers\\amplifier-agent-repl.mjs" %*')
      expect(shim).toContain('set "ELECTRON_RUN_AS_NODE=1"')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('writes profile-scoped Windows wrappers for worker terminals', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-dev-terminal-wrapper-'))
    const userDataPath = path.join(root, 'profile')
    prepareDevCliTerminalWrappers({
      repoRoot: root,
      userDataPath,
      electronExecutable: path.join(root, 'electron.exe'),
      platform: 'win32'
    })

    const wrapper = readFileSync(path.join(userDataPath, 'cli', 'bin', 'orca-dev.cmd'), 'utf8')
    expect(wrapper).toContain(`set "ORCA_USER_DATA_PATH=${userDataPath}"`)
    expect(wrapper).toContain('set "ORCA_DEV_CLI_INVOCATION=1"')
    expect(wrapper).toContain(`node "${path.join(root, 'out', 'cli', 'index.js')}" %*`)
    expect(readFileSync(path.join(userDataPath, 'cli', 'bin', 'orca.cmd'), 'utf8')).toBe(wrapper)
    expect(readFileSync(path.join(root, 'out', 'bin', 'orca-dev.cmd'), 'utf8')).toBe(wrapper)
    expect(readFileSync(path.join(root, 'out', 'bin', 'orca.cmd'), 'utf8')).toBe(wrapper)
    const agentWrapper = readFileSync(
      path.join(userDataPath, 'cli', 'bin', 'amplifier-agent-repl.cmd'),
      'utf8'
    )
    expect(agentWrapper).toContain(
      `node "${path.join(root, 'config', 'scripts', 'amplifier-agent-repl.mjs').replaceAll('%', '%%')}" %*`
    )
  })

  it('escapes literal percent signs in every Windows batch path', () => {
    const root = path.join(mkdtempSync(path.join(tmpdir(), 'orca-dev-terminal-wrapper-')), '%repo%')
    const userDataPath = path.join(root, '%profile%')
    const electronExecutable = path.join(root, '%electron%', 'electron.exe')
    prepareDevCliTerminalWrappers({
      repoRoot: root,
      userDataPath,
      electronExecutable,
      platform: 'win32'
    })

    const wrapper = readFileSync(path.join(userDataPath, 'cli', 'bin', 'orca-dev.cmd'), 'utf8')
    expect(wrapper).toContain(`set "ORCA_USER_DATA_PATH=${userDataPath.replaceAll('%', '%%')}"`)
    expect(wrapper).toContain(
      `set "ORCA_APP_EXECUTABLE=${electronExecutable.replaceAll('%', '%%')}"`
    )
    expect(wrapper).toContain(
      `node "${path.join(root, 'out', 'cli', 'index.js').replaceAll('%', '%%')}" %*`
    )
    expect(readFileSync(path.join(root, 'out', 'bin', 'orca-dev.cmd'), 'utf8')).toBe(wrapper)
    expect(readFileSync(path.join(root, 'out', 'bin', 'orca.cmd'), 'utf8')).toBe(wrapper)
  })

  it('writes executable-style POSIX wrappers with the same profile identity', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-dev-terminal-wrapper-'))
    const userDataPath = path.join(root, 'profile')
    prepareDevCliTerminalWrappers({
      repoRoot: root,
      userDataPath,
      electronExecutable: path.join(root, 'electron'),
      platform: 'linux'
    })

    const wrapper = readFileSync(path.join(userDataPath, 'cli', 'bin', 'orca-dev'), 'utf8')
    expect(wrapper).toContain(`export ORCA_USER_DATA_PATH=${JSON.stringify(userDataPath)}`)
    expect(wrapper).toContain('export ORCA_DEV_CLI_INVOCATION=1')
    expect(wrapper).toContain(
      `exec node ${JSON.stringify(path.join(root, 'out', 'cli', 'index.js'))}`
    )
    expect(readFileSync(path.join(userDataPath, 'cli', 'bin', 'orca'), 'utf8')).toBe(wrapper)
    expect(readFileSync(path.join(root, 'out', 'bin', 'orca-dev'), 'utf8')).toBe(wrapper)
    expect(readFileSync(path.join(root, 'out', 'bin', 'orca'), 'utf8')).toBe(wrapper)
  })
})
