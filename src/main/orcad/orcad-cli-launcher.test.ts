import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import {
  ORCAD_CLI_ENTRY_FILENAME,
  orcadTemplateCommonFilenames
} from '../../shared/orcad-artifacts'
import { getOrcadCliLauncherPath, prepareOrcadCliLauncher } from './orcad-cli-launcher'

const roots = vi.hoisted(() => ({ install: '', profile: '' }))
vi.mock('./orcad-app-paths', () => ({
  resolveOrcadInstallRoot: () => roots.install,
  resolveUserDataPath: () => roots.profile
}))

let directory = ''
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-node-cli-'))
  roots.install = join(directory, "server ' slot")
  roots.profile = join(directory, "profile ' data")
})

afterEach(async () => {
  Object.defineProperty(process, 'platform', platformDescriptor)
  await rm(directory, { recursive: true, force: true })
})

async function writeCli(): Promise<void> {
  const path = join(roots.install, ...ORCAD_CLI_ENTRY_FILENAME.split('/'))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    'console.log(JSON.stringify({profile:process.env.ORCA_USER_DATA_PATH, args:process.argv.slice(2), electron:process.env.ELECTRON_RUN_AS_NODE}))'
  )
}

describe('orcad profile CLI launcher', () => {
  it.skipIf(process.platform === 'win32')(
    'delivers fresh and history-resumed engine turns from the standalone template with its own Node',
    async () => {
      await writeCli()
      for (const filename of orcadTemplateCommonFilenames([])) {
        if (filename.startsWith('agent-wrappers/')) {
          const destination = join(roots.install, ...filename.split('/'))
          await mkdir(dirname(destination), { recursive: true })
          await copyFile(
            new URL('../../../config/scripts/amplifier-agent-repl.mjs', import.meta.url),
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
appendFileSync(process.env.ENGINE_CALLS, JSON.stringify({
  args: process.argv.slice(2),
  runtime: process.execPath,
  nodeOptions: process.env.NODE_OPTIONS ?? null,
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
          args: [
            'run',
            '-y',
            '--session-id',
            'fresh-delivery',
            '--workspace',
            'workspace',
            'first'
          ],
          runtime: process.execPath,
          nodeOptions: null,
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
          electron: null
        }
      ])
    }
  )

  it.skipIf(process.platform === 'win32')(
    'launches pinned Node with intact arguments and the execution host profile',
    async () => {
      await writeCli()
      await prepareOrcadCliLauncher()
      const launcher = getOrcadCliLauncherPath()
      expect(launcher).toBe(join(roots.profile, 'cli', 'bin', 'orca'))
      if (!launcher) {
        throw new Error('CLI launcher is missing')
      }
      const args = ['orchestration', 'send', 'a body\nwith "quotes" and $HOME']
      const launchers =
        process.platform === 'linux' ? [launcher, join(dirname(launcher), 'orca-ide')] : [launcher]
      for (const program of launchers) {
        const result = await runProcess({
          program,
          args,
          env: {
            ...process.env,
            ORCA_USER_DATA_PATH: '/another/owner',
            ELECTRON_RUN_AS_NODE: '1',
            NODE_OPTIONS: '--require /missing/inherited/preload'
          },
          timeoutMs: 5000
        })
        expect(result.code).toBe(0)
        expect(JSON.parse(result.stdout)).toEqual({ profile: roots.profile, args })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    "passes a person's own Orca settings through, adding only the profile",
    async () => {
      const path = join(roots.install, ...ORCAD_CLI_ENTRY_FILENAME.split('/'))
      await mkdir(dirname(path), { recursive: true })
      await writeFile(
        path,
        "console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('ORCA_')))))"
      )
      await prepareOrcadCliLauncher()
      const result = await runProcess({
        program: getOrcadCliLauncherPath()!,
        args: ['status'],
        env: {
          PATH: process.env.PATH,
          ORCA_ENVIRONMENT: 'other-server',
          ORCA_PAIRING_CODE: 'other-pairing'
        },
        timeoutMs: 5000
      })
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({
        ORCA_USER_DATA_PATH: roots.profile,
        ORCA_ENVIRONMENT: 'other-server',
        ORCA_PAIRING_CODE: 'other-pairing'
      })
    }
  )
})
