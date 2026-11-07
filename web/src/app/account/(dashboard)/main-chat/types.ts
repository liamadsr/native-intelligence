import type { UIMessage } from '@ai-sdk/react'

/**
 * The main chat (docs/plans/one-chat.md, Slice 1): ONE chat per workspace, the
 * person's home thread with the main agent. There are no tabs, no history list
 * and no titles. This is what the device keeps of it (main-chat-storage.ts),
 * and what the chat panel mounts on.
 *
 * `chatSessionId` is the chat's stable identity in its workspace: it keys
 * `useChat({ id })`, the transport's eve session and the auto-save. It is
 * minted once per workspace on this device and kept for good.
 */
export interface ChatSlice {
  chatSessionId: string
  /**
   * The chat's retained transcript. BOUNDED, not the whole conversation:
   * hydrate runs it through `applyChatRetention` (src/lib/chat/message-retention.ts):
   * the newest MAX_LIVE_MESSAGES messages, with oversized string tool outputs on
   * older ones replaced by a marker. The full history stays server-side
   * (use-chat-auto-save and the eve persist write every message), and a
   * restored panel catches up from the conversation's rows.
   */
  chatMessages: UIMessage[]
  chatInput: string
  /**
   * The conversation row the chat is bound to: the home thread, or a live
   * meeting's conversation while a call holds the chat (until Slice 3). What a
   * restored panel catches its thread up from (caughtUpThread).
   */
  conversationId?: string
}
