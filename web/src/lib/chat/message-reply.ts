/**
 * Reply to a message in the main chat (Liam, 2026-10-20: "kind of like
 * iMessage how you slide to the right and you apply reply to that specific
 * thing … make sure it's clear for the agent as well that I'm referring to
 * that piece of text"). The person picks a message (its Reply button, a swipe
 * to the right, or words they selected in it and the Reply that pops up over
 * them): it waits as a chip above the composer, flying there as a For you
 * card's does (card-reply-flight.ts), and rides their next typed message, on
 * that turn only, as `systemContext.replyTo`. Nothing is sent by the pick.
 *
 * The For you card's Reply (card-reply.ts) is the precedent. One chip at a
 * time: a message's Reply takes a card's place, and a card's a message's.
 *
 * What rides the turn is the message's id, whose it was, and the words quoted:
 * the whole message's opening (plain text, cut), or exactly the words the
 * person selected. The agent reads them in a line on the person's message
 * (messageReplyNote): eve keeps it, so "make that shorter" two turns later
 * still knows what "that" is. The message they sent keeps the quote too
 * (`metadata.replyTo`, messageReplyMetadata): the thread draws it above their
 * words, on reload too, and a press on it goes back to the message.
 *
 * Pure and client-safe: the thread, the panel, the transport and the persist
 * route share it.
 */
import { markdownToSpeech } from '@/lib/read-aloud/speech-text'

export interface MessageReplyRef {
  /** The message replied to: its UIMessage id (chat_messages.ui_message_id). */
  messageId: string
  /** Whose message it was: the agent's (`assistant`), or the person's own. */
  role: 'assistant' | 'user'
  /** The words quoted: the message's opening, or the words the person selected. */
  quote: string
  /** True when the words are a piece of the message, not the whole of it: words the person selected, or one bubble of a turn that says several things. */
  part: boolean
  /**
   * True when the person selected these words by hand (selection-reply.tsx),
   * not a whole bubble: the thread shows them over the hook, the person's own
   * pick. A whole message or bubble shows the hook alone (its words are right
   * above it). Absent unless true.
   */
  selected?: boolean
}

/** The quote, at most (what the agent reads; the chip cuts it to one line). */
export const MESSAGE_REPLY_QUOTE_CHARS = 600

/** A UIMessage id, as chat_messages.ui_message_id holds it (the feedback route's rule). */
const MESSAGE_ID = /^[A-Za-z0-9_\-:.]{1,200}$/

/** The words, tidied: line breaks kept (at most one blank line), spaces collapsed, cut to `max`. */
export function clipQuote(value: unknown, max: number = MESSAGE_REPLY_QUOTE_CHARS): string {
  if (typeof value !== 'string') return ''
  const tidy = value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return tidy.length > max ? `${tidy.slice(0, max - 1).trimEnd()}…` : tidy
}

/**
 * A message's words as a quote: its markdown read as plain text (emphasis,
 * links and markers gone, code and tables skipped), or the raw words when
 * nothing is left of them that way (a reply that is all table). Cut.
 */
export function messageQuoteText(markdown: string, max: number = MESSAGE_REPLY_QUOTE_CHARS): string {
  const plain = clipQuote(markdownToSpeech(markdown), max)
  return plain || clipQuote(markdown, max)
}

/**
 * The ref in `value`, checked: null unless it names a message by a plain id,
 * whose it was, and has words to quote. Client-supplied wherever it lands, so
 * the server parses it again.
 */
export function parseMessageReplyRef(value: unknown): MessageReplyRef | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.messageId !== 'string' || !MESSAGE_ID.test(v.messageId)) return null
  if (v.role !== 'assistant' && v.role !== 'user') return null
  const quote = clipQuote(v.quote)
  if (!quote) return null
  return { messageId: v.messageId, role: v.role, quote, part: v.part === true, ...(v.selected === true ? { selected: true } : {}) }
}

/**
 * The line a reply adds to what the agent receives for the person's message
 * (eve-chat-transport.ts eveUserContent), never to the message the thread
 * shows: whose message it was and the words quoted, in the person's voice
 * (the line rides their message). The quote is JSON-quoted, so its line
 * breaks and quote marks can't end the line early. `ref` is parsed
 * (parseMessageReplyRef).
 */
export function messageReplyNote(ref: MessageReplyRef): string {
  const whose = ref.role === 'assistant' ? 'your' : 'my own'
  const what = ref.part ? `this part of ${whose} earlier message` : `${whose} earlier message`
  return `[Replying to ${what}: ${JSON.stringify(ref.quote)}]`
}

/** Two refs name the same reply (the same message, the same words). */
export function sameMessageReply(a: MessageReplyRef | null, b: MessageReplyRef | null): boolean {
  return !!a && !!b && a.messageId === b.messageId && a.quote === b.quote
}

/**
 * The quote on the message it rode: the AI SDK keeps a message's metadata and
 * the chat's save stores it (the persist route parses it again), so the thread
 * shows the quote above the person's words on reload too.
 */
export function messageReplyMetadata(ref: MessageReplyRef): { replyTo: MessageReplyRef } {
  return { replyTo: ref }
}

/** The quote a message's metadata carries (messageReplyMetadata), checked: it was written by the client. */
export function messageReplyOfMetadata(metadata: unknown): MessageReplyRef | null {
  if (!metadata || typeof metadata !== 'object') return null
  return parseMessageReplyRef((metadata as { replyTo?: unknown }).replyTo)
}

/** The flight key of a message's Reply (card-reply-flight.ts launchFlight / landFlight). */
export function messageReplyFlightKey(ref: Pick<MessageReplyRef, 'messageId'>): string {
  return `message:${ref.messageId}`
}
