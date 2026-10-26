import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const hook = fileURLToPath(new URL('../../.husky/pre-commit', import.meta.url))
const lintStaged = fileURLToPath(
  new URL('../../node_modules/lint-staged/bin/lint-staged.js', import.meta.url)
)

it.each([
  { mode: 'normal', fail: false },
  { mode: 'merge', fail: false },
  { mode: 'normal', fail: true },
  { mode: 'merge', fail: true }
])('pre-commit selects $mode files and preserves task failure=$fail', ({ mode, fail }) => {
  const root = mkdtempSync(join(tmpdir(), 'orca-pre-commit-'))
  const repo = join(root, 'repo')
  const bin = join(root, 'bin')
  const observation = join(root, 'tasks.jsonl')
  const invocation = join(root, 'pnpm-args.json')
  const config = join(root, 'lint-staged.json')
  const task = join(root, 'task.cjs')
  const env = {
    PATH: [bin, dirname(process.execPath), process.env.PATH].join(delimiter),
    SystemRoot: process.env.SystemRoot,
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: root,
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(root, 'no-global-config'),
    ORCA_TEST_LINT_STAGED: lintStaged,
    ORCA_TEST_CONFIG: config,
    ORCA_TEST_INVOCATION: invocation,
    ORCA_TEST_OBSERVATION: observation,
    ORCA_TEST_FAIL: fail ? '1' : '0'
  }
  const run = (command, args) =>
    spawnSync(command, args, {
      cwd: repo,
      env,
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true
    })
  const git = (args) =>
    execFileSync('git', args, {
      cwd: repo,
      env,
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  const write = (name, content) => writeFileSync(join(repo, name), content)

  try {
    mkdirSync(repo)
    mkdirSync(bin)
    mkdirSync(join(root, 'empty-template'))
    git(['init', '--quiet', `--template=${join(root, 'empty-template')}`])
    git(['symbolic-ref', 'HEAD', 'refs/heads/fork'])
    git(['config', 'user.name', 'Hook Test'])
    git(['config', 'user.email', 'hook@example.invalid'])
    for (const name of [
      'upstream-only.txt',
      'fork committed.txt',
      'fork staged.txt',
      'unstaged.txt'
    ]) {
      write(name, 'base\n')
    }
    git(['add', '.'])
    git(['commit', '--quiet', '-m', 'base'])
    git(['branch', 'incoming'])
    write('fork committed.txt', 'fork\n')
    git(['add', 'fork committed.txt'])
    git(['commit', '--quiet', '-m', 'fork delta'])

    if (mode === 'merge') {
      git(['checkout', '--quiet', 'incoming'])
      write('upstream-only.txt', 'incoming\n')
      git(['add', 'upstream-only.txt'])
      git(['commit', '--quiet', '-m', 'upstream delta'])
      git(['checkout', '--quiet', 'fork'])
      git(['merge', '--no-commit', '--no-ff', 'incoming'])
      write('merge resolution.txt', 'resolved\n')
      git(['add', 'merge resolution.txt'])
    } else {
      write('unstaged.txt', 'unstaged\n')
    }
    write('fork staged.txt', 'staged\n')
    git(['add', 'fork staged.txt'])
    const headBefore = git(['rev-parse', 'HEAD'])
    const upstreamBefore = readFileSync(join(repo, 'upstream-only.txt'), 'utf8')

    writeFileSync(
      join(bin, 'pnpm'),
      [
        '#!/usr/bin/env node',
        "const { spawnSync } = require('node:child_process')",
        "const { writeFileSync } = require('node:fs')",
        'const args = process.argv.slice(2)',
        'writeFileSync(process.env.ORCA_TEST_INVOCATION, JSON.stringify(args))',
        "if (args[0] !== 'exec' || args[1] !== 'lint-staged') process.exit(2)",
        "const result = spawnSync(process.execPath, [process.env.ORCA_TEST_LINT_STAGED, ...args.slice(2), '--config', process.env.ORCA_TEST_CONFIG, '--quiet'], { stdio: 'inherit', timeout: 10000, windowsHide: true })",
        'if (result.error) throw result.error',
        'process.exit(result.status ?? 1)'
      ].join('\n')
    )
    chmodSync(join(bin, 'pnpm'), 0o755)
    writeFileSync(
      task,
      [
        "const { appendFileSync, readFileSync, writeFileSync } = require('node:fs')",
        "const { basename } = require('node:path')",
        'const [task, ...files] = process.argv.slice(2)',
        "appendFileSync(process.env.ORCA_TEST_OBSERVATION, JSON.stringify({ task, files: files.map(file => basename(file)).sort() }) + '\\n')",
        "if (task === 'lint' && process.env.ORCA_TEST_FAIL === '1') process.exit(1)",
        "if (task === 'format') for (const file of files) writeFileSync(file, readFileSync(file, 'utf8') + 'formatted\\n')"
      ].join('\n')
    )
    const taskCommand = [process.execPath, task].map((value) => JSON.stringify(value)).join(' ')
    writeFileSync(
      config,
      JSON.stringify({ '*.txt': [`${taskCommand} lint`, `${taskCommand} format`] })
    )
    mkdirSync(join(repo, '.git', 'hooks'))
    copyFileSync(hook, join(repo, '.git', 'hooks', 'pre-commit'))
    chmodSync(join(repo, '.git', 'hooks', 'pre-commit'), 0o755)

    const result = run('git', ['commit', '--quiet', '-m', 'checked commit'])
    expect(result.error).toBeUndefined()
    expect(result.status, result.stdout + result.stderr).toBe(fail ? 1 : 0)
    expect(JSON.parse(readFileSync(invocation, 'utf8'))).toEqual([
      'exec',
      'lint-staged',
      ...(mode === 'merge' ? ['--diff=MERGE_HEAD'] : [])
    ])
    const files =
      mode === 'merge'
        ? ['fork committed.txt', 'fork staged.txt', 'merge resolution.txt']
        : ['fork staged.txt']
    expect(readFileSync(observation, 'utf8').trim().split('\n').map(JSON.parse)).toEqual(
      (fail ? ['lint'] : ['lint', 'format']).map((task) => ({ task, files }))
    )
    expect(readFileSync(join(repo, 'upstream-only.txt'), 'utf8')).toBe(upstreamBefore)
    expect(readFileSync(join(repo, 'fork staged.txt'), 'utf8')).toBe(
      fail ? 'staged\n' : 'staged\nformatted\n'
    )
    if (fail) {
      expect(git(['rev-parse', 'HEAD'])).toBe(headBefore)
      if (mode === 'merge') {
        expect(git(['rev-parse', 'MERGE_HEAD'])).toBe(git(['rev-parse', 'incoming']))
      }
    } else {
      expect(git(['show', 'HEAD:fork staged.txt'])).toBe('staged\nformatted')
      if (mode === 'merge') {
        expect(git(['show', 'HEAD:fork committed.txt'])).toBe('fork\nformatted')
        expect(git(['show', 'HEAD:merge resolution.txt'])).toBe('resolved\nformatted')
      }
    }
    if (mode === 'normal') {
      expect(readFileSync(join(repo, 'unstaged.txt'), 'utf8')).toBe('unstaged\n')
      expect(readFileSync(join(repo, 'fork committed.txt'), 'utf8')).toBe('fork\n')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
