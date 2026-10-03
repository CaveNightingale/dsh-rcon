/**
 * The permission decision for one rcon command, kept separate from the plugin
 * wiring so the allow/ask/deny outcome can be exercised directly.
 *
 * @module dsh-rcon/policy
 */

import type { UngrantedCommandPolicy } from './types.ts'

/** The policy outcome for one command. */
export type CommandPolicyDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string }
  | { readonly kind: 'ask'; readonly reason: string }

/**
 * The text the command dispatcher will read for one command.
 *
 * The wire carries the command exactly as written and the server applies its own
 * `CommandSourceStack.trimOptionalPrefix`, so this mirrors that one strip and
 * nothing else. It exists for the permission gate to judge the command that will
 * actually run — never to prepare the outgoing packet, because stripping here as
 * well would eat a second slash and break mod commands spelled `//some-command`.
 * @param command - command as the model wrote it, with or without a leading slash.
 * @returns the command with at most one leading slash removed.
 */
export function dispatchedCommand(command: string): string {
  return command.startsWith('/') ? command.slice(1) : command
}

/**
 * Whether one normalized command is covered by the configured prefixes.
 * @param command - normalized console command.
 * @param prefixes - allowed command prefixes.
 * @returns whether any prefix heads the command.
 */
export function matchesAllowedPrefix(command: string, prefixes: readonly string[]): boolean {
  return prefixes.some(prefix => command.startsWith(prefix))
}

/**
 * Decide one rcon command against the deployment's allowlist.
 * @param command - normalized console command.
 * @param prefixes - allowed command prefixes.
 * @param otherwise - policy for a command matching no prefix.
 * @returns the allow, ask, or deny decision this command earns.
 */
export function decideCommand(
  command: string,
  prefixes: readonly string[],
  otherwise: UngrantedCommandPolicy,
): CommandPolicyDecision {
  if (matchesAllowedPrefix(command, prefixes)) return { kind: 'allow' }
  if (otherwise === 'ask') {
    return { kind: 'ask', reason: `Run the Minecraft rcon command ${JSON.stringify(command)}?` }
  }
  return {
    kind: 'deny',
    reason: `The Minecraft rcon command ${JSON.stringify(command)} matches no allowed prefix, `
      + 'and this deployment denies commands it does not grant.',
  }
}

/** Whether a not-yet-validated parsed argument value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the command out of a parsed argument object the tool schema has not
 * validated yet, so the gate and the outgoing packet start from the same text.
 * @param value - parsed model arguments.
 * @returns the command exactly as the model wrote it, or undefined when the call
 *   carries none.
 */
export function readCommandArgument(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const command = value['command']
  return typeof command === 'string' ? command : undefined
}
