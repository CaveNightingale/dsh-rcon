import assert from 'node:assert/strict'
import test from 'node:test'
import { FeedbackBatch } from '../src/batch.ts'

test('groups by request id and anchors each window at its first message', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const groups: Array<{ requestId: number; messages: string[] }> = []
  const batch = new FeedbackBatch({
    windowMs: 100,
    flush: group => groups.push({ requestId: group.requestId, messages: [...group.messages] }),
  })

  batch.push(1, 'a')
  t.mock.timers.tick(60)
  // A later message for the same request id joins its group and must NOT extend the window.
  batch.push(1, 'b')
  // Another request id starts its own group and its own window at this instant.
  batch.push(2, 'x')
  t.mock.timers.tick(40)
  assert.deepEqual(groups, [{ requestId: 1, messages: ['a', 'b'] }])
  t.mock.timers.tick(60)
  assert.deepEqual(groups, [
    { requestId: 1, messages: ['a', 'b'] },
    { requestId: 2, messages: ['x'] },
  ])
  batch.dispose()
})

test('a further message for a flushed request id starts a new group', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const groups: Array<{ requestId: number; messages: string[] }> = []
  const batch = new FeedbackBatch({
    windowMs: 50,
    flush: group => groups.push({ requestId: group.requestId, messages: [...group.messages] }),
  })

  batch.push(7, 'first')
  t.mock.timers.tick(50)
  batch.push(7, 'late')
  t.mock.timers.tick(50)
  assert.deepEqual(groups, [
    { requestId: 7, messages: ['first'] },
    { requestId: 7, messages: ['late'] },
  ])
  batch.dispose()
})

test('a zero window still merges same-tick messages', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const groups: Array<{ requestId: number; messages: string[] }> = []
  const batch = new FeedbackBatch({
    windowMs: 0,
    flush: group => groups.push({ requestId: group.requestId, messages: [...group.messages] }),
  })

  batch.push(3, 'first')
  batch.push(3, 'second')
  t.mock.timers.tick(0)
  assert.deepEqual(groups, [{ requestId: 3, messages: ['first', 'second'] }])
  batch.dispose()
})

test('dispose drops pending groups', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const groups: Array<{ requestId: number; messages: string[] }> = []
  const batch = new FeedbackBatch({
    windowMs: 50,
    flush: group => groups.push({ requestId: group.requestId, messages: [...group.messages] }),
  })

  batch.push(1, 'pending')
  batch.push(2, 'pending')
  batch.dispose()
  t.mock.timers.tick(500)
  assert.deepEqual(groups, [])

  batch.push(1, 'after disposal')
  t.mock.timers.tick(500)
  assert.deepEqual(groups, [])
})
