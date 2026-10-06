/**
 * Out-of-tree DeepSeek Harness plugin that bridges Minecraft server rcon
 * consoles into an agent Session.
 *
 * The plugin serves several named servers. A Session keeps one lazily opened
 * connection per server it uses and reclaims a connection that has been idle
 * for the configured timeout. One `rcon` tool call sends a console command and
 * blocks for a wait window; the feedback the server tags with that request id
 * during the window becomes the call's result, and feedback for the same
 * request id that arrives later is delivered as its own message, merged by a
 * fixed window anchored at that request id's first message.
 *
 * Deployment policy decides which commands may run, per server: a command headed
 * by one of the deployment-wide `allowedPrefixes` or by a prefix the target
 * server grants itself runs, and every other command is asked about or denied.
 *
 * @module dsh-rcon
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveConfig } from './config.ts'
import type { Config } from './config.ts'
import { decideCommand, dispatchedCommand, effectiveAllowedPrefixes, readCommandArgument, readServerArgument, unknownServerReason } from './policy.ts'
import { RconSession } from './session.ts'
import type { ResolvedConfig } from './types.ts'

export { Config } from './config.ts'

/** Cordis plugin name; also the `kind` of every message this plugin delivers. */
export const name = 'dsh-rcon'

/** The tool registry is required before the `rcon` tool can be registered. */
export const inject = ['tools']

/** The one tool this plugin registers and gates. */
const TOOL_NAME = 'rcon'

/** Build the model-facing description, naming the configured servers. */
function toolDescription(config: ResolvedConfig): string {
  const names = config.servers.map(server => server.name).join(', ')
  return 'Run one Minecraft server console command over rcon and return the feedback the server tagged '
    + 'with that command\'s rcon request id during a blocking wait window. Feedback for the same request '
    + 'id that arrives after the window follows feedback_delivery. Use 0 for wait_ms to skip the window '
    + `and let all feedback arrive that way. Configured servers: ${names}. Default server: ${config.defaultServer}.`
}

/**
 * Register the Session-scoped rcon bridge and its command gate for the lifetime of `ctx`.
 * @param ctx - plugin context; the tool, the gate, and every link are disposed with it.
 * @param config - server endpoints, timing, and the command policy.
 * @throws when the configuration is incomplete or out of range.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const sessions = new Map<SessionId, RconSession>()

  /** Reuse the Session's link set, replacing one left by a superseded agent. */
  const sessionFor = (agent: Agent): RconSession => {
    const existing = sessions.get(agent.session.id)
    if (existing !== undefined) {
      if (existing.owner === agent) return existing
      // `clear`, `compact`, and `resume` enter a replacement agent on the same
      // Session id. The predecessor's links and batchers belong to it, not to
      // the successor, so drop them here rather than reporting into a disposed
      // agent for the rest of the Session's life.
      sessions.delete(agent.session.id)
      existing.dispose()
    }
    const created = new RconSession(ctx, agent, resolved)
    sessions.set(agent.session.id, created)
    return created
  }

  ctx.on('agent/disposed', ({ agent }) => {
    const session = sessions.get(agent.session.id)
    // Only the owning agent may release an entry: a predecessor disposed after
    // its successor was registered must not evict the successor's state.
    if (session === undefined || session.owner !== agent) return
    sessions.delete(agent.session.id)
    session.dispose()
  })

  ctx.effect(() => () => {
    for (const session of sessions.values()) session.dispose()
    sessions.clear()
  }, 'dsh-rcon.sessions')

  // Command policy belongs on the documented gate: other plugins layer on it,
  // and a direct tool call cannot bypass a decision the pipeline makes.
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== TOOL_NAME) return next()
    const command = readCommandArgument(exec.arguments)
    // A call without a usable command is rejected by the tool's own schema.
    if (command === undefined) return next()
    // The allowlist is per server, so the target is resolved here, the same way
    // the tool resolves it. A name this deployment does not configure cannot
    // succeed later either, so it is refused before a policy question that could
    // not have changed the outcome.
    const requested = readServerArgument(exec.arguments) ?? resolved.defaultServer
    const server = resolved.servers.find(candidate => candidate.name === requested)
    if (server === undefined) return { kind: 'deny', reason: unknownServerReason(requested, resolved) }
    // Judge the text the dispatcher will read, not the wire spelling that the
    // server still has to strip one slash from.
    const decision = decideCommand(
      dispatchedCommand(command),
      effectiveAllowedPrefixes(resolved, server),
      resolved.otherwise,
      server.name,
    )
    if (decision.kind === 'allow') return next()
    if (decision.kind === 'deny') return { kind: 'deny', reason: decision.reason }
    return { kind: 'ask', reason: decision.reason }
  })

  ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description: toolDescription(resolved),
    parameters: {
      server: {
        type: 'string',
        description: 'Name of the configured server to run on. Omit to use the default server.',
      },
      command: {
        type: 'string',
        required: true,
        description: 'Minecraft console command, sent as written. The leading slash is optional, '
          + 'for example "list" or "/list".',
      },
      wait_ms: {
        type: 'number',
        description: 'Milliseconds to block and collect command feedback as this call\'s result. '
          + 'Defaults to the deployment\'s configured wait window.',
      },
      feedback_delivery: {
        type: 'string',
        enum: ['inject', 'followup'],
        description: 'How feedback for this command that arrives after the wait window reaches you: '
          + '"inject" adds it as context without waking you, "followup" delivers it as a new turn that '
          + 'wakes you so you can react. Defaults to "inject" and stays in effect until you change it.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          server: {
            type: 'string',
            required: true,
            description: 'Configured server the command ran on.',
          },
          request_id: {
            type: 'integer',
            required: true,
            description: 'rcon request id this command was sent with; later feedback for it carries the same id.',
          },
          messages: {
            type: 'array',
            items: { type: 'string' },
            required: true,
            description: 'Feedback tagged with this request id that arrived during the wait window, in order.',
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.messages.length === 0
          ? `No rcon feedback for server "${value.server}" request #${String(value.request_id)} arrived during `
            + 'the wait window. Feedback the server sends for it after the window arrives separately.'
          : `rcon server "${value.server}" request #${String(value.request_id)}:\n${value.messages.join('\n')}`,
      }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('dsh-rcon: the rcon tool requires an agent-scoped call')
      const waitMs = args.wait_ms ?? resolved.defaultWaitMs
      if (!Number.isSafeInteger(waitMs) || waitMs < 0) {
        throw new Error('dsh-rcon: wait_ms must be a non-negative integer')
      }
      // Sent verbatim: the server strips at most one leading slash itself, and
      // `//command` spellings must reach the dispatcher intact. An empty command
      // is allowed through as well — it fails on the server, which is the
      // server's answer to give, and it is a legitimate way to refresh the
      // link's activity.
      const result = await sessionFor(agent).runCommand(
        args.server ?? resolved.defaultServer,
        args.command,
        waitMs,
        args.feedback_delivery,
        exec.signal,
      )
      return { server: result.server, request_id: result.requestId, messages: result.messages }
    },
    isConcurrencySafe: () => false,
  }))
}
