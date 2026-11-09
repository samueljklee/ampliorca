import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { BridgeFeedWakeup } from './bridge-feed-wakeup'
import { readBridgeFeedLines } from './bridge-feed-lines'

import type { SpoolRecord } from '../../shared/agent-hook-listener/transport/agent-hook-spool'
import {
  AMPLIFIER_AGENT_DEFAULT_HOME,
  prepareAmplifierAgentFeed,
  type AmplifierAgentFeedOptions
} from './amplifier-agent-feed'

export { amplifierAgentEventsPath, amplifierAgentWorkspaceSlug } from './amplifier-agent-feed'

type RegisteredSession = {
  paneKey: string
  sessionId: string
  launchToken?: string
  offset: number
  delegateOffsets: Map<string, number>
}

export class AmplifierAgentBridgeTailer {
  private readonly ingest: (record: SpoolRecord, isCurrent: () => boolean) => void | Promise<void>
  private readonly amplifierAgentHome: string
  private readonly sessionsByPath = new Map<string, RegisteredSession>()
  private active = false
  private generation = 0
  private starting: Promise<void> | null = null
  private readonly registrations = new Map<string, symbol>()
  private readonly wakeup = new BridgeFeedWakeup(
    () => [...this.sessionsByPath.keys()].map(dirname),
    () => this.pollOnce(this.generation),
    (error) => console.error('[amplifier-agent-bridge] read failed', error)
  )

  constructor(
    ingest: (record: SpoolRecord, isCurrent: () => boolean) => void | Promise<void>,
    amplifierAgentHome: string = AMPLIFIER_AGENT_DEFAULT_HOME
  ) {
    this.ingest = ingest
    this.amplifierAgentHome = amplifierAgentHome
  }

  async registerSession(
    paneKey: string,
    cwd: string,
    sessionId: string,
    options?: AmplifierAgentFeedOptions
  ): Promise<void> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(sessionId)) {
      return
    }
    this.unregisterSession(paneKey)
    const registration = Symbol()
    const generation = this.generation
    this.registrations.set(paneKey, registration)
    const { path, offset } =
      options?.feed ??
      (await prepareAmplifierAgentFeed(cwd, sessionId, {
        home: this.amplifierAgentHome,
        ...options
      }))
    if (generation !== this.generation || this.registrations.get(paneKey) !== registration) {
      return
    }
    this.sessionsByPath.set(path, {
      paneKey,
      sessionId,
      launchToken: options?.launchToken,
      offset,
      delegateOffsets: new Map()
    })
    this.wakeup.wake()
  }

  admitWrapper(paneKey: string, sessionId: string): { launchToken?: string } | undefined {
    for (const session of this.sessionsByPath.values()) {
      if (session.paneKey === paneKey && session.sessionId === sessionId) {
        return { launchToken: session.launchToken }
      }
    }
    return undefined
  }

  delegatesThrough(paneKey: string, from: number, through: number): ReadonlySet<string> {
    const ids = new Set<string>()
    for (const session of this.sessionsByPath.values()) {
      if (session.paneKey === paneKey) {
        for (const [id, offset] of session.delegateOffsets) {
          if (offset > from && offset <= through) {
            ids.add(id)
          }
        }
      }
    }
    return ids
  }

  sessionIdForPane(
    paneKey: string,
    resolvePaneKey: (key: string) => string = (key) => key
  ): string | undefined {
    for (const session of this.sessionsByPath.values()) {
      if (resolvePaneKey(session.paneKey) === paneKey) {
        return session.sessionId
      }
    }
    return undefined
  }

  unregisterSession(paneKey: string, resolvePaneKey: (key: string) => string = (key) => key): void {
    for (const key of this.registrations.keys()) {
      if (resolvePaneKey(key) === paneKey) {
        this.registrations.delete(key)
      }
    }
    for (const [path, session] of this.sessionsByPath) {
      if (resolvePaneKey(session.paneKey) === paneKey) {
        this.sessionsByPath.delete(path)
      }
    }
    this.wakeup.wake()
  }

  unregisterTab(tabId: string): void {
    for (const key of this.registrations.keys()) {
      if (key.startsWith(`${tabId}:`)) {
        this.registrations.delete(key)
      }
    }
    for (const [path, session] of this.sessionsByPath) {
      if (session.paneKey.startsWith(`${tabId}:`)) {
        this.sessionsByPath.delete(path)
      }
    }
    this.wakeup.wake()
  }

  async start(options?: { skipExisting?: boolean }): Promise<void> {
    if (this.active) {
      return this.starting ?? undefined
    }
    this.active = true
    const generation = this.generation
    const pending = (async () => {
      if (options?.skipExisting) {
        for (const [path, session] of this.sessionsByPath) {
          const size = await stat(path).then(
            (entry) => entry.size,
            () => 0
          )
          if (generation !== this.generation) {
            return
          }
          if (this.sessionsByPath.get(path) === session) {
            session.offset = size
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

  stop(clearSessions = false): void {
    this.generation += 1
    this.active = false
    this.starting = null
    this.registrations.clear()
    this.wakeup.stop()
    if (clearSessions) {
      this.sessionsByPath.clear()
    }
  }

  async flush(): Promise<void> {
    await this.starting
    await this.wakeup.flush()
  }

  private async pollOnce(generation: number): Promise<boolean> {
    let changed = false
    for (const [path, session] of this.sessionsByPath) {
      if (generation !== this.generation) {
        return changed
      }
      changed = (await this.pollFile(path, session, generation)) || changed
    }
    return changed
  }

  private async pollFile(
    path: string,
    session: RegisteredSession,
    generation: number
  ): Promise<boolean> {
    const isCurrent = () =>
      this.active && generation === this.generation && this.sessionsByPath.get(path) === session
    const previousOffset = session.offset
    try {
      const offset = await readBridgeFeedLines(
        path,
        previousOffset,
        isCurrent,
        async (line, through) => {
          if (line) {
            await this.processLine(line, session, through, isCurrent)
          }
          if (isCurrent()) {
            session.offset = through
          }
        }
      )
      if (isCurrent()) {
        session.offset = offset
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

  private processLine(
    line: string,
    session: RegisteredSession,
    offset: number,
    isCurrent: () => boolean
  ): void | Promise<void> {
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
    const hookEventName =
      'event' in envelope && typeof envelope.event === 'string' ? envelope.event : ''
    if (!hookEventName) {
      return
    }
    const payload =
      'data' in envelope && envelope.data && typeof envelope.data === 'object' ? envelope.data : {}
    if (
      (hookEventName === 'delegate:agent_spawned' || hookEventName === 'delegate:agent_resumed') &&
      'sub_session_id' in payload &&
      typeof payload.sub_session_id === 'string'
    ) {
      session.delegateOffsets.set(payload.sub_session_id, offset)
    }
    return this.ingest(
      {
        paneKey: session.paneKey,
        ...(session.launchToken ? { launchToken: session.launchToken } : {}),
        source: 'amplifier-agent',
        hookEventName,
        payload,
        receivedAt: Date.now()
      },
      isCurrent
    )
  }
}
