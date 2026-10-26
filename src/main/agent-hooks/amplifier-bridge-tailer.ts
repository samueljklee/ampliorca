// Why: Amplifier is not a push-hook agent -- there is no hook script calling
// out to this server. Its activity feed is a per-session JSONL file
// (hooks-orca-bridge, an Amplifier-side module) that this tailer polls for
// new appended lines and converts into the same SpoolRecord shape the
// existing spool-replay path already knows how to ingest.
//
// Pane attribution does NOT need any reverse lookup: hooks-orca-bridge reads
// ORCA_PANE_KEY directly from its own process environment (confirmed against
// Orca's own source -- the same env var Orca's CLI handlers read via
// process.env.ORCA_PANE_KEY) and carries it on every record as `pane_key`.
// This deliberately avoids touching Orca's PTY-creation code at all.
//
// Polling, not fs.watch: fs.watch's cross-platform quirks (double-fires,
// missed events under load, different semantics per OS) make it a worse fit
// here than a small, predictable interval -- this is a low-frequency status
// feed, not a hot path.

import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { SpoolRecord } from '../../shared/agent-hook-spool'

export const AMPLIFIER_BRIDGE_DEFAULT_FEED_DIR = join(homedir(), '.ampliorca', 'orca-bridge')
const POLL_INTERVAL_MS = 300

export class AmplifierBridgeTailer {
  private readonly feedDir: string
  private readonly ingest: (record: SpoolRecord, isCurrent: () => boolean) => void | Promise<void>
  private readonly offsetByPath = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | null = null
  private generation = 0
  private polling = false

  constructor(
    ingest: (record: SpoolRecord, isCurrent: () => boolean) => void | Promise<void>,
    feedDir: string = AMPLIFIER_BRIDGE_DEFAULT_FEED_DIR
  ) {
    this.ingest = ingest
    this.feedDir = feedDir
  }

  start(options?: { skipExisting?: boolean }): void {
    if (this.timer) {
      return
    }
    if (options?.skipExisting) {
      try {
        for (const name of readdirSync(this.feedDir)) {
          if (name.endsWith('.jsonl')) {
            const path = join(this.feedDir, name)
            this.offsetByPath.set(path, statSync(path).size)
          }
        }
      } catch {
        // No feed yet.
      }
    }
    this.timer = setInterval(() => {
      if (!this.polling) {
        this.polling = true
        void this.pollOnce(this.generation)
          .catch((error: unknown) => console.error('[amplifier-bridge] poll failed', error))
          .finally(() => {
            this.polling = false
          })
      }
    }, POLL_INTERVAL_MS)
    // Why: a background status poller must never be the reason the process stays alive.
    this.timer.unref()
  }

  stop(): void {
    this.generation += 1
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async pollOnce(generation: number): Promise<void> {
    let names: string[]
    try {
      names = readdirSync(this.feedDir)
    } catch {
      // Feed dir doesn't exist yet (no Amplifier session has run since Orca
      // started) -- not an error, just try again next tick.
      return
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) {
        continue
      }
      if (generation !== this.generation) {
        return
      }
      await this.pollFile(join(this.feedDir, name), generation)
    }
  }

  private async pollFile(path: string, generation: number): Promise<void> {
    let size: number
    try {
      size = statSync(path).size
    } catch {
      return
    }
    const previousOffset = this.offsetByPath.get(path) ?? 0
    if (size <= previousOffset) {
      // No growth. A shrink (truncate/rotate) is treated the same as "nothing
      // new yet" -- hooks-orca-bridge only ever appends, so this shouldn't
      // happen in practice; if it does, silently resetting to size avoids
      // reprocessing old bytes as if they were new.
      if (size < previousOffset) {
        this.offsetByPath.set(path, size)
      }
      return
    }
    let fd: number
    try {
      fd = openSync(path, 'r')
    } catch {
      return
    }
    try {
      const toRead = size - previousOffset
      const buffer = Buffer.alloc(toRead)
      readSync(fd, buffer, 0, toRead, previousOffset)
      const text = buffer.toString('utf8')
      const lines = text.split('\n')
      // The last element is either '' (chunk ended exactly on a newline) or a
      // torn trailing line still being written -- never process it; only
      // advance the offset through the end of the last COMPLETE line.
      const completeLines = lines.slice(0, -1)
      let consumedBytes = 0
      for (const line of completeLines) {
        if (generation !== this.generation) {
          return
        }
        consumedBytes += Buffer.byteLength(line, 'utf8') + 1 // +1 for the newline itself
        if (line.length > 0) {
          const pending = this.processLine(line, () => generation === this.generation)
          if (pending) {
            await pending
          }
        }
        if (generation !== this.generation) {
          return
        }
        this.offsetByPath.set(path, previousOffset + consumedBytes)
      }
    } finally {
      closeSync(fd)
    }
  }

  private processLine(line: string, isCurrent: () => boolean): void | Promise<void> {
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      return
    }
    if (typeof record !== 'object' || record === null) {
      return
    }
    const envelope = record as Record<string, unknown>
    const paneKey = typeof envelope.pane_key === 'string' ? envelope.pane_key.trim() : ''
    if (!paneKey) {
      // Amplifier running outside Orca (or an old bridge version pre-dating
      // pane_key) writes feed files with no pane to attribute to -- correctly
      // invisible to Orca, not an error.
      return
    }
    const hookEventName = typeof envelope.type === 'string' ? envelope.type : ''
    if (!hookEventName) {
      return
    }
    const payload =
      envelope.data && typeof envelope.data === 'object'
        ? (envelope.data as Record<string, unknown>)
        : {}
    const launchToken =
      typeof envelope.launch_token === 'string' ? envelope.launch_token : undefined

    return this.ingest(
      {
        paneKey,
        source: 'amplifier',
        hookEventName,
        payload,
        launchToken,
        receivedAt: Date.now()
      },
      isCurrent
    )
  }
}
