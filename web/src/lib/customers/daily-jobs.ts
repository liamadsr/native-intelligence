/**
 * The owner's day by text (roadmap F3: "a daily list of jobs with
 * addresses"), for any business with bookings, on today's schema.
 *
 *   1. Hourly (src/lib/inngest/daily-jobs.ts), every business with a profile
 *      whose own zone (its profile's, else its owner's) reads 7 o'clock gets
 *      ONE request for that local date. The Inngest event id
 *      `daily-jobs:<workspace>:<YYYY-MM-DD>` dedupes it: a retried pass, or
 *      a second pass the same hour, sends nothing twice.
 *   2. The request lists that local day's CONFIRMED bookings (a request still
 *      waiting on the owner's yes is not a job yet). None: nothing at all,
 *      no text, no message (nothing to show, nothing sent). A workspace whose
 *      agent is paused is skipped, as the rolling campaign pass skips it, and
 *      so is one whose profile's owner is no longer its owner or an admin
 *      (their customers' names and addresses go to them).
 *   3. Otherwise the profile's owner gets one text (textPerson, from the
 *      workspace's business number when it has one) and the same words in
 *      their home thread: per job its time, the customer's name, address and
 *      phone, and what it is (items, sizes, price, from its quote).
 *
 * Every word but the customer's name, address and phone and the quote's own
 * summary is Native Intelligence's; those are clipped to one short line each.
 *
 * Server only; service role.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { appendHomeMessage } from '@/lib/chat/home-message-writer'
import { textPerson } from '@/lib/chat/text-turn-server'
import { readMemberTimeZone, isStorableTimeZone } from '@/lib/agent-events/member-time-zone'
import { formatE164ForDisplay } from '@/lib/sms/phone-format'
import { fetchAllRows } from '@/lib/supabase/paging'
import { isAgentPaused } from '@/lib/work/agent-paused'
import { cleanText } from './intake'
import { localDate, zonedTime } from './slots'
import { businessName, getBusinessProfile, listBookings, QUOTE_SELECT, toQuote } from './store'
import { quoteSummary, type CustomerBooking, type CustomerQuote } from './types'

/** The local hour the list goes out. */
export const DAILY_JOBS_LOCAL_HOUR = 7
/** The event one business's list is requested with. */
export const DAILY_JOBS_EVENT = 'customers/daily-jobs.requested' as const
/** The most jobs one text lists; past it, a count of the rest. */
export const DAILY_JOBS_MAX = 40
/** A job's "what" (its quote's summary) at most this long. */
export const DAILY_JOB_WHAT_MAX = 80

export interface DailyJobsBusiness {
  workspaceId: string
  ownerUserId: string
  timeZone: string
}

export interface DailyJobsRequest {
  id: string
  name: typeof DAILY_JOBS_EVENT
  data: { workspaceId: string; localDate: string }
}

/** The event id that makes one business's list once per local date. Pure. */
export function dailyJobsEventId(workspaceId: string, localDateKey: string): string {
  return `daily-jobs:${workspaceId}:${localDateKey}`
}

const pad = (n: number) => String(n).padStart(2, '0')

/** The local date (YYYY-MM-DD) and hour of `now` in `timeZone`, or null for a zone Intl doesn't know. Pure. */
export function localClock(now: number, timeZone: string): { date: string; hour: number } | null {
  try {
    const day = localDate(now, timeZone)
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit' }).format(new Date(now)))
    return { date: `${day.y}-${pad(day.m)}-${pad(day.d)}`, hour }
  } catch {
    return null
  }
}

/** One request per business whose zone reads DAILY_JOBS_LOCAL_HOUR at `now`. Pure. */
export function planDailyJobs(businesses: readonly DailyJobsBusiness[], now: number): DailyJobsRequest[] {
  const out: DailyJobsRequest[] = []
  for (const b of businesses) {
    const clock = localClock(now, b.timeZone)
    if (!clock || clock.hour !== DAILY_JOBS_LOCAL_HOUR) continue
    out.push({ id: dailyJobsEventId(b.workspaceId, clock.date), name: DAILY_JOBS_EVENT, data: { workspaceId: b.workspaceId, localDate: clock.date } })
  }
  return out
}

/** Every business with a profile, and its zone (its profile's, else its owner's). Throws on a failed read of the profiles. */
export async function findDailyJobsBusinesses(supabase: SupabaseClient): Promise<DailyJobsBusiness[]> {
  const { data, error } = await fetchAllRows<{ workspace_id: string; owner_user_id: string; time_zone: string | null }>(
    () => supabase.from('business_profile').select('workspace_id, owner_user_id, time_zone'),
    { orderBy: 'workspace_id' },
  )
  if (error) throw new Error(`business_profile read failed: ${error.message}`)
  const out: DailyJobsBusiness[] = []
  for (const row of data) {
    const timeZone = isStorableTimeZone(row.time_zone)
      ? row.time_zone
      : (await readMemberTimeZone(supabase, { workspaceId: row.workspace_id, userId: row.owner_user_id })).timeZone
    out.push({ workspaceId: row.workspace_id, ownerUserId: row.owner_user_id, timeZone })
  }
  return out
}

export interface DailyJob {
  booking: Pick<CustomerBooking, 'startsAt' | 'customerName' | 'address' | 'customerPhone' | 'kind'> & { customerConfirmedAt?: string | null }
  quote: Pick<CustomerQuote, 'items' | 'service' | 'totalCents' | 'currency'> | null
}

