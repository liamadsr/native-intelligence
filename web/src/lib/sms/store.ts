/**
 * The texting tables (migration 411), read and written with the service
 * role: `user_phone` (a person's verified number), and the `sms_message`
 * ledger (texts in and out, no bodies) that the rate limits, a guest's daily
 * cap, the once-only unknown-sender reply and an unlinked number's STOP read.
 * The person's own texts have no cap (Liam, 2026-10-31).
 *
 * One phone, two accounts (migration 464): a phone has at most one
 * Dial8-line row (`line = 'dial8'`, the account the Dial8 number reaches) and
 * any number of business-line rows (`line = 'business'`, an account reached
 * only on the business number of a workspace its person belongs to). Each
 * person still has one row.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/** Kinds of inbound ledger rows. */
export type SmsInboundKind =
  | 'text'
  | 'stop'
  | 'start'
  | 'help'
  | 'unknown'
  | 'limited'
  | 'approval'
  | 'code_miss'
  // A guest's (428): a text to their agent, their invite code, a JOIN request.
  | 'guest_text'
  | 'guest_invite'
  | 'guest_join'
  // A wrong code from a number signing up by text (457, ./signup.ts): the daily guess cap counts them.
  | 'signup_code_miss'
/** Kinds of outbound ledger rows. */
export type SmsOutboundKind =
  | 'verification'
  | 'welcome'
  | 'reply'
  | 'notice'
  | 'unknown_reply'
  | 'auto_reply'
  | 'needs_you'
  | 'approval_result'
  // An agent message the router texted while the person was away from the app (454, src/lib/reach/route.ts).
  | 'away'
  // To a guest (428): their agent's reply, the welcome, a notice (a JOIN answer, a cap).
  | 'guest_reply'
  | 'guest_welcome'
  | 'guest_notice'
  // Signing up by text (457): the sign-up code, and the "Google is connected" text after a texted link.
  | 'signup_code'
  | 'connected'

/** Texts one number may send in RATE_WINDOW_MS before the rest are ignored. */
export const SMS_INBOUND_RATE_LIMIT = 20
export const SMS_INBOUND_RATE_WINDOW_MS = 10 * 60_000
/**
 * Replies to texts Dial8 can't tie to a person (HELP, START, an unknown
 * sender) across ALL numbers in an hour: anyone can trigger them, so they are
 * capped globally against SMS pumping. Past it, those texts get no reply.
 */
export const SMS_AUTO_REPLY_HOURLY_CAP = 100
/**
 * The outbound kinds that cap counts. A guest's welcome and notices are in it
 * too: they answer a number nobody verified (an invite code, a JOIN). A
 * sign-up code (457) is not: it has its own, lower cap (./signup.ts), so
 * sign-ups can never starve the HELP and START answers.
 */
export const SMS_AUTO_REPLY_KINDS: readonly SmsOutboundKind[] = ['unknown_reply', 'auto_reply', 'guest_welcome', 'guest_notice']

/**
 * Which number reaches a verified phone's account (migration 464): 'dial8' the
 * Dial8 number (one account per phone), 'business' only the business number
 * of a workspace its person belongs to.
 */
export type PhoneLine = 'dial8' | 'business'

/** A verified number as the webhook and the reply read it. */
export interface LinkedPhone {
  id: string
  userId: string
  workspaceId: string
  phone: string
  optedOut: boolean
  line: PhoneLine
}

interface UserPhoneRow {
  id: string
  user_id: string
  workspace_id: string
  phone_e164: string
  opted_out_at: string | null
  line?: string | null
  created_at?: string | null
}

const USER_PHONE_SELECT = 'id, user_id, workspace_id, phone_e164, opted_out_at, line, created_at'

function toLinked(row: UserPhoneRow): LinkedPhone {
  return {
    id: row.id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    phone: row.phone_e164,
    optedOut: row.opted_out_at !== null,
    line: row.line === 'business' ? 'business' : 'dial8',
  }
}

/**
 * The account the Dial8 number reaches from `phone`: its verified Dial8-line
 * row, or null. A business-line row is never it (that account is reached on a
 * business's own number only). Throws on a failed read.
 */
export async function findLinkedPhone(supabase: SupabaseClient, phone: string): Promise<LinkedPhone | null> {
  const { data, error } = await supabase
    .from('user_phone')
    .select(USER_PHONE_SELECT)
    .eq('phone_e164', phone)
    .not('verified_at', 'is', null)
    .eq('line', 'dial8')
    .maybeSingle<UserPhoneRow>()
  if (error) throw new Error(`user_phone lookup failed: ${error.message}`)
  return data ? toLinked(data) : null
}

/** The user ids of `workspaceId`'s members among `userIds`. Throws on a failed read. */
async function membersAmong(supabase: SupabaseClient, workspaceId: string, userIds: readonly string[]): Promise<Set<string>> {
  if (!userIds.length) return new Set()
  const { data, error } = await supabase.from('member').select('user_id').eq('workspace_id', workspaceId).in('user_id', [...userIds])
  if (error) throw new Error(`member read failed: ${error.message}`)
  return new Set(((data ?? []) as Array<{ user_id: string }>).map((m) => m.user_id))
}

