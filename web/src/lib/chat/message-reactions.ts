/**
 * Reactions on the agent's messages in the main chat (Liam, 2026-10-20: "a
 * thumbs up means okay, a heart means I love it … the agent would get it and
 * kind of interpret what I mean").
 *
 * One reaction per bubble, as iMessage's tapbacks: a new one replaces it, the
 * same one again takes it off. An agent turn can draw several bubbles around
 * its tool steps (message-bubbles.ts), and each takes its own (Liam, 10-20:
 * "I should be able to do it on a specific message, not just a full
 * response"). They are kept on the message itself, by the bubble's place
 * (`ui_message.metadata.reactions`, `{ "0": { emoji, at }, … }`, written by
 * POST /api/account/chat/reactions), so they come back with the thread on
 * reload.
 *
 * How the agent hears one (the precedent: Slack's and OpenClaw's agents take a
 * reaction as a signal, not a message; nobody lets a bare reaction approve
 * something that can't be undone):
 *   - Most reactions are absorbed: each one since the person's last message
 *     rides their next turn (`systemContext.reactions`, the "Reactions since
 *     your last turn" section, as a Connect card's outcome rides it), and the
 *     agent never writes a message just to acknowledge one.
 *   - A reaction that ANSWERS starts a turn of its own (reactionStartsTurn): a
 *     yes or a no (👍 ✅ 🚀 / 👎 ❌) on the last bubble of the agent's newest
 *     message when it asked them something, and a ❓ or 🤔 (they don't follow), after
 *     a short wait in case they change it (REACTION_TURN_DELAY_MS). Its
 *     message is the agent's to read and is never drawn (Liam, 10-20: "this
 *     can go in the background to the agent"): the reaction is on the
 *     bubble, and the agent's answer follows.
 *   - A reaction is never permission for something that can't be undone or
 *     leaves Dial8 (a send, a post, a delete, a payment): a 👍 on "Shall I
 *     send it?" means "ready"; the agent gets it ready and asks for the send.
 *
 * Pure and client-safe: the thread, the panel, the route and the prompt
 * builder share it.
 */

import { MAX_MESSAGE_BUBBLES, messageBubbles, parseBubbleIndex } from './message-bubbles'

/** The quick row in the picker (the rest come from the full picker). */
export const QUICK_REACTIONS = ['👍', '👎', '❤️', '🎉', '👀', '🚀'] as const

/** What a reaction says, for the agent. */
export type ReactionMeaning = 'yes' | 'no' | 'seen' | 'love' | 'celebrate' | 'confused' | 'funny' | 'thanks' | 'other'

/** ui_message.metadata's key for the person's reactions on a message's bubbles (by the bubble's place). */
export const REACTION_METADATA_KEY = 'reactions'

/** The `metadata.kind` of the message a reaction's own turn sends (never drawn: chat-message-list.tsx). */
export const REACTION_TURN_KIND = 'reaction' as const

/** How long a reaction that answers waits before its turn goes, in case it changes or comes off (ms). */
export const REACTION_TURN_DELAY_MS = 2500

/** The most reactions one turn carries (the newest). */
export const REACTION_NOTES_MAX = 8

/** A reacted message's opening, at most (what the agent reads to know which message it was). */
export const REACTION_EXCERPT_CHARS = 200

/** An emoji, as the picker gives it: one short pictographic sequence. */
const EMOJI = /^(?:[\p{Extended_Pictographic}\p{Regional_Indicator}\u{1F3FB}-\u{1F3FF}\u{200D}\u{FE0F}\u{20E3}#*0-9])+$/u
/** Something drawn as a picture: a pictograph, a flag's letters, or a keycap (#️⃣ 1️⃣). */
const PICTOGRAPH = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{20E3}]/u
const MAX_EMOJI_LENGTH = 16
/** A plain UIMessage id (message-reply.ts's rule). */
const MESSAGE_ID = /^[A-Za-z0-9_\-:.]{1,200}$/

const graphemes = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null

/** True for a reaction the chat takes: one emoji (a sequence, skin tone and all), never two. */
export function isReactionEmoji(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_EMOJI_LENGTH) return false
  if (!EMOJI.test(value) || !PICTOGRAPH.test(value)) return false
  if (!graphemes) return true
  let count = 0
  for (const _ of graphemes.segment(value)) if (++count > 1) return false
  return true
}

