import {
  buildSpoolHookBody,
  type SpoolRecord
} from '../../../shared/agent-hook-listener/transport/agent-hook-spool'
import { isAgentHookSource } from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import {
  type PrefetchedRolloutReads,
  withPrefetchedRolloutReads
} from '../../../shared/agent-hook-listener/providers/codex/codex-rollout-prefetch-scope'
import { AgentHookServerIngestNormalization } from './server-ingest-normalization'

export abstract class AgentHookServerIngestLiveFile extends AgentHookServerIngestNormalization {
  /** File-tail observations use live hook admission and replies, never spool replay authority. */
  ingestLiveFileRecord(
    record: SpoolRecord,
    isCurrent: () => boolean = () => true
  ): Promise<void> | void {
    if (!isCurrent() || !this.statusHooksEnabled || !isAgentHookSource(record.source)) {
      return
    }
    const source = record.source
    const token = this.token
    const generation = this.statusHookGeneration
    const body = this.normalizeHookBodyPaneKeyAlias(buildSpoolHookBody(record))
    const apply = (reads?: PrefetchedRolloutReads) => {
      if (
        isCurrent() &&
        this.statusHooksEnabled &&
        this.token === token &&
        this.statusHookGeneration === generation
      ) {
        withPrefetchedRolloutReads(reads, () => this.ingestLocalHook(source, body))
      }
    }
    const pending = this.checkHookOwner(source, body)
    if (source === 'codex') {
      return Promise.resolve(pending).then(async () => {
        const prefetch = await this.codexRolloutPrefetcher.prefetch(this.state, body)
        try {
          apply(prefetch?.reads)
        } finally {
          prefetch?.release()
        }
      })
    }
    return pending ? pending.then(() => apply()) : apply()
  }
}
