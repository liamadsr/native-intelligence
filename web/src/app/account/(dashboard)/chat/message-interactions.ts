'use client'

/**
 * What a message in the chat can do beyond being read: be replied to
 * (src/lib/chat/message-reply.ts) and, the agent's, be reacted to
 * (src/lib/chat/message-reactions.ts); its paused budget prompt answered
 * (session-limit-card.tsx). ChatPanel provides them
 * (MessageInteractionsContext); a host that doesn't (a run chat, a teammate
 * chat) shows neither, as the thumbs (MessageFeedbackContext). The value
 * changes only with the conversation, so the memoized messages never
 * re-render for it.
 *
 * The thread's rows are found here too (messageRow), and a quote goes back
 * to its message (jumpToMessage).
 */
import { createContext } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import type { MessageReplyRef } from '@/lib/chat/message-reply'
import type { MessageReactionsStore } from '@/hooks/use-message-reactions'
import type { SessionLimitChoice } from './session-limit-card'

export interface MessageInteractions {
  /**
   * Reply to a message, or one bubble of it: its chip above the composer.
   * `source` is what flies into it (or nothing); `body` is the words the chip
   * shows as written (a bubble's markdown), when they aren't the whole message's.
   */
  reply: (ref: MessageReplyRef, source: HTMLElement | null, body?: string | null) => void
  /** React to one bubble of an agent message, by its place (message-bubbles.ts; null takes it off). */
  react: (message: UIMessage, bubble: number, emoji: string | null) => void
  /** The conversation's reactions, or null before it has a conversation. */
  reactions: MessageReactionsStore | null
  /**
   * Answer eve's session-limit prompt (session-limit-card.tsx): Continue or
   * Stop. True once eve has it; false when it didn't go (the buttons come back).
   */
  answerSessionLimit?: (toolCallId: string, choice: SessionLimitChoice) => Promise<boolean>
}

export const MessageInteractionsContext = createContext<MessageInteractions | null>(null)

/** The thread's row for a message (chat-message-list.tsx), if it is drawn. */
export function messageRow(messageId: string): HTMLElement | null {
  if (typeof document === 'undefined') return null
  return document.querySelector<HTMLElement>(`[data-message-row="${CSS.escape(messageId)}"]`)
}

/**
 * Bring a message into view and show which one it is: its row scrolls to the
 * middle of the thread and its bubbles pulse once. False when it isn't drawn
 * (further back than the thread holds).
 */
export function jumpToMessage(messageId: string): boolean {
  const row = messageRow(messageId)
  if (!row) return false
  const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  row.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
  if (reduce || typeof row.animate !== 'function') return true
  for (const bubble of row.querySelectorAll<HTMLElement>('.chat-message-bubble')) {
    bubble.animate(
      [
        { transform: 'none', filter: 'none' },
        { transform: 'scale(1.025)', filter: 'brightness(0.94)', offset: 0.3 },
        { transform: 'none', filter: 'none' },
      ],
      { duration: 700, delay: 250, easing: 'ease-in-out' },
    )
  }
  return true
}

/** How long {@link jumpToMessageWhenDrawn} waits for a row, and how often it looks. */
export const JUMP_WAIT_MS = 2_000
const JUMP_POLL_MS = 100

/**
 * {@link jumpToMessage} once the message's row is drawn: a message just put
 * in the thread draws on the next render. Looks every 100 ms (timers, never
 * animation frames) for at most JUMP_WAIT_MS; false when it never drew.
 */
export function jumpToMessageWhenDrawn(messageId: string, waitMs: number = JUMP_WAIT_MS): Promise<boolean> {
  if (jumpToMessage(messageId)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const deadline = Date.now() + waitMs
    const look = () => {
      if (jumpToMessage(messageId)) return resolve(true)
      if (Date.now() >= deadline) return resolve(false)
      setTimeout(look, JUMP_POLL_MS)
    }
    setTimeout(look, JUMP_POLL_MS)
  })
}
