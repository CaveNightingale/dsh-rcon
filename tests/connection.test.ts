import assert from 'node:assert/strict'
import test from 'node:test'
import { connect, delay, FeedbackLog, startFakeServer } from './fake-server.ts'

test('reuses one connection across commands', async (t) => {
  const server = await startFakeServer()
  t.after(() => server.close())
  const connection = connect(t, server.port, () => {})

  assert.deepEqual(
    await connection.exec('first', 100, AbortSignal.timeout(2000)),
    { requestId: 1, messages: ['ack:first'] },
  )
  assert.deepEqual(
    await connection.exec('second', 100, AbortSignal.timeout(2000)),
    { requestId: 2, messages: ['ack:second'] },
  )
  assert.equal(server.connections, 1)
  assert.deepEqual(server.commands, ['first', 'second'])
})

test('collects in-window pushes into the command result', async (t) => {
  const server = await startFakeServer({ pushDelayMs: 20 })
  t.after(() => server.close())
  const log = new FeedbackLog()
  const connection = connect(t, server.port, (requestId, message) => { log.push(requestId, message) })

  assert.deepEqual(
    await connection.exec('list', 200, AbortSignal.timeout(2000)),
    { requestId: 1, messages: ['ack:list', 'later:list'] },
  )
  assert.deepEqual(log.messages, [])
})

test('a zero window returns nothing and reports every push as feedback', async (t) => {
  const server = await startFakeServer({ pushDelayMs: 10 })
  t.after(() => server.close())
  const log = new FeedbackLog()
  const connection = connect(t, server.port, (requestId, message) => { log.push(requestId, message) })

  assert.deepEqual(
    await connection.exec('say hi', 0, AbortSignal.timeout(2000)),
    { requestId: 1, messages: [] },
  )
  await log.waitFor(2)
  assert.deepEqual(log.entries, [
    { requestId: 1, message: 'ack:say hi' },
    { requestId: 1, message: 'later:say hi' },
  ])
})

test('a push arriving after the window becomes feedback', async (t) => {
  const server = await startFakeServer({ pushDelayMs: 80 })
  t.after(() => server.close())
  const log = new FeedbackLog()
  const connection = connect(t, server.port, (requestId, message) => { log.push(requestId, message) })

  assert.deepEqual(
    await connection.exec('kill', 25, AbortSignal.timeout(2000)),
    { requestId: 1, messages: ['ack:kill'] },
  )
  await log.waitFor(1)
  assert.deepEqual(log.entries, [{ requestId: 1, message: 'later:kill' }])
})

test('a late message for an earlier request id stays out of a later window', async (t) => {
  const server = await startFakeServer({ pushDelayMs: 80 })
  t.after(() => server.close())
  const log = new FeedbackLog()
  const connection = connect(t, server.port, (requestId, message) => { log.push(requestId, message) })

  assert.deepEqual(
    await connection.exec('first', 25, AbortSignal.timeout(2000)),
    { requestId: 1, messages: ['ack:first'] },
  )
  // 'later:first' arrives while the second window is open but still carries id 1.
  assert.deepEqual(
    await connection.exec('second', 200, AbortSignal.timeout(2000)),
    { requestId: 2, messages: ['ack:second', 'later:second'] },
  )
  await log.waitFor(1)
  assert.deepEqual(log.entries, [{ requestId: 1, message: 'later:first' }])
})

test('a wrong password fails the handshake loudly', async (t) => {
  const server = await startFakeServer({ rejectAuth: true })
  t.after(() => server.close())
  const connection = connect(t, server.port, () => {}, 'wrong')

  await assert.rejects(
    connection.exec('list', 0, AbortSignal.timeout(2000)),
    /authentication failed/,
  )
})

test('a dropped connection is re-established by the next command', async (t) => {
  const server = await startFakeServer()
  t.after(() => server.close())
  const connection = connect(t, server.port, () => {})

  assert.deepEqual(
    await connection.exec('first', 50, AbortSignal.timeout(2000)),
    { requestId: 1, messages: ['ack:first'] },
  )
  // Close the peer side behind the client's back, as a server restart would.
  await server.dropConnections()
  // A command sent while the client is still noticing the close can fail or
  // collect nothing, so retry until the reconnect is visible instead of racing it.
  let messages: string[] = []
  for (let attempt = 0; attempt < 10 && messages.length !== 1; attempt += 1) {
    const result = await connection.exec('second', 200, AbortSignal.timeout(2000)).catch(() => undefined)
    messages = result?.messages ?? []
    if (messages.length !== 1) await delay(20)
  }
  assert.deepEqual(messages, ['ack:second'])
  assert.equal(server.connections, 2)
})

test('a closed connection refuses further commands', async (t) => {
  const server = await startFakeServer()
  t.after(() => server.close())
  const connection = connect(t, server.port, () => {})

  assert.deepEqual(
    await connection.exec('first', 50, AbortSignal.timeout(2000)),
    { requestId: 1, messages: ['ack:first'] },
  )
  connection.close()
  await assert.rejects(
    connection.exec('second', 50, AbortSignal.timeout(2000)),
    /closed/,
  )
})
