/**
 * Card numbers (pages in the chat): every card the agent shows gets a number
 * for the conversation ("card 3"), stamped on its `show` result here, in the
 * chat-agent's proxy, so the number is the result's own. The client reads it
 * from the result (never from the card's place in a list the chat may trim),
 * and the cards note and read_card name cards by it.
 *
 * A per-session counter in eve durable state, keyed by eve's call id so a
 * replayed call keeps its number, and floored by the highest number the client
 * says the conversation already has (the turn's cards), so a conversation
 * that moved to a new session never numbers a card twice.
 */
import { defineState } from 'eve/context'

interface CardNumberState {
  last: number
  /** call id → its number, newest last, capped. */
  byCall: Array<[string, number]>
}

const MAX_REMEMBERED = 100
/** Card numbers run below this (src/lib/chat-cards/context.ts parseCardContext). */
const MAX_CARD_NUMBER = 10_000

const numbers = defineState<CardNumberState>('chat-agent.card-numbers', () => ({ last: 0, byCall: [] }))

/** The highest card number among the turn's cards (spec.cards), 0 when there are none. */
export function highestCardNumber(cards: unknown): number {
  if (!Array.isArray(cards)) return 0
  let max = 0
  for (const c of cards) {
    const n = (c as { n?: unknown } | null)?.n
    // The client says it: only a plausible card number counts (the same bound
    // the app's parseCardContext keeps), so a forged one cannot push numbering off.
    if (typeof n === 'number' && Number.isInteger(n) && n > 0 && n < MAX_CARD_NUMBER && n > max) max = n
  }
  return max
}

/**
 * The show result with its card number, when it drew a card. One state update
 * per call, so parallel calls in a step each get their own number.
 */
export function stampCardNumber(output: unknown, callId: string | undefined, floor: number): unknown {
  if (!output || typeof output !== 'object' || (output as { success?: unknown }).success !== true) return output
  let n = 0
  try {
    numbers.update((raw) => {
      const s: CardNumberState = raw && Array.isArray(raw.byCall) && typeof raw.last === 'number' ? raw : { last: 0, byCall: [] }
      const known = callId ? s.byCall.find(([id]) => id === callId) : undefined
      if (known) {
        n = known[1]
        return s
      }
      n = Math.max(s.last, floor) + 1
      const byCall = callId ? [...s.byCall, [callId, n] as [string, number]].slice(-MAX_REMEMBERED) : s.byCall
      return { last: n, byCall }
    })
  } catch {
    // No eve context (a test, a replay without state): number from the floor.
    n = floor + 1
  }
  return { ...(output as Record<string, unknown>), card_number: n }
}
