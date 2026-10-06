import assert from 'node:assert/strict'
import test from 'node:test'
import { decideCommand, dispatchedCommand, effectiveAllowedPrefixes, matchesAllowedPrefix, readCommandArgument, readServerArgument } from '../src/policy.ts'
import type { CommandPolicyDecision } from '../src/policy.ts'
import type { ResolvedConfig, ResolvedServer } from '../src/types.ts'

/** The reason of a decision that carries one; an allow has none. */
function reasonOf(decision: CommandPolicyDecision): string {
  return decision.kind === 'allow' ? '' : decision.reason
}

/** Two servers whose grants differ, on top of one deployment-wide list. */
function twoServerConfig(): { config: ResolvedConfig; main: ResolvedServer; creative: ResolvedServer } {
  const [main, creative] = [
    { name: 'main', host: '10.0.0.1', port: 25575, password: 'pw', allowedPrefixes: [] },
    { name: 'creative', host: '10.0.0.2', port: 25575, password: 'pw', allowedPrefixes: ['fill'] },
  ] as const
  assert.ok(main !== undefined && creative !== undefined)
  return {
    config: {
      servers: [main, creative],
      defaultServer: 'main',
      idleTimeoutMs: 1,
      defaultWaitMs: 0,
      feedbackBatchMs: 0,
      connectTimeoutMs: 1,
      allowedPrefixes: ['list'],
      otherwise: 'deny',
    },
    main,
    creative,
  }
}

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

test('a server adds its own grants to the deployment-wide list', () => {
  const { config, main, creative } = twoServerConfig()
  assert.deepEqual(effectiveAllowedPrefixes(config, main), ['list'])
  assert.deepEqual(effectiveAllowedPrefixes(config, creative), ['list', 'fill'])
})

test('a per-server grant does not travel to another server', () => {
  const { config, main, creative } = twoServerConfig()
  const fill = dispatchedCommand('fill 0 0 0 1 1 1 stone')
  assert.equal(decideCommand(fill, effectiveAllowedPrefixes(config, main), 'deny').kind, 'deny')
  assert.equal(decideCommand(fill, effectiveAllowedPrefixes(config, creative), 'deny').kind, 'allow')
  // The deployment-wide grant still holds on the server that adds none.
  assert.equal(decideCommand('list', effectiveAllowedPrefixes(config, main), 'deny').kind, 'allow')
})

test('a per-server list cannot revoke a deployment-wide grant', () => {
  const { config, creative } = twoServerConfig()
  assert.equal(decideCommand('list', effectiveAllowedPrefixes(config, creative), 'deny').kind, 'allow')
})

test('the decision names the target server', () => {
  assert.match(reasonOf(decideCommand('op Steve', ['list'], 'deny', 'creative')), /"op Steve" on server "creative"/)
  assert.match(reasonOf(decideCommand('op Steve', ['list'], 'ask', 'creative')), /on server "creative"\?$/)
})

test('the gate reads the server the call names, and nothing else', () => {
  assert.equal(readServerArgument({ server: 'creative', command: 'list' }), 'creative')
  assert.equal(readServerArgument({ command: 'list' }), undefined)
  assert.equal(readServerArgument({ server: '', command: 'list' }), undefined)
  assert.equal(readServerArgument({ server: 7, command: 'list' }), undefined)
  assert.equal(readServerArgument(undefined), undefined)
  assert.equal(readServerArgument('creative'), undefined)
})
