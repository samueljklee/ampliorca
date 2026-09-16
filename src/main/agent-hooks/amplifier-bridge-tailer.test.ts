import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpoolRecord } from '../../shared/agent-hook-spool'
import { AmplifierBridgeTailer } from './amplifier-bridge-tailer'

// Why fake timers, not real sleeps: the tailer polls on a 300ms interval --
// advancing fake time makes every test instant and deterministic instead of
// paying (and risking flakiness on) a real wall-clock wait per assertion.
beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

function makeTailer(feedDir: string) {
  const ingested: SpoolRecord[] = []
  const tailer = new AmplifierBridgeTailer((record) => ingested.push(record), feedDir)
  return { tailer, ingested }
}

function record(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    schema: 'amplifier.orca-bridge/v1',
    seq: 0,
    ts: '2026-09-15T00:00:00.000Z',
    session_id: 'sess-1',
    launch_token: 'token-1',
    pane_key: 'tab-1:0',
    turn_id: 'turn-1',
    type: 'agent_start',
    data: { agent_name: 'anchors:explorer', subsession_id: 'sub-1' },
    ...overrides
  })}\n`
}

describe('AmplifierBridgeTailer', () => {
  it('ingests a complete line already present when polling starts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-bridge-tailer-'))
    writeFileSync(join(dir, 'sess-1.jsonl'), record())
    const { tailer, ingested } = makeTailer(dir)

    tailer.start()
    vi.advanceTimersByTime(300)
    tailer.stop()

    expect(ingested).toEqual([
      {
        paneKey: 'tab-1:0',
        source: 'amplifier',
        hookEventName: 'agent_start',
        payload: { agent_name: 'anchors:explorer', subsession_id: 'sub-1' },
        launchToken: 'token-1',
        receivedAt: expect.any(Number)
      }
    ])
  })

  it('picks up a line appended after start(), on the next poll tick', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-bridge-tailer-'))
    const file = join(dir, 'sess-1.jsonl')
    writeFileSync(file, '')
    const { tailer, ingested } = makeTailer(dir)

    tailer.start()
    vi.advanceTimersByTime(300)
    expect(ingested).toHaveLength(0)

    appendFileSync(file, record())
    vi.advanceTimersByTime(300)
    tailer.stop()

    expect(ingested).toHaveLength(1)
  })

  it('never re-ingests bytes already consumed on a prior poll', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-bridge-tailer-'))
    const file = join(dir, 'sess-1.jsonl')
    writeFileSync(file, record({ seq: 0 }))
    const { tailer, ingested } = makeTailer(dir)

    tailer.start()
    vi.advanceTimersByTime(300)
    appendFileSync(file, record({ seq: 1 }))
    vi.advanceTimersByTime(300)
    vi.advanceTimersByTime(300) // a third, no-op tick -- nothing new appended
    tailer.stop()

    expect(ingested).toHaveLength(2)
    expect(ingested.map((r) => (r.payload as { subsession_id: string }).subsession_id)).toEqual([
      'sub-1',
      'sub-1'
    ])
  })

  it('leaves a torn trailing line for the next poll instead of parsing a partial write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-bridge-tailer-'))
    const file = join(dir, 'sess-1.jsonl')
    const whole = record()
    // Simulate a writer mid-append: everything up to (not including) the
    // final newline of a second record.
    const torn = whole + whole.slice(0, -1)
    writeFileSync(file, torn)
    const { tailer, ingested } = makeTailer(dir)

    tailer.start()
    vi.advanceTimersByTime(300)
    expect(ingested).toHaveLength(1) // only the one COMPLETE line

    appendFileSync(file, '\n') // writer finally terminates the second record
    vi.advanceTimersByTime(300)
    tailer.stop()

    expect(ingested).toHaveLength(2)
  })

  it('skips a record with no pane_key -- nothing to attribute it to', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-bridge-tailer-'))
    writeFileSync(join(dir, 'sess-1.jsonl'), record({ pane_key: undefined }))
    const { tailer, ingested } = makeTailer(dir)

    tailer.start()
    vi.advanceTimersByTime(300)
    tailer.stop()

    expect(ingested).toHaveLength(0)
  })

  it('ignores non-.jsonl files in the feed directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-bridge-tailer-'))
    writeFileSync(join(dir, 'not-a-feed.txt'), record())
    const { tailer, ingested } = makeTailer(dir)

    tailer.start()
    vi.advanceTimersByTime(300)
    tailer.stop()

    expect(ingested).toHaveLength(0)
  })

  it('does not throw when the feed directory does not exist yet', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'orca-bridge-tailer-')), 'does-not-exist')
    const { tailer, ingested } = makeTailer(dir)

    tailer.start()
    expect(() => vi.advanceTimersByTime(300)).not.toThrow()
    tailer.stop()

    expect(ingested).toHaveLength(0)
  })

  it('stops polling once stop() is called', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-bridge-tailer-'))
    const file = join(dir, 'sess-1.jsonl')
    writeFileSync(file, '')
    const { tailer, ingested } = makeTailer(dir)

    tailer.start()
    tailer.stop()
    appendFileSync(file, record())
    vi.advanceTimersByTime(1000) // several ticks' worth -- none should fire

    expect(ingested).toHaveLength(0)
  })
})
