import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeRconPacket, RCON_AUTH, RCON_COMMAND, RCON_RESPONSE, RconPacketDecoder } from '../src/protocol.ts'

test('round-trips one packet', () => {
  const decoder = new RconPacketDecoder()
  const packets = decoder.push(encodeRconPacket(7, RCON_COMMAND, 'list'))
  assert.deepEqual(packets, [{ id: 7, type: RCON_COMMAND, body: 'list' }])
})

test('decodes packets that arrive split across chunks', () => {
  const decoder = new RconPacketDecoder()
  const encoded = encodeRconPacket(1, RCON_AUTH, 'secret')
  assert.deepEqual(decoder.push(encoded.subarray(0, 5)), [])
  assert.deepEqual(decoder.push(encoded.subarray(5)), [{ id: 1, type: RCON_AUTH, body: 'secret' }])
})

test('decodes several packets from one chunk', () => {
  const decoder = new RconPacketDecoder()
  const packets = decoder.push(Buffer.concat([
    encodeRconPacket(2, RCON_RESPONSE, 'first'),
    encodeRconPacket(3, RCON_RESPONSE, 'second'),
  ]))
  assert.deepEqual(packets, [
    { id: 2, type: RCON_RESPONSE, body: 'first' },
    { id: 3, type: RCON_RESPONSE, body: 'second' },
  ])
})

test('reset drops a retained partial frame', () => {
  const decoder = new RconPacketDecoder()
  decoder.push(encodeRconPacket(1, RCON_AUTH, 'secret').subarray(0, 6))
  decoder.reset()
  assert.deepEqual(decoder.push(encodeRconPacket(4, RCON_RESPONSE, 'ok')), [
    { id: 4, type: RCON_RESPONSE, body: 'ok' },
  ])
})

test('rejects a frame length outside the protocol bound', () => {
  const decoder = new RconPacketDecoder()
  const hostile = Buffer.alloc(4)
  hostile.writeInt32LE(3, 0)
  assert.throws(() => decoder.push(hostile), /invalid packet length/)
})

test('encodes the trailing null pair and total length', () => {
  const encoded = encodeRconPacket(0, RCON_RESPONSE, 'x')
  assert.equal(encoded.readInt32LE(0), 4 + 4 + 1 + 2)
  assert.equal(encoded.readUInt8(encoded.length - 1), 0)
  assert.equal(encoded.readUInt8(encoded.length - 2), 0)
})

test('rejects a body larger than one packet carries', () => {
  const oversized = 'a'.repeat(4 * 1024 * 1024 + 1)
  assert.throws(() => encodeRconPacket(1, RCON_COMMAND, oversized), /exceeds the packet bound/)
})

test('accepts a body at the packet bound', () => {
  const exact = 'a'.repeat(4 * 1024 * 1024)
  assert.equal(encodeRconPacket(1, RCON_COMMAND, exact).readInt32LE(0), 4 + 4 + exact.length + 2)
})
