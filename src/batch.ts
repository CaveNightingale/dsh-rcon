/**
 * Fixed-window merge of feedback messages into one batch per rcon request id.
 *
 * Each group's window is anchored at that group's first message and is never
 * extended by later messages, so a continuously chatty server still settles:
 * the group flushes `windowMs` after its own first message no matter how many
 * arrive. Groups never merge across request ids, because a request id is what
 * ties a message to the command that produced it.
 *
 * @module dsh-rcon/batch
 */

import type { RconExchange } from './types.ts'

/** Deployment-selected merge window and the sink a settled group reaches. */
export interface FeedbackBatchOptions {
  /** Milliseconds between a group's first message and its flush; `0` flushes on the next tick. */
  readonly windowMs: number
  /** Receives one settled group, in arrival order. */
  readonly flush: (group: RconExchange) => void
}

/** One open request-id group and its anchored flush timer. */
interface PendingGroup {
  readonly requestId: number
  readonly messages: string[]
  timer: NodeJS.Timeout | undefined
}

/** Accumulates feedback messages and publishes them as one merged message per request id. */
export class FeedbackBatch {
  private readonly groups = new Map<number, PendingGroup>()
  private disposed = false

  /** @param options - merge window and flush sink. */
  constructor(private readonly options: FeedbackBatchOptions) {}

  /**
   * Add one message. The first message of a request id's group starts that
   * group's timer; later messages join it without extending the window.
   * @param requestId - request id the server tagged the message with.
   * @param message - one feedback message from the server.
   */
  push(requestId: number, message: string): void {
    if (this.disposed) return
    let group = this.groups.get(requestId)
    if (group === undefined) {
      const created: PendingGroup = { requestId, messages: [], timer: undefined }
      // A message is pushed into `created` before this timer can run, and only
      // `emit` removes a group, so a fired timer always owns a non-empty group.
      created.timer = setTimeout(() => { this.emit(created) }, this.options.windowMs)
      this.groups.set(requestId, created)
      group = created
    }
    group.messages.push(message)
  }

  /** Stop every timer and drop all pending groups without publishing them. */
  dispose(): void {
    for (const group of this.groups.values()) {
      if (group.timer !== undefined) clearTimeout(group.timer)
    }
    this.groups.clear()
    this.disposed = true
  }

  /**
   * Publish the exact group a timer was scheduled for and close it.
   * @param group - the group that timer was created with; `dispose` cancels it
   *   before it fires, so this never runs after the group was dropped.
   */
  private emit(group: PendingGroup): void {
    this.groups.delete(group.requestId)
    this.options.flush({ requestId: group.requestId, messages: group.messages })
  }
}
