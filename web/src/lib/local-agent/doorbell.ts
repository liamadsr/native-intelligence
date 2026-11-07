/**
 * The local-agent doorbell: a private broadcast on `device:<userId>` that
 * tells the person's online Mac to drain its pending work now (a start, a
 * message, a stop). Fire-and-drop, copied from the browser-command queue
 * (src/lib/browser-agent/queue.ts): the relay's 5 s poll is the correctness
 * backstop, so a failed ring only means the Mac picks it up on the next poll.
 *
 * Subscribe is gated by migration 410's realtime.messages policy (the topic's
 * user id must be auth.uid()); only the service role can send.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export const DOORBELL_EVENT = 'local-agent'

export function deviceTopic(userId: string): string {
  return `device:${userId}`
}

export type DoorbellReason = 'start' | 'message' | 'stop'

/** Ring the person's devices. Never throws. */
export async function ringDoorbell(
  svc: SupabaseClient,
  userId: string,
  payload: { reason: DoorbellReason; sessionId: string },
): Promise<void> {
  try {
    const channel = svc.channel(deviceTopic(userId), {
      config: { private: true, broadcast: { ack: false } },
    })
    await channel.send({ type: 'broadcast', event: DOORBELL_EVENT, payload })
    await svc.removeChannel(channel)
  } catch {
    /* the poll backstop covers a missed doorbell */
  }
}
