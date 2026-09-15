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
// Status: first draft, not yet empirically verified against a built Orca -- in particular
// `expectedProcess` in tui-agent-config.ts assumes this script's process is identifiable as
// `amplifier-agent-repl` (true on macOS/Linux once installed via the package.json `bin`
// entry; unconfirmed on Windows, where bin shims can surface as `node` in the process list).

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'

const cwd = process.cwd()
const workspace = basename(cwd) || 'amplifier-agent-orca'

// Why: persisting the session id in the worktree (not just in this process's memory) means
// continuity survives Orca restarting the pane, hibernating the agent, or the user reopening
// the worktree in a later Orca session -- matching what every native agent gets from its own
// on-disk session store.
const sessionFile = join(cwd, '.amplifier-agent-session-id')
function loadOrCreateSessionId() {
  if (existsSync(sessionFile)) {
    const existing = readFileSync(sessionFile, 'utf8').trim()
    if (existing) return existing
  }
  const id = randomUUID()
  writeFileSync(sessionFile, id, 'utf8')
  return id
}
const sessionId = loadOrCreateSessionId()

// Why: keep amplifier-agent's state under its own home, separate from the unrelated `amplifier`
// CLI's `~/.amplifier` -- explicit rather than relying on whatever default ships upstream.
const env = {
  ...process.env,
  AMPLIFIER_AGENT_HOME: process.env.AMPLIFIER_AGENT_HOME ?? join(homedir(), '.amplifier-agent')
}

let turnCount = 0

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
    if (turnCount > 0) args.push('--resume')
    args.push(prompt)

    const child = spawn('amplifier-agent', args, {
      cwd,
      env,
      stdio: ['ignore', 'inherit', 'inherit']
    })
    child.on('exit', (code) => {
      turnCount += 1
      if (code !== 0 && code !== null) {
        console.error(`[amplifier-agent-repl] turn exited with code ${code}`)
      }
      resolve()
    })
    child.on('error', (err) => {
      console.error(`[amplifier-agent-repl] failed to spawn amplifier-agent: ${err.message}`)
      console.error('[amplifier-agent-repl] is amplifier-agent installed and on PATH? see: https://github.com/microsoft/amplifier-agent#install')
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
