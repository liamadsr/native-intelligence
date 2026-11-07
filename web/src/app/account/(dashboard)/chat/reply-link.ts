/**
 * How a reply points at the message it answers in the thread (GEN-353,
 * Liam's references: "really clean and elegant", "it should look the same"):
 * a frosted capsule stacked on the reply at the right, set in 3.5rem so a
 * compact ┐ sits beside it pointing down into the reply. The capsule holds a
 * copy of what was answered (its markdown, all of it: the bubble replied to,
 * or the whole message), or the words the person selected (one line);
 * wherever the message is, the one right above or further up.
 *
 * A whole-message reply whose message isn't drawn here (an earlier page, past
 * the window) has nothing to copy: the reply's one-line quote with its small
 * hook (message-reply-chip.tsx).
 *
 * The ┐ is one glyph, 26px, never stretched, and points without touching:
 * replyHookPlacement.
 *
 * Pure: the list finds the copy (chat-message-list.tsx), the reply draws it
 * (message-reply-chip.tsx), measuring the capsule and its own bubble.
 */
import type { UIMessage } from '@ai-sdk/react'
import { messageBubbles } from '@/lib/chat/message-bubbles'
import { messageQuoteText, messageReplyOfMetadata, type MessageReplyRef } from '@/lib/chat/message-reply'
import { stripSuggestionMarkers } from '@/components/suggestions/remark-suggestion-markers'

// A settled message keeps its object for good (chat-message.tsx), so its bubbles and their quotes are
// worked out once, not on every list render (the list re-renders on each streamed token).
const bubblesCache = new WeakMap<object, { bubbles: string[]; quotes: string[] }>()
function bubblesOf(message: UIMessage): { bubbles: string[]; quotes: string[] } {
  let hit = bubblesCache.get(message)
  if (!hit) {
    const bubbles = messageBubbles(message).map(stripSuggestionMarkers)
    hit = { bubbles, quotes: bubbles.map((b) => messageQuoteText(b)) }
    bubblesCache.set(message, hit)
  }
  return hit
}

/** The bubble of `message` the reply quotes: the one whose quote it is, the one holding the words selected, the only one; else null. */
export function repliedBubbleIndex(message: UIMessage, reply: Pick<MessageReplyRef, 'quote' | 'part' | 'selected'>): number | null {
  const { quotes } = bubblesOf(message)
  const exact = quotes.indexOf(reply.quote)
  if (exact >= 0) return exact
  if (reply.selected) {
    const words = reply.quote.replace(/\s+/g, ' ')
    const holding = quotes.findIndex((q) => q.replace(/\s+/g, ' ').includes(words))
    if (holding >= 0) return holding
  }
  return quotes.length === 1 ? 0 : null
}

/**
 * The capsule's copy for `message` (a reply of the person's) from the drawn
 * messages by id: the markdown of the bubble it answers, or of the whole
 * message (its bubbles, in order) when it answered all of it. Null when it
 * isn't a reply, answers words selected (the capsule holds those), or the
 * message isn't drawn here (or its bubble can't be told).
 */
export function replyCopyFor(message: UIMessage, drawn: ReadonlyMap<string, UIMessage>): string | null {
  if (message.role !== 'user') return null
  const reply = messageReplyOfMetadata(message.metadata)
  if (!reply || reply.selected) return null
  const original = drawn.get(reply.messageId)
  if (!original) return null
  const { bubbles } = bubblesOf(original)
  const bubble = repliedBubbleIndex(original, reply)
  const copy = bubble !== null ? bubbles[bubble] : reply.part ? null : bubbles.join('\n\n')
  return copy?.trim() ? copy : null
}

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/** The ┐ glyph, px: square, never stretched (thread-hook.tsx REPLY_LINK_STROKE draws it). */
export const REPLY_HOOK_PX = 26
/** Its top leg starts this far right of the capsule's right edge. */
const HOOK_OFFSET_PX = 18
/** It ends this far above the reply's top (or more). */
const HOOK_CLEAR_PX = 10
/** Its down leg at least this far inside the reply's right edge, so it points into the reply. */
const HOOK_INSIDE_PX = 12

/**
 * Where the ┐ glyph goes (its top-left), in `frame`'s own coordinates (the
 * reply's column, which it is placed in): `from` is the capsule, `to` the
 * reply's bubble.
 *
 * In the capsule's right margin, HOOK_OFFSET_PX off its right edge, its top
 * leg level with the capsule's foot, ending HOOK_CLEAR_PX above the reply or
 * more (rising beside the capsule, which sits close on the reply); its down
 * leg at least HOOK_INSIDE_PX inside the reply's right edge. Always somewhere
 * once both are laid out (the glyph rises beside the capsule rather than
 * needing room under it); null only before then.
 */
export function replyHookPlacement(from: Box, to: Box, frame: Pick<Box, 'left' | 'top'>): { left: number; top: number } | null {
  const size = REPLY_HOOK_PX
  if (to.right - to.left <= 0 || from.right - from.left <= 0) return null
  const left = Math.min(from.right + HOOK_OFFSET_PX, to.right - HOOK_INSIDE_PX - size)
  const top = Math.min(from.bottom, to.top - HOOK_CLEAR_PX - size)
  return { left: left - frame.left, top: top - frame.top }
}
