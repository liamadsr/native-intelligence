import { getServiceClient } from '@/lib/supabase/service'

/**
 * Ephemeral "the live agent wants to say something to you" channel.
 *
 * The live agent runs as a series of short-lived `POST /api/ai/live-agent`
 * requests (one per voice-pause). When its `say_to_user` tool fires we need the
 * message to reach a LONG-LIVED surface — the detached agent HUD window, which
 * is alive for the whole meeting and is a different context than any single
 * request. A Realtime BROADCAST is the right fit: a pure ephemeral pub/sub
 * message over a websocket, scoped to a channel. **No database row is written**
 * — the message exists only in flight and is gone once delivered. (The user
 * explicitly did not want "random rows in the DB" for this.)
 *
 * Channel naming: `agent-nudge:<captureId>`. The capture id is a hard-to-guess
 * UUID and the natural scope — only surfaces watching THAT meeting subscribe.
 *
 * The payload carries a stable `id` so a future reply path (HUD → agent) can
 * reference a specific nudge without any schema change. One-way for now.
 */

export type NudgeKind = 'insight' | 'reminder' | 'suggestion'

export interface AgentNudge {
  /** Stable id for this message (lets a future reply reference it). */
  id: string
  /** The message text the agent wants to surface to the user. */
  message: string
  /** Loose classification so the HUD can style/iconify it. */
  kind: NudgeKind
  /** The capture this nudge belongs to (also the channel scope). */
  captureId: string
  /** Unix ms when it was sent (stamped server-side). */
  ts: number
}

/** The Realtime channel name for a capture's agent nudges. */
export function nudgeChannelName(captureId: string): string {
  return `agent-nudge:${captureId}`
}

/** The broadcast event name carried on that channel. */
export const NUDGE_EVENT = 'nudge'

/**
 * Publish one nudge over the capture's broadcast channel. Best-effort and
 * self-contained: it creates a transient channel, subscribes, sends, and tears
 * down — so a tool call never leaks a long-lived subscription on the server.
 * Returns true if the send was accepted by the Realtime client.
 *
 * NOTE: this writes NOTHING to the database. If no HUD is currently subscribed
 * the message is simply dropped (correct — there's nobody to tell).
 */
export async function broadcastNudge(nudge: AgentNudge): Promise<boolean> {
  const supabase = getServiceClient()
  // PRIVATE channel: subscribers are gated by the realtime.messages RLS policy
  // (capture's-workspace members only — see migration). This producer uses the
  // service-role client, which BYPASSES RLS, so it can always publish; making the
  // channel private only locks down who may SUBSCRIBE/inject, closing the
  // eavesdrop + nudge-spoof vectors a public channel would leave open.
  const channel = supabase.channel(nudgeChannelName(nudge.captureId), {
    config: { private: true, broadcast: { ack: true } },
  })

  try {
    // A broadcast-only channel must be SUBSCRIBED before `.send()` will deliver.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('subscribe timeout')), 4000)
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          clearTimeout(timer)
          resolve()
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          clearTimeout(timer)
          reject(new Error(`channel status: ${status}`))
        }
      })
    })

    const res = await channel.send({
      type: 'broadcast',
      event: NUDGE_EVENT,
      payload: nudge,
    })
    return res === 'ok'
  } catch {
    return false
  } finally {
    // Always tear the transient channel down — never leak a subscription.
    await supabase.removeChannel(channel).catch(() => {})
  }
}