/** One job's line: time, name (and "confirmed" when they answered their reminder yes), address, phone, what. Pure. */
export function dailyJobLine(job: DailyJob, timeZone: string): string {
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(job.booking.startsAt))
  const summary = job.quote ? quoteSummary(job.quote) : null
  const what = summary && summary !== 'a quote request' ? cleanText(summary, DAILY_JOB_WHAT_MAX) : cleanText(job.booking.kind, 40)
  return [
    time,
    `${cleanText(job.booking.customerName, 40) ?? 'Customer'}${job.booking.customerConfirmedAt ? ' (confirmed)' : ''}`,
    cleanText(job.booking.address, 80),
    job.booking.customerPhone ? formatE164ForDisplay(job.booking.customerPhone) : null,
    what,
  ]
    .filter(Boolean)
    .join(' - ')
}

/** The whole text: the business, the day, how many, then a line per job. Pure. */
export function dailyJobsText(args: { business: string; dayLabel: string; timeZone: string; jobs: readonly DailyJob[] }): string {
  const shown = args.jobs.slice(0, DAILY_JOBS_MAX)
  const more = args.jobs.length - shown.length
  return [
    `${args.business}, today (${args.dayLabel}): ${args.jobs.length} booked`,
    ...shown.map((job) => dailyJobLine(job, args.timeZone)),
    ...(more > 0 ? [`…and ${more} more in Native Intelligence.`] : []),
  ].join('\n')
}

export type DailyJobsPlan =
  | { outcome: 'no_profile' | 'owner_gone' | 'paused' | 'empty' | 'bad_date' }
  | { outcome: 'ready'; userId: string; body: string; jobs: number }

/** Seams for the tests. */
export interface DailyJobsDeps {
  paused?: (workspaceId: string) => Promise<boolean>
  appendHome?: typeof appendHomeMessage
  text?: typeof textPerson
}

/**
 * What one business's list says today, or why it sends nothing (step 2 of
 * the header). Throws on a failed read (the step retries).
 */
export async function buildDailyJobs(
  supabase: SupabaseClient,
  args: { workspaceId: string; localDate: string },
  deps: DailyJobsDeps = {},
): Promise<DailyJobsPlan> {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(args.localDate)
  if (!m) return { outcome: 'bad_date' }
  const profile = await getBusinessProfile(supabase, args.workspaceId)
  if (!profile) return { outcome: 'no_profile' }
  // The list goes to the profile's owner only while they still run the workspace.
  const { data: member, error: memberError } = await supabase
    .from('member')
    .select('role')
    .eq('workspace_id', args.workspaceId)
    .eq('user_id', profile.ownerUserId)
    .maybeSingle<{ role: string | null }>()
  if (memberError) throw new Error(`member read failed: ${memberError.message}`)
  if (member?.role !== 'owner' && member?.role !== 'admin') return { outcome: 'owner_gone' }
  if (await (deps.paused ?? ((w) => isAgentPaused(supabase, w)))(args.workspaceId)) return { outcome: 'paused' }
  const timeZone = isStorableTimeZone(profile.timeZone)
    ? profile.timeZone
    : (await readMemberTimeZone(supabase, { workspaceId: args.workspaceId, userId: profile.ownerUserId })).timeZone
  const day = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
  const dayStart = zonedTime(day, '00:00', timeZone)
  const next = new Date(Date.UTC(day.y, day.m - 1, day.d + 1))
  const dayEnd = zonedTime({ y: next.getUTCFullYear(), m: next.getUTCMonth() + 1, d: next.getUTCDate() }, '00:00', timeZone)

  const bookings = (await listBookings(supabase, args.workspaceId, { fromIso: new Date(dayStart).toISOString(), state: 'confirmed', limit: 100 }))
    .filter((b) => Date.parse(b.startsAt) < dayEnd)
  if (!bookings.length) return { outcome: 'empty' }

  const quoteIds = [...new Set(bookings.map((b) => b.quoteId).filter((id): id is string => !!id))]
  const quotes = new Map<string, CustomerQuote>()
  if (quoteIds.length) {
    const { data, error } = await supabase.from('customer_quote').select(QUOTE_SELECT).eq('workspace_id', args.workspaceId).in('id', quoteIds)
    if (error) throw new Error(`customer_quote read failed: ${error.message}`)
    for (const row of (data ?? []) as Parameters<typeof toQuote>[0][]) quotes.set(row.id, toQuote(row))
  }
  const dayLabel = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(zonedTime(day, '12:00', timeZone)))
  const body = dailyJobsText({
    business: await businessName(supabase, args.workspaceId),
    dayLabel,
    timeZone,
    jobs: bookings.map((booking) => ({ booking, quote: booking.quoteId ? (quotes.get(booking.quoteId) ?? null) : null })),
  })
  return { outcome: 'ready', userId: profile.ownerUserId, body, jobs: bookings.length }
}

/** The owner's home thread gets the list (once per business and date: its message id). Never throws; whether it was written. */
export async function writeDailyJobsHome(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; localDate: string; body: string },
  deps: DailyJobsDeps = {},
): Promise<boolean> {
  const written = await (deps.appendHome ?? appendHomeMessage)(supabase, {
    userId: args.userId,
    workspaceId: args.workspaceId,
    parts: [{ type: 'text', text: args.body }],
    messageId: `daily-jobs-${args.workspaceId}-${args.localDate}`,
    metadata: { kind: 'daily_jobs', local_date: args.localDate },
  })
  return written.written
}

/** The owner's text, from the workspace's business number when it has one. Never throws; whether it went. */
export async function textDailyJobs(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; body: string },
  deps: DailyJobsDeps = {},
): Promise<boolean> {
  const sent = await (deps.text ?? textPerson)(supabase, { userId: args.userId, workspaceId: args.workspaceId, body: args.body, kind: 'notice' })
  return sent.sent
}
