import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { SpoolRecord } from '../../shared/agent-hook-spool'
import {
  AmplifierAgentBridgeTailer,
  amplifierAgentEventsPath,
  amplifierAgentWorkspaceSlug
} from './amplifier-agent-bridge-tailer'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function event(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    event: 'prompt:submit',
    workspace: '-Users-sam-repo-project',
    timestamp: '2026-09-16T00:00:00.000Z',
    data: { session_id: 'session-1', turn_id: 'turn-1', ...overrides }
  })}\n`
}

function makeTailer(home: string) {
  const ingested: SpoolRecord[] = []
  const tailer = new AmplifierAgentBridgeTailer((record) => {
    ingested.push(record)
  }, home)
  return { tailer, ingested }
}

describe('amplifierAgentWorkspaceSlug', () => {
  it('matches the REPL --workspace basename for POSIX and Windows cwd forms', () => {
    expect(amplifierAgentWorkspaceSlug('/Users/sam/repo/project/')).toBe('project')
    expect(amplifierAgentWorkspaceSlug('C:\\Users\\sam\\repo\\project')).toBe('project')
    expect(
      amplifierAgentEventsPath('/tmp/amplifier-agent', '/Users/sam/repo/project', 'session-1')
    ).toBe(
      join(
        '/tmp/amplifier-agent',
        'state',
        'workspaces',
        'project',
        'sessions',
        'session-1',
        'context-intelligence',
        'events.jsonl'
      )
    )
  })
})

describe('AmplifierAgentBridgeTailer', () => {
  it('resumes the REPL-discovered workspace without treating old turns as live', async () => {
    const home = mkdtempSync(join(tmpdir(), 'amplifier-agent-tailer-'))
    const file = join(
      home,
      'state',
      'workspaces',
      'original',
      'sessions',
      'session-1',
      'context-intelligence',
      'events.jsonl'
    )
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, event())
    const { tailer, ingested } = makeTailer('/unused-default-home')
    tailer.registerSession('tab-1:0', '/new/location', 'session-1', {
      home,
      resume: true,
      launchToken: 'current-launch'
    })
    tailer.start()
    await vi.advanceTimersByTimeAsync(300)
    expect(ingested).toEqual([])
    appendFileSync(file, event({ turn_id: 'turn-2' }))
    await vi.advanceTimersByTimeAsync(300)
    tailer.stop()
    expect(ingested).toEqual([
      expect.objectContaining({
        launchToken: 'current-launch',
        payload: { session_id: 'session-1', turn_id: 'turn-2' }
      })
    ])
  })

  it('revokes a pending delivery when its pane is rebound', async () => {
    const home = mkdtempSync(join(tmpdir(), 'amplifier-agent-tailer-'))
    const file = amplifierAgentEventsPath(home, '/repo/project', 'session-1')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, event())
    const applied: SpoolRecord[] = []
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const tailer = new AmplifierAgentBridgeTailer(async (entry, isCurrent) => {
      await blocked
      if (isCurrent()) {
        applied.push(entry)
      }
    }, home)
    tailer.registerSession('tab-1:0', '/repo/project', 'session-1')
    tailer.start()
    await vi.advanceTimersByTimeAsync(300)
    tailer.registerSession('tab-1:0', '/repo/project', 'session-2')
    release()
    await tailer.flush()
    tailer.stop()
    expect(applied).toEqual([])
  })

  it('ingests only a registered session and stops after it is unregistered', async () => {
    const home = mkdtempSync(join(tmpdir(), 'amplifier-agent-tailer-'))
    const cwd = '/Users/sam/repo/project'
    const sessionId = 'session-1'
    const file = amplifierAgentEventsPath(home, cwd, sessionId)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, event())
    const { tailer, ingested } = makeTailer(home)

    tailer.registerSession('tab-1:0', cwd, sessionId)
    tailer.start()
    await vi.advanceTimersByTimeAsync(300)

    expect(ingested).toEqual([
      {
        paneKey: 'tab-1:0',
        source: 'amplifier-agent',
        hookEventName: 'prompt:submit',
        payload: { session_id: 'session-1', turn_id: 'turn-1' },
        receivedAt: expect.any(Number)
      }
    ])

    tailer.unregisterSession('tab-1:0')
    appendFileSync(file, event({ turn_id: 'turn-2' }))
    await vi.advanceTimersByTimeAsync(300)
    tailer.stop()

    expect(ingested).toHaveLength(1)
  })

  it('reads only bytes appended since its prior poll', async () => {
    const home = mkdtempSync(join(tmpdir(), 'amplifier-agent-tailer-'))
    const cwd = '/Users/sam/repo/project'
    const file = amplifierAgentEventsPath(home, cwd, 'session-1')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, event())
    const { tailer, ingested } = makeTailer(home)

    tailer.registerSession('tab-1:0', cwd, 'session-1')
    tailer.start()
    await vi.advanceTimersByTimeAsync(300)
    appendFileSync(file, event({ turn_id: 'turn-2' }))
    await vi.advanceTimersByTimeAsync(600)
    tailer.stop()

    expect(ingested.map((record) => (record.payload as { turn_id: string }).turn_id)).toEqual([
      'turn-1',
      'turn-2'
    ])
  })

  it('leaves a torn trailing line until a later poll terminates it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'amplifier-agent-tailer-'))
    const cwd = '/Users/sam/repo/project'
    const file = amplifierAgentEventsPath(home, cwd, 'session-1')
    mkdirSync(dirname(file), { recursive: true })
    const whole = event()
    writeFileSync(file, whole + whole.slice(0, -1))
    const { tailer, ingested } = makeTailer(home)

    tailer.registerSession('tab-1:0', cwd, 'session-1')
    tailer.start()
    await vi.advanceTimersByTimeAsync(300)
    expect(ingested).toHaveLength(1)

    appendFileSync(file, '\n')
    await vi.advanceTimersByTimeAsync(300)
    tailer.stop()

    expect(ingested).toHaveLength(2)
  })
})
