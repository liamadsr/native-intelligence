/**
 * Guests in the owner's chat (guest access PR4): the parts the server writes
 * into the owner's home thread about what their guests did, read here for the
 * chat to draw.
 *
 *   data-ask-card + `guest`   a guest's held call that needs the owner: the
 *                             ordinary ask card (chat-asks.ts, the same
 *                             tool_approval and its one person-only door),
 *                             with who asked riding along (the approval's
 *                             context.guest, approvals.ts askAtHome) so the
 *                             chat says so above the card and opens their
 *                             conversation.
 *   data-guest-request        someone asking to reach the agent (JOIN and the
 *                             owner's request code): an agent_guest row in
 *                             state 'requested', allowed with a preset or
 *                             ignored through the People routes
 *                             (/api/account/agent-guests/[id]/approve, /ignore).
 *   data-guest-message        a note a guest's agent passes the owner
 *                             (message_owner): their words, under their line.
 *   data-guest-activity       one stretch of a guest's conversation (their
 *                             texts within an hour), in one line: what
 *                             happened, who, how many things. The server
 *                             rewrites the same part (same id) as the stretch
 *                             grows. No notification of its own.
 *
 * Both open the guest's conversation as a card (the `guest` page kind,
 * ./chat-cards/pages.ts), on the message they are about when they name one.
 *
 * Client-safe and pure: a part is data, so every field is checked.
 */
import type { GuestPresetValue } from './presets'

/** The part an access request is shown in, in the owner's home thread. */
export const GUEST_REQUEST_PART_TYPE = 'data-guest-request' as const

/** The part a guest's note to the owner is shown in (message_owner), in the owner's home thread. */
export const GUEST_MESSAGE_PART_TYPE = 'data-guest-message' as const

/** The part a guest's stretch of conversation is logged in, in the owner's home thread. */
export const GUEST_ACTIVITY_PART_TYPE = 'data-guest-activity' as const

/** `ui_message.metadata.kind` of a guest activity message in the home thread. */
export const GUEST_ACTIVITY_MESSAGE_KIND = 'guest_activity' as const

/** `ui_message.metadata.kind` of a guest's note to the owner in the home thread (reach-owner.ts writes it). */
export const GUEST_MESSAGE_MESSAGE_KIND = 'guest_message' as const

/** `ui_message.metadata.kind` of an access request in the home thread (activity.ts writes it). */
export const GUEST_REQUEST_MESSAGE_KIND = 'guest_request' as const

/** How a guest reached the agent (by text, on Slack, or through their own Native Intelligence agent: migration 435). */
export type GuestChannel = 'sms' | 'slack' | 'dial8'

/**
 * A guest's name as a model reads it outside any fence: letters, digits and
 * plain punctuation on one line, at most 60 characters, else "A guest". The
 * owner types it, but a business's customer's comes from their own contact
 * details, so it never carries markup or a paragraph of instructions. Pure.
 */
export function guestNameForModel(name: unknown): string {
  const clean = typeof name === 'string' ? name.replace(/[^\p{L}\p{N} .,'’()&-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60).trim() : ''
  return clean || 'A guest'
}

/** How a guest reached the agent, in a few words ("by text", "on Slack", "through their agent"). */
export function guestVia(via: GuestChannel = 'sms'): string {
  return via === 'slack' ? 'on Slack' : via === 'dial8' ? 'through their agent' : 'by text'
}

/** Who a part is about: enough to say it and to open their conversation. */
export interface GuestRef {
  /** agent_guest.id */
  id: string
  /** The name the owner gave them. */
  name: string
  /** Absent where the writer didn't read it (an approval's context names only the guest). */
  preset?: GuestPresetValue
  channel: GuestChannel
  /** Their thread (chat_conversations.agent_guest_id = id). */
  conversation_id?: string
  /** The message in their thread this part is about, to open the card on. */
  message_id?: string
}

/** A `data-ask-card` part's `guest` field: the guest whose request it is. */
export type GuestAskData = GuestRef

export interface GuestActivityPartData {
  guest: GuestRef
  /** What happened, in plain words ("Booked Nopa, added 2 to Groceries"). */
  summary: string
  /** How many things the stretch holds (1 when absent). */
  count: number
  /** When the stretch began and last grew (ISO). */
  started_at: string
  last_at: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const uuid = (v: unknown): string | null => (typeof v === 'string' && UUID_RE.test(v) ? v : null)
const PRESETS: ReadonlySet<unknown> = new Set(['household', 'colleague', 'custom'])
const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null
  const t = v.replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, max) : null
}
const iso = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null)

