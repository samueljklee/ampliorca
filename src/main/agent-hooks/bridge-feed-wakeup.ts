import { watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, relative, sep } from 'node:path'
import { closeFileSystemWatcher } from '../ipc/filesystem/watcher-process/rebinding-file-watch'
import { nextRetryDelayMs } from '../sqlite/row-cache/row-cache-failure'

const RETRY = { minMs: 300, maxMs: 30_000 }

/** Directory events survive file replacement; idle healthy watches need no recurring timer. */
export class BridgeFeedWakeup {
  private readonly watches = new Map<string, { watcher: FSWatcher; root: string }>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private active = false
  private generation = 0
  private work: Promise<void> | null = null
  private requested = false
  private delayMs = 0

  constructor(
    private readonly directories: () => string[],
    private readonly drain: () => Promise<boolean>,
    private readonly onError: (error: unknown) => void
  ) {}

  start(): void {
    if (!this.active) {
      this.active = true
      this.wake()
    }
  }

  stop(): void {
    this.active = false
    this.generation += 1
    clearTimeout(this.timer)
    this.timer = undefined
    for (const entry of this.watches.values()) {
      void closeFileSystemWatcher(entry.watcher)
    }
    this.watches.clear()
  }

  wake(): void {
    this.delayMs = 0
    if (this.active) {
      void this.flush().catch(this.onError)
    }
  }

  async flush(): Promise<void> {
    if (!this.active) {
      return
    }
    this.requested = true
    if (this.work) {
      await this.work
      // A stopped generation may still have been draining when this one started.
      if (this.active && this.requested) {
        return this.flush()
      }
      return
    }
    clearTimeout(this.timer)
    this.timer = undefined
    const generation = this.generation
    const current = () => this.active && generation === this.generation
    const pending = (async () => {
      let changed = false
      let bound = false
      try {
        do {
          this.requested = false
          bound = await this.refreshWatches(current)
          if (!current()) {
            return
          }
          changed = (await this.drain()) || changed
        } while (this.requested && current())
      } finally {
        if (current() && this.directories().length) {
          this.delayMs = changed ? RETRY.minMs : nextRetryDelayMs(this.delayMs, RETRY)
          if (!bound || changed || this.delayMs < RETRY.maxMs) {
            this.timer = setTimeout(() => {
              this.timer = undefined
              void this.flush().catch(this.onError)
            }, this.delayMs)
            this.timer.unref()
          }
        }
      }
    })()
    this.work = pending
    try {
      await pending
    } finally {
      if (this.work === pending) {
        this.work = null
      }
    }
  }

  private async refreshWatches(isCurrent: () => boolean): Promise<boolean> {
    const directories = new Set(this.directories())
    for (const [directory, entry] of this.watches) {
      if (!directories.has(directory)) {
        this.watches.delete(directory)
        void closeFileSystemWatcher(entry.watcher)
      }
    }
    let bound = true
    for (const directory of directories) {
      let root = directory
      while (true) {
        try {
          if ((await stat(root)).isDirectory()) {
            break
          }
        } catch {}
        const parent = dirname(root)
        if (parent === root || !isCurrent()) {
          return false
        }
        root = parent
      }
      if (!isCurrent()) {
        return false
      }
      bound &&= root === directory
      const previous = this.watches.get(directory)
      if (previous?.root === root) {
        continue
      }
      if (previous) {
        this.watches.delete(directory)
        void closeFileSystemWatcher(previous.watcher)
      }
      try {
        const child = relative(root, directory).split(sep)[0]
        const watcher = watch(root, { persistent: false }, (_event, name) => {
          if (isCurrent() && (!child || name === null || name.toString() === child)) {
            this.wake()
          }
        })
        watcher.on('error', () => {
          if (this.watches.get(directory)?.watcher === watcher) {
            this.watches.delete(directory)
            void closeFileSystemWatcher(watcher)
            this.wake()
          }
        })
        this.watches.set(directory, { watcher, root })
      } catch {
        bound = false
      }
    }
    return bound
  }
}
