import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer, type Socket } from 'node:net'
import { once } from 'node:events'
import { spawnProcess } from '@orca/process-host'
import { AgentHookServer } from './server'
import { makePaneKey } from '../../shared/stable-pane-id'
import { consumeAmplifierAgentTurnSettlementOutput } from '../../shared/amplifier-agent-turn-settlement'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'orca-wrapper-runtime-')))
  const home = join(directory, 'custom-home')
  const bin = join(directory, 'bin')
  mkdirSync(bin)
  const socketPath = join(directory, 'engine.sock')
  const starts: { args: string[]; release: (code?: number) => void }[] = []
  let nextStart = deferred<(typeof starts)[number]>()
  const sockets = new Set<Socket>()
  const listener = createServer((socket) => {
    sockets.add(socket)
    let pending = ''
    socket.on('data', (chunk) => {
      pending += chunk.toString()
      if (!pending.includes('\n')) {
        return
      }
      const args = JSON.parse(pending.trim())
      const start = { args, release: (code = 0) => socket.end(String(code)) }
      starts.push(start)
      nextStart.resolve(start)
      nextStart = deferred<(typeof starts)[number]>()
    })
  })
  listener.listen(socketPath)
  await once(listener, 'listening')
  writeFileSync(
    join(bin, 'amplifier-agent'),
    `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const args = process.argv.slice(2);
const session = args[args.indexOf('--session-id') + 1];
const workspace = args[args.indexOf('--workspace') + 1];
const lock = path.join(process.cwd(), 'active-engine');
try { fs.mkdirSync(lock) } catch {
  fs.writeFileSync(path.join(process.cwd(), 'overlap'), 'concurrent children');
}
const feed = path.join(process.env.AMPLIFIER_AGENT_HOME, 'state', 'workspaces', workspace,
  'sessions', session, 'context-intelligence', 'events.jsonl');
fs.mkdirSync(path.dirname(feed), { recursive: true });
fs.appendFileSync(feed, JSON.stringify({ event: 'delegate:agent_spawned',
  data: { sub_session_id: args.at(-1), agent: 'builder' } }) + '\\n');
const socket = net.connect(process.env.TEST_ENGINE_SOCKET, () => socket.write(JSON.stringify(args) + '\\n'));
socket.once('data', (code) => {
  fs.rmSync(lock, { recursive: true, force: true });
  socket.destroy();
  process.exit(Number(code));
});
`,
    { mode: 0o755 }
  )
  const paneKey = makePaneKey('tab-wrapper', '11111111-1111-4111-8111-111111111111')
  const server = new AgentHookServer()
  await server.start({ userDataPath: directory })
  server.registerAmplifierAgentSession(paneKey, directory, 'session-1', {
    home,
    launchToken: 'wrapper-launch'
  })
  const terminal = { ptyId: 'pty-wrapper', incarnationId: 'inc-wrapper' }
  const bound = deferred<void>()
  let settled = deferred<void>()
  let pending = ''
  let stderr = ''
  let ingress = Promise.resolve()
  const markers: unknown[] = []
  const child = spawnProcess({
    program: process.execPath,
    args: [resolve('config/scripts/amplifier-agent-repl.mjs'), '--session-id', 'session-1'],
    cwd: directory,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      AMPLIFIER_AGENT_HOME: home,
      ORCA_PANE_KEY: paneKey,
      ORCA_AGENT_LAUNCH_TOKEN: 'wrapper-launch',
      TEST_ENGINE_SOCKET: socketPath
    }
  })
  const closed = once(child, 'close')
  child.stdout.resume()
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
    const output = consumeAmplifierAgentTurnSettlementOutput(pending, chunk.toString())
    pending = output.pending
    ingress = ingress.then(async () => {
      for (const binding of output.bindings) {
        await server.observeAmplifierAgentWrapper(paneKey, binding, terminal, () => true)
        bound.resolve()
      }
      for (const marker of output.settlements) {
        markers.push(marker)
        await server.settleAmplifierAgentTurnForPane(
          paneKey,
          marker.failed,
          marker.sessionId,
          marker
        )
        settled.resolve()
        settled = deferred<void>()
      }
    })
  })
  onTestFinished(async () => {
    child.kill()
    for (const socket of sockets) {
      socket.destroy()
    }
    listener.close()
    server.stop()
    vi.useRealTimers()
    await closed
    rmSync(directory, { recursive: true, force: true })
  })
  await bound.promise
  return {
    server,
    child,
    closed,
    directory,
    home,
    paneKey,
    terminal,
    starts,
    markers,
    stderr: () => stderr,
    nextStart: () => nextStart.promise,
    settled: () => settled.promise,
    ingress: () => ingress
  }
}

