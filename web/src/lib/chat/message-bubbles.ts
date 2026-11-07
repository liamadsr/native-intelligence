/**
 * The bubbles a chat message draws, in order (chat-message.tsx renderTextPart).
 * One agent turn is one message, but it can say several things around its
 * tool steps, each its own bubble, and a long reply folds its middle into a
 * document between its lead and its question. Reply and React act on one
 * bubble (Liam, 2026-10-20: "I should be able to do it on a specific
 * message, not just a full response"), so a bubble is named by its place
 * here: the n-th bubble the message draws, 0 first. The thread and this
 * count the same way because the thread draws from textPartPieces.
 *
 * Pure and client-safe: the thread, the panel and the reactions share it.
 */
import { splitLongReply } from './split-long-reply'

/** What one text part draws: bubbles, and a long reply's folded document between them. */
export type TextPartPiece = { kind: 'bubble'; text: string } | { kind: 'doc'; title: string | null; body: string }

/** The most bubbles of one message a reaction can name. */
export const MAX_MESSAGE_BUBBLES = 50

/**
 * The pieces a text part draws: nothing for whitespace alone (a model's stray
 * newline between tool calls), an agent's long reply as its lead, its
 * document and its question (splitLongReply), anything else one bubble.
 */
export function textPartPieces(text: string, assistant: boolean): TextPartPiece[] {
  if (!text.trim()) return []
  if (assistant) {
    const { lead, doc, tail } = splitLongReply(text)
    if (doc) {
      return [
        ...(lead ? [{ kind: 'bubble' as const, text: lead }] : []),
        { kind: 'doc' as const, title: doc.title, body: doc.body },
        ...(tail ? [{ kind: 'bubble' as const, text: tail }] : []),
      ]
    }
  }
  return [{ kind: 'bubble', text }]
}

type MessageLike = { role: string; parts: ReadonlyArray<{ type: string; text?: string }> }

/** Every bubble `message` draws, its words as written, in order. */
export function messageBubbles(message: MessageLike): string[] {
  const assistant = message.role === 'assistant'
  const out: string[] = []
  for (const part of message.parts) {
    if (part.type !== 'text' || typeof part.text !== 'string') continue
    for (const piece of textPartPieces(part.text, assistant)) if (piece.kind === 'bubble') out.push(piece.text)
  }
  return out
}

/** A bubble's place, checked (client-sent): a whole number under MAX_MESSAGE_BUBBLES, or null. */
export function parseBubbleIndex(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < MAX_MESSAGE_BUBBLES ? value : null
}
