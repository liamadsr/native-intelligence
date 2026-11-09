/**
 * The reminder rows (migration 472, customer_reminder), read and written with
 * the service role: one per subject (a booking, or a calendar event) and
 * phone, claimed before its text goes (./reminders.ts), what the customer
 * answered (./reminder-replies.ts), and the owner's own move or cancel of
 * the booking (./booking-changes.ts). Every function takes the workspace and
 * touches only its rows.
 *
 * Server only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export const REMINDER_SUBJECTS = ['booking', 'meeting'] as const
export type ReminderSubjectType = (typeof REMINDER_SUBJECTS)[number]

/** The customer's answer, or `cancelled`: the owner cancelled the booking since. */
export const REMINDER_ANSWERS = ['confirmed', 'moved', 'opted_out', 'cancelled'] as const
export type ReminderAnswer = (typeof REMINDER_ANSWERS)[number]

export const REMINDER_STATUSES = ['claimed', 'sent', 'failed'] as const
export type ReminderStatus = (typeof REMINDER_STATUSES)[number]

/** How long after its text a reminder can still be answered (by its own agent) or opted out of. */
export const REMINDER_ANSWER_WINDOW_MS = 3 * 24 * 60 * 60_000

export const REMINDER_SELECT =
  'id, workspace_id, owner_user_id, subject_type, subject_id, contact_id, phone_e164, customer_name, kind, starts_at, ends_at, status, answer, answered_at, moved_to, sent_at, created_at'

interface ReminderRow {
  id: string
  workspace_id: string
  owner_user_id: string
  subject_type: string
  subject_id: string
  contact_id: string | null
  phone_e164: string
  customer_name: string
  kind: string
  starts_at: string
  ends_at: string
  status: string
  answer: string | null
  answered_at: string | null
  moved_to: string | null
  sent_at: string | null
  created_at: string
}

export interface CustomerReminder {
  id: string
  workspaceId: string
  ownerUserId: string
  subjectType: ReminderSubjectType
  subjectId: string
  contactId: string | null
  phone: string
  customerName: string
  kind: string
  /** When it was when the reminder went (a move keeps it: `movedTo` is the new time, whoever moved it). */
  startsAt: string
  endsAt: string
  status: ReminderStatus
  answer: ReminderAnswer | null
  answeredAt: string | null
  movedTo: string | null
  sentAt: string | null
  createdAt: string
}

const iso = (value: string | null): string | null => (value ? new Date(value).toISOString() : null)

export function toReminder(row: ReminderRow): CustomerReminder {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ownerUserId: row.owner_user_id,
    subjectType: row.subject_type === 'meeting' ? 'meeting' : 'booking',
    subjectId: row.subject_id,
    contactId: row.contact_id,
    phone: row.phone_e164,
    customerName: row.customer_name,
    kind: row.kind,
    startsAt: new Date(row.starts_at).toISOString(),
    endsAt: new Date(row.ends_at).toISOString(),
    status: (REMINDER_STATUSES as readonly string[]).includes(row.status) ? (row.status as ReminderStatus) : 'failed',
    answer: (REMINDER_ANSWERS as readonly string[]).includes(row.answer ?? '') ? (row.answer as ReminderAnswer) : null,
    answeredAt: iso(row.answered_at),
    movedTo: iso(row.moved_to),
    sentAt: iso(row.sent_at),
    createdAt: row.created_at,
  }
}

/** When the reminder's job or meeting is now: the time it moved to, else its own. Pure. */
export function reminderAt(reminder: Pick<CustomerReminder, 'startsAt' | 'movedTo'>): string {
  return reminder.movedTo ?? reminder.startsAt
}

export interface NewReminder {
  workspaceId: string
  ownerUserId: string
  subjectType: ReminderSubjectType
  subjectId: string
  contactId: string | null
  phone: string
  customerName: string
  kind: string
  startsAt: string
  endsAt: string
}

/**
 * Claim one reminder before its text goes. `taken` when this subject and
 * phone already had one (never twice). Throws on any other failed write.
 */
