/**
 * One persistent rcon connection: connect, log in, then run commands inside a
 * blocking wait window while routing everything arriving outside a window to
 * the connection's feedback listener.
 *
 * @module dsh-rcon/connection
 */

import { createConnection, type Socket } from 'node:net'
import {
  encodeRconPacket,
  RCON_AUTH,
  RCON_COMMAND,
  RconPacketDecoder,
  type RconPacket,
} from './protocol.ts'
import type { RconEndpoint, RconExchange } from './types.ts'

export type { RconEndpoint }

export type { RconExchange }

/** Highest request id before wrapping; the protocol carries a signed 32-bit id. */
const MAX_REQUEST_ID = 0x7fff_fffe

/** Fixed request id for the login handshake, keeping command ids starting at 1. */
const AUTH_REQUEST_ID = 1

/** The abort reason when the caller signal carries no explicit one. */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new Error('dsh-rcon: the call was aborted')
}

/**
 * Resolve after `ms`, or reject as soon as `signal` aborts.
 * @param ms - non-negative delay in milliseconds.
 * @param signal - caller-owned cancellation.
 * @returns fulfillment after the delay.
 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortReason(signal))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * A lazily connected, per-Session rcon client.
 *
 * The connection is established on the first command and reused for every
 * later command of the same Session. The server tags every feedback packet
 * with the request id of the command that produced it, so a command's window
 * collects exactly the feedback for its own id, and feedback for that id that
 * arrives after the window is delivered to the feedback listener.
 */
export class RconConnection {
  private readonly decoder = new RconPacketDecoder()
  private readonly collectors = new Map<number, string[]>()
  private readonly rejections = new Map<number, (error: Error) => void>()
  private socket: Socket | undefined
  private connecting: Promise<void> | undefined
  private loggedIn = false
  private closed = false
  private nextRequestIdValue = 1
  private pendingAuthId: number | undefined
  private readyResolve: (() => void) | undefined
  private readyReject: ((error: Error) => void) | undefined

  /**
   * @param endpoint - host, port, password, and handshake timeout.
   * @param onFeedback - receives feedback for a request id outside its command window.
   */
  constructor(
    private readonly endpoint: RconEndpoint,
    private readonly onFeedback: (requestId: number, message: string) => void,
  ) {}

  /**
   * Ensure the connection is open and authenticated, reconnecting if needed.
   * @param signal - caller-owned cancellation for this attempt.
   */
  async ensureReady(signal: AbortSignal): Promise<void> {
    if (this.closed) throw new Error('dsh-rcon: the rcon connection is closed')
    if (this.loggedIn) return
    this.connecting ??= this.open(signal).finally(() => { this.connecting = undefined })
    await this.connecting
  }

  /**
   * Send one console command and collect the feedback tagged with its request id
   * that arrives within a window.
   * @param command - console command without the leading slash.
   * @param windowMs - blocking window in milliseconds; `0` collects nothing and
   *   lets every resulting message arrive through the feedback listener.
   * @param signal - caller-owned cancellation.
   * @returns the command's request id and the feedback received inside the window.
   */
  async exec(command: string, windowMs: number, signal: AbortSignal): Promise<RconExchange> {
    await this.ensureReady(signal)
    const socket = this.socket
    if (socket === undefined) throw new Error('dsh-rcon: the rcon connection is not established')
    const requestId = this.nextRequestId()
    const messages: string[] = []
    if (windowMs <= 0) {
      socket.write(encodeRconPacket(requestId, RCON_COMMAND, command))
      return { requestId, messages }
    }
    this.collectors.set(requestId, messages)
    const failure = Promise.withResolvers<never>()
    this.rejections.set(requestId, failure.reject)
    try {
      socket.write(encodeRconPacket(requestId, RCON_COMMAND, command))
      await Promise.race([delay(windowMs, signal), failure.promise])
      return { requestId, messages }
    } finally {
      this.collectors.delete(requestId)
      this.rejections.delete(requestId)
    }
  }

  /** Close the connection and stop delivering feedback. */
  close(): void {
    this.closed = true
    this.fail(new Error('dsh-rcon: the rcon connection was closed'))
  }

  /** Establish TCP and complete the rcon login handshake. */
  private async open(signal: AbortSignal): Promise<void> {
    const { host, port, password, connectTimeoutMs } = this.endpoint
    const socket = createConnection({ host, port })
    socket.setNoDelay(true)
    this.socket = socket
    this.decoder.reset()
    const ready = Promise.withResolvers<void>()
    this.readyResolve = ready.resolve
    this.readyReject = ready.reject
    const timer = setTimeout(() => {
      this.fail(new Error(`dsh-rcon: connecting to ${host}:${String(port)} timed out after ${String(connectTimeoutMs)}ms`))
    }, connectTimeoutMs)
    const onAbort = (): void => { this.fail(abortReason(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    socket.on('data', (chunk: Buffer) => { if (this.socket === socket) this.handleData(chunk) })
    socket.on('error', (error: Error) => { if (this.socket === socket) this.fail(error) })
    socket.on('close', () => {
      if (this.socket === socket) this.fail(new Error('dsh-rcon: the rcon connection closed'))
    })
    socket.once('connect', () => {
      if (this.socket !== socket) return
      this.pendingAuthId = AUTH_REQUEST_ID
      socket.write(encodeRconPacket(AUTH_REQUEST_ID, RCON_AUTH, password))
    })
    try {
      await ready.promise
      if (this.socket !== socket) throw new Error('dsh-rcon: the rcon connection closed during login')
      this.loggedIn = true
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      this.readyResolve = undefined
      this.readyReject = undefined
      this.pendingAuthId = undefined
    }
  }

  /** Decode one chunk and route every packet it completed. */
  private handleData(chunk: Buffer): void {
    let packets: RconPacket[]
    try {
      packets = this.decoder.push(chunk)
    } catch (error: unknown) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
      return
    }
    for (const packet of packets) this.handlePacket(packet)
  }

  /** Complete the pending login, fill the matching window, or publish as feedback. */
  private handlePacket(packet: RconPacket): void {
    if (this.pendingAuthId !== undefined) {
      this.pendingAuthId = undefined
      if (packet.id === -1) {
        this.fail(new Error('dsh-rcon: authentication failed (wrong password)'))
        return
      }
      this.readyResolve?.()
      return
    }
    if (packet.body.length === 0) return
    const collector = this.collectors.get(packet.id)
    if (collector !== undefined) {
      collector.push(packet.body)
      return
    }
    this.onFeedback(packet.id, packet.body)
  }

  /** Tear the current socket down and settle whoever waits on it. */
  private fail(error: Error): void {
    this.loggedIn = false
    this.collectors.clear()
    const rejectReady = this.readyReject
    const rejections = [...this.rejections.values()]
    this.rejections.clear()
    this.readyReject = undefined
    const socket = this.socket
    this.socket = undefined
    socket?.destroy()
    rejectReady?.(error)
    for (const reject of rejections) reject(error)
  }

  /** Next request id, wrapping before the signed 32-bit ceiling. */
  private nextRequestId(): number {
    const id = this.nextRequestIdValue
    this.nextRequestIdValue = id >= MAX_REQUEST_ID ? 1 : id + 1
    return id
  }
}