// The controlled executable uses a POSIX shebang; Windows requires its own signed-launcher fixture.
describe.skipIf(process.platform === 'win32')('persistent wrapper runtime', () => {
  it('keeps a bracketed multiline paste in one prompt even when markers span chunks', async () => {
    const f = await fixture()
    const start = f.nextStart()
    f.child.stdin.write('\x1b[20')
    f.child.stdin.write('0~ first line\nsecond line ')
    f.child.stdin.end('\x1b[201~\n')
    const engine = await start
    expect(engine.args.at(-1)).toBe(' first line\nsecond line ')
    engine.release()
    expect((await f.closed)[0], f.stderr()).toBe(0)
    await f.ingress()
    expect(f.starts).toHaveLength(1)
  })

  it('serializes newline-separated pasted prompts, preserving every line and resuming the session', async () => {
    const f = await fixture()
    const first = f.nextStart()
    f.child.stdin.end('  first prompt  \nsecond prompt\n')
    const a = await first
    expect(a.args.at(-1)).toBe('  first prompt  ')
    expect(a.args).not.toContain('--resume')
    const second = f.nextStart()
    a.release()
    const b = await second
    expect(b.args.at(-1)).toBe('second prompt')
    expect(b.args).toContain('--resume')
    expect(b.args[b.args.indexOf('--session-id') + 1]).toBe('session-1')
    b.release()
    expect((await f.closed)[0], f.stderr()).toBe(0)
    await f.ingress()
    expect(f.starts).toHaveLength(2)
    expect(f.markers).toHaveLength(2)
    expect(() => readFileSync(join(f.directory, 'overlap'))).toThrow()
  })

  it('restores the same proven wrapper after hook-runtime restart and observes only its next turn', async () => {
    const f = await fixture()
    const first = f.nextStart()
    const settled = f.settled()
    f.child.stdin.write('turn-a\n')
    const a = await first
    a.release()
    await settled
    f.server.stop()
    vi.useFakeTimers()
    await f.server.start({ userDataPath: f.directory })
    const register = vi.spyOn(f.server, 'registerAmplifierAgentSession')
    await f.server.restoreAmplifierAgentSessionForPty(
      f.paneKey,
      { ...f.terminal, incarnationId: 'a-different-incarnation' },
      () => true
    )
    await f.server.restoreAmplifierAgentSessionForPty(f.paneKey, f.terminal, () => false)
    expect(register).not.toHaveBeenCalled()
    await f.server.restoreAmplifierAgentSessionForPty(f.paneKey, f.terminal, () => true)
    expect(register).toHaveBeenCalledExactlyOnceWith(f.paneKey, f.directory, 'session-1', {
      home: f.home,
      workspace: f.directory.split('/').at(-1),
      resume: true,
      launchToken: 'wrapper-launch'
    })
    expect(f.server.getStatusChangeSnapshot()[0]?.observedInCurrentRuntime).not.toBe(true)
    const second = f.nextStart()
    f.child.stdin.write('turn-b\n')
    const b = await second
    await vi.advanceTimersByTimeAsync(300)
    expect(f.server.getStatusSnapshotForPane(f.paneKey)[0]).toMatchObject({
      state: 'working',
      subagents: [expect.objectContaining({ id: 'turn-b', state: 'working' })]
    })
    expect(f.server.getStatusChangeSnapshot()[0]?.observedInCurrentRuntime).toBe(true)
    b.release(7)
    f.child.stdin.end()
    expect((await f.closed)[0], f.stderr()).toBe(0)
    await f.ingress()
    expect(f.server.getStatusSnapshotForPane(f.paneKey)[0]).toMatchObject({
      state: 'working',
      subagents: [expect.objectContaining({ id: 'turn-b', state: 'unverifiable' })]
    })
  })
})
