import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import {
  ORCAD_CLI_ENTRY_FILENAME,
  orcadTemplateCommonFilenames
} from '../../../shared/remote-runtime/orcad-distribution/orcad-artifacts'
import { prepareOrcadCliLauncher } from './orcad-cli-launcher'

const roots = vi.hoisted(() => ({ install: '', profile: '' }))
vi.mock('../host-runtime/orcad-app-paths', () => ({
  resolveOrcadInstallRoot: () => roots.install,
  resolveUserDataPath: () => roots.profile
}))

let directory = ''

afterEach(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true })
  }
})

it.skipIf(process.platform === 'win32')(
  'delivers fresh and resumed turns through the template wrapper with pinned Node and binding proof',
  async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-node-cli-'))
    roots.install = join(directory, "server ' slot")
    roots.profile = join(directory, "profile ' data")
    const cli = join(roots.install, ...ORCAD_CLI_ENTRY_FILENAME.split('/'))
    await mkdir(dirname(cli), { recursive: true })
    await writeFile(cli, '')
    for (const filename of orcadTemplateCommonFilenames([])) {
      if (filename.startsWith('agent-wrappers/')) {
        const destination = join(roots.install, ...filename.split('/'))
        await mkdir(dirname(destination), { recursive: true })
        await copyFile(
          new URL('../../../../config/scripts/amplifier-agent-repl.mjs', import.meta.url),
          destination
        )
      }
    }
    await prepareOrcadCliLauncher()
    const binDir = join(roots.profile, 'cli', 'bin')
    const callsPath = join(directory, 'engine-calls.jsonl')
    await writeFile(join(binDir, 'node'), '#!/bin/sh\nexit 99\n', { mode: 0o700 })
    await writeFile(
      join(binDir, 'amplifier-agent'),
      `#!${process.execPath}
const { appendFileSync } = require('node:fs')
console.error('engine-start')
appendFileSync(process.env.ENGINE_CALLS, JSON.stringify({
  args: process.argv.slice(2),
  runtime: process.execPath,
  nodeOptions: process.env.NODE_OPTIONS ?? null,
  repl: process.env.NODE_REPL_EXTERNAL_MODULE ?? null,
  electron: process.env.ELECTRON_RUN_AS_NODE ?? null
}) + '\\n')
`,
      { mode: 0o700 }
    )
    const workspace = join(directory, 'workspace')
    const home = join(directory, 'agent-home')
    await mkdir(workspace)
    const env = {
      ...process.env,
      PATH: `${binDir}:/usr/bin:/bin`,
      ENGINE_CALLS: callsPath,
      AMPLIFIER_AGENT_HOME: home,
      ORCA_AGENT_LAUNCH_TOKEN: 'launcher-delivery-proof',
      NODE_OPTIONS: '--require=/missing/inherited/preload',
      NODE_REPL_EXTERNAL_MODULE: '/missing/inherited/repl',
      ELECTRON_RUN_AS_NODE: '1'
    }
    const program = join(binDir, 'amplifier-agent-repl')
    const fresh = await runProcess({
      program,
      args: ['--session-id', 'fresh-delivery'],
      input: 'first\n\x1b[200~second\nline\x1b[201~\n',
      cwd: workspace,
      env,
      timeoutMs: 10_000
    })
    expect(fresh.code, fresh.stderr).toBe(0)
    const marker = /^\[amplifier-agent-repl\] bound (.+)$/m.exec(fresh.stderr)
    expect(JSON.parse(marker?.[1] ?? 'null')).toMatchObject({
      sessionId: 'fresh-delivery',
      workspace: 'workspace',
      launchToken: 'launcher-delivery-proof'
    })
    expect(fresh.stderr.indexOf('[amplifier-agent-repl] bound ')).toBeLessThan(
      fresh.stderr.indexOf('engine-start')
    )
    await mkdir(
      join(home, 'state', 'workspaces', 'original-workspace', 'sessions', 'history-delivery'),
      { recursive: true }
    )
    const resumed = await runProcess({
      program,
      args: ['--resume', 'history-delivery'],
      input: 'resumed\n',
      cwd: workspace,
      env,
      timeoutMs: 10_000
    })
    expect(resumed.code, resumed.stderr).toBe(0)
    expect(
      (await readFile(callsPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    ).toEqual([
      {
        args: ['run', '-y', '--session-id', 'fresh-delivery', '--workspace', 'workspace', 'first'],
        runtime: process.execPath,
        nodeOptions: null,
        repl: null,
        electron: null
      },
      {
        args: [
          'run',
          '-y',
          '--session-id',
          'fresh-delivery',
          '--workspace',
          'workspace',
          '--resume',
          'second\nline'
        ],
        runtime: process.execPath,
        nodeOptions: null,
        repl: null,
        electron: null
      },
      {
        args: [
          'run',
          '-y',
          '--session-id',
          'history-delivery',
          '--workspace',
          'original-workspace',
          '--resume',
          'resumed'
        ],
        runtime: process.execPath,
        nodeOptions: null,
        repl: null,
        electron: null
      }
    ])
  }
)
