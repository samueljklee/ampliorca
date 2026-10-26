import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  readAgentProcess,
  probeAgentProcessPresence
} from '../../shared/agent-process-presence-probe'
import { readAgentProcessIdentity } from '../../shared/agent-process-presence'
import {
  readAmplifierAgentWrapperBinding,
  type AmplifierAgentWrapperBinding
} from '../../shared/amplifier-agent-turn-settlement'

export type AmplifierAgentTerminalBinding = { ptyId: string; incarnationId: string }

function bindingPath(directory: string, paneKey: string): string {
  return join(
    directory,
    `amplifier-agent-${createHash('sha256').update(paneKey).digest('hex')}.json`
  )
}

export async function persistAmplifierAgentWrapperBinding(
  directory: string,
  wrapper: AmplifierAgentWrapperBinding,
  terminal: AmplifierAgentTerminalBinding,
  isCurrent: () => boolean
): Promise<boolean> {
  const observation = await readAgentProcess(wrapper.pid)
  if (observation.verdict !== 'live' || observation.zombie || !isCurrent()) {
    return false
  }
  const processIdentity = readAgentProcessIdentity({
    pid: wrapper.pid,
    platform: process.platform,
    startTime: observation.startTime
  })
  if (!processIdentity) {
    return false
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (!isCurrent()) {
    return false
  }
  await writeFile(
    bindingPath(directory, wrapper.paneKey),
    JSON.stringify({ wrapper, terminal, processIdentity }),
    { mode: 0o600 }
  )
  return true
}

export async function restoreAmplifierAgentWrapperBinding(
  directory: string,
  paneKey: string,
  terminal: AmplifierAgentTerminalBinding
): Promise<AmplifierAgentWrapperBinding | undefined> {
  try {
    const saved = JSON.parse(await readFile(bindingPath(directory, paneKey), 'utf8'))
    const wrapper = readAmplifierAgentWrapperBinding(saved.wrapper)
    const identity = readAgentProcessIdentity(saved.processIdentity)
    if (
      !wrapper ||
      wrapper.paneKey !== paneKey ||
      !identity ||
      identity.pid !== wrapper.pid ||
      saved.terminal?.ptyId !== terminal.ptyId ||
      saved.terminal?.incarnationId !== terminal.incarnationId ||
      (await probeAgentProcessPresence(identity)) !== 'live'
    ) {
      return
    }
    return wrapper
  } catch {
    /* Missing or unproven bindings cannot authorize reattachment. */
    return undefined
  }
}
