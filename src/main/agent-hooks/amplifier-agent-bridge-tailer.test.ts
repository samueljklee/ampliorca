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
  const tailer = new AmplifierAgentBridgeTailer((record) => ingested.push(record), home)
  return { tailer, ingested }
}

describe('amplifierAgentWorkspaceSlug', () => {
  it('derives the event path from POSIX and Windows cwd forms without trimming a trailing separator', () => {
    expect(amplifierAgentWorkspaceSlug('/Users/sam/repo/project/')).toBe('-Users-sam-repo-project-')
    expect(amplifierAgentWorkspaceSlug('C:\\Users\\sam\\repo\\project')).toBe(
      '-C:-Users-sam-repo-project'
    )
    expect(
      amplifierAgentEventsPath('/tmp/amplifier-agent', '/Users/sam/repo/project', 'session-1')
    ).toBe(
      join(
        '/tmp/amplifier-agent',
        'state',
        'workspaces',
        '-Users-sam-repo-project',
        'sessions',
        'session-1',
        'context-intelligence',
        'events.jsonl'
      )
    )
  })
})

describe('AmplifierAgentBridgeTailer', () => {
  it('ingests only a registered session and stops after it is unregistered', () => {
    const home = mkdtempSync(join(tmpdir(), 'amplifier-agent-tailer-'))
    const cwd = '/Users/sam/repo/project'
    const sessionId = 'session-1'
    const file = amplifierAgentEventsPath(home, cwd, sessionId)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, event())
    const { tailer, ingested } = makeTailer(home)

    tailer.registerSession('tab-1:0', cwd, sessionId)
    tailer.start()
    vi.advanceTimersByTime(300)

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
    vi.advanceTimersByTime(300)
    tailer.stop()

    expect(ingested).toHaveLength(1)
  })

  it('reads only bytes appended since its prior poll', () => {
    const home = mkdtempSync(join(tmpdir(), 'amplifier-agent-tailer-'))
    const cwd = '/Users/sam/repo/project'
    const file = amplifierAgentEventsPath(home, cwd, 'session-1')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, event())
    const { tailer, ingested } = makeTailer(home)

    tailer.registerSession('tab-1:0', cwd, 'session-1')
    tailer.start()
    vi.advanceTimersByTime(300)
    appendFileSync(file, event({ turn_id: 'turn-2' }))
    vi.advanceTimersByTime(600)
    tailer.stop()

    expect(ingested.map((record) => (record.payload as { turn_id: string }).turn_id)).toEqual([
      'turn-1',
      'turn-2'
    ])
  })

  it('leaves a torn trailing line until a later poll terminates it', () => {
    const home = mkdtempSync(join(tmpdir(), 'amplifier-agent-tailer-'))
    const cwd = '/Users/sam/repo/project'
    const file = amplifierAgentEventsPath(home, cwd, 'session-1')
    mkdirSync(dirname(file), { recursive: true })
    const whole = event()
    writeFileSync(file, whole + whole.slice(0, -1))
    const { tailer, ingested } = makeTailer(home)

    tailer.registerSession('tab-1:0', cwd, 'session-1')
    tailer.start()
    vi.advanceTimersByTime(300)
    expect(ingested).toHaveLength(1)

    appendFileSync(file, '\n')
    vi.advanceTimersByTime(300)
    tailer.stop()

    expect(ingested).toHaveLength(2)
  })
})
