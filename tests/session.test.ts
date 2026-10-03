import assert from 'node:assert/strict'
import test from 'node:test'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RconSession } from '../src/session.ts'
import type { RconAgent, RconDiagnostics, ResolvedConfig, ResolvedServer } from '../src/types.ts'
import { delay, startFakeServer, withDeadline } from './fake-server.ts'

/** An agent double that records how each feedback message was delivered. */
class RecordingAgent implements RconAgent {
  readonly session = { id: SessionId('test-session') }
  readonly injected: UserMessage[] = []
  readonly followed: UserMessage[] = []
  inject(message: UserMessage): void { this.injected.push(message) }
  followup(message: UserMessage): void { this.followed.push(message) }
}

/** The text of one delivered message, or '' when it carries none. */
function textOf(message: UserMessage | undefined): string {
  const [first] = message?.content ?? []
  return first?.type === 'text' ? first.text : ''
}

/** Build a resolved config with timings short enough for a test. */
function testConfig(servers: ResolvedServer[], overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  const [first] = servers
  assert.ok(first !== undefined)
  return {
    servers,
    defaultServer: first.name,
    idleTimeoutMs: 60_000,
    defaultWaitMs: 50,
    feedbackBatchMs: 30,
    connectTimeoutMs: 2000,
    allowedPrefixes: [],
    otherwise: 'deny',
    ...overrides,
  }
}

/** Diagnostics that record instead of printing. */
function diagnostics(log: string[]): RconDiagnostics {
  return { logger: { debug: (message: string) => { log.push(message) } } }
}

/** Wait until `ready` holds, so a test observes delivery instead of sleeping. */
async function until(ready: () => boolean, label: string): Promise<void> {
  await withDeadline((async () => {
    while (!ready()) await delay(5)
  })(), label)
}

test('reuses one link for repeated commands to the same server', async (t) => {
  const server = await startFakeServer()
  t.after(() => server.close())
  const session = new RconSession(diagnostics([]), new RecordingAgent(), testConfig([
    { name: 'main', host: '127.0.0.1', port: server.port, password: 'secret' },
  ]))
  t.after(() => { session.dispose() })

  assert.deepEqual(
    await session.runCommand('main', 'one', 50, undefined, AbortSignal.timeout(2000)),
    { server: 'main', requestId: 1, messages: ['ack:one'] },
  )
  assert.deepEqual(
    await session.runCommand('main', 'two', 50, undefined, AbortSignal.timeout(2000)),
    { server: 'main', requestId: 2, messages: ['ack:two'] },
  )
  assert.equal(server.connections, 1)
})

test('each configured server gets its own link', async (t) => {
  const first = await startFakeServer()
  const second = await startFakeServer()
  t.after(() => first.close())
  t.after(() => second.close())
  const session = new RconSession(diagnostics([]), new RecordingAgent(), testConfig([
    { name: 'main', host: '127.0.0.1', port: first.port, password: 'secret' },
    { name: 'creative', host: '127.0.0.1', port: second.port, password: 'secret' },
  ]))
  t.after(() => { session.dispose() })

  assert.deepEqual(
    await session.runCommand('main', 'one', 50, undefined, AbortSignal.timeout(2000)),
    { server: 'main', requestId: 1, messages: ['ack:one'] },
  )
  assert.deepEqual(
    await session.runCommand('creative', 'two', 50, undefined, AbortSignal.timeout(2000)),
    { server: 'creative', requestId: 1, messages: ['ack:two'] },
  )
  assert.equal(first.connections, 1)
  assert.equal(second.connections, 1)
  assert.deepEqual(first.commands, ['one'])
  assert.deepEqual(second.commands, ['two'])
})

test('an unconfigured server name names the configured ones', async (t) => {
  const session = new RconSession(diagnostics([]), new RecordingAgent(), testConfig([
    { name: 'main', host: '127.0.0.1', port: 1, password: 'secret' },
  ]))
  t.after(() => { session.dispose() })

  await assert.rejects(
    session.runCommand('nope', 'list', 0, undefined, AbortSignal.timeout(2000)),
    /unknown server "nope"; configured servers are main/,
  )
})

