/**
 * The People tab's view of a guest (guest access, PR5): what
 * /api/account/agent-guests answers and the agent panel's People tab reads.
 * The owner's own id and the full number stay on the server; the tab shows
 * the masked number.
 *
 * Pure and client-safe.
 */
import type { GuestAskBefore, GuestPresetValue } from './presets'
import type { GuestChannelId, GuestState } from './store'

export interface GuestView {
  id: string
  displayName: string
  /** The number as the tab shows it, like "··8830"; null for someone on Slack only. */
  masked: string | null
  /** Where they reach the agent: Text, Slack (migration 434). */
  channels: GuestChannelId[]
  /** The Native Intelligence user they are, when their agent is a channel (435); join with /api/account/agent-links by myHalfGuestId. */
  peerUserId: string | null
  /** Their channels not yet proven theirs: their invite still binds these. */
  unbound: GuestChannelId[]
  preset: GuestPresetValue
  /** What their agent holds (Always allow or Needs approval); anything else is Blocked. */
  tools: string[]
  /** Of those, the ones whose every call waits for the owner's yes (Needs approval). */
  askTools: string[]
  askBefore: GuestAskBefore[]
  notes: string | null
  /** The addresses their calendar invites come from (migration 455): their invites count as the owner's own plans. */
  calendarEmails: string[]
  /** removed only when one person is read by id (GET /api/account/agent-guests/[id]); lists leave them out. */
  state: GuestState
  inviteExpiresAt: string | null
  requestedAt: string | null
  activatedAt: string | null
  lastInboundAt: string | null
  optedOut: boolean
  createdAt: string
}

/** A one-time invite, as Add a person and New invite link answer it: show it once. */
export interface GuestInvite {
  code: string
  /** The first text it types in for them: "Hi, it's Sam · K7Q4MX". */
  text: string
  /** The Native Intelligence number they text, E.164; null when texting isn't set up. */
  dial8Number: string | null
  expiresAt: string | null
}

/** The channels' names as the tab shows them; dial8 is their own Native Intelligence agent (agent links, migration 435). */
export const GUEST_CHANNEL_LABELS: Record<GuestChannelId, string> = { sms: 'Text', slack: 'Slack', dial8: 'Their agent' }

/** "··8830": the last four digits, as the People tab shows a guest's number. */
export function maskGuestPhone(e164: string): string {
  return `··${e164.slice(-4)}`
}

/** Calendar addresses one guest may list (migration 455's check). */
export const GUEST_CALENDAR_EMAILS_MAX = 5
/**
 * Entries a calendar-emails list may hold before any cleaning: the cap, room
 * for blanks and repeats a pasted list carries, and no more. A longer list is
 * refused unread (the PATCH route refuses it before the store).
 */
export const GUEST_CALENDAR_EMAILS_RAW_MAX = GUEST_CALENDAR_EMAILS_MAX * 4
/** An entry longer than this is no address (254, plus room for the spaces around it). */
const EMAIL_RAW_CHARS = 320

/** An address as a calendar would list it: one local part, one domain with a dot, no spaces. */
const PLAUSIBLE_EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/

/** Whether a lower-case string reads as an address a calendar would list. Pure. */
export function isPlausibleEmail(email: string): boolean {
  return email.length <= 254 && PLAUSIBLE_EMAIL_RE.test(email)
}

/**
 * The calendar addresses an owner typed for a guest, cleaned: each trimmed
 * and lower-cased, empty entries dropped, duplicates once. Null when one
 * isn't a plausible address (it would never match an invite, and the owner
 * should see why), when there are more than GUEST_CALENDAR_EMAILS_MAX (the
 * moment the list passes it), or when the raw list is longer than
 * GUEST_CALENDAR_EMAILS_RAW_MAX (before any work). Linear. The People page
 * checks with it before saving; the store checks again. Pure.
 */
export function cleanCalendarEmails(values: readonly unknown[]): string[] | null {
  if (values.length > GUEST_CALENDAR_EMAILS_RAW_MAX) return null
  const out = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string' || value.length > EMAIL_RAW_CHARS) return null
    const email = value.trim().toLowerCase()
    if (!email) continue
    if (!isPlausibleEmail(email)) return null
    out.add(email)
    if (out.size > GUEST_CALENDAR_EMAILS_MAX) return null
  }
  return [...out]
}

/** What the People page's calendar-emails field holds, as a list: split on commas, semicolons and spaces. Pure. */
export function splitCalendarEmails(text: string): string[] {
  return text.split(/[\s,;]+/).filter(Boolean)
}