/**
 * Who is texting a business's own number from `phone` when it is one of that
 * business's own people: the phone's verified row whose person is a member of
 * `workspaceId`. A business-line row first, then the Dial8-line one; between
 * two rows on one line, the oldest (then the lowest id), so the answer never
 * flips. Null when none is (a customer). The row is returned as stored: the
 * caller puts the business's workspace on it. Throws on a failed read.
 */
export async function findBusinessPerson(supabase: SupabaseClient, phone: string, workspaceId: string): Promise<LinkedPhone | null> {
  const { data, error } = await supabase.from('user_phone').select(USER_PHONE_SELECT).eq('phone_e164', phone).not('verified_at', 'is', null)
  if (error) throw new Error(`user_phone lookup failed: ${error.message}`)
  const rows = (data ?? []) as UserPhoneRow[]
  if (!rows.length) return null
  const members = await membersAmong(supabase, workspaceId, [...new Set(rows.map((r) => r.user_id))])
  const rank = (row: UserPhoneRow) => (row.line === 'business' ? 0 : 1)
  const theirs = rows
    .filter((r) => members.has(r.user_id))
    .sort((a, b) => rank(a) - rank(b) || String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || a.id.localeCompare(b.id))
  return theirs[0] ? toLinked(theirs[0]) : null
}

/** The person's verified number, or null. Throws on a failed read. */
export async function linkedPhoneForUser(supabase: SupabaseClient, userId: string): Promise<LinkedPhone | null> {
  const { data, error } = await supabase
    .from('user_phone')
    .select(USER_PHONE_SELECT)
    .eq('user_id', userId)
    .not('verified_at', 'is', null)
    .maybeSingle<UserPhoneRow>()
  if (error) throw new Error(`user_phone lookup failed: ${error.message}`)
  return data ? toLinked(data) : null
}

/**
 * Set or clear the opt-out of the phone's Dial8-line row: a STOP / START to
 * the Dial8 number, or Twilio's 21610 on a text from it. Its business-line
 * rows are left alone: an opt-out is per sending number at the carrier
 * (Twilio's own, `OptOutType`), and they are texted from business numbers
 * only. Throws on a failed write.
 */
export async function setPhoneOptOut(supabase: SupabaseClient, phone: string, optedOut: boolean): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('user_phone')
    .update({ opted_out_at: optedOut ? now : null, updated_at: now })
    .eq('phone_e164', phone)
    .eq('line', 'dial8')
  if (error) throw new Error(`user_phone opt-out failed: ${error.message}`)
}

/**
 * Set or clear one row's opt-out, on either line: a STOP / START to a
 * business's number toggles the row that number resolves the phone to
 * ({@link findBusinessPerson}), and Twilio's 21610 on a text from it the row
 * of the person texted, which is the same row (Dial8 texts someone from a
 * business's number only when a text back would reach them:
 * ./workspace-line.ts). Throws on a failed write.
 */
export async function setPhoneRowOptOut(supabase: SupabaseClient, id: string, optedOut: boolean): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await supabase.from('user_phone').update({ opted_out_at: optedOut ? now : null, updated_at: now }).eq('id', id)
  if (error) throw new Error(`user_phone opt-out failed: ${error.message}`)
}

/**
 * Record an inbound text. 'duplicate' when Twilio already delivered this
 * MessageSid (a retried webhook): the caller does nothing more. Throws on any
 * other failed write.
 */
export async function recordInbound(
  supabase: SupabaseClient,
  row: { phone: string; kind: SmsInboundKind; sid: string | null; userId?: string | null },
): Promise<'new' | 'duplicate'> {
  const { error } = await supabase.from('sms_message').insert({
    direction: 'in',
    kind: row.kind,
    phone_e164: row.phone,
    twilio_sid: row.sid,
    user_id: row.userId ?? null,
  })
  if (!error) return 'new'
  if (error.code === '23505') return 'duplicate'
  throw new Error(`sms_message insert failed: ${error.message}`)
}

/** Delete an inbound row by its MessageSid (its delivery failed; Twilio retries). Throws on a failed write. */
export async function forgetInbound(supabase: SupabaseClient, sid: string): Promise<void> {
  const { error } = await supabase.from('sms_message').delete().eq('direction', 'in').eq('twilio_sid', sid)
  if (error) throw new Error(`sms_message delete failed: ${error.message}`)
}

/** Re-mark an inbound row by its MessageSid (it answered an approval, or guessed a code wrong: 426, 457). Throws on a failed write. */
export async function markInboundKind(supabase: SupabaseClient, sid: string, kind: Extract<SmsInboundKind, 'approval' | 'code_miss' | 'signup_code_miss' | 'text'>): Promise<void> {
  const { error } = await supabase.from('sms_message').update({ kind }).eq('direction', 'in').eq('twilio_sid', sid)
  if (error) throw new Error(`sms_message update failed: ${error.message}`)
}

