import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_IDLE_TIMEOUT_MS, resolveConfig } from '../src/config.ts'

const main = { name: 'main', host: '10.0.0.1', port: 25575, password: 'pw' }

test('defaults fill every optional bound', () => {
  const resolved = resolveConfig({ servers: [main] })
  assert.equal(resolved.defaultServer, 'main')
  assert.equal(resolved.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS)
  assert.equal(resolved.defaultWaitMs, 1000)
  assert.equal(resolved.feedbackBatchMs, 1000)
  assert.equal(resolved.connectTimeoutMs, 5000)
  assert.deepEqual(resolved.allowedPrefixes, [])
  assert.equal(resolved.otherwise, 'deny')
})

test('the first server is the default unless another is named', () => {
  const servers = [main, { name: 'creative', host: '10.0.0.2', port: 25576, password: 'pw2' }]
  assert.equal(resolveConfig({ servers }).defaultServer, 'main')
  assert.equal(resolveConfig({ servers, defaultServer: 'creative' }).defaultServer, 'creative')
})

test('an empty server list fails loud and says where to configure it', () => {
  assert.throws(
    () => resolveConfig({ servers: [] }),
    /must list at least one server.*cordis\.patch\.yml/,
  )
})

test('duplicate server names are rejected', () => {
  assert.throws(() => resolveConfig({ servers: [main, { ...main }] }), /duplicate server name "main"/)
})

test('an unknown default server is rejected', () => {
  assert.throws(() => resolveConfig({ servers: [main], defaultServer: 'nope' }), /defaultServer "nope"/)
})

test('a server missing a name, host, or password is rejected', () => {
  assert.throws(() => resolveConfig({ servers: [{ ...main, name: '' }] }), /servers\[0\]\.name/)
  assert.throws(() => resolveConfig({ servers: [{ ...main, host: '  ' }] }), /servers\[0\]\.host/)
  assert.throws(() => resolveConfig({ servers: [{ ...main, password: '' }] }), /servers\[0\]\.password/)
})

test('out-of-range ports and timings are rejected', () => {
  assert.throws(() => resolveConfig({ servers: [{ ...main, port: 0 }] }), /servers\[0\]\.port/)
  assert.throws(() => resolveConfig({ servers: [{ ...main, port: 70000 }] }), /servers\[0\]\.port/)
  assert.throws(() => resolveConfig({ servers: [main], idleTimeoutMs: 0 }), /config\.idleTimeoutMs/)
  assert.throws(() => resolveConfig({ servers: [main], defaultWaitMs: -1 }), /config\.defaultWaitMs/)
  assert.throws(() => resolveConfig({ servers: [main], feedbackBatchMs: 1.5 }), /config\.feedbackBatchMs/)
  assert.throws(() => resolveConfig({ servers: [main], connectTimeoutMs: 0 }), /config\.connectTimeoutMs/)
})

test('an empty allowlist entry is rejected rather than ignored', () => {
  assert.throws(
    () => resolveConfig({ servers: [main], allowedPrefixes: ['list', ' '] }),
    /allowedPrefixes\[1\]/,
  )
})

test('a padded allowlist entry is rejected rather than sitting there dead', () => {
  assert.throws(
    () => resolveConfig({ servers: [main], allowedPrefixes: [' list '] }),
    /allowedPrefixes\[0\] must not have leading or trailing whitespace/,
  )
})

test('a slash-leading allowlist entry is valid: it targets the dispatcher spelling', () => {
  const resolved = resolveConfig({ servers: [main], allowedPrefixes: ['/mod-command'] })
  assert.deepEqual(resolved.allowedPrefixes, ['/mod-command'])
})

test('otherwise accepts ask or deny', () => {
  assert.equal(resolveConfig({ servers: [main], otherwise: 'ask' }).otherwise, 'ask')
  assert.equal(resolveConfig({ servers: [main], otherwise: 'deny' }).otherwise, 'deny')
})
