import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BridgeFeedWakeup } from './bridge-feed-wakeup'
import { readBridgeFeedLines } from './bridge-feed-lines'

import type { SpoolRecord } from '../../shared/agent-hook-listener/transport/agent-hook-spool'

export const AMPLIFIER_BRIDGE_DEFAULT_FEED_DIR = join(homedir(), '.ampliorca', 'orca-bridge')

export class AmplifierBridgeTailer {
  private readonly feedDir: string
  private readonly ingest: (record: SpoolRecord, isCurrent: () => boolean) => void | Promise<void>
  private readonly offsetByPath = new Map<string, number>()
  private active = false
  private generation = 0
  private starting: Promise<void> | null = null
  private readonly wakeup: BridgeFeedWakeup

  constructor(
    ingest: (record: SpoolRecord, isCurrent: () => boolean) => void | Promise<void>,
    feedDir: string = AMPLIFIER_BRIDGE_DEFAULT_FEED_DIR
  ) {
    this.ingest = ingest
    this.feedDir = feedDir
    this.wakeup = new BridgeFeedWakeup(
      () => [this.feedDir],
      () => this.pollOnce(this.generation),
      (error) => console.error('[amplifier-bridge] read failed', error)
    )
  }

  async start(options?: { skipExisting?: boolean }): Promise<void> {
    if (this.active) {
      return this.starting ?? undefined
    }
    this.active = true
    const generation = this.generation
    const pending = (async () => {
      if (options?.skipExisting) {
        for (const name of await readdir(this.feedDir).catch(() => [])) {
          if (name.endsWith('.jsonl')) {
            const path = join(this.feedDir, name)
            const size = await stat(path).then(
              (entry) => entry.size,
              () => 0
            )
            if (generation !== this.generation) {
              return
            }
            this.offsetByPath.set(path, size)
          }
        }
      }
      if (this.active && generation === this.generation) {
        this.wakeup.start()
      }
    })()
    this.starting = pending
    await pending
  }

  stop(): void {
    this.generation += 1
    this.active = false
    this.starting = null
    this.wakeup.stop()
  }

  async flush(): Promise<void> {
    await this.starting
    await this.wakeup.flush()
  }

  private async pollOnce(generation: number): Promise<boolean> {
    let names: string[]
    try {
      names = await readdir(this.feedDir)
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      ) {
        return false
      }
      throw error
    }
    let changed = false
    for (const name of names) {
      if (!name.endsWith('.jsonl')) {
        continue
      }
      if (generation !== this.generation) {
        return changed
      }
      changed = (await this.pollFile(join(this.feedDir, name), generation)) || changed
    }
    return changed
  }

  private async pollFile(path: string, generation: number): Promise<boolean> {
    const isCurrent = () => this.active && generation === this.generation
    const previousOffset = this.offsetByPath.get(path) ?? 0
    try {
      const offset = await readBridgeFeedLines(
        path,
        previousOffset,
        isCurrent,
        async (line, through) => {
          if (line) {
            await this.processLine(line, isCurrent)
          }
          if (isCurrent()) {
            this.offsetByPath.set(path, through)
          }
        }
      )
      if (isCurrent()) {
        this.offsetByPath.set(path, offset)
      }
      return offset !== previousOffset
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      ) {
        return false
      }
      throw error
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
    const envelope = record
    const paneKey =
      'pane_key' in envelope && typeof envelope.pane_key === 'string'
        ? envelope.pane_key.trim()
        : ''
    if (!paneKey) {
      // Amplifier running outside Orca (or an old bridge version pre-dating
      // pane_key) writes feed files with no pane to attribute to -- correctly
      // invisible to Orca, not an error.
      return
    }
    const hookEventName =
      'type' in envelope && typeof envelope.type === 'string' ? envelope.type : ''
    if (!hookEventName) {
      return
    }
    const payload =
      'data' in envelope && envelope.data && typeof envelope.data === 'object' ? envelope.data : {}
    const launchToken =
      'launch_token' in envelope && typeof envelope.launch_token === 'string'
        ? envelope.launch_token
        : undefined

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
