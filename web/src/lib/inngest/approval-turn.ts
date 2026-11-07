import { inngest } from './client'
import { APPROVAL_TURN_DEBOUNCE_PERIOD, APPROVAL_TURN_DEBOUNCE_TIMEOUT, APPROVAL_TURN_REQUESTED_EVENT } from '@/lib/chat/home-turn'
import { homeTurnLogLine } from '@/lib/chat/home-turn-server'
import { runHomeTurn } from './home-turn'

/**
 * home/approval-turn.requested → the agent carries on once the person's yes
 * ran a call it held (migration 445, src/lib/safety/approval-turn.ts): one
 * home turn with reason 'approval', the same steps as every home turn
 * (runHomeTurn). Its own function only for the debounce: the person just
 * approved and is waiting, so a few seconds batch cards approved in a row,
 * not a report's 90 s. One run per conversation at a time; a home turn of
 * another function already running there holds the lease, and this one waits
 * for it (runHomeTurn's lease waits).
 */
export const approvalTurn = inngest.createFunction(
  {
    id: 'approval-turn',
    retries: 2,
    debounce: { key: 'event.data.conversationId', period: APPROVAL_TURN_DEBOUNCE_PERIOD, timeout: APPROVAL_TURN_DEBOUNCE_TIMEOUT },
    concurrency: [{ limit: 1, key: 'event.data.conversationId' }],
    triggers: [{ event: APPROVAL_TURN_REQUESTED_EVENT }],
  },
  async (ctx) => {
    // Only the approval reason rides this event.
    const reason = (ctx.event.data as { reason?: unknown } | null)?.reason
    if (reason !== 'approval') {
      const conversationId = (ctx.event.data as { conversationId?: unknown } | null)?.conversationId
      console.info(homeTurnLogLine({ conversationId: typeof conversationId === 'string' ? conversationId : '-', outcome: 'unsupported_reason' }))
      return { status: 'skipped', reason: 'unsupported_reason' }
    }
    return runHomeTurn(ctx)
  },
)
