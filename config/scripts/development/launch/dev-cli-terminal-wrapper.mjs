import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

function escapeWindowsBatchValue(value) {
  // Why: cmd.exe expands %NAME% even inside quotes, so literal path percent signs must be doubled.
  return value.replaceAll('%', '%%')
}

function writeAgentTerminalWrapper(targetDir, content, platform) {
  const wrapperPath = path.join(
    targetDir,
    platform === 'win32' ? 'amplifier-agent-repl.cmd' : 'amplifier-agent-repl'
  )
  mkdirSync(targetDir, { recursive: true })
  writeFileSync(wrapperPath, content, 'utf8')
  if (platform !== 'win32') {
    chmodSync(wrapperPath, 0o755)
  }
}

export function preparePackagedAgentTerminalWrapper({ resourcesDir, platform, executableName }) {
  const scriptPath = path.join(resourcesDir, 'agent-wrappers', 'amplifier-agent-repl.mjs')
  if (!existsSync(scriptPath)) {
    throw new Error(`Missing packaged Amplifier Agent wrapper: ${scriptPath}`)
  }
  const content =
    platform === 'win32'
      ? `@echo off\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE=1"\r\nset "NODE_OPTIONS="\r\nset "NODE_REPL_EXTERNAL_MODULE="\r\n"%~dp0..\\..\\${escapeWindowsBatchValue(executableName)}.exe" "%~dp0..\\agent-wrappers\\amplifier-agent-repl.mjs" %*\r\n`
      : `#!/usr/bin/env bash\nset -euo pipefail\nSCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"\nunset NODE_OPTIONS NODE_REPL_EXTERNAL_MODULE\nELECTRON_RUN_AS_NODE=1 exec "$SCRIPT_DIR/../../${platform === 'darwin' ? 'MacOS/' : ''}${executableName}" "$SCRIPT_DIR/../agent-wrappers/amplifier-agent-repl.mjs" "$@"\n`
  writeAgentTerminalWrapper(path.join(resourcesDir, 'bin'), content, platform)
}

export function prepareDevCliTerminalWrappers({
  repoRoot,
  userDataPath,
  electronExecutable,
  platform = process.platform
}) {
  const binDir = path.join(repoRoot, 'out', 'bin')
  const userDataBinDir = path.join(userDataPath, 'cli', 'bin')
  const cliPath = path.join(repoRoot, 'out', 'cli', 'index.js')
  const agentScriptPath = path.join(repoRoot, 'config', 'scripts', 'amplifier-agent-repl.mjs')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(userDataBinDir, { recursive: true })

  if (platform === 'win32') {
    const wrapperContent = `@echo off\r\nset "ORCA_USER_DATA_PATH=${escapeWindowsBatchValue(userDataPath)}"\r\nset "ORCA_DEV_CLI_INVOCATION=1"\r\nset "ORCA_APP_EXECUTABLE=${escapeWindowsBatchValue(electronExecutable)}"\r\nset "ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT=1"\r\nnode "${escapeWindowsBatchValue(cliPath)}" %*\r\n`
    for (const targetDir of [binDir, userDataBinDir]) {
      for (const commandName of ['orca-dev.cmd', 'orca.cmd']) {
        writeFileSync(path.join(targetDir, commandName), wrapperContent, 'utf8')
      }
      writeAgentTerminalWrapper(
        targetDir,
        `@echo off\r\nnode "${escapeWindowsBatchValue(agentScriptPath)}" %*\r\n`,
        platform
      )
    }
  } else {
    const wrapperContent = `#!/usr/bin/env bash\nexport ORCA_USER_DATA_PATH=${JSON.stringify(userDataPath)}\nexport ORCA_DEV_CLI_INVOCATION=1\nexport ORCA_APP_EXECUTABLE=${JSON.stringify(electronExecutable)}\nexport ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT=1\nexec node ${JSON.stringify(cliPath)} "$@"\n`
    for (const targetDir of [binDir, userDataBinDir]) {
      for (const commandName of ['orca-dev', 'orca']) {
        const wrapperPath = path.join(targetDir, commandName)
        writeFileSync(wrapperPath, wrapperContent, 'utf8')
        chmodSync(wrapperPath, 0o755)
      }
      writeAgentTerminalWrapper(
        targetDir,
        `#!/usr/bin/env bash\nexec node '${agentScriptPath.replaceAll("'", "'\\''")}' "$@"\n`,
        platform
      )
    }
  }

  return { binDir, userDataBinDir }
}