export async function claimReminder(supabase: SupabaseClient, reminder: NewReminder): Promise<{ ok: true; id: string } | { ok: false; reason: 'taken' }> {
  const { data, error } = await supabase
    .from('customer_reminder')
    .insert({
      workspace_id: reminder.workspaceId,
      owner_user_id: reminder.ownerUserId,
      subject_type: reminder.subjectType,
      subject_id: reminder.subjectId,
      contact_id: reminder.contactId,
      phone_e164: reminder.phone,
      customer_name: reminder.customerName,
      kind: reminder.kind,
      starts_at: reminder.startsAt,
      ends_at: reminder.endsAt,
      status: 'claimed',
    })
    .select('id')
    .single<{ id: string }>()
  if (error?.code === '23505') return { ok: false, reason: 'taken' }
  if (error || !data) throw new Error(`customer_reminder claim failed: ${error?.message ?? 'no row'}`)
  return { ok: true, id: data.id }
}

/** Stamp a claimed reminder sent (or failed). Throws on a failed write. */
export async function markReminderSent(supabase: SupabaseClient, workspaceId: string, id: string, sent: boolean, nowIso: string): Promise<void> {
  const { error } = await supabase
    .from('customer_reminder')
    .update(sent ? { status: 'sent', sent_at: nowIso, updated_at: nowIso } : { status: 'failed', updated_at: nowIso })
    .eq('workspace_id', workspaceId)
    .eq('id', id)
  if (error) throw new Error(`customer_reminder update failed: ${error.message}`)
}

/**
 * Whether the business sent a reminder for any day before `beforeIso` (its
 * first day's report says what reminders are; a retry of that day still
 * reads as the first). Throws on a failed read.
 */
export async function sentRemindersBefore(supabase: SupabaseClient, workspaceId: string, beforeIso: string): Promise<boolean> {
  const { count, error } = await supabase
    .from('customer_reminder')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .eq('status', 'sent')
    .lt('starts_at', beforeIso)
  if (error) throw new Error(`customer_reminder count failed: ${error.message}`)
  return (count ?? 0) > 0
}

/**
 * The reminders sent for jobs and meetings in [fromIso, toIso), soonest
 * first: the owner's report reads them from the table, so a run cut short
 * after its texts (and its retry, which sends nothing) still reports them.
 * Throws on a failed read.
 */
export async function sentRemindersBetween(supabase: SupabaseClient, workspaceId: string, fromIso: string, toIso: string): Promise<CustomerReminder[]> {
  const { data, error } = await supabase
    .from('customer_reminder')
    .select(REMINDER_SELECT)
    .eq('workspace_id', workspaceId)
    .eq('status', 'sent')
    .gte('starts_at', fromIso)
    .lt('starts_at', toIso)
    .order('starts_at', { ascending: true })
    .limit(200)
  if (error) throw new Error(`customer_reminder read failed: ${error.message}`)
  return ((data ?? []) as ReminderRow[]).map(toReminder)
}

/** One reminder of the workspace's, or null. Throws on a failed read. */
export async function getReminder(supabase: SupabaseClient, workspaceId: string, id: string): Promise<CustomerReminder | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  const { data, error } = await supabase.from('customer_reminder').select(REMINDER_SELECT).eq('workspace_id', workspaceId).eq('id', id).maybeSingle<ReminderRow>()
  if (error) throw new Error(`customer_reminder read failed: ${error.message}`)
  return data ? toReminder(data) : null
}

/**
 * The reminders texted to this number lately (claimed inside the answer
 * window) whose job or meeting is still ahead, soonest first: what the
 * customer's agent can act on, and what a STOP opts out of. A reminder
 * still `claimed` counts: a run cut short between the text and its stamp
 * may well have sent it, and the customer's yes must still land. Throws on
 * a failed read.
 */
