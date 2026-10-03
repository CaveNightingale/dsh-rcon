/**
 * Minecraft rcon (Source rcon) packet framing: little-endian length-prefixed
 * packets of `id`, `type`, `body`, and a trailing pair of null bytes.
 *
 * @module dsh-rcon/protocol
 */

/** `SERVERDATA_RESPONSE_VALUE`: the server's answer to a request. */
export const RCON_RESPONSE = 0

/** `SERVERDATA_EXECCOMMAND`: a console command. */
export const RCON_COMMAND = 2

/** `SERVERDATA_AUTH`: the login handshake. */
export const RCON_AUTH = 3

/** Body limit for one packet, also the sanity bound for a claimed frame length. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/** One decoded rcon packet. */
export interface RconPacket {
  readonly id: number
  readonly type: number
  readonly body: string
}

/**
 * Frame one rcon packet.
 * @param id - request id; the server echoes it on the matching response.
 * @param type - one of {@link RCON_AUTH}, {@link RCON_COMMAND}, or {@link RCON_RESPONSE}.
 * @param body - UTF-8 payload without the terminating null bytes.
 * @returns the complete packet, ready to write to the socket.
 * @throws TypeError when the encoded body exceeds {@link MAX_BODY_BYTES}.
 */
export function encodeRconPacket(id: number, type: number, body: string): Buffer {
  const bodyBytes = Buffer.from(body, 'utf8')
  if (bodyBytes.length > MAX_BODY_BYTES) {
    throw new TypeError(`rcon: body of ${String(bodyBytes.length)} bytes exceeds the packet bound`)
  }
  const length = 4 + 4 + bodyBytes.length + 2
  const packet = Buffer.alloc(4 + length)
  packet.writeInt32LE(length, 0)
  packet.writeInt32LE(id, 4)
  packet.writeInt32LE(type, 8)
  bodyBytes.copy(packet, 12)
  return packet
}

/**
 * Incremental decoder for a TCP byte stream carrying rcon packets.
 *
 * A `data` event may deliver a partial packet or several packets at once, so
 * the decoder retains the unconsumed tail until the next chunk completes it.
 */
export class RconPacketDecoder {
  private buffer: Buffer = Buffer.alloc(0)

  /** Drop any retained partial frame, as when a connection is replaced. */
  reset(): void {
    this.buffer = Buffer.alloc(0)
  }

  /**
   * Consume one chunk and return every packet it completed.
   * @param chunk - bytes received from the socket.
   * @returns the packets completed by this chunk, in arrival order.
   * @throws TypeError when the stream carries a frame length outside the protocol bound.
   */
  push(chunk: Buffer): RconPacket[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const packets: RconPacket[] = []
    while (this.buffer.length >= 4) {
      const length = this.buffer.readInt32LE(0)
      if (length < 10 || length > MAX_BODY_BYTES + 10) {
        throw new TypeError(`rcon: invalid packet length ${String(length)}`)
      }
      if (this.buffer.length < 4 + length) break
      const id = this.buffer.readInt32LE(4)
      const type = this.buffer.readInt32LE(8)
      const body = this.buffer.subarray(12, 4 + length - 2).toString('utf8')
      packets.push({ id, type, body })
      this.buffer = this.buffer.subarray(4 + length)
    }
    return packets
  }
}
