import { inngest } from '@/lib/inngest/client'

type Send = (event: { name: string; id: string; data: Record<string, unknown> }) => Promise<unknown>

/**
 * Emit `flow/chat.message` for a message a PERSON just posted in team chat,
 * once per message: the event id is keyed on it, so a retried send (the post
 * route's `replayed`) fires its loops once. Called only from the post route
 * (src/app/api/account/team-chat/channels/[id]/messages/route.ts), which only
 * a signed-in person reaches: an agent's reply (src/lib/team-chat/agent-turn.ts)
 * never comes through here, and the dispatcher re-checks the author anyway.
 * flowDispatchOnChatMessage (src/lib/inngest/flow-functions.ts) fires the
 * matching chat_message loops. Ids only. Never throws.
 */
export async function emitChatMessage(
  args: { workspaceId: string; messageId: string; channelId: string; firedAt?: string },
  deps: { send?: Send } = {},
): Promise<boolean> {
  try {
    await (deps.send ?? ((e) => inngest.send(e as never)))({
      name: 'flow/chat.message',
      id: `chat-message:${args.messageId}`,
      data: {
        workspace_id: args.workspaceId,
        message_id: args.messageId,
        channel_id: args.channelId,
        fired_at: args.firedAt ?? new Date().toISOString(),
      },
    })
    return true
  } catch (err) {
    console.error('[flows] chat message inngest.send failed', err instanceof Error ? err.message : 'unknown')
    return false
  }
}
