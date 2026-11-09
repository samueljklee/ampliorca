import { join } from 'node:path'
import { expect, it } from 'vitest'
import { parseAmplifierAgentSessionContent } from './session-scanner-amplifier-agent-parser'
import { jsonLines } from '../../session-scanner-test-fixtures'
import { withFullFirstUserPromptCapture } from '../../session-scanner-first-user-prompt-capture'
import type { TranscriptMessage } from '../../transcripts/session-transcript-consumers'

it('never counts, captures or publishes ephemeral reminders as user prompts', async () => {
  const messages: TranscriptMessage[] = []
  const session = await withFullFirstUserPromptCapture(async () =>
    parseAmplifierAgentSessionContent(
      {
        path: join('/fixtures', 's1', 'context-intelligence', 'metadata.json'),
        mtimeMs: 0,
        modifiedAt: '2026-05-01T10:00:00.000Z'
      },
      JSON.stringify({ session_id: 's1', started_at: '2026-05-01T10:00:00.000Z' }),
      jsonLines([
        { role: 'user', content: 'Injected reminder', metadata: { ephemeral: true } },
        { role: 'user', content: 'The actual question' },
        { role: 'assistant', content: 'The answer' }
      ]),
      'darwin',
      { active: true, push: (message) => messages.push(message) }
    )
  )
  expect(session).toMatchObject({
    title: 'The actual question',
    firstUserPrompt: 'The actual question',
    messageCount: 2
  })
  expect(session?.previewMessages.map((message) => message.text)).toEqual([
    'The actual question',
    'The answer'
  ])
  expect(messages.map((message) => message.text)).toEqual(['The actual question', 'The answer'])
})
