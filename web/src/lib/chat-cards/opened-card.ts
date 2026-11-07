/**
 * A card the person opened themselves, from `/` (./page-menu.ts): saved in the
 * chat as a message of their own, so it comes back after a reload like any
 * message, and drawn by the same card component as a `show` card.
 *
 * The message is a user message with one data part and no text. Neither
 * runtime ever sends it to the model: both transports send only the newest
 * user message's text, a turn always appends a newer one, and the history
 * primers skip a message with no text. The agent hears about the card through
 * the cards note instead, as a card the person opened (./context.ts `u`).
 *
 * Its number joins the `show` cards' numbering: the next free one when it is
 * opened. The chat-agent's numbering floors above the highest card the turn
 * carries (agents/chat-agent/lib/card-numbers.ts), so the agent's next card
 * never takes it.
 *
 * Client-safe and pure.
 */
import type { UIMessage } from 'ai'
import { isCardSpec, type CardSpec } from './kinds'

/** The data part's type. */
export const OPENED_CARD_PART_TYPE = 'data-chat-card' as const

/** Every opened card's message id starts with this; its part id is the card's id. */
export const OPENED_CARD_ID_PREFIX = 'opened-card-'

/** Card numbers run below this (parseCardContext and the chat-agent keep the same bound). */
export const MAX_CARD_NUMBER = 10_000

export interface OpenedCardData {
  card: CardSpec
  /** The card's number in the chat ("card 4"); null when the chat is out of numbers. */
  card_number: number | null
  /** The `/` page it came from. */
  page: string
}

/** The next free card number above `highest`, or null past the bound. */
export function nextCardNumber(highest: number): number | null {
  const n = Math.max(0, Math.floor(highest)) + 1
  return n < MAX_CARD_NUMBER ? n : null
}

/** The message that puts an opened card in the chat. */
export function openedCardMessage(args: { id: string; spec: CardSpec; number: number | null; page: string }): UIMessage {
  const data: OpenedCardData = { card: args.spec, card_number: args.number, page: args.page }
  return {
    id: `${OPENED_CARD_ID_PREFIX}${args.id}`,
    role: 'user',
    parts: [{ type: OPENED_CARD_PART_TYPE, id: args.id, data }],
  }
}

/** The card an opened-card part carries, or null for any other part (or a malformed one). */
export function openedCardFromPart(part: unknown): { id: string; spec: CardSpec; number: number | null } | null {
  if (!part || typeof part !== 'object') return null
  const p = part as { type?: unknown; id?: unknown; data?: unknown }
  if (p.type !== OPENED_CARD_PART_TYPE || typeof p.id !== 'string' || !p.id) return null
  const data = (p.data ?? {}) as Partial<OpenedCardData>
  if (!isCardSpec(data.card)) return null
  const n = data.card_number
  return {
    id: p.id,
    spec: data.card,
    number: typeof n === 'number' && Number.isInteger(n) && n > 0 && n < MAX_CARD_NUMBER ? n : null,
  }
}

/** True for a message that is only an opened card (no words of the person's). */
export function isOpenedCardMessage(message: Pick<UIMessage, 'parts'>): boolean {
  return message.parts.length > 0 && message.parts.every((p) => p.type === OPENED_CARD_PART_TYPE)
}
