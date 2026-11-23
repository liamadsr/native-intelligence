/**
 * Tell a canvas's open editors that its sharing changed (docs/plans/
 * record-sharing.md, Phase 2): a grant was removed, or lowered from edit to
 * view. Realtime checks a private channel's policies when it is joined, so a
 * person whose grant just went could otherwise keep hearing cursors until
 * their token refreshes. This says so in the room, naming nobody; each
 * editor there asks the server again (its canvas GET, under its own RLS) and
 * leaves, or turns read-only, when the answer changed. Our own client honours
 * it; content never travelled this way (it is RLS-checked per change).
 *
 * The service role sends it (the room is private; 682's policies let in only
 * whoever may open the canvas). Fire-and-drop, as the local-agent doorbell:
 * never throws.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { ACCESS_CHANGED_EVENT, presenceTopic } from './presence'

export async function announceCanvasAccessChanged(svc: SupabaseClient, canvasId: string): Promise<void> {
  await announceAccessChanged(svc, presenceTopic(canvasId))
}

/** The same word in any record's presence room (a spreadsheet's, 689, as its editor listens for it). Never throws. */
export async function announceAccessChanged(svc: SupabaseClient, topic: string): Promise<void> {
  try {
    const channel = svc.channel(topic, { config: { private: true, broadcast: { ack: false } } })
    await channel.send({ type: 'broadcast', event: ACCESS_CHANGED_EVENT, payload: {} })
    await svc.removeChannel(channel)
  } catch {
    /* the editor's next save or read fails under RLS in any case */
  }
}
