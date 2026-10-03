import assert from 'node:assert/strict'
import test from 'node:test'
import { decideCommand, dispatchedCommand, matchesAllowedPrefix, readCommandArgument } from '../src/policy.ts'

test('dispatchedCommand mirrors trimOptionalPrefix: at most one leading slash', () => {
  assert.equal(dispatchedCommand('list'), 'list')
  assert.equal(dispatchedCommand('/list'), 'list')
  assert.equal(dispatchedCommand('//mod-command'), '/mod-command')
})

test('dispatchedCommand leaves whitespace alone, as the server does', () => {
  assert.equal(dispatchedCommand(' list '), ' list ')
  assert.equal(dispatchedCommand('/ list'), ' list')
  assert.equal(decideCommand(' list ', ['list'], 'deny').kind, 'deny')
})

test('a command headed by an allowed prefix is allowed', () => {
  assert.equal(decideCommand('list', ['list'], 'deny').kind, 'allow')
  assert.equal(decideCommand('say hello', ['say'], 'deny').kind, 'allow')
  assert.equal(decideCommand('listplayers', ['list'], 'deny').kind, 'allow')
})

test('an ungranted command follows the configured policy', () => {
  const denied = decideCommand('op Steve', ['list'], 'deny')
  assert.equal(denied.kind, 'deny')
  const asked = decideCommand('op Steve', ['list'], 'ask')
  assert.equal(asked.kind, 'ask')
})

test('an empty allowlist grants nothing', () => {
  assert.equal(matchesAllowedPrefix('list', []), false)
  assert.equal(decideCommand('list', [], 'deny').kind, 'deny')
})

test('a near miss is not covered by a prefix', () => {
  assert.equal(decideCommand('op Steve', ['time'], 'deny').kind, 'deny')
  assert.equal(decideCommand('stop', ['stone'], 'deny').kind, 'deny')
})

test('the gate reads the command verbatim, because the wire carries it verbatim', () => {
  assert.equal(readCommandArgument({ command: '/list' }), '/list')
  assert.equal(readCommandArgument({ command: '//mod-command' }), '//mod-command')
  assert.equal(readCommandArgument({ command: ' list ' }), ' list ')
})

test('the gate judges the dispatcher form, so a list rule covers /list', () => {
  const command = readCommandArgument({ command: '/list' }) ?? ''
  assert.equal(decideCommand(dispatchedCommand(command), ['list'], 'deny').kind, 'allow')
})

test('a double-slash mod command keeps its second slash past the gate', () => {
  const command = readCommandArgument({ command: '//mod-command' }) ?? ''
  assert.equal(dispatchedCommand(command), '/mod-command')
  // Only the dispatcher spelling can be allowlisted; the bare word must not match.
  assert.equal(decideCommand(dispatchedCommand(command), ['/mod-command'], 'deny').kind, 'allow')
  assert.equal(decideCommand(dispatchedCommand(command), ['mod-command'], 'deny').kind, 'deny')
})

test('the gate ignores arguments the tool schema will reject', () => {
  assert.equal(readCommandArgument(undefined), undefined)
  assert.equal(readCommandArgument(null), undefined)
  assert.equal(readCommandArgument([]), undefined)
  assert.equal(readCommandArgument('list'), undefined)
  assert.equal(readCommandArgument({}), undefined)
  assert.equal(readCommandArgument({ command: 7 }), undefined)
  assert.equal(readCommandArgument({ command: {} }), undefined)
})
