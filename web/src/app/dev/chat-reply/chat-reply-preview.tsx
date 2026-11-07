'use client'

/**
 * The main chat's thread as ChatPanel draws it (chat-panel.tsx): the real
 * ChatMessageList in the reading column, Reply and React from the host
 * (no-ops here) and the sky's ink. The sky behind is the public one
 * (MarketingSky). Two replies (reply-link.ts), each with a frosted capsule
 * stacked on it at the right and the compact ┐ beside it:
 *   1. to a whole message: the capsule is its copy;
 *   2. to words selected in one: the capsule holds those words.
 */
import type { UIMessage } from '@ai-sdk/react'
import { ChatMessageList } from '@/app/account/(dashboard)/chat/chat-message-list'
import { MessageInteractionsContext, type MessageInteractions } from '@/app/account/(dashboard)/chat/message-interactions'
import { OnSkyContext } from '@/components/sky/on-sky'
import { MarketingSky } from '@/components/sky/marketing-sky'
import { messageReplyMetadata, messageQuoteText } from '@/lib/chat/message-reply'

const LAUNCH =
  "Here's where things stand with the launch:\n\n" +
  '- **Landing page** is live, and the waitlist form is collecting sign-ups.\n' +
  '- **Pricing** still needs your call on the annual discount.\n' +
  '- **Press kit** is drafted; I can send it to the two reporters you met last week.'
const EMAIL = 'Want me to draft the launch email next, or hold until pricing is settled?'

const text = (id: string, role: 'assistant' | 'user', words: string, metadata?: Record<string, unknown>): UIMessage =>
  ({ id, role, parts: [{ type: 'text', text: words }], ...(metadata ? { metadata } : {}) }) as UIMessage

const MESSAGES: UIMessage[] = [
  // 1. A whole message.
  text('dev-a1', 'assistant', LAUNCH),
  text('dev-u1', 'user', 'Send the press kit, and go 20% off annual.', messageReplyMetadata({ messageId: 'dev-a1', role: 'assistant', quote: messageQuoteText(LAUNCH), part: false })),
  // 2. Words selected in one.
  text('dev-a2', 'assistant', EMAIL),
  text('dev-u2', 'user', 'Draft it now.', messageReplyMetadata({ messageId: 'dev-a2', role: 'assistant', quote: 'draft the launch email next', part: true, selected: true })),
]

const INTERACTIONS: MessageInteractions = { reply: () => {}, react: () => {}, reactions: null }

export default function ChatReplyPreview() {
  return (
    <>
      <MarketingSky />
      <main className="flex min-h-dvh flex-col justify-end py-10">
        <MessageInteractionsContext.Provider value={INTERACTIONS}>
          <OnSkyContext.Provider value>
            <div className="chat-reading-col flex w-full flex-col gap-4 px-5">
              <ChatMessageList messages={MESSAGES} latestUserMessageId="dev-u2" userAvatarUrl={null} userInitials="LA" />
            </div>
          </OnSkyContext.Provider>
        </MessageInteractionsContext.Provider>
      </main>
    </>
  )
}
