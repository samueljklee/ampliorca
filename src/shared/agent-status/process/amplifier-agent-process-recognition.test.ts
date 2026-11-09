import { describe, expect, it } from 'vitest'
import {
  isExpectedAgentProcess,
  recognizeAgentProcess,
  recognizeAgentProcessFromCommandLine
} from './agent-process-recognition'

describe('Amplifier process identity', () => {
  it('keeps the chat CLI distinct from the persistent engine wrapper', () => {
    expect(
      recognizeAgentProcessFromCommandLine('amplifier run --mode chat -- "--print the notes"')
    ).toEqual({ agent: 'amplifier', processName: 'amplifier' })
    expect(recognizeAgentProcess('amplifier-agent-repl')).toEqual({
      agent: 'amplifier-agent',
      processName: 'amplifier-agent-repl'
    })
    expect(isExpectedAgentProcess('amplifier-agent', 'amplifier-agent-repl')).toBe(false)
    expect(isExpectedAgentProcess('node.exe', 'amplifier-agent-repl')).toBe(false)
  })

  it.each([
    'node /repo/config/scripts/amplifier-agent-repl.mjs',
    'node /app/resources/agent-wrappers/amplifier-agent-repl.mjs',
    'node /server/slot/agent-wrappers/amplifier-agent-repl.mjs --resume abc',
    '"/Applications/Orca.app/Contents/MacOS/Orca" "/Applications/Orca.app/Contents/Resources/bin/../agent-wrappers/amplifier-agent-repl.mjs" --resume abc',
    '/opt/orca/orca-ide /opt/orca/resources/agent-wrappers/amplifier-agent-repl.mjs',
    String.raw`"C:\Orca\Orca.exe" "C:\Orca\resources\bin\..\agent-wrappers\amplifier-agent-repl.mjs"`,
    'node /repo/node_modules/.bin/../../config/scripts/amplifier-agent-repl.mjs'
  ])('recognizes only the hosted REPL entrypoint: %s', (command) => {
    expect(recognizeAgentProcessFromCommandLine(command)).toEqual({
      agent: 'amplifier-agent',
      processName: 'amplifier-agent-repl'
    })
  })

  it.each([
    'node /tmp/amplifier-agent-repl.mjs',
    'node /repo/config/scripts/amplifier-agent-repl.mjs.backup',
    'node /repo/config/scripts/not-amplifier-agent-repl.mjs',
    'Orca /tmp/amplifier-agent-repl.mjs',
    'Orca /app/resources/agent-wrappers/amplifier-agent-repl.mjs.backup',
    'node /tmp/server.mjs /repo/config/scripts/amplifier-agent-repl.mjs',
    'node --require /repo/config/scripts/amplifier-agent-repl.mjs /tmp/server.mjs',
    'node --eval "console.log(1)" /repo/config/scripts/amplifier-agent-repl.mjs'
  ])('rejects a lookalike or a script mentioned only as an argument: %s', (command) => {
    expect(recognizeAgentProcessFromCommandLine(command)).toBeNull()
  })
})
