/**
 * Plugin configuration: the deployment-facing shape, its Schemastery schema, and
 * the resolution step that applies defaults and rejects what the schema cannot
 * express.
 *
 * @module dsh-rcon/config
 */

import z from '@deepseek-ai/schemastery'
import type { ResolvedConfig, ResolvedServer, RconServerConfig, UngrantedCommandPolicy } from './types.ts'

/** Five hours: the default idle deadline for one Session's link to one server. */
export const DEFAULT_IDLE_TIMEOUT_MS = 18_000_000

/**
 * Deployment values read from the plugin row's `config` in `cordis.patch.yml`.
 * Servers, passwords, timing bounds, and the command allowlist are all
 * deployment-varying, so they live here instead of in the plugin body.
 */
export interface Config {
  /** Named rcon endpoints; a call selects one by name. */
  servers: RconServerConfig[]
  /** Name of the server a call uses when it names none; defaults to the first entry. */
  defaultServer?: string
  /** Idle time in milliseconds after which one Session's link to one server is reclaimed. */
  idleTimeoutMs?: number
  /** Default command wait window in milliseconds when a call omits `wait_ms`. */
  defaultWaitMs?: number
  /** Fixed merge window in milliseconds, anchored at a feedback group's first message. */
  feedbackBatchMs?: number
  /** Bound on the TCP connect plus login handshake, in milliseconds. */
  connectTimeoutMs?: number
  /** Command prefixes that run without approval. */
  allowedPrefixes?: string[]
  /** Policy for a command matching no allowed prefix. */
  otherwise?: UngrantedCommandPolicy
}

/** Server endpoints, timing, and command policy. Passwords are deployment secrets
 * and belong in the profile's own `cordis.patch.yml`, outside the session workspace. */
export const Config: z<Config> = z.object({
  servers: z.array(z.object({
    name: z.string(),
    host: z.string().default('127.0.0.1'),
    port: z.number().step(1).min(1).max(65535).default(25575),
    password: z.string(),
  })).default([]),
  defaultServer: z.string(),
  idleTimeoutMs: z.number().step(1).min(1).default(DEFAULT_IDLE_TIMEOUT_MS),
  defaultWaitMs: z.number().step(1).min(0).default(1000),
  feedbackBatchMs: z.number().step(1).min(0).default(1000),
  connectTimeoutMs: z.number().step(1).min(1).default(5000),
  allowedPrefixes: z.array(z.string()).default([]),
  otherwise: z.union(['ask', 'deny']).default('deny'),
})

/** Require one bounded integer, naming the config field on failure. */
function requireInteger(value: number | undefined, field: string, min: number, max: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(
      `dsh-rcon: config.${field} must be an integer in [${String(min)}, ${String(max)}], got ${String(value)}`,
    )
  }
  return value
}

/** Require one non-empty string, naming the config field on failure. */
function requireText(value: string | undefined, field: string): string {
  if (value === undefined || value.trim() === '') {
    throw new TypeError(`dsh-rcon: config.${field} must be a non-empty string`)
  }
  return value
}

/**
 * Require one usable allowlist prefix. Matching runs against the dispatcher's
 * single-strip form, so a padded entry could never match a command and would sit
 * in the configuration as dead policy; it is rejected instead of rewritten.
 * @param prefix - raw allowlist entry.
 * @param index - entry position, used in the error message.
 * @returns the prefix as configured.
 */
function resolveAllowedPrefix(prefix: string, index: number): string {
  const field = `allowedPrefixes[${String(index)}]`
  const value = requireText(prefix, field)
  if (value.trim() !== value) {
    throw new TypeError(`dsh-rcon: config.${field} must not have leading or trailing whitespace`)
  }
  return value
}

/**
 * Apply schema defaults and validate the constraints the schema does not express.
 * @param config - raw plugin configuration.
 * @returns fully resolved configuration.
 * @throws when the deployment lists no usable server or a bound is out of range.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const servers: ResolvedServer[] = (config.servers ?? []).map((server, index) => ({
    name: requireText(server.name, `servers[${String(index)}].name`),
    host: requireText(server.host, `servers[${String(index)}].host`),
    port: requireInteger(server.port, `servers[${String(index)}].port`, 1, 65535),
    password: requireText(server.password, `servers[${String(index)}].password`),
  }))
  const [first] = servers
  if (first === undefined) {
    throw new Error(
      'dsh-rcon: config.servers must list at least one server; set it in the profile cordis.patch.yml '
      + 'under $DSH_HOME/profiles/<name>/ (outside the session workspace)',
    )
  }
  const names = new Set<string>()
  for (const server of servers) {
    if (names.has(server.name)) {
      throw new TypeError(`dsh-rcon: duplicate server name ${JSON.stringify(server.name)}`)
    }
    names.add(server.name)
  }
  const requestedDefault = config.defaultServer
  if (requestedDefault !== undefined && !names.has(requestedDefault)) {
    throw new TypeError(
      `dsh-rcon: config.defaultServer ${JSON.stringify(requestedDefault)} is not a configured server`,
    )
  }
  return {
    servers,
    defaultServer: requestedDefault ?? first.name,
    idleTimeoutMs: requireInteger(config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, 'idleTimeoutMs', 1, 0x7fff_ffff),
    defaultWaitMs: requireInteger(config.defaultWaitMs ?? 1000, 'defaultWaitMs', 0, 0x7fff_ffff),
    feedbackBatchMs: requireInteger(config.feedbackBatchMs ?? 1000, 'feedbackBatchMs', 0, 0x7fff_ffff),
    connectTimeoutMs: requireInteger(config.connectTimeoutMs ?? 5000, 'connectTimeoutMs', 1, 0x7fff_ffff),
    allowedPrefixes: (config.allowedPrefixes ?? []).map(resolveAllowedPrefix),
    otherwise: config.otherwise ?? 'deny',
  }
}