/** Mark an inbound row as a guest's (428): its kind and the guest it is from, when known. Throws on a failed write. */
export async function markInboundGuest(
  supabase: SupabaseClient,
  sid: string,
  kind: Extract<SmsInboundKind, 'guest_text' | 'guest_invite' | 'guest_join' | 'limited'>,
  guestId: string | null,
): Promise<void> {
  const { error } = await supabase.from('sms_message').update({ kind, guest_id: guestId }).eq('direction', 'in').eq('twilio_sid', sid)
  if (error) throw new Error(`sms_message update failed: ${error.message}`)
}

/** Texts in or out for one guest since `sinceMs` (their per-day caps). Throws on a failed read. */
export async function countGuestMessagesSince(supabase: SupabaseClient, guestId: string, direction: 'in' | 'out', sinceMs: number): Promise<number> {
  const { count, error } = await supabase
    .from('sms_message')
    .select('id', { count: 'exact', head: true })
    .eq('guest_id', guestId)
    .eq('direction', direction)
    .gte('created_at', new Date(sinceMs).toISOString())
  if (error) throw new Error(`sms_message count failed: ${error.message}`)
  return count ?? 0
}

/** Inbound texts of `kind` from `phone` since `sinceMs` (the daily wrong-code cap). Throws on a failed read. */
export async function countInboundKindSince(supabase: SupabaseClient, phone: string, kind: SmsInboundKind, sinceMs: number): Promise<number> {
  const { count, error } = await supabase
    .from('sms_message')
    .select('id', { count: 'exact', head: true })
    .eq('phone_e164', phone)
    .eq('direction', 'in')
    .eq('kind', kind)
    .gte('created_at', new Date(sinceMs).toISOString())
  if (error) throw new Error(`sms_message count failed: ${error.message}`)
  return count ?? 0
}

/** Record an outbound text. Best-effort: a missed row only loosens a limit. */
export async function recordOutbound(
  supabase: SupabaseClient,
  row: { phone: string; kind: SmsOutboundKind; sid?: string | null; userId?: string | null; guestId?: string | null },
): Promise<void> {
  try {
    await supabase.from('sms_message').insert({
      direction: 'out',
      kind: row.kind,
      phone_e164: row.phone,
      twilio_sid: row.sid ?? null,
      user_id: row.userId ?? null,
      ...(row.guestId ? { guest_id: row.guestId } : {}),
    })
  } catch {
    // Best-effort (see above).
  }
}

/** Inbound texts from `phone` since `sinceMs`. Throws on a failed read. */
export async function countInboundSince(supabase: SupabaseClient, phone: string, sinceMs: number): Promise<number> {
  const { count, error } = await supabase
    .from('sms_message')
    .select('id', { count: 'exact', head: true })
    .eq('phone_e164', phone)
    .eq('direction', 'in')
    .gte('created_at', new Date(sinceMs).toISOString())
  if (error) throw new Error(`sms_message count failed: ${error.message}`)
  return count ?? 0
}

/** Replies of the given kinds sent to anyone since `sinceMs` (the global auto-reply cap). Throws on a failed read. */
export async function countOutboundKindsSince(supabase: SupabaseClient, kinds: readonly SmsOutboundKind[], sinceMs: number): Promise<number> {
  const { count, error } = await supabase
    .from('sms_message')
    .select('id', { count: 'exact', head: true })
    .eq('direction', 'out')
    .in('kind', [...kinds])
    .gte('created_at', new Date(sinceMs).toISOString())
  if (error) throw new Error(`sms_message count failed: ${error.message}`)
  return count ?? 0
}

/** True when Dial8 already sent `phone` a text of `kind` (since `sinceMs`, when given). Throws on a failed read. */
export async function hasOutbound(supabase: SupabaseClient, phone: string, kind: SmsOutboundKind, sinceMs?: number): Promise<boolean> {
  let query = supabase.from('sms_message').select('id').eq('phone_e164', phone).eq('direction', 'out').eq('kind', kind)
  if (sinceMs !== undefined) query = query.gte('created_at', new Date(sinceMs).toISOString())
  const { data, error } = await query.limit(1)
  if (error) throw new Error(`sms_message read failed: ${error.message}`)
  return Array.isArray(data) && data.length > 0
}

/**
 * True when a number no one linked last said STOP (its newest stop / start
 * row is a stop): nothing is texted to it. Throws on a failed read.
 */
export async function unlinkedNumberOptedOut(supabase: SupabaseClient, phone: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('sms_message')
    .select('kind')
    .eq('phone_e164', phone)
    .eq('direction', 'in')
    .in('kind', ['stop', 'start'])
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) throw new Error(`sms_message read failed: ${error.message}`)
  return (data as Array<{ kind?: unknown }> | null)?.[0]?.kind === 'stop'
}

/** True when the person is still a member of the workspace. Throws on a failed read. */
export async function isWorkspaceMember(supabase: SupabaseClient, userId: string, workspaceId: string): Promise<boolean> {
  const { data, error } = await supabase.from('member').select('id').eq('user_id', userId).eq('workspace_id', workspaceId).maybeSingle<{ id: string }>()
  if (error) throw new Error(`member lookup failed: ${error.message}`)
  return !!data
}
