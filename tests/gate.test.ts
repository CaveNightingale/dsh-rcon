import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import type { Config } from '../src/config.ts'

/** What the gate receives and returns, to the extent these tests care. */
type PreExecute = (
  exec: { name: string; arguments?: unknown },
  next: () => Promise<unknown>,
) => Promise<unknown>

/** The sentinel `next()` returns, so "delegated" is distinguishable from a decision. */
const DELEGATED = { kind: 'delegated' }

/**
 * The slice of the Cordis context `apply` touches: the tool registry, the gate
 * it installs, and the effect hook it registers and never runs here.
 */
class FakeContext {
  /** Tools handed to `tools.register`. */
  readonly registered: unknown[] = []
  /** The `tools/pre-execute` handler the plugin installed. */
  gate: PreExecute | undefined

  readonly tools = {
    registered: this.registered,
    register(tool: unknown): void { this.registered.push(tool) },
  }

  on(event: string, handler: PreExecute): void {
    if (event === 'tools/pre-execute') this.gate = handler
  }

  /** Run the effect body so a registration mistake still throws here. */
  effect(body: () => unknown): unknown {
    return body()
  }
}

/** Apply the plugin to a fake context and return the gate it installed. */
function gateOf(config: Config): PreExecute {
  const context = new FakeContext()
  apply(context as unknown as Context, config)
  const gate = context.gate
  assert.ok(gate !== undefined, 'apply must install a tools/pre-execute gate')
  assert.equal(context.registered.length, 1)
  return gate
}

/** Judge one rcon call, reporting whether the gate delegated or decided. */
function judge(gate: PreExecute, args: unknown): Promise<unknown> {
  return gate({ name: 'rcon', arguments: args }, async () => DELEGATED)
}

/** Two servers on top of one deployment-wide grant. */
const SERVERS: Config['servers'] = [
  { name: 'main', host: '10.0.0.1', port: 25575, password: 'pw' },
  { name: 'creative', host: '10.0.0.2', port: 25575, password: 'pw', allowedPrefixes: ['fill'] },
]

test('a deployment-wide grant runs on every server', async () => {
  const gate = gateOf({ servers: SERVERS, allowedPrefixes: ['list'], otherwise: 'deny' })
  assert.deepEqual(await judge(gate, { command: 'list' }), DELEGATED)
  assert.deepEqual(await judge(gate, { server: 'creative', command: '/list' }), DELEGATED)
})

test('a per-server grant runs only on the server that declared it', async () => {
  const gate = gateOf({ servers: SERVERS, allowedPrefixes: ['list'], otherwise: 'deny' })
  const fill = 'fill 0 0 0 1 1 1 stone'
  assert.deepEqual(await judge(gate, { server: 'creative', command: fill }), DELEGATED)
  const denied = await judge(gate, { command: fill })
  assert.equal((denied as { kind: string }).kind, 'deny')
  assert.match((denied as { reason: string }).reason, /on server "main"/)
})

test('an ungranted command follows the configured policy, naming the server', async () => {
  const denying = gateOf({ servers: SERVERS, allowedPrefixes: ['list'], otherwise: 'deny' })
  const denied = await judge(denying, { server: 'creative', command: 'op Steve' })
  assert.equal((denied as { kind: string }).kind, 'deny')
  assert.match((denied as { reason: string }).reason, /"op Steve" on server "creative"/)

  const asking = gateOf({ servers: SERVERS, allowedPrefixes: ['list'], otherwise: 'ask' })
  const asked = await judge(asking, { server: 'creative', command: 'op Steve' })
  assert.equal((asked as { kind: string }).kind, 'ask')
  assert.match((asked as { reason: string }).reason, /on server "creative"\?$/)
})

test('a server this deployment does not configure is refused before the policy question', async () => {
  const gate = gateOf({ servers: SERVERS, allowedPrefixes: ['list'], otherwise: 'ask' })
  // `list` is granted everywhere, but the call still cannot succeed: the name is
  // wrong, so it is refused outright instead of asked about.
  const decision = await judge(gate, { server: 'nope', command: 'list' })
  assert.equal((decision as { kind: string }).kind, 'deny')
  assert.match((decision as { reason: string }).reason, /unknown server "nope".*main, creative/)
})

test('a call without a usable command is left to the tool schema', async () => {
  const gate = gateOf({ servers: SERVERS, allowedPrefixes: ['list'], otherwise: 'deny' })
  assert.deepEqual(await judge(gate, { server: 'nope' }), DELEGATED)
  assert.deepEqual(await judge(gate, { command: 7 }), DELEGATED)
})

test('another tool is not this gate\'s business', async () => {
  const gate = gateOf({ servers: SERVERS, allowedPrefixes: ['list'], otherwise: 'deny' })
  assert.deepEqual(await gate({ name: 'bash', arguments: { command: 'list' } }, async () => DELEGATED), DELEGATED)
})
