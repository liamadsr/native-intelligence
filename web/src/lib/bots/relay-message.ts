/**
 * The copies a relayed turn leaves in a bot's own thread (bots v4 Phase A4,
 * docs/plans/bots-v4.md "The main agent talks to the bots"): the person's
 * message, marked "From your main chat", and the bot's reply, written by the
 * server (src/lib/bots/bot-relay.ts) because no browser persists that turn.
 * Pure, so the thread's live bridge (useLiveConversation's `relays` scope)
 * tells them apart in the browser.
 */

/** ui_message.metadata key the relay stamps: `{ id: <relay row>, from: 'main_chat' }`. */
export const RELAY_METADATA_KEY = 'relay' as const

/** The mark on the person's message as it lands in the bot's thread. */
export const FROM_MAIN_CHAT_MARK = 'From your main chat'

/** The thread's copy of the person's message and of the bot's reply: ids from the relay row, so a retry never duplicates them. */
export function relayThreadMessageIds(relayId: string): { message: string; reply: string } {
  return { message: `relay-${relayId}-message`, reply: `relay-${relayId}-reply` }
}

/** True for a chat message a relayed turn wrote into a bot's thread. */
export function isRelayMessage(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false
  const metadata = (message as { metadata?: unknown }).metadata
  if (!metadata || typeof metadata !== 'object') return false
  const relay = (metadata as Record<string, unknown>)[RELAY_METADATA_KEY]
  return !!relay && typeof relay === 'object' && (relay as { from?: unknown }).from === 'main_chat'
}
