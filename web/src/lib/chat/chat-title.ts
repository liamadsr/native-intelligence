/**
 * Chat titles — the name a tab carries now that a tab IS a chat.
 *
 * Pure and dependency-free: shared by the tab bar (what a tab is labelled),
 * the chat panel (the fallback when no generated name is available) and the
 * title route (cleaning up what the model returns).
 */

/** What the server names a conversation until something better is known —
 *  the `chat_conversations.title` column default, and what eve's mint writes. */
export const DEFAULT_CONVERSATION_TITLE = 'New conversation'

/** A tab whose chat has no name and no message yet. */
export const NEW_CHAT_LABEL = 'New chat'

/** Longest name a chat keeps. Tabs truncate long before this; it bounds what
 *  is stored and sent. */
export const CHAT_TITLE_MAX = 60

/** How a fallback name is cut down from the first message. */
const FALLBACK_TITLE_MAX = 48

/** The minimal message shape these helpers read (an AI SDK UIMessage fits). */
interface TitleMessage {
  role: string
  parts?: ReadonlyArray<{ type: string; text?: string }>
}

/** Is this a name the conversation doesn't really have yet? */
export function isUntitled(title: string | null | undefined): boolean {
  return !title || !title.trim() || title.trim() === DEFAULT_CONVERSATION_TITLE
}

/** The text of the thread's first user message that HAS text, trimmed ('' when
 *  none). A first message that is only an attachment names nothing, so the
 *  first one with words in it does. */
export function firstUserText(messages: ReadonlyArray<TitleMessage>): string {
  for (const m of messages) {
    if (m.role !== 'user') continue
    const text = m.parts?.find((p) => p.type === 'text' && p.text?.trim())?.text?.trim()
    if (text) return text
  }
  return ''
}

/**
 * A name made from the first message itself — used until (or instead of) a
 * generated one: for threads restored from before chats had names, and when
 * generating one fails. Whitespace collapsed; cut at a word boundary.
 */
export function fallbackChatTitle(text: string): string | null {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  if (flat.length <= FALLBACK_TITLE_MAX) return flat
  const cut = flat.slice(0, FALLBACK_TITLE_MAX)
  const space = cut.lastIndexOf(' ')
  return `${(space > FALLBACK_TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/**
 * Clean up a model's answer into a usable name, or null if nothing usable is
 * left. Models wrap names in quotes, prefix them ("Title: …"), add a trailing
 * period or run past one line despite being asked not to.
 */
export function sanitizeChatTitle(raw: string): string | null {
  let t = raw.trim().split('\n').find((line) => line.trim())?.trim() ?? ''
  t = t.replace(/^(?:chat\s+)?(?:title|name)\s*[:\-–—]\s*/i, '')
  t = t.replace(/^[\s"'“”‘’`*_#]+|[\s"'“”‘’`*_]+$/g, '')
  t = t.replace(/[.!?,;:]+$/, '')
  t = t.replace(/\s+/g, ' ').trim()
  if (!t) return null
  if (t.length > CHAT_TITLE_MAX) {
    const cut = t.slice(0, CHAT_TITLE_MAX)
    const space = cut.lastIndexOf(' ')
    t = (space > CHAT_TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()
  }
  return t
}

/**
 * What a tab is labelled: its chat's name; else, for a thread that has one, a
 * name made from its first message; else "New chat".
 */
export function chatTabLabel(chat: { title?: string; chatMessages: ReadonlyArray<TitleMessage> }): string {
  if (chat.title && chat.title.trim()) return chat.title
  return fallbackChatTitle(firstUserText(chat.chatMessages)) ?? NEW_CHAT_LABEL
}
