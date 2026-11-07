/**
 * Deliver one inbound text (src/lib/sms/inbound.ts step 9): write it into
 * the person's home thread as THEIR message, then request its text turn
 * (src/lib/inngest/text-turn.ts). The message id is the MessageSid's
 * (`sms-in:<sid>`) and the event id is too, so a webhook Twilio retries
 * converges on one message and one turn. The web chat shows the text through
 * the home thread's live bridge (use-live-conversation.ts, isChannelMessageRow).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { inngest } from '@/lib/inngest/client'
import { ensureHomeThread } from '@/lib/chat/home-thread'
import { persistEveMessage } from '@/lib/chat/eve-message-writer'
import type { HomeTurnRequestedData } from '@/lib/chat/home-turn'
import { CHANNEL_MESSAGE_KIND, SMS_CHANNEL, smsMessageId } from '@/lib/chat/channel-turn'
import { TEXT_TURN_REQUESTED_EVENT } from '@/lib/chat/text-turn'
import type { LinkedPhone } from './store'

/** Seams for the tests. */
export interface DeliverTextDeps {
  send?: (event: { name: string; id: string; data: HomeTurnRequestedData }) => Promise<unknown>
}

/** Throws when the message could not be written (the webhook answers 500 and Twilio retries). */
export async function deliverTextToHomeThread(
  supabase: SupabaseClient,
  args: { linked: LinkedPhone; text: string; sid: string },
  deps: DeliverTextDeps = {},
): Promise<{ conversationId: string }> {
  const { linked, text, sid } = args
  const home = await ensureHomeThread(supabase, { userId: linked.userId, workspaceId: linked.workspaceId })
  const written = await persistEveMessage(supabase, {
    conversationId: home.id,
    userId: linked.userId,
    workspaceId: linked.workspaceId,
    role: 'user',
    parts: [{ type: 'text', text }],
    messageId: smsMessageId(sid),
    metadata: { kind: CHANNEL_MESSAGE_KIND, channel: SMS_CHANNEL, twilio_sid: sid },
  })
  // A replay finds the row already there (written: false, no reason): still request the turn.
  if (!written.written && written.reason) throw new Error(`text not written (${written.reason})`)
  const data: HomeTurnRequestedData = {
    conversationId: home.id,
    userId: linked.userId,
    workspaceId: linked.workspaceId,
    workItemIds: [],
    reason: 'text',
  }
  await (deps.send ?? ((e) => inngest.send(e as never)))({ name: TEXT_TURN_REQUESTED_EVENT, id: `text-turn-${sid}`, data })
  return { conversationId: home.id }
}
