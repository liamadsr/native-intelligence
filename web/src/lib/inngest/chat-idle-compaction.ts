import { getServiceClient } from '@/lib/admin'
import { inngest } from './client'
import { CHAT_SESSION_ACTIVITY_EVENT, type ChatSessionActivityData } from '@/lib/chat/idle-compaction-signal'
import {
  IDLE_COMPACTION_DEBOUNCE_PERIOD,
  IDLE_COMPACTION_RECHECK_DELAY,
  IDLE_COMPACTION_RECHECK_OUTCOMES,
  checkIdleCompaction,
  compactIdleSession,
  idleCompactionLogLine,
  idleCompactionStillQuiet,
  parseActivityData,
  type IdleCompactionOutcome,
} from '@/lib/chat/idle-compaction'

/**
 * chat/session.activity → (debounced 3 min per conversation) → idle compaction
 *
 * docs/plans/always-on-agent.md §2. The eve-session and persist routes send
 * `chat/session.activity` (src/lib/chat/idle-compaction-signal.ts) whenever a
 * send starts, the person types in an existing conversation, or a turn ends.
 * Inngest's debounce holds the run until the conversation has been quiet for
 * IDLE_COMPACTION_QUIET_MS. The event is ids only (no credential). The run
 * re-checks everything itself, never trusting the event
 * (src/lib/chat/idle-compaction.ts), and compacts only a big, idle, settled
 * session, as the chat-agent's narrow server principal.
 *
 * Background work about to wake the agent (a home turn claimed, sending or
 * pending, a background helper running) re-arms the timer instead of
 * compacting: the run sends a fresh activity signal and stops.
 *
 * A turn running, recent activity or no events at all (a slow stream open)
 * may clear up soon: the run sleeps IDLE_COMPACTION_RECHECK_DELAY and looks
 * once more (both steps again), then stops either way.
 *
 * Its own event, not `conversation/activity`: that one feeds the 20-minute
 * knowledge extraction, which a mint (no new message) must not trigger.
 *
 * `retries: 0`: a compaction request is billed, so it is never sent twice.
 * Every expected stop returns `{ status: 'skipped', reason }`; nothing throws.
 * One `[idle-compaction]` line per look (two with the re-check).
 */
export const chatIdleCompaction = inngest.createFunction(
  {
    id: 'chat-idle-compaction',
    retries: 0,
    debounce: { key: 'event.data.conversationId', period: IDLE_COMPACTION_DEBOUNCE_PERIOD },
    triggers: [{ event: CHAT_SESSION_ACTIVITY_EVENT }],
  },
  async ({ event, step }) => {
    const data = parseActivityData(event.data)
    if (!data) {
      console.info(idleCompactionLogLine({ conversationId: '-', outcome: 'bad_event' }))
      return { status: 'skipped', reason: 'bad_event' }
    }

    /** One look: the database check, then eve. A step-1 skip is final. */
    const look = async (recheck: boolean): Promise<{ status: 'skipped'; reason: IdleCompactionOutcome } | { status: IdleCompactionOutcome }> => {
      const suffix = recheck ? '-again' : ''
      const check = await step.run(`check${suffix}`, () => checkIdleCompaction(getServiceClient(), data))
      if (!check.ok) {
        console.info(
          idleCompactionLogLine({
            conversationId: data.conversationId,
            sessionId: check.sessionId,
            inputTokens: check.billedInputTokens,
            outcome: check.reason,
            recheck,
          }),
        )
        // Background work is about to wake the agent here: no compaction now,
        // and the quiet timer starts again (a fresh activity signal through the
        // same debounce), so the conversation is looked at once that work is
        // done. Each waking condition is bounded (idle-compaction.ts
        // backgroundWorkWaking), so this never re-arms for good.
        if (check.reason === 'background_waking') {
          await step.sendEvent(`rearm${suffix}`, { name: CHAT_SESSION_ACTIVITY_EVENT, data: { ...data, source: 'turn' } })
        }
        return { status: 'skipped', reason: check.reason }
      }

      const result = await step.run(`compact${suffix}`, () =>
        compactIdleSession(
          { claims: check.claims, sessionId: check.sessionId },
          { stillQuiet: () => stillQuiet(data, check.sessionId, check.latestUsageAt) },
        ),
      )
      console.info(
        idleCompactionLogLine({
          conversationId: data.conversationId,
          sessionId: check.sessionId,
          inputTokens: result.inputTokens ?? check.billedInputTokens,
          outcome: result.outcome,
          recheck,
        }),
      )
      return { status: result.outcome }
    }

    const first = await look(false)
    if (first.status === 'skipped') return first
    if (!IDLE_COMPACTION_RECHECK_OUTCOMES.has(first.status)) return { ...first, conversationId: data.conversationId }
    // Once more, later: bounded (one sleep, one look), never a loop.
    await step.sleep('recheck-wait', IDLE_COMPACTION_RECHECK_DELAY)
    const second = await look(true)
    return { ...second, conversationId: data.conversationId, rechecked: true }
  },
)

/** The pre-compact presence re-check, on a fresh service client. */
function stillQuiet(data: ChatSessionActivityData, sessionId: string, latestUsageAt: string | null): Promise<boolean> {
  return idleCompactionStillQuiet(getServiceClient(), { userId: data.userId, sessionId, latestUsageAt })
}