test('post-window feedback is injected by default, labelled with server and request id', async (t) => {
  const server = await startFakeServer({ pushDelayMs: 20 })
  t.after(() => server.close())
  const agent = new RecordingAgent()
  const session = new RconSession(diagnostics([]), agent, testConfig([
    { name: 'main', host: '127.0.0.1', port: server.port, password: 'secret' },
    // A wide merge window keeps the assertions independent of timer-versus-I/O
    // phase ordering under a loaded test runner.
  ], { feedbackBatchMs: 250 }))
  t.after(() => { session.dispose() })

  // A zero window sends every message down the post-window path.
  assert.deepEqual(
    await session.runCommand('main', 'list', 0, undefined, AbortSignal.timeout(2000)),
    { server: 'main', requestId: 1, messages: [] },
  )
  await until(() => agent.injected.length === 1, 'one injected group')

  const [message] = agent.injected
  assert.deepEqual(agent.followed, [])
  assert.equal(message?.source.kind, 'dsh-rcon')
  assert.match(textOf(message), /^Minecraft rcon feedback from server "main" for request #1:/)
  assert.match(textOf(message), /ack:list/)
  assert.match(textOf(message), /later:list/)
})

test('feedback_delivery followup wakes the agent instead of injecting', async (t) => {
  const server = await startFakeServer({ pushDelayMs: 10 })
  t.after(() => server.close())
  const agent = new RecordingAgent()
  const session = new RconSession(diagnostics([]), agent, testConfig([
    { name: 'main', host: '127.0.0.1', port: server.port, password: 'secret' },
  ]))
  t.after(() => { session.dispose() })

  await session.runCommand('main', 'list', 0, 'followup', AbortSignal.timeout(2000))
  await until(() => agent.followed.length === 1, 'one followed group')

  assert.deepEqual(agent.injected, [])
  assert.match(textOf(agent.followed[0]), /ack:list/)
})

test('an idle link is reclaimed and the next command reconnects', async (t) => {
  const server = await startFakeServer()
  t.after(() => server.close())
  const session = new RconSession(diagnostics([]), new RecordingAgent(), testConfig([
    { name: 'main', host: '127.0.0.1', port: server.port, password: 'secret' },
  ], { idleTimeoutMs: 40 }))
  t.after(() => { session.dispose() })

  assert.deepEqual(
    await session.runCommand('main', 'one', 20, undefined, AbortSignal.timeout(2000)),
    { server: 'main', requestId: 1, messages: ['ack:one'] },
  )
  assert.equal(server.connections, 1)

  await until(() => server.liveConnections === 0, 'the idle link to close')

  // A fresh link restarts request ids, which proves the old connection is gone.
  assert.deepEqual(
    await session.runCommand('main', 'two', 20, undefined, AbortSignal.timeout(2000)),
    { server: 'main', requestId: 1, messages: ['ack:two'] },
  )
  assert.equal(server.connections, 2)
})

test('commands reach the server verbatim, including a double slash and an empty body', async (t) => {
  const server = await startFakeServer()
  t.after(() => server.close())
  const session = new RconSession(diagnostics([]), new RecordingAgent(), testConfig([
    { name: 'main', host: '127.0.0.1', port: server.port, password: 'secret' },
  ]))
  t.after(() => { session.dispose() })

  // The server strips at most one leading slash itself, so stripping here as
  // well would turn '//mod-command' into 'mod-command' on the dispatcher.
  await session.runCommand('main', '//mod-command', 50, undefined, AbortSignal.timeout(2000))
  // An empty command is the server's to reject; it is also a way to refresh the link.
  await session.runCommand('main', '', 50, undefined, AbortSignal.timeout(2000))
  assert.deepEqual(server.commands, ['//mod-command', ''])
})

test('a disposed session refuses further commands', async (t) => {
  const server = await startFakeServer()
  t.after(() => server.close())
  const session = new RconSession(diagnostics([]), new RecordingAgent(), testConfig([
    { name: 'main', host: '127.0.0.1', port: server.port, password: 'secret' },
  ]))

  session.dispose()
  await assert.rejects(
    session.runCommand('main', 'list', 0, undefined, AbortSignal.timeout(2000)),
    /disposed/,
  )
})
