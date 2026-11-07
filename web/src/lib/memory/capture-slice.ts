/**
 * The capture pass's slice (always-on plan §3b, slice A2c): what was said in a
 * chat since its last capture, as plain text only. The person's words and the
 * agent's words, never a tool call or result, a recalled memory record, or
 * the turn context and expertise the app adds: the pass reads what was SAID.
 *
 * Two producers build it:
 *   - the chat agent's profile slot at compaction (agents/chat-agent/lib/
 *     profile-memory.ts captureSlice, from eve's history; this module's
 *     limits are mirrored there, checked by a drift test);
 *   - the nightly catch-up (capture-catchup.ts), from the stored chat
 *     history (sliceFromUiMessages).
 * The memory route re-validates whatever arrives (validateSlice): it is data
 * from our own runtime, but bounded here again before it is stored or queued.
 */

import { isSeededSend } from '@/lib/chat/seeded-send'

/** About how many characters a slice carries in all; the newest are kept. */
export const CAPTURE_SLICE_MAX_CHARS = 40_000
/** The most characters one message carries (its head, then an ellipsis). */
export const CAPTURE_MESSAGE_MAX_CHARS = 6_000
/** The most messages one slice carries. */
export const CAPTURE_SLICE_MAX_MESSAGES = 400

export interface SliceMessage {
  role: 'user' | 'assistant'
  text: string
}

/** One message's text, whitespace runs kept to single spaces per line, a long one clipped to its TAIL. */
export function clipSliceText(text: string): string {
  const clean = text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  return clean.length > CAPTURE_MESSAGE_MAX_CHARS ? `…${clean.slice(-(CAPTURE_MESSAGE_MAX_CHARS - 1))}` : clean
}

const PRIMER_OPEN = '<conversation-so-far>'
const PRIMER_CLOSE = '</conversation-so-far>'

/**
 * The person's own words in one of their messages, or null: a seeded UI send
 * (src/lib/chat/seeded-send.ts) is left out whole, and a leading history
 * primer (src/lib/chat/conversation-history.ts) is cut off up to its last
 * closing tag, and a server-written background update (A4 slice 5) is never
 * the person's. Twin of personText in agents/chat-agent/lib/person-messages.ts.
 */
export function personSaid(text: string): string | null {
  if (isSeededSend(text)) return null
  if (isBackgroundUpdate(text)) return null
  let rest = text
  if (rest.trimStart().startsWith(PRIMER_OPEN)) {
    const end = rest.lastIndexOf(PRIMER_CLOSE)
    rest = end >= 0 ? rest.slice(end + PRIMER_CLOSE.length) : ''
  }
  rest = rest.trim()
  return rest && !isBackgroundUpdate(rest) ? rest : null
}

/**
 * How a server-written background update starts (renderBackgroundUpdate,
 * src/lib/chat/home-turn.ts; twin of BACKGROUND_UPDATE_HEADER in
 * agents/chat-agent/lib/person-messages.ts). It arrives as a user-role
 * message in eve's history, but nobody typed it: never the person's side of
 * a slice (A4 slice 5).
 */
export const BACKGROUND_UPDATE_HEADER = '[BACKGROUND UPDATE'

/** True when a user-role message is a server-written background update. */
export function isBackgroundUpdate(text: string): boolean {
  return text.trimStart().toUpperCase().startsWith(BACKGROUND_UPDATE_HEADER)
}

/**
 * Keep the newest messages within the caps, oldest first. Empty texts drop
 * out. Pure.
 */
export function capSlice(messages: readonly SliceMessage[]): SliceMessage[] {
  const out: SliceMessage[] = []
  let left = CAPTURE_SLICE_MAX_CHARS
  for (let i = messages.length - 1; i >= 0 && out.length < CAPTURE_SLICE_MAX_MESSAGES; i--) {
    const text = clipSliceText(messages[i].text)
    if (!text) continue
    if (text.length > left) break
    out.push({ role: messages[i].role, text })
    left -= text.length
  }
  return out.reverse()
}

/**
 * A slice from the wire, shape-guarded and capped: only { role: user |
 * assistant, text: string } entries survive. Never throws.
 */
export function validateSlice(value: unknown): SliceMessage[] {
  if (!Array.isArray(value)) return []
  const messages: SliceMessage[] = []
  for (const m of value.slice(-CAPTURE_SLICE_MAX_MESSAGES * 2)) {
    if (!m || typeof m !== 'object') continue
    const { role, text } = m as { role?: unknown; text?: unknown }
    if ((role !== 'user' && role !== 'assistant') || typeof text !== 'string') continue
    // The person's own words only, whatever the sender stripped already.
    const said = role === 'user' ? personSaid(text) : text
    if (said) messages.push({ role, text: said })
  }
  return capSlice(messages)
}

/** Whether a slice has anything the person said: the pass reads nothing without it. */
export function sliceHasPersonText(slice: readonly SliceMessage[]): boolean {
  return slice.some((m) => m.role === 'user' && m.text.trim().length > 0)
}

/** A stored chat message (chat_messages.ui_message), as far as the slice reads it. */
interface UiMessageLike {
  role?: unknown
  parts?: unknown
  metadata?: unknown
}

/**
 * The slice from stored chat history (chat_messages rows, oldest first): the
 * text parts of the person's and the agent's messages. Messages the app wrote
 * into the thread itself (a teammate's report, a system notice: anything with
 * a metadata `kind`) are not something either of them said, and drop out, as
 * do tool, file, reasoning and data parts. Pure.
 */
export function sliceFromUiMessages(rows: ReadonlyArray<{ role: string; ui_message: unknown }>): SliceMessage[] {
  const messages: SliceMessage[] = []
  for (const row of rows) {
    if (row.role !== 'user' && row.role !== 'assistant') continue
    const ui = (row.ui_message ?? {}) as UiMessageLike
    const meta = ui.metadata as { kind?: unknown } | null | undefined
    if (meta && typeof meta === 'object' && typeof meta.kind === 'string' && meta.kind) continue
    if (!Array.isArray(ui.parts)) continue
    const text = ui.parts
      .filter((p): p is { type: 'text'; text: string } => !!p && typeof p === 'object' && (p as { type?: unknown }).type === 'text' && typeof (p as { text?: unknown }).text === 'string')
      .map((p) => p.text)
      .join('\n')
    const said = row.role === 'user' ? personSaid(text) : text
    if (said && said.trim()) messages.push({ role: row.role, text: said })
  }
  return capSlice(messages)
}
