/**
 * The "someone is here" signal for idle-time chat compaction
 * (docs/plans/always-on-agent.md §2, src/lib/inngest/chat-idle-compaction.ts).
 *
 * Three senders, all cheap and best-effort:
 *   - /api/account/chat/eve-session's mint (`source: 'mint'`): a send is
 *     starting;
 *   - its `presence` action (`source: 'typing'`): the person is typing in an
 *     existing conversation (the browser asks at most once a minute);
 *   - /api/account/chat/eve-persist (`source: 'turn'`): a turn just finished.
 * Mint and typing signals go at most once a minute per conversation per
 * instance; a turn always goes. The presence action also takes at most
 * PRESENCE_USER_LIMIT pings a minute per person per instance
 * (allowPresencePing), so one person can't flood it across conversations. The Inngest function debounces on the
 * conversation id, so each signal pushes the idle timer back and only a
 * conversation quiet for IDLE_COMPACTION_QUIET_MS is looked at.
 *
 * The event carries ids only, never a credential: the compaction runs as the
 * chat-agent channel's narrow server principal (internal secret + a run token
 * the function mints itself), see src/lib/chat/idle-compaction.ts.
 */
import { after } from 'next/server'
import { inngest } from '@/lib/inngest/client'

/** The Inngest event the idle-compaction function debounces on. */
export const CHAT_SESSION_ACTIVITY_EVENT = 'chat/session.activity' as const

/** Mints and typing pings: a minute is enough resolution for the 3-minute timer (each ping pushes it back). */
export const ACTIVITY_SIGNAL_THROTTLE_MS = 60_000

/** Bounds the per-instance throttle map (a serverless instance serves few chats). */
const THROTTLE_MAX_ENTRIES = 1000

/** Presence pings one person may send a minute, per instance (the browser sends one per conversation a minute). */
export const PRESENCE_USER_LIMIT = 10

export type ChatSessionActivitySource = 'mint' | 'typing' | 'turn'

export interface ChatSessionActivityData {
  conversationId: string
  workspaceId: string
  userId: string
  source: ChatSessionActivitySource
}

const lastSignal = new Map<string, number>()

/**
 * Tell the idle-compaction timer this conversation is in use. Never throws and
 * never delays the response: the send runs after it (next/server `after`),
 * or detached outside a request scope.
 */
export function signalChatSessionActivity(args: ChatSessionActivityData & { now?: number }): void {
  try {
    const now = args.now ?? Date.now()
    if (args.source !== 'turn') {
      const last = lastSignal.get(args.conversationId)
      if (last !== undefined && now - last < ACTIVITY_SIGNAL_THROTTLE_MS) return
      if (lastSignal.size >= THROTTLE_MAX_ENTRIES) lastSignal.clear()
      lastSignal.set(args.conversationId, now)
    }
    const data: ChatSessionActivityData = {
      conversationId: args.conversationId,
      workspaceId: args.workspaceId,
      userId: args.userId,
      source: args.source,
    }
    const send = async () => {
      try {
        await inngest.send({ name: CHAT_SESSION_ACTIVITY_EVENT, data })
      } catch (err) {
        console.warn('[idle-compaction] activity signal failed:', err instanceof Error ? err.message : String(err))
      }
    }
    try {
      after(send)
    } catch {
      // Outside a request scope (a script, a test): send detached.
      void send()
    }
  } catch {
    // Best-effort by contract: a missed signal only means a missed idle compaction.
  }
}

const presenceWindows = new Map<string, { start: number; count: number }>()

/**
 * The presence action's per-person throttle: true while `userId` has sent
 * fewer than PRESENCE_USER_LIMIT pings in the current minute (on this
 * instance). Checked before the route's conversation read.
 */
export function allowPresencePing(userId: string, now: number = Date.now()): boolean {
  const w = presenceWindows.get(userId)
  if (!w || now - w.start >= ACTIVITY_SIGNAL_THROTTLE_MS) {
    if (presenceWindows.size >= THROTTLE_MAX_ENTRIES) presenceWindows.clear()
    presenceWindows.set(userId, { start: now, count: 1 })
    return true
  }
  if (w.count >= PRESENCE_USER_LIMIT) return false
  w.count += 1
  return true
}

/** Test seam: forget the throttle. */
export function resetChatActivityThrottle(): void {
  lastSignal.clear()
  presenceWindows.clear()
}
