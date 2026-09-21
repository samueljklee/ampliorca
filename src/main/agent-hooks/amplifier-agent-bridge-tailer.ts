import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { SpoolRecord } from '../../shared/agent-hook-spool'

export const AMPLIFIER_AGENT_DEFAULT_HOME = join(homedir(), '.amplifier-agent')
const POLL_INTERVAL_MS = 300

export function amplifierAgentWorkspaceSlug(cwd: string): string {
  const slug = cwd.replaceAll('\\', '/').replaceAll('/', '-')
  return slug.startsWith('-') ? slug : `-${slug}`
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
  offset: number
}

export class AmplifierAgentBridgeTailer {
  private readonly ingest: (record: SpoolRecord) => void
  private readonly amplifierAgentHome: string
  private readonly sessionsByPath = new Map<string, RegisteredSession>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    ingest: (record: SpoolRecord) => void,
    amplifierAgentHome: string = AMPLIFIER_AGENT_DEFAULT_HOME
  ) {
    this.ingest = ingest
    this.amplifierAgentHome = amplifierAgentHome
  }

  registerSession(paneKey: string, cwd: string, sessionId: string): void {
    this.unregisterSession(paneKey)
    this.sessionsByPath.set(amplifierAgentEventsPath(this.amplifierAgentHome, cwd, sessionId), {
      paneKey,
      offset: 0
    })
  }

  unregisterSession(paneKey: string): void {
    for (const [path, session] of this.sessionsByPath) {
      if (session.paneKey === paneKey) {
        this.sessionsByPath.delete(path)
      }
    }
  }

  start(): void {
    if (this.timer) {
      return
    }
    this.timer = setInterval(() => this.pollOnce(), POLL_INTERVAL_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.sessionsByPath.clear()
  }

  private pollOnce(): void {
    for (const [path, session] of this.sessionsByPath) {
      this.pollFile(path, session)
    }
  }

  private pollFile(path: string, session: RegisteredSession): void {
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
        consumedBytes += Buffer.byteLength(line, 'utf8') + 1
        if (line.length > 0) {
          this.processLine(line, session.paneKey)
        }
      }
      session.offset = previousOffset + consumedBytes
    } finally {
      closeSync(fd)
    }
  }

  private processLine(line: string, paneKey: string): void {
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
    const hookEventName = typeof envelope.event === 'string' ? envelope.event : ''
    if (!hookEventName) {
      return
    }
    const payload =
      envelope.data && typeof envelope.data === 'object'
        ? (envelope.data as Record<string, unknown>)
        : {}
    this.ingest({
      paneKey,
      source: 'amplifier-agent',
      hookEventName,
      payload,
      receivedAt: Date.now()
    })
  }
}
