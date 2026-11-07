/**
 * Reply on a For you card → the main chat (Liam, 2026-10-16: "the reply
 * button attaches the action to the chat … where you can ask the main agent
 * to change something about it or whatever you want to do that has to do
 * with that action"). The column's focus view fires this window event; the
 * shell (main-chat-host.tsx) puts the home thread up and hands it to its
 * panel, which shows the card as a chip above the composer (one at a time: a
 * new Reply replaces it) and sends it with the person's next message, on
 * that turn only, as `systemContext.replyCard`. Nothing is sent by the click.
 * While it waits the thread behind goes soft (the chip and the composer are
 * what's in focus), and the message it rode keeps it (`metadata.replyCard`,
 * cardReplyMetadata): the thread shows the card above the person's words,
 * on reload too.
 *
 * Mail's Reply (src/lib/email/reply-in-chat.ts) is the precedent, with one
 * difference: Mail's click means one thing (draft the reply) and auto-sends;
 * a card's Reply leaves the words to the person.
 *
 * What rides the turn is the card's id and kind, and the verb and sentence
 * the chip showed. The words are read off the shared source (titles a bot,
 * a mail or a meeting wrote), so the server fences them as data
 * (card-reply-context.ts) and names the tools that act on the item by its id.
 *
 * Pure and client-safe: the column, the shell, the panel and the prompt
 * builder share it.
 */
import { isAboutId } from './teammate-about-ref'

/** Window event name. Listened for in main-chat-host.tsx. */
export const CARD_REPLY_EVENT = 'dial8:card-reply'

/**
 * What a card is, for the agent: an attention card (`card`: a suggested
 * action, a draft to write, an approval, a work proposal, an FYI), a work
 * item waiting on a review (`review`), a run waiting on an answer
 * (`question`), or an email draft a bot wrote, waiting in Mail (`draft`: its
 * email_draft row id, src/lib/email/agent-drafts.ts).
 */
export type CardReplyKind = 'card' | 'review' | 'question' | 'draft'

/**
 * The round icon the card's sentence starts with in the For you column (the
 * agent mark, or the kind of thing it's about: column-card-copy.ts
 * CompactIcon), carried so the card in the chat draws it too.
 */
export const CARD_REPLY_ICONS = ['mail', 'document', 'pr', 'link', 'action', 'capture', 'contact', 'company', 'list', 'cards', 'run', 'bot'] as const
export type CardReplyIcon = (typeof CARD_REPLY_ICONS)[number]

export interface CardReplyRef {
  kind: CardReplyKind
  /** The attention item's id (`card`), the work item's (`review`, `question`), or the draft's (`draft`). */
  id: string
  /** The item's workspace. */
  workspaceId: string
  /** The card's verb, as its pill said it ("Add", "Review", "Answer"). */
  verb: string
  /** The one sentence after the verb, as the card showed it. */
  sentence: string
  /** The finer kind: the attention item's (`action_card`, `draft_email`…) or the work item's. */
  subkind?: string
  /** The card's round icon, when it had one. */
  icon?: CardReplyIcon
}

/** The verb, at most. */
export const CARD_REPLY_VERB_CHARS = 24
/** The sentence, at most. */
export const CARD_REPLY_SENTENCE_CHARS = 280

const KINDS = new Set<CardReplyKind>(['card', 'review', 'question', 'draft'])
const ICONS = new Set<string>(CARD_REPLY_ICONS)
const SUBKIND = /^[a-z][a-z0-9_]{0,39}$/

function clip(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const one = value.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** Fire the handoff. Safe during SSR (no window, no event). */
export function requestCardReply(detail: CardReplyRef): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<CardReplyRef>(CARD_REPLY_EVENT, { detail }))
}

/**
 * The ref in `value`, checked: null unless it names a known kind by uuid ids
 * (the item and its workspace). The words are cut to one line each, at most
 * their caps; a subkind that isn't a plain word, or an icon that isn't one of
 * CARD_REPLY_ICONS, is dropped. Client-supplied
 * wherever it lands, so the server parses it again.
 */
export function parseCardReplyRef(value: unknown): CardReplyRef | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.kind !== 'string' || !KINDS.has(v.kind as CardReplyKind)) return null
  if (!isAboutId(v.id) || !isAboutId(v.workspaceId)) return null
  const verb = clip(v.verb, CARD_REPLY_VERB_CHARS)
  const sentence = clip(v.sentence, CARD_REPLY_SENTENCE_CHARS)
  if (!verb) return null
  return {
    kind: v.kind as CardReplyKind,
    id: v.id,
    workspaceId: v.workspaceId,
    verb,
    sentence,
    ...(typeof v.subkind === 'string' && SUBKIND.test(v.subkind) ? { subkind: v.subkind } : {}),
    ...(typeof v.icon === 'string' && ICONS.has(v.icon) ? { icon: v.icon as CardReplyIcon } : {}),
  }
}

/** What each kind is called in the note, in the person's voice (the note rides their message). */
const NOTE_WHAT: Record<CardReplyKind, (id: string) => string> = {
  card: (id) => `my card ${id}`,
  review: (id) => `my work item ${id}, waiting on my review`,
  question: (id) => `my work item ${id}, waiting on my answer`,
  draft: (id) => `my email draft ${id}, waiting in Mail`,
}

/** How the agent reads what the note names. */
const NOTE_READ: Record<CardReplyKind, (id: string) => string> = {
  card: (id) => `read it with get_bot_item, item_id ${id}`,
  review: (id) => `read it with get_bot_item, item_id ${id}`,
  question: (id) => `read it with get_bot_item, item_id ${id}`,
  draft: (id) => `change it with revise_email_draft, draft_id ${id}`,
}

/**
 * The line a card the person replied to adds to what the agent receives for
 * their message (eve-chat-transport.ts eveUserContent), never to the message
 * the thread shows: which card it is, by its kind and id, and the tool that
 * reads it. The turn's "Replying to a card" section (card-reply-context.ts)
 * carries the card's words and the tools that act on it, for that turn only;
 * this line stays in the conversation, so a later "make it more formal" still
 * knows the card, and a turn whose context failed to load still names it.
 * Ids only: the card's words were written by a bot's run, a mail or a
 * meeting, so they never ride the person's own message. `ref` is parsed
 * (parseCardReplyRef).
 */
export function cardReplyNote(ref: CardReplyRef): string {
  return `[Replying to ${NOTE_WHAT[ref.kind](ref.id)}: ${NOTE_READ[ref.kind](ref.id)}.]`
}

/** Two refs name the same card. */
export function sameCardReply(a: CardReplyRef | null, b: CardReplyRef | null): boolean {
  return !!a && !!b && a.kind === b.kind && a.id === b.id
}

/**
 * The card on the message it rode: the AI SDK keeps a message's metadata and
 * the chat's save stores the whole message, so the thread shows the card
 * above the person's words (chat-message.tsx) on reload too.
 */
export function cardReplyMetadata(card: CardReplyRef): { replyCard: CardReplyRef } {
  return { replyCard: card }
}

/** The card a message's metadata carries (cardReplyMetadata), checked: it was written by the client. */
export function cardReplyOfMetadata(metadata: unknown): CardReplyRef | null {
  if (!metadata || typeof metadata !== 'object') return null
  return parseCardReplyRef((metadata as { replyCard?: unknown }).replyCard)
}
