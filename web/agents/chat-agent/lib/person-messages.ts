/**
 * The evidence rule for `remember` with scope 'profile' (always-on plan,
 * decision 3, A2 review): what the person TELLS the agent saves; anything
 * else is a proposal. A profile fact follows the person into every workspace,
 * so the model must quote the person's own words (`quote`), and here, before
 * the call reaches the app, the quote is checked against what the person
 * actually said (their last PERSON_MESSAGES_KEPT messages in this session)
 * AND against the fact it is meant to state (lib/evidence.ts: 3+ words, 60%
 * of the fact's content words). A real but unrelated quote never verifies.
 *
 * Only the person's OWN words count:
 *   - messages come from eve's `message.received` (hooks/person-messages.ts),
 *     never one eve authored (`kind`), never a framework message (turn
 *     context, expertise, recalled memory) and never a teammate's report;
 *   - the app's history primer (`<conversation-so-far>…</conversation-so-far>`,
 *     src/lib/chat/conversation-history.ts), which leads a new session's first
 *     message, is cut off (personText);
 *   - a seeded send (the UI composing a message from a proposal or an action:
 *     its description, reasoning, a transcript quote) starts with
 *     SEEDED_SEND_MARKER and is left out whole (src/lib/chat/seeded-send.ts);
 *   - a background update the server sent into a home thread (A4 slice 5:
 *     it starts with BACKGROUND_UPDATE_HEADER, and its turn runs on a
 *     `server` token, hooks/person-messages.ts) is never the person's: the
 *     helper text inside it could otherwise pass this rule;
 *   - a long message keeps its TAIL, where the person's own words are.
 * They live in eve's durable per-session state, so a turn's steps in
 * different processes see the same list.
 */
import { defineState } from 'eve/context'
import { evidenceVerified } from './evidence.js'

/** How many of the person's latest messages a quote may come from. */
export const PERSON_MESSAGES_KEPT = 5
/** The most characters of one message kept: its tail. */
export const PERSON_MESSAGE_MAX_CHARS = 8_000

/**
 * The mark a seeded UI send starts with: two U+2063 INVISIBLE SEPARATORs,
 * which nobody types. Twin of SEEDED_SEND_MARKER in src/lib/chat/seeded-send.ts.
 */
export const SEEDED_SEND_MARKER = '⁣⁣'

/**
 * How a server-written background update starts (twin of the first line
 * renderBackgroundUpdate writes, src/lib/chat/home-turn.ts). A message that
 * starts with it, whatever its case or leading space, is never the person's.
 */
export const BACKGROUND_UPDATE_HEADER = '[BACKGROUND UPDATE'

/** True when a delivered message is a server-written background update. */
export function isBackgroundUpdate(message: string): boolean {
  return message.trimStart().toUpperCase().startsWith(BACKGROUND_UPDATE_HEADER)
}

const PRIMER_OPEN = '<conversation-so-far>'
const PRIMER_CLOSE = '</conversation-so-far>'

/**
 * The person's own words in a delivered message, or null when it holds none
 * (a seeded send, an empty text): the history primer cut off (up to its LAST
 * closing tag, so restored text quoting the tag can't leak), the tail kept.
 */
export function personText(message: string): string | null {
  if (message.startsWith(SEEDED_SEND_MARKER)) return null
  if (isBackgroundUpdate(message)) return null
  let text = message
  if (text.trimStart().startsWith(PRIMER_OPEN)) {
    const end = text.lastIndexOf(PRIMER_CLOSE)
    text = end >= 0 ? text.slice(end + PRIMER_CLOSE.length) : ''
  }
  text = text.trim()
  if (!text || isBackgroundUpdate(text)) return null
  return text.length > PERSON_MESSAGE_MAX_CHARS ? text.slice(-PERSON_MESSAGE_MAX_CHARS) : text
}

/**
 * The latest messages, and how many of the person's messages this session has
 * seen in all (`seq`, monotonic: it only ever grows). The seq rides with every
 * tool call for the reviewer (A5, src/lib/safety/action-review.ts): a different
 * turn id is not proof the person spoke (a wake turn has none of their words),
 * a higher seq is.
 */
const recent = defineState<{ messages: string[]; seq?: number; turns?: Array<string | null> }>(
  'chat-agent.person-messages',
  () => ({ messages: [], seq: 0, turns: [] }),
)

/** Record one delivered message (`message.received`). Never throws. */
export function notePersonMessage(data: unknown): void {
  try {
    const d = (data ?? {}) as { kind?: unknown; message?: unknown; turnId?: unknown }
    // Present only when eve, not a channel participant, authored the input.
    if (d.kind !== undefined) return
    if (typeof d.message !== 'string') return
    const text = personText(d.message)
    if (!text) return
    const turn = typeof d.turnId === 'string' && d.turnId ? d.turnId : null
    recent.update((prev) => {
      const messages = Array.isArray(prev?.messages) ? prev.messages : []
      // The turn each kept message arrived in, aligned with `messages` (older
      // state has none: unknown turns).
      const turns = Array.isArray(prev?.turns) && prev.turns.length === messages.length ? prev.turns : messages.map(() => null)
      return {
        messages: [...messages, text].slice(-PERSON_MESSAGES_KEPT),
        turns: [...turns, turn].slice(-PERSON_MESSAGES_KEPT),
        seq: (Number.isInteger(prev?.seq) && (prev!.seq as number) >= 0 ? (prev!.seq as number) : 0) + 1,
      }
    })
  } catch {
    // A lost message only makes a later quote fail (a proposal): never break the turn.
  }
}

/** The person's latest messages in this session, oldest first. Never throws (empty when unreadable). */
export function recentPersonMessages(): string[] {
  try {
    const messages = recent.get()?.messages
    return Array.isArray(messages) ? messages.filter((m): m is string => typeof m === 'string') : []
  } catch {
    return []
  }
}

/**
 * The turn each of the latest messages arrived in, aligned with
 * recentPersonMessages() (null: unknown). Never throws.
 */
export function recentPersonMessageTurns(): Array<string | null> {
  try {
    const state = recent.get()
    const messages = Array.isArray(state?.messages) ? state.messages : []
    const turns = Array.isArray(state?.turns) && state.turns.length === messages.length ? state.turns : messages.map(() => null)
    return turns.map((t) => (typeof t === 'string' && t ? t : null))
  } catch {
    return []
  }
}

/** How many of the person's messages this session has recorded (monotonic). 0 when unreadable. */
export function personMessageSeq(): number {
  try {
    const seq = recent.get()?.seq
    return Number.isInteger(seq) && (seq as number) >= 0 ? (seq as number) : 0
  } catch {
    return 0
  }
}

/** Whether a remember's quote is the person's own words, AND states the fact it is saved with. */
export function quoteVerified(quote: unknown, fact: unknown): boolean {
  return typeof fact === 'string' && evidenceVerified(quote, fact, recentPersonMessages())
}
