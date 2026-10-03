/**
 * Shared test doubles for the rcon tests: an in-process rcon server that
 * authenticates, acknowledges commands, and can push extra messages.
 */

import assert from 'node:assert/strict'
import { createServer, type Server, type Socket } from 'node:net'
import type test from 'node:test'
import { RconConnection } from '../src/connection.ts'
import { encodeRconPacket, RCON_AUTH, RCON_COMMAND, RCON_RESPONSE, RconPacketDecoder } from '../src/protocol.ts'

/** One feedback message with the request id the server tagged it with. */
export interface FeedbackEntry {
  readonly requestId: number
  readonly message: string
}

/** Records feedback and lets a test await the next one without polling. */
export class FeedbackLog {
  readonly entries: FeedbackEntry[] = []
  private readonly waiters: Array<() => void> = []

  push(requestId: number, message: string): void {
    this.entries.push({ requestId, message })
    for (const waiter of this.waiters.splice(0)) waiter()
  }

  get messages(): string[] {
    return this.entries.map(entry => entry.message)
  }

  async waitFor(count: number): Promise<void> {
    await withDeadline((async () => {
      while (this.entries.length < count) {
        await new Promise<void>(resolve => { this.waiters.push(resolve) })
      }
    })(), `feedback count ${String(count)}`)
  }
}

/** Fail a test instead of hanging forever when the expected event never arrives. */
export function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => { reject(new Error(`timed out waiting for ${label}`)) }, 2000).unref()
    }),
  ])
}

/** Wait for a duration without pulling in a timer helper. */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/** An in-process rcon server that acknowledges commands and can push extra messages. */
export interface FakeServer {
  /** TCP port the server listens on. */
  readonly port: number
  /** Number of accepted connections so far; proves whether a client reused one. */
  readonly connections: number
  /** Accepted sockets still open. */
  readonly liveConnections: number
  /** Command bodies received so far, in order. */
  readonly commands: string[]
  /** Destroy every accepted socket without stopping the listener, as a restart would. */
  dropConnections(): Promise<void>
  /** Stop listening and destroy accepted sockets. */
  close(): Promise<void>
}

/**
 * Start a fake rcon server.
 * @param options - `pushDelayMs` pushes one extra message after each command;
 *   `rejectAuth` answers the login with the protocol's failure id.
 */
export async function startFakeServer(
  options: { pushDelayMs?: number; rejectAuth?: boolean } = {},
): Promise<FakeServer> {
  const server: Server = createServer()
  const sockets = new Set<Socket>()
  const commands: string[] = []
  let connections = 0
  server.on('connection', (socket: Socket) => {
    connections += 1
    sockets.add(socket)
    socket.on('close', () => { sockets.delete(socket) })
    const decoder = new RconPacketDecoder()
    socket.on('data', (chunk: Buffer) => {
      for (const packet of decoder.push(chunk)) {
        if (packet.type === RCON_AUTH) {
          socket.write(encodeRconPacket(options.rejectAuth === true ? -1 : packet.id, RCON_RESPONSE, ''))
          continue
        }
        if (packet.type !== RCON_COMMAND) continue
        commands.push(packet.body)
        socket.write(encodeRconPacket(packet.id, RCON_RESPONSE, `ack:${packet.body}`))
        if (options.pushDelayMs === undefined) continue
        const timer = setTimeout(() => {
          socket.write(encodeRconPacket(packet.id, RCON_RESPONSE, `later:${packet.body}`))
        }, options.pushDelayMs)
        socket.once('close', () => { clearTimeout(timer) })
      }
    })
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  return {
    port: address.port,
    get connections() { return connections },
    get liveConnections() { return sockets.size },
    commands,
    dropConnections: async () => {
      for (const socket of sockets) socket.destroy()
      while (sockets.size > 0) await delay(5)
    },
    close: () => new Promise<void>(resolve => {
      // Teardown destroys the client socket; close the peer side too so the
      // close callback cannot wait on a half-open connection.
      for (const socket of sockets) socket.destroy()
      server.close(() => { resolve() })
    }),
  }
}

/** Connect a client to a fake server and register it for teardown. */
export function connect(
  t: test.TestContext,
  port: number,
  feedback: (requestId: number, message: string) => void,
  password = 'secret',
): RconConnection {
  const connection = new RconConnection({
    host: '127.0.0.1',
    port,
    password,
    connectTimeoutMs: 2000,
  }, feedback)
  t.after(() => { connection.close() })
  return connection
}
