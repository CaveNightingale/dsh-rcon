/**
 * Per-Session rcon state: one lazily opened, idle-reclaimed link per configured
 * server, plus the feedback batcher that delivers messages arriving outside a
 * command window.
 *
 * @module dsh-rcon/session
 */

import { boundContextSummary, createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { FeedbackBatch } from './batch.ts'
import { RconConnection } from './connection.ts'
import { unknownServerReason } from './policy.ts'
import type {
  FeedbackDelivery,
  RconAgent,
  RconDiagnostics,
  RconExchange,
  RconServerFeedback,
  ResolvedConfig,
  ResolvedServer,
} from './types.ts'

/** The Session-event source kind this plugin declares for delivered feedback. */
const SOURCE_KIND = 'dsh-rcon'

/**
 * Render one request id's feedback as the model-facing text.
 * @param feedback - settled messages for one request id.
 * @returns the merged text, labelled with its server and rcon request id.
 */
function renderFeedback(feedback: RconServerFeedback): string {
  return `Minecraft rcon feedback from server "${feedback.server}" for request `
    + `#${String(feedback.requestId)}:\n${feedback.messages.join('\n')}`
}

/**
 * One Session's link to one configured server: the connection commands reuse,
 * the feedback batch for messages outside a window, and the idle deadline that
 * reclaims both.
 */
class ServerLink {
  private readonly connection: RconConnection
  private readonly feedback: FeedbackBatch
  private readonly idleTimeoutMs: number
  private idleTimer: NodeJS.Timeout | undefined

  /**
   * @param server - configured endpoint this link talks to.
   * @param config - timing bounds shared by every link of the deployment.
   * @param onFeedback - receives each settled post-window group.
   * @param onIdle - called once when the link went `config.idleTimeoutMs` without traffic.
   */
  constructor(
    readonly server: ResolvedServer,
    config: ResolvedConfig,
    onFeedback: (exchange: RconExchange) => void,
    private readonly onIdle: () => void,
  ) {
    this.idleTimeoutMs = config.idleTimeoutMs
    this.connection = new RconConnection({
      host: server.host,
      port: server.port,
      password: server.password,
      connectTimeoutMs: config.connectTimeoutMs,
    }, (requestId, message) => {
      this.touch()
      this.feedback.push(requestId, message)
    })
    this.feedback = new FeedbackBatch({
      windowMs: config.feedbackBatchMs,
      flush: onFeedback,
    })
    this.touch()
  }

  /**
   * Send one command over this link.
   * @param command - console command, sent verbatim.
   * @param waitMs - blocking window in milliseconds.
   * @param signal - caller-owned cancellation.
   * @returns the command's request id and the feedback received inside the window.
   */
  run(command: string, waitMs: number, signal: AbortSignal): Promise<RconExchange> {
    this.touch()
    return this.connection.exec(command, waitMs, signal)
  }

  /** Close the connection, cancel the idle deadline, and drop pending groups. */
  dispose(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
    this.feedback.dispose()
    this.connection.close()
  }

  /**
   * Restart the idle deadline. Any received message and any sent command counts
   * as activity, so an unused link is reclaimed while an active one survives.
   * The deadline is unref'd: an idle link never keeps the process alive.
   */
  private touch(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => { this.onIdle() }, this.idleTimeoutMs)
    this.idleTimer.unref()
  }
}

/**
 * Owns everything one agent Session keeps against the configured servers: one
 * reusable link per server, and the batcher that turns post-window feedback into
 * model-visible messages.
 */
export class RconSession {
  /** The Session these links serve. */
  readonly sessionId: SessionId
  /** The agent that owns these links; a replacement agent is a different owner. */
  readonly owner: RconAgent
  private readonly links = new Map<string, ServerLink>()
  private delivery: FeedbackDelivery = 'inject'
  private disposed = false

  /**
   * @param diagnostics - logger used when a delivery finds a disposed agent.
   * @param agent - the agent whose Session owns these links.
   * @param config - validated servers and timing bounds.
   */
  constructor(
    private readonly diagnostics: RconDiagnostics,
    agent: RconAgent,
    private readonly config: ResolvedConfig,
  ) {
    this.owner = agent
    this.sessionId = agent.session.id
  }

  /**
   * Run one console command against one configured server.
   * @param server - name of the configured server to use.
   * @param command - console command, sent verbatim.
   * @param waitMs - blocking window in milliseconds.
   * @param delivery - delivery for feedback arriving after the window; omitted keeps the current mode.
   * @param signal - caller-owned cancellation.
   * @returns the server, request id, and the feedback received inside the window.
   * @throws when the Session was disposed or the name is not configured.
   */
  async runCommand(
    server: string,
    command: string,
    waitMs: number,
    delivery: FeedbackDelivery | undefined,
    signal: AbortSignal,
  ): Promise<RconServerFeedback> {
    if (delivery !== undefined) this.delivery = delivery
    const exchange = await this.linkFor(server).run(command, waitMs, signal)
    return { server, requestId: exchange.requestId, messages: exchange.messages }
  }

  /** Close every link and stop delivering feedback for this Session. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const link of this.links.values()) link.dispose()
    this.links.clear()
  }

  /** Reuse this Session's link to `name`, opening one on first use. */
  private linkFor(name: string): ServerLink {
    if (this.disposed) throw new Error(`dsh-rcon: Session "${this.sessionId}" is disposed`)
    const existing = this.links.get(name)
    if (existing !== undefined) return existing
    const server = this.config.servers.find(candidate => candidate.name === name)
    if (server === undefined) throw new Error(unknownServerReason(name, this.config))
    const created = new ServerLink(
      server,
      this.config,
      exchange => { this.deliver({ server: name, ...exchange }) },
      () => { this.reclaim(name) },
    )
    this.links.set(name, created)
    return created
  }

  /** Drop one idle link; a later command opens a fresh one. */
  private reclaim(name: string): void {
    const link = this.links.get(name)
    if (link === undefined) return
    this.links.delete(name)
    link.dispose()
  }

  /** Deliver one merged feedback group the way the model last asked for. */
  private deliver(feedback: RconServerFeedback): void {
    try {
      const message = createUserMessage({
        content: [{ type: 'text', text: renderFeedback(feedback) }],
        source: {
          kind: SOURCE_KIND,
          rconServer: feedback.server,
          rconRequestId: feedback.requestId,
          form: 'notice',
          summary: boundContextSummary(
            `Minecraft rcon "${feedback.server}" request #${String(feedback.requestId)}: `
            + `${String(feedback.messages.length)} message(s)`,
          ),
        },
      })
      if (this.delivery === 'followup') this.owner.followup(message)
      else this.owner.inject(message)
    } catch (error: unknown) {
      // The agent can reach disposal between the batch timer and this flush.
      this.diagnostics.logger.debug(`dsh-rcon: dropped rcon feedback for ${this.sessionId}: ${errorChain(error)}`)
    }
  }
}
