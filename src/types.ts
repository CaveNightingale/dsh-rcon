/**
 * Configuration, resolved runtime values, and the Session-event source this
 * plugin declares for model-visible context.
 *
 * @module dsh-rcon/types
 */

import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Command feedback the Minecraft server forwarded over the rcon connection. */
    'dsh-rcon': { kind: 'dsh-rcon'; rconServer: string; rconRequestId: number } & ContextFormed
  }
}

/**
 * The agent surface this plugin needs: the Session identity that scopes its
 * links, plus the two delivery methods for post-window feedback. `Agent`
 * satisfies it, and a test can satisfy it with a plain object.
 */
export interface RconAgent {
  readonly session: { readonly id: SessionId }
  /** Queue feedback as next-step context without waking the agent. */
  inject(message: UserMessage): void
  /** Deliver feedback as its own turn, waking the agent. */
  followup(message: UserMessage): void
}

/** The diagnostics surface this plugin needs. */
export interface RconDiagnostics {
  readonly logger: { debug(message: string): void }
}

/** How feedback arriving after a command's wait window reaches the model. */
export type FeedbackDelivery = 'inject' | 'followup'

/** Policy for a command that matches none of the allowed prefixes. */
export type UngrantedCommandPolicy = 'ask' | 'deny'

/** One named rcon endpoint from the plugin's `servers` list. */
export interface RconServerConfig {
  /** Name the model uses to select this server. */
  name: string
  /** Host name or address. */
  host: string
  /** TCP port. */
  port: number
  /** rcon password; a deployment secret that belongs in the deployment's own
   * configuration layer, outside the session workspace. */
  password: string
  /** Command prefixes this server grants **in addition to** the deployment-wide
   * `allowedPrefixes`. Grants are additive only: a per-server list can widen what
   * a server accepts, never take away a deployment-wide grant. */
  allowedPrefixes?: string[]
}

/** One configured server with every default applied. */
export interface ResolvedServer {
  readonly name: string
  readonly host: string
  readonly port: number
  readonly password: string
  /** Extra prefixes this server grants on top of the deployment-wide list; empty
   * when it adds none. */
  readonly allowedPrefixes: readonly string[]
}

/** Validated configuration with every default applied. */
export interface ResolvedConfig {
  readonly servers: readonly ResolvedServer[]
  /** Name of the server a call uses when it names none. */
  readonly defaultServer: string
  /** Idle time after which one Session's link to one server is reclaimed. */
  readonly idleTimeoutMs: number
  readonly defaultWaitMs: number
  readonly feedbackBatchMs: number
  readonly connectTimeoutMs: number
  /** Deployment-wide command prefixes that run without approval; each server's
   * own `allowedPrefixes` is added to this list for calls that target it. */
  readonly allowedPrefixes: readonly string[]
  /** Policy applied to a command matching no allowed prefix. */
  readonly otherwise: UngrantedCommandPolicy
}

/** TCP endpoint and credentials for one rcon connection. */
export interface RconEndpoint {
  readonly host: string
  readonly port: number
  readonly password: string
  readonly connectTimeoutMs: number
}

/** One connection's answer to one command, keyed by the request id that produced it. */
export interface RconExchange {
  /** Request id the command was sent with; the server tags its feedback with the same id. */
  readonly requestId: number
  /** Feedback received inside the wait window, in arrival order. */
  readonly messages: string[]
}

/** One settled post-window feedback group, plus the server it came from. */
export interface RconServerFeedback {
  /** Name of the configured server that produced the feedback. */
  readonly server: string
  /** Request id the producing command was sent with. */
  readonly requestId: number
  /** The group's messages, in arrival order. */
  readonly messages: string[]
}
