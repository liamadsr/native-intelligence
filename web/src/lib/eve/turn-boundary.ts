/**
 * Where a drain of one eve turn stops, and how an unattended one-shot turn
 * ended, for readers of a durable `session.stream()` (which stays open across a
 * park and never ends at a turn boundary by itself).
 *
 * Two eve changes these encode:
 *   - eve 0.67 removed the `task` run mode (the create route ignores `mode`):
 *     EVERY session parks after each turn. A one-shot that used to end with
 *     `session.completed` (or fail closed with `session.failed`) now ends its
 *     turn with `turn.completed` / `turn.failed` / `turn.cancelled`, then parks
 *     at `session.waiting`. A failure that ends the session still reports
 *     `session.failed` (after a `turn.failed` with `terminal: true`).
 *   - eve 0.70 holds a turn open on a question, an approval or a sign-in: the
 *     stream emits `turn.waiting` (`on: "input"`) in place of `turn.completed`
 *     + `session.waiting`, so a drain that only knew `session.waiting` would
 *     hang on a park.
 */
import { isCurrentTurnBoundaryEvent, type MessageStreamEvent } from 'eve/client'

/**
 * A stop condition for one turn's drain, eve 0.79's own rule
 * (client/session-utils.js `endsTurnSegment`) with webhook sign-ins followed,
 * as these drains always did:
 *   - `session.completed` / `session.failed` end the turn;
 *   - `session.waiting` ends it unless a webhook sign-in is still pending
 *     (the sign-in's callback resumes the same session, so keep reading);
 *   - `turn.waiting` ends it when a person must act: an open question or
 *     approval, or `on: "input"` with no webhook sign-in pending.
 *     `on: "tasks"` (the turn's own work is still running) never ends it.
 * Stateful: make one per drain and feed it every event in order.
 */
export function createTurnBoundary(): (ev: MessageStreamEvent) => boolean {
  const pendingWebhookSignIns = new Set<string>()
  const openRequests = new Set<string>()
  return (ev) => {
    switch (ev.type) {
      case 'authorization.required':
        if (ev.data.webhookUrl !== undefined) pendingWebhookSignIns.add(ev.data.attemptId ?? ev.data.name)
        return false
      case 'authorization.completed':
        pendingWebhookSignIns.delete(ev.data.attemptId ?? ev.data.name)
        return false
      case 'input.requested':
        for (const request of ev.data.requests) openRequests.add(request.requestId)
        return false
      case 'input.resolved':
        for (const resolution of ev.data.resolutions) openRequests.delete(resolution.requestId)
        return false
      case 'turn.waiting':
        return openRequests.size > 0 || (ev.data.on === 'input' && pendingWebhookSignIns.size === 0)
      default:
        return isCurrentTurnBoundaryEvent(ev) && (ev.type !== 'session.waiting' || pendingWebhookSignIns.size === 0)
    }
  }
}

/** How an unattended one-shot turn ended. */
export interface OneShotOutcome {
  /**
   * `completed`: the turn finished (or the session completed). `failed`: the
   * turn or the session failed, or the turn was cancelled. `waiting`: it parked
   * on a person (a question, approval or sign-in nobody will answer) or parked
   * without ending its turn; an unattended caller treats this as a failure and
   * cancels the session.
   */
  status: 'completed' | 'failed' | 'waiting'
  failureCode: string | null
  semanticErrorId: string | null
  /**
   * True when eve reported the turn (or the session) over, so nothing is left
   * running and no cancel is needed. False for a park on a person.
   */
  turnEnded: boolean
}

/** classifyOneShot's failureCode for a turn that was cancelled before it ended. */
export const TURN_CANCELLED_CODE = 'TURN_CANCELLED'

/**
 * Classify a one-shot from the boundary its drain stopped at (createTurnBoundary)
 * and the events read before it. Null when the stream ended with no boundary
 * (a cut connection: never a silent success). A one-shot session carries one
 * turn, so the last turn-ending event before the boundary is the answer.
 */
export function classifyOneShot(
  boundary: MessageStreamEvent | undefined,
  events: readonly MessageStreamEvent[],
): OneShotOutcome | null {
  if (!boundary) return null
  const failed = (data: { code?: unknown; details?: unknown }): OneShotOutcome => {
    const details = data.details as { semanticErrorId?: unknown } | undefined
    return {
      status: 'failed',
      failureCode: typeof data.code === 'string' ? data.code : null,
      semanticErrorId: typeof details?.semanticErrorId === 'string' ? details.semanticErrorId : null,
      turnEnded: true,
    }
  }
  const ended = (status: OneShotOutcome['status'], failureCode: string | null = null): OneShotOutcome => ({
    status,
    failureCode,
    semanticErrorId: null,
    turnEnded: status !== 'waiting',
  })
  if (boundary.type === 'session.failed') return failed(boundary.data)
  if (boundary.type === 'session.completed') return ended('completed')
  if (boundary.type === 'turn.waiting') return ended('waiting')
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev.type === 'turn.completed') return ended('completed')
    if (ev.type === 'turn.failed') return failed(ev.data)
    if (ev.type === 'turn.cancelled') return ended('failed', TURN_CANCELLED_CODE)
    if (ev.type === 'turn.started') break
  }
  return ended('waiting')
}

/** Whether eve reported a turn or the session over anywhere in `events`. */
export function turnHasEnded(events: readonly MessageStreamEvent[]): boolean {
  return events.some(
    (ev) =>
      ev.type === 'session.completed' ||
      ev.type === 'session.failed' ||
      ev.type === 'turn.completed' ||
      ev.type === 'turn.failed' ||
      ev.type === 'turn.cancelled',
  )
}