/** The guest a part names, or null when it names none (or a malformed one). */
export function guestRef(value: unknown): GuestRef | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const id = uuid(v.id)
  const name = text(v.name, 80)
  if (!id || !name) return null
  const conversationId = uuid(v.conversation_id)
  const messageId = text(v.message_id, 120)
  return {
    id,
    name,
    ...(PRESETS.has(v.preset) ? { preset: v.preset as GuestPresetValue } : {}),
    channel: v.channel === 'slack' || v.channel === 'dial8' ? v.channel : 'sms',
    ...(conversationId ? { conversation_id: conversationId } : {}),
    ...(messageId ? { message_id: messageId } : {}),
  }
}

/** What an access request held when it was written; the card reads whether it is still waiting. */
export type GuestRequestStatus = 'pending' | 'approved' | 'ignored'

export interface GuestRequestPartData {
  /** agent_guest.id of the requested row. */
  guest_id: string
  /** The name they gave in their JOIN text. */
  guest_name: string
  /** The last four digits of their number, all the owner gets to see of it. */
  phone_last4?: string
  status: GuestRequestStatus
  requested_at: string
  /** Once approved: the preset the owner picked (the People routes merge it in). */
  preset?: GuestPresetValue
}

/** An access request part's data, or null when it isn't one. */
export function guestRequestPartData(value: unknown): GuestRequestPartData | null {
  if (!value || typeof value !== 'object') return null
  const d = value as Record<string, unknown>
  const id = uuid(d.guest_id)
  const name = text(d.guest_name, 80)
  if (!id || !name) return null
  const last4 = typeof d.phone_last4 === 'string' && /^\d{4}$/.test(d.phone_last4) ? d.phone_last4 : null
  const status: GuestRequestStatus = d.status === 'approved' || d.status === 'ignored' ? d.status : 'pending'
  return {
    guest_id: id,
    guest_name: name,
    ...(last4 ? { phone_last4: last4 } : {}),
    status,
    requested_at: iso(d.requested_at) ?? new Date(0).toISOString(),
    ...(status === 'approved' && PRESETS.has(d.preset) ? { preset: d.preset as GuestPresetValue } : {}),
  }
}

export interface GuestMessagePartData {
  guest: GuestRef
  /** The note, as the guest's agent passed it on. */
  text: string
  /** The guest's agent marked it urgent (it pinged the owner too). */
  urgent: boolean
  at: string
}

/** A guest's note part's data, or null when it isn't one. */
export function guestMessagePartData(value: unknown): GuestMessagePartData | null {
  if (!value || typeof value !== 'object') return null
  const d = value as Record<string, unknown>
  const guest = guestRef(d.guest)
  const note = typeof d.text === 'string' ? d.text.trim().slice(0, 2000) : ''
  if (!guest || !note) return null
  return { guest, text: note, urgent: d.urgent === true, at: iso(d.at) ?? new Date(0).toISOString() }
}

/** A guest activity part's data, or null when it isn't one. */
export function guestActivityPartData(value: unknown): GuestActivityPartData | null {
  if (!value || typeof value !== 'object') return null
  const d = value as Record<string, unknown>
  const guest = guestRef(d.guest)
  const summary = text(d.summary, 240)
  const lastAt = iso(d.last_at)
  if (!guest || !summary || !lastAt) return null
  const count = typeof d.count === 'number' && Number.isInteger(d.count) && d.count > 0 ? Math.min(d.count, 999) : 1
  return { guest, summary, count, started_at: iso(d.started_at) ?? lastAt, last_at: lastAt }
}

/** "Household", "Colleague", or nothing for a custom set of tools. */
export function presetLabel(preset: GuestPresetValue | undefined): string | null {
  return preset === 'household' ? 'Household' : preset === 'colleague' ? 'Colleague' : null
}

/** The guest's initials, for their avatar ("Jason Lee" → "JL", "Sam" → "S"). */
export function guestInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const letters = (words.length > 1 ? [words[0], words[words.length - 1]] : words).map((w) => [...w][0] ?? '')
  return letters.join('').toUpperCase() || '?'
}

/** Who and how, in one line: "Jason Lee · Colleague", "Sam · Household · by text". */
export function guestLine(guest: GuestRef, opts: { channel?: boolean } = {}): string {
  const parts = [guest.name, presetLabel(guest.preset)]
  if (opts.channel) parts.push(guest.channel === 'slack' ? 'in Slack' : 'by text')
  return parts.filter(Boolean).join(' · ')
}

/** The activity card's second line: "Sam · Household · 3 things · 1:15 PM". */
export function guestActivityMeta(data: GuestActivityPartData, time: string): string {
  return [guestLine(data.guest), data.count > 1 ? `${data.count} things` : null, time].filter(Boolean).join(' · ')
}
