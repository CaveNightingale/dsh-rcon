/**
 * The permission decision for one rcon command, kept separate from the plugin
 * wiring so the allow/ask/deny outcome can be exercised directly.
 *
 * @module dsh-rcon/policy
 */

import type { ResolvedConfig, ResolvedServer, UngrantedCommandPolicy } from './types.ts'

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
 * The allowlist one call is judged against: the deployment-wide prefixes plus
 * whatever the target server adds. A server's list is a grant, so the two are
 * unioned — configuring a server can only widen what it accepts, never revoke a
 * deployment-wide grant.
 * @param config - resolved configuration.
 * @param server - the server the call targets.
 * @returns the prefixes that run without approval on that server.
 */
export function effectiveAllowedPrefixes(
  config: ResolvedConfig,
  server: ResolvedServer,
): readonly string[] {
  if (server.allowedPrefixes.length === 0) return config.allowedPrefixes
  return [...config.allowedPrefixes, ...server.allowedPrefixes]
}

/**
 * The message a call earns when it names a server this deployment does not
 * configure. The gate and the Session share it, so the wording cannot drift.
 * @param name - server name exactly as the call wrote it.
 * @param config - resolved configuration; its names are listed as the valid set.
 * @returns the reason text.
 */
export function unknownServerReason(name: string, config: ResolvedConfig): string {
  const known = config.servers.map(server => server.name).join(', ')
  return `dsh-rcon: unknown server ${JSON.stringify(name)}; configured servers are ${known}`
}

/**
 * Decide one rcon command against the allowlist of the server it targets.
 * @param command - normalized console command.
 * @param prefixes - allowed command prefixes for the target server.
 * @param otherwise - policy for a command matching no prefix.
 * @param server - target server name, named in the reason when given.
 * @returns the allow, ask, or deny decision this command earns.
 */
export function decideCommand(
  command: string,
  prefixes: readonly string[],
  otherwise: UngrantedCommandPolicy,
  server?: string,
): CommandPolicyDecision {
  if (matchesAllowedPrefix(command, prefixes)) return { kind: 'allow' }
  // The allowlist is per server, so both the model reading a refusal and the
  // human reading an approval prompt need to know which endpoint the call hits.
  const where = server === undefined ? '' : ` on server ${JSON.stringify(server)}`
  if (otherwise === 'ask') {
    return { kind: 'ask', reason: `Run the Minecraft rcon command ${JSON.stringify(command)}${where}?` }
  }
  return {
    kind: 'deny',
    reason: `The Minecraft rcon command ${JSON.stringify(command)}${where} matches no allowed prefix, `
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

/**
 * Read the target server out of a parsed argument object the tool schema has not
 * validated yet. Selection is by exact name, so an empty or non-string value
 * counts as "named none" and falls back to the deployment's default server.
 * @param value - parsed model arguments.
 * @returns the server name the call asked for, or undefined when it named none.
 */
export function readServerArgument(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const server = value['server']
  return typeof server === 'string' && server !== '' ? server : undefined
}