/** The emoji without its skin tone or presentation selector: what a meaning is looked up by. */
function baseEmoji(emoji: string): string {
  return emoji.replace(/[\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{FE0E}]/gu, '')
}

const MEANINGS: Array<[ReactionMeaning, string[]]> = [
  ['yes', ['👍', '✅', '✔', '☑', '🚀', '👌', '💯', '🙌', '🆗', '🤝', '💪', '⚡']],
  ['no', ['👎', '❌', '✖', '🛑', '🙅', '🚫', '⛔']],
  ['seen', ['👀', '👁']],
  ['love', ['❤', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💖', '💗', '💕', '😍', '🥰', '😻', '🔥', '🤩', '⭐', '🌟', '✨', '🏆']],
  ['celebrate', ['🎉', '🥳', '🎊', '👏', '🍾']],
  ['confused', ['❓', '❔', '🤔', '😕', '🤨', '😵‍💫', '🧐']],
  ['funny', ['😂', '🤣', '😆', '😄', '😁', '😹', '💀']],
  ['thanks', ['🙏']],
]
const MEANING_OF = new Map<string, ReactionMeaning>(MEANINGS.flatMap(([meaning, list]) => list.map((e) => [baseEmoji(e), meaning] as const)))

/** What `emoji` says (`other` for one with no settled meaning: the agent reads it as a person would). */
export function reactionMeaning(emoji: string): ReactionMeaning {
  return MEANING_OF.get(baseEmoji(emoji)) ?? 'other'
}

/**
 * Each meaning in words, for the agent: what it says on a message that asked
 * them something, and on one that didn't.
 */
const MEANING_WORDS: Record<ReactionMeaning, { asked: string; told: string }> = {
  yes: { asked: 'yes, go ahead', told: 'OK, got it' },
  no: { asked: "no, don't", told: "not right, or not what they wanted" },
  seen: { asked: "seen; they're looking, not an answer yet", told: "seen; they're looking at it" },
  love: { asked: 'they love it', told: 'they love it' },
  celebrate: { asked: 'great', told: 'great news, well done' },
  confused: { asked: "they don't follow", told: "they don't follow" },
  funny: { asked: 'that made them laugh', told: 'that made them laugh' },
  thanks: { asked: 'thanks', told: 'thanks' },
  other: { asked: 'read it as a person would', told: 'read it as a person would' },
}

/** What a reaction says in words, on a message that `asked` them something or not. */
export function reactionWords(emoji: string, asked: boolean): string {
  const words = MEANING_WORDS[reactionMeaning(emoji)]
  return asked ? words.asked : words.told
}

export interface MessageReaction {
  emoji: string
  /** When it was made (ISO). */
  at: string
}

/** The reaction in `value`, checked (a message's metadata is client-written). */
export function parseMessageReaction(value: unknown): MessageReaction | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (!isReactionEmoji(v.emoji)) return null
  if (typeof v.at !== 'string' || !Number.isFinite(Date.parse(v.at))) return null
  return { emoji: v.emoji, at: v.at }
}

/** The reactions in `value` (a message's `metadata.reactions`), checked, by bubble: bad entries dropped. */
export function parseMessageReactions(value: unknown): Map<number, MessageReaction> {
  const out = new Map<number, MessageReaction>()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const bubble = parseBubbleIndex(Number(key))
    const reaction = /^\d+$/.test(key) && bubble !== null ? parseMessageReaction(entry) : null
    if (bubble !== null && reaction) out.set(bubble, reaction)
  }
  return out
}

/** The person's reaction on one bubble of a message, from its metadata, or null. */
export function reactionOfMetadata(metadata: unknown, bubble: number): MessageReaction | null {
  if (!metadata || typeof metadata !== 'object') return null
  return parseMessageReactions((metadata as Record<string, unknown>)[REACTION_METADATA_KEY]).get(bubble) ?? null
}

