import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import type { SpoolRecord } from '../../shared/agent-hook-spool'

export const AMPLIFIER_AGENT_DEFAULT_HOME = join(homedir(), '.amplifier-agent')
const POLL_INTERVAL_MS = 300

export function amplifierAgentWorkspaceSlug(cwd: string): string {
  // The REPL passes --workspace basename(cwd), not the Python CLI's full-path slug.
  return basename(cwd.replaceAll('\\', '/')) || 'amplifier-agent-orca'
}

export function amplifierAgentEventsPath(
  amplifierAgentHome: string,
  cwd: string,
  sessionId: string
): string {
  return join(
    amplifierAgentHome,
    'state',
    'workspaces',
    amplifierAgentWorkspaceSlug(cwd),
    'sessions',
    sessionId,
    'context-intelligence',
    'events.jsonl'
  )
}

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
  private timer: ReturnType<typeof setInterval> | null = null
  private generation = 0
  private polling: Promise<void> | null = null

  constructor(
    ingest: (record: SpoolRecord, isCurrent: () => boolean) => void | Promise<void>,
    amplifierAgentHome: string = AMPLIFIER_AGENT_DEFAULT_HOME
  ) {
    this.ingest = ingest
    this.amplifierAgentHome = amplifierAgentHome
  }

  registerSession(
    paneKey: string,
    cwd: string,
    sessionId: string,
    options?: { home?: string; launchToken?: string; resume?: boolean; workspace?: string }
  ): void {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(sessionId)) {
      return
    }
    this.unregisterSession(paneKey)
    const home = resolve(cwd, options?.home ?? this.amplifierAgentHome)
    let path = amplifierAgentEventsPath(home, cwd, sessionId)
    if (options?.workspace && !/[/\\]/.test(options.workspace) && options.workspace !== '..') {
      path = join(
        home,
        'state',
        'workspaces',
        options.workspace,
        'sessions',
        sessionId,
        'context-intelligence',
        'events.jsonl'
      )
    } else if (options?.resume) {
      const root = join(home, 'state', 'workspaces')
      try {
        const workspace = readdirSync(root).find((name) =>
          existsSync(join(root, name, 'sessions', sessionId))
        )
        if (workspace) {
          path = join(
            root,
            workspace,
            'sessions',
            sessionId,
            'context-intelligence',
            'events.jsonl'
          )
        }
      } catch {
        // Match the REPL's basename fallback when the resumed session is missing.
      }
    }
    let offset = 0
    if (options?.resume) {
      try {
        offset = statSync(path).size
      } catch {
        /* Session has no feed yet. */
      }
    }
    this.sessionsByPath.set(path, {
      paneKey,
      sessionId,
      launchToken: options?.launchToken,
      offset,
      delegateOffsets: new Map()
    })
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
    for (const [path, session] of this.sessionsByPath) {
      if (resolvePaneKey(session.paneKey) === paneKey) {
        this.sessionsByPath.delete(path)
      }
    }
  }

  start(options?: { skipExisting?: boolean }): void {
    if (this.timer) {
      return
    }
    if (options?.skipExisting) {
      for (const [path, session] of this.sessionsByPath) {
        try {
          session.offset = statSync(path).size
        } catch {
          /* No feed yet. */
        }
      }
    }
    this.timer = setInterval(() => {
      if (!this.polling) {
        void this.flush().catch((error: unknown) =>
          console.error('[amplifier-agent-bridge] poll failed', error)
        )
      }
    }, POLL_INTERVAL_MS)
    this.timer.unref()
  }

  stop(clearSessions = false): void {
    this.generation += 1
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (clearSessions) {
      this.sessionsByPath.clear()
    }
  }

  async flush(): Promise<void> {
    if (this.polling) {
      await this.polling
      return this.flush()
    }
    if (!this.timer) {
      return
    }
    const pending = this.pollOnce(this.generation)
    this.polling = pending
    try {
      await pending
    } finally {
      if (this.polling === pending) {
        this.polling = null
      }
    }
  }

  private async pollOnce(generation: number): Promise<void> {
    for (const [path, session] of this.sessionsByPath) {
      if (generation !== this.generation) {
        return
      }
      await this.pollFile(path, session, generation)
    }
  }

  private async pollFile(
    path: string,
    session: RegisteredSession,
    generation: number
  ): Promise<void> {
    let size: number
    try {
      size = statSync(path).size
    } catch {
      return
    }
    const previousOffset = session.offset
    if (size <= previousOffset) {
      if (size < previousOffset) {
        session.offset = size
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
      const lines = buffer.toString('utf8').split('\n')
      const completeLines = lines.slice(0, -1)
      let consumedBytes = 0
      for (const line of completeLines) {
        if (generation !== this.generation || this.sessionsByPath.get(path) !== session) {
          return
        }
        consumedBytes += Buffer.byteLength(line, 'utf8') + 1
        if (line.length > 0) {
          const pending = this.processLine(
            line,
            session,
            previousOffset + consumedBytes,
            () => generation === this.generation && this.sessionsByPath.get(path) === session
          )
          if (pending) {
            await pending
          }
        }
        if (generation !== this.generation || this.sessionsByPath.get(path) !== session) {
          return
        }
        session.offset = previousOffset + consumedBytes
      }
    } finally {
      closeSync(fd)
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