export async function openRemindersForPhone(supabase: SupabaseClient, workspaceId: string, phone: string, now: number = Date.now()): Promise<CustomerReminder[]> {
  const { data, error } = await supabase
    .from('customer_reminder')
    .select(REMINDER_SELECT)
    .eq('workspace_id', workspaceId)
    .eq('phone_e164', phone)
    .in('status', ['sent', 'claimed'])
    .gte('created_at', new Date(now - REMINDER_ANSWER_WINDOW_MS).toISOString())
    .order('starts_at', { ascending: true })
    .limit(10)
  if (error) throw new Error(`customer_reminder read failed: ${error.message}`)
  return ((data ?? []) as ReminderRow[]).map(toReminder).filter((r) => Date.parse(reminderAt(r)) > now)
}

/**
 * Record the customer's answer, fenced on the answers it may replace (a
 * retried call, or two texts at once, records it once). The reminder as it
 * now is, or null when it wasn't in one of `from`. Throws on a failed write.
 */
export async function answerReminder(
  supabase: SupabaseClient,
  args: { workspaceId: string; id: string; answer: ReminderAnswer; from: ReadonlyArray<ReminderAnswer | null>; movedTo?: string; nowIso: string },
): Promise<CustomerReminder | null> {
  const patch: Record<string, unknown> = { answer: args.answer, answered_at: args.nowIso, updated_at: args.nowIso }
  if (args.movedTo !== undefined) patch.moved_to = args.movedTo
  let query = supabase.from('customer_reminder').update(patch).eq('workspace_id', args.workspaceId).eq('id', args.id)
  const answers = args.from.filter((a): a is ReminderAnswer => a !== null)
  const ors = [...(args.from.includes(null) ? ['answer.is.null'] : []), ...answers.map((a) => `answer.eq.${a}`)]
  if (!ors.length) return null
  query = query.or(ors.join(','))
  const { data, error } = await query.select(REMINDER_SELECT).maybeSingle<ReminderRow>()
  if (error) throw new Error(`customer_reminder update failed: ${error.message}`)
  return data ? toReminder(data) : null
}

/**
 * The owner moved a booking (./booking-changes.ts): its reminders follow it
 * to the new time, and an answer about the old time (confirmed, moved) is
 * cleared, so the customer's agent asks again. A STOP stays. Throws on a
 * failed write.
 */
export async function remindersFollowBooking(supabase: SupabaseClient, args: { workspaceId: string; bookingId: string; startsAt: string; nowIso: string }): Promise<void> {
  const moved = await supabase
    .from('customer_reminder')
    .update({ moved_to: args.startsAt, updated_at: args.nowIso })
    .eq('workspace_id', args.workspaceId)
    .eq('subject_type', 'booking')
    .eq('subject_id', args.bookingId)
  if (moved.error) throw new Error(`customer_reminder update failed: ${moved.error.message}`)
  const cleared = await supabase
    .from('customer_reminder')
    .update({ answer: null, answered_at: null, updated_at: args.nowIso })
    .eq('workspace_id', args.workspaceId)
    .eq('subject_type', 'booking')
    .eq('subject_id', args.bookingId)
    .in('answer', ['confirmed', 'moved'])
  if (cleared.error) throw new Error(`customer_reminder update failed: ${cleared.error.message}`)
}

/**
 * The owner cancelled a booking (./booking-changes.ts): its reminders are
 * answered `cancelled`, whatever the customer said, so their agent knows and
 * a later STOP doesn't tell the owner it still stands. Throws on a failed
 * write.
 */
export async function remindersCancelled(supabase: SupabaseClient, args: { workspaceId: string; bookingId: string; nowIso: string }): Promise<void> {
  const { error } = await supabase
    .from('customer_reminder')
    .update({ answer: 'cancelled', answered_at: args.nowIso, updated_at: args.nowIso })
    .eq('workspace_id', args.workspaceId)
    .eq('subject_type', 'booking')
    .eq('subject_id', args.bookingId)
  if (error) throw new Error(`customer_reminder update failed: ${error.message}`)
}
