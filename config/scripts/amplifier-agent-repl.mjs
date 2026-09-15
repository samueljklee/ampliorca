#!/usr/bin/env node

// amplifier-agent-repl: a persistent-session shim over `amplifier-agent`.
//
// microsoft/amplifier-agent is a one-turn-per-invocation engine by design -- it boots,
// answers one prompt, and exits; continuity across turns comes from a session id, not a
// long-lived process (see its docs/INTEGRATION.md). Every other agent Orca launches here is
// itself a persistent TUI/REPL process that Orca just attaches a terminal pane to. To fit
// that same model, this script IS the persistent process Orca watches: it reads one line at
// a time from stdin and spawns a fresh `amplifier-agent run` per line, reusing a session id
// pinned to this worktree so continuity survives pane restarts, hibernation, and reopening
// the worktree later.
//
// Resume (`amplifier-agent-repl --resume <sessionId>`, from Agent Session History): the
// session's original --workspace name is required to find its state directory
// ($AMPLIFIER_AGENT_HOME/state/workspaces/<workspace>/sessions/<id>/), but Orca's resume
// command only carries the session id (matching the dominant `--resume <id>` shape used by
// most other agents in ai-vault-resume-command.ts) -- so this script resolves the owning
// workspace itself by searching state/workspaces/*/sessions/<id>.
//
// Status: not yet empirically verified against a built Orca -- in particular
// `expectedProcess` in tui-agent-config.ts assumes this script's process is identifiable as
// `amplifier-agent-repl` (true on macOS/Linux once installed via the package.json `bin`
// entry; unconfirmed on Windows, where bin shims can surface as `node` in the process list).

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'

const cwd = process.cwd()

// Why: keep amplifier-agent's state under its own home, separate from the unrelated `amplifier`
// CLI's `~/.amplifier` -- explicit rather than relying on whatever default ships upstream.
const amplifierAgentHome = process.env.AMPLIFIER_AGENT_HOME ?? join(homedir(), '.amplifier-agent')
const env = { ...process.env, AMPLIFIER_AGENT_HOME: amplifierAgentHome }
const workspacesRoot = join(amplifierAgentHome, 'state', 'workspaces')

function findWorkspaceForSession(sessionId) {
  if (!existsSync(workspacesRoot)) {
    return null
  }
  for (const workspaceName of readdirSync(workspacesRoot)) {
    if (existsSync(join(workspacesRoot, workspaceName, 'sessions', sessionId))) {
      return workspaceName
    }
  }
  return null
}

const sessionFile = join(cwd, '.amplifier-agent-session-id')

function parseResumeArg() {
  const flagIndex = process.argv.indexOf('--resume')
  return flagIndex !== -1 ? (process.argv[flagIndex + 1] ?? null) : null
}

// Why: whether the very first turn this process sends needs `--resume` depends on
// whether the underlying amplifier-agent session already has prior turns, NOT on
// whether THIS process has sent one yet -- reopening a worktree pane spawns a brand
// new wrapper process against a session id that already has real history. Getting
// this wrong would silently drop `--resume` on it and desync the transcript from
// what the session actually remembers.
let sessionId
let workspace
let isContinuingExistingSession

const resumeSessionId = parseResumeArg()
if (resumeSessionId) {
  const foundWorkspace = findWorkspaceForSession(resumeSessionId)
  sessionId = resumeSessionId
  workspace = foundWorkspace ?? basename(cwd) ?? 'amplifier-agent-orca'
  if (!foundWorkspace) {
    console.error(
      `[amplifier-agent-repl] warning: could not locate the workspace for session ${resumeSessionId} under ${workspacesRoot}; guessing workspace "${workspace}"`
    )
  }
  isContinuingExistingSession = true
  writeFileSync(sessionFile, sessionId, 'utf8')
} else if (existsSync(sessionFile) && readFileSync(sessionFile, 'utf8').trim()) {
  sessionId = readFileSync(sessionFile, 'utf8').trim()
  workspace = basename(cwd) || 'amplifier-agent-orca'
  isContinuingExistingSession = true
} else {
  sessionId = randomUUID()
  workspace = basename(cwd) || 'amplifier-agent-orca'
  isContinuingExistingSession = false
  writeFileSync(sessionFile, sessionId, 'utf8')
}

let sentFirstTurn = false

function runTurn(prompt) {
  return new Promise((resolve) => {
    const args = [
      'run',
      '-y', // Why: matches every other agent's default permission-bypass flag here (see docs/site/content/docs/agents/supported.mdx) -- worktrees are disposable, so auto-approve by default.
      '--session-id',
      sessionId,
      '--workspace',
      workspace
    ]
    if (sentFirstTurn || isContinuingExistingSession) {
      args.push('--resume')
    }
    args.push(prompt)

    const child = spawn('amplifier-agent', args, {
      cwd,
      env,
      stdio: ['ignore', 'inherit', 'inherit']
    })
    child.on('exit', (code) => {
      sentFirstTurn = true
      if (code !== 0 && code !== null) {
        console.error(`[amplifier-agent-repl] turn exited with code ${code}`)
      }
      resolve()
    })
    child.on('error', (err) => {
      console.error(`[amplifier-agent-repl] failed to spawn amplifier-agent: ${err.message}`)
      console.error(
        '[amplifier-agent-repl] is amplifier-agent installed and on PATH? see: https://github.com/microsoft/amplifier-agent#install'
      )
      resolve()
    })
  })
}

console.log(`[amplifier-agent-repl] session ${sessionId} (workspace: ${workspace})`)
console.log('[amplifier-agent-repl] type a prompt and press enter; Ctrl+D to exit.')

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' })
rl.prompt()
rl.on('line', async (line) => {
  const prompt = line.trim()
  if (prompt) {
    await runTurn(prompt)
  }
  rl.prompt()
})
rl.on('close', () => {
  console.log('\n[amplifier-agent-repl] session ended.')
  process.exit(0)
})