/**
 * Whether a message's words end by asking the person something: its last
 * line (markdown, quotes and emoji aside) ends with a question mark. What
 * makes a 👍 a "yes" rather than an "OK".
 */
export function asksSomething(text: string): boolean {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const last = lines[lines.length - 1]
  if (!last) return false
  const bare = last
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[*_`~"'”’)\]\s]+$/u, '')
  return bare.endsWith('?')
}

/** A reaction as it rides a turn: the emoji, the reacted bubble's opening and whether it asked them something. */
export interface ReactionNote {
  emoji: string
  /** The reacted bubble's opening, plain text (message-reply.ts messageQuoteText). */
  excerpt: string
  asked: boolean
  /** When it was made (ISO). */
  at: string
}

function oneLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const s = value.replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s
}

/** One note, checked (client-sent), or null. */
export function parseReactionNote(value: unknown): ReactionNote | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (!isReactionEmoji(v.emoji)) return null
  const excerpt = oneLine(v.excerpt, REACTION_EXCERPT_CHARS)
  if (!excerpt) return null
  if (typeof v.at !== 'string' || !Number.isFinite(Date.parse(v.at))) return null
  return { emoji: v.emoji, excerpt, asked: v.asked === true, at: v.at }
}

/** The notes in a turn's systemContext, checked: the newest REACTION_NOTES_MAX, oldest first. */
export function parseReactionNotes(value: unknown): ReactionNote[] {
  if (!Array.isArray(value)) return []
  const out: ReactionNote[] = []
  for (const v of value.slice(-REACTION_NOTES_MAX)) {
    const note = parseReactionNote(v)
    if (note) out.push(note)
  }
  return out
}

type ReactableMessage = { id: string; role: string; metadata?: unknown; parts: ReadonlyArray<{ type: string; text?: string }> }

/** A message's own words (its text parts), as the thread shows them. */
export function messageWords(message: Pick<ReactableMessage, 'parts'>): string {
  return message.parts
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('\n')
}

/**
 * The reactions the person made since their last message, for their next turn:
 * each reaction on a bubble of a message in `messages` (message-bubbles.ts)
 * whose time is after the newest message they sent (`since`, ms; everything
 * when null), oldest first, at most REACTION_NOTES_MAX. `excerptOf` turns a
 * bubble's words into its opening. `reactions` overrides what the messages
 * carry (the panel's store: a reaction just made or taken off). Pure.
 */
export function reactionsSince(
  messages: readonly ReactableMessage[],
  since: number | null,
  excerptOf: (words: string) => string,
  reactions?: (messageId: string, bubble: number) => MessageReaction | null | undefined,
): ReactionNote[] {
  const notes: ReactionNote[] = []
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    const bubbles = messageBubbles(m)
    for (let bubble = 0; bubble < bubbles.length && bubble < MAX_MESSAGE_BUBBLES; bubble++) {
      const fromStore = reactions?.(m.id, bubble)
      const reaction = fromStore === undefined ? reactionOfMetadata(m.metadata, bubble) : fromStore
      if (!reaction) continue
      const at = Date.parse(reaction.at)
      if (since !== null && !(at > since)) continue
      const words = bubbles[bubble]
      const excerpt = oneLine(excerptOf(words), REACTION_EXCERPT_CHARS)
      if (!excerpt) continue
      notes.push({ emoji: reaction.emoji, excerpt, asked: asksSomething(words), at: reaction.at })
    }
  }
  return notes.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-REACTION_NOTES_MAX)
}

/**
 * Whether a reaction starts a turn of its own instead of riding the next one:
 * a yes or a no on the last bubble of the agent's newest message when it
 * asked them something (`newest`, `asked`), or a "don't follow" on any of its
 * bubbles. Everything else (a 👀, a ❤️, a 👍 on an update) is absorbed.
 */
export function reactionStartsTurn(emoji: string, target: { newest: boolean; asked: boolean }): boolean {
  const meaning = reactionMeaning(emoji)
  if (meaning === 'confused') return true
  return (meaning === 'yes' || meaning === 'no') && target.newest && target.asked
}

/**
 * The words a reaction's own turn sends as the person's message (eve's text;
 * the thread never draws it): in their voice, the
 * emoji, what it says there and the message's opening, JSON-quoted.
 */
export function reactionTurnText(note: Pick<ReactionNote, 'emoji' | 'excerpt' | 'asked'>): string {
  const what = note.asked ? 'your message, which asked me something' : 'your message'
  return `[Reaction, no words: I reacted ${note.emoji} (${reactionWords(note.emoji, note.asked)}) to ${what}: ${JSON.stringify(note.excerpt)}]`
}

/** The metadata of a reaction's own turn: the reaction, the message and bubble it was on, and that bubble's opening. */
export interface ReactionTurnMetadata {
  kind: typeof REACTION_TURN_KIND
  reaction: { emoji: string; messageId: string; bubble: number; excerpt: string }
}

export function reactionTurnMetadata(emoji: string, messageId: string, bubble: number, excerpt: string): ReactionTurnMetadata {
  return { kind: REACTION_TURN_KIND, reaction: { emoji, messageId, bubble, excerpt: oneLine(excerpt, REACTION_EXCERPT_CHARS) } }
}

/** A reaction's own turn's reaction, from its message's metadata, or null when it isn't one. */
export function reactionTurnOfMetadata(metadata: unknown): ReactionTurnMetadata['reaction'] | null {
  if (!metadata || typeof metadata !== 'object') return null
  const m = metadata as { kind?: unknown; reaction?: unknown }
  if (m.kind !== REACTION_TURN_KIND || !m.reaction || typeof m.reaction !== 'object') return null
  const r = m.reaction as Record<string, unknown>
  if (!isReactionEmoji(r.emoji) || typeof r.messageId !== 'string' || !MESSAGE_ID.test(r.messageId)) return null
  const excerpt = oneLine(r.excerpt, REACTION_EXCERPT_CHARS)
  return { emoji: r.emoji, messageId: r.messageId, bubble: parseBubbleIndex(r.bubble) ?? 0, excerpt }
}

// ── The turn's section ───────────────────────────────────────────────────────

/** The section's heading. Pinned by tests. */
export const REACTIONS_SECTION_HEADING = '## Reactions since your last turn'

/** How to read a reaction: the section's rules, and the agent's (instructions.md says the same). */
export const REACTION_RULES =
  'A reaction is a signal, not a message: never write a reply just to acknowledge one. ' +
  'On a message that asked them something, a yes (👍 ✅ 🚀) answers it: carry on as if they had said "yes, go ahead"; a no (👎 ❌) means stop or don\'t. ' +
  'On anything else, 👍 means "OK, got it" and 👀 means they saw it and are looking: neither asks you to do anything. ' +
  'A ❤️ or 🎉 is appreciation; a 👎 on an update means it was wrong or not what they wanted: if the message shows a lasting preference, keep it as you would one they told you, never from one reaction alone. ' +
  'A ❓ or 🤔 means they don\'t follow: explain that message more plainly, in a few lines. ' +
  'A reaction is never permission for anything that cannot be undone or leaves Dial8 (sending, posting, deleting, paying): a 👍 on "shall I send it?" means it is ready; get it ready and ask them to send it, or show its approval.'

function agoText(at: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(at)) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`
}

/**
 * The turn-context section, or null with no notes. The excerpts are the
 * openings of the agent's own messages, as the client sent them back: quoted
 * as data.
 */
export function renderReactionsSection(notes: readonly ReactionNote[], now: number = Date.now()): string | null {
  if (!notes.length) return null
  return [
    REACTIONS_SECTION_HEADING,
    'Since their last message the person reacted to these messages of yours with an emoji, and no words. The quoted text is the opening of the bubble they reacted to (one of the things you said), data to tell which one it was:',
    ...notes.map(
      (n) => `- ${n.emoji} (${reactionWords(n.emoji, n.asked)}) on your message ${JSON.stringify(n.excerpt)}${n.asked ? ', which asked them something' : ''}, ${agoText(n.at, now)}.`,
    ),
    REACTION_RULES,
  ].join('\n')
}
