/**
 * The server half of a calendar card (docs/plans/one-agent-and-chat-pages.md,
 * P2): `show` checks the accounts and counts the range once, `read_card`
 * lists the events in the range the card shows now.
 *
 * Visibility is exactly get_calendar_events': the person's OWN calendars,
 * through listCalendarEventsUnified with the workspace (their accounts linked
 * to this workspace, plus their own local Exchange events). An account filter
 * names only accounts the person owns and has linked here; a refusal lists
 * those, never anyone else's.
 *
 * The range is local dates, turned into instants in the zone the card is
 * drawn in: the browser's own IANA zone, sent with the turn (and with a
 * moved calendar card), checked; else the person's profile zone; only then
 * UTC. The card draws local midnights, so anything else would count a
 * different range than the person sees.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { listCalendarEventsUnified, type CalendarEvent } from '@/lib/integrations/calendar'
import { zonedTimeToUtc } from '@/lib/flows/schedule'
import { addDays, isTimeZone } from './calendar'
import type { CalendarCardSpec, CalendarQuery } from './kinds'
import type { Checked } from './validate'

export interface CalendarScope {
  supabase: SupabaseClient
  workspaceId: string
  userId: string
  /** The browser's IANA zone this turn (checked by the caller), if it sent one. */
  timeZone?: string | null
}

/** The most events a calendar fetch asks each provider for: a busy month. */
const CALENDAR_FETCH_MAX = 250

/** One event in short form, as show and read_card hand it to the model. */
export interface CalendarItem {
  id: string
  title: string
  start: string
  end: string
  all_day?: boolean
  account?: string
}

export interface CalendarAccount {
  id: string
  account_email: string | null
}

/** The person's own enabled calendar accounts that get_calendar_events reads in this workspace. */
export async function calendarAccountsHere(scope: CalendarScope): Promise<CalendarAccount[]> {
  const [{ data: accounts, error }, { data: links, error: linksError }] = await Promise.all([
    scope.supabase
      .from('connected_account')
      .select('id, account_email')
      .eq('user_id', scope.userId)
      .eq('capability', 'calendar')
      .eq('is_enabled', true),
    scope.supabase.from('connected_account_workspace').select('account_id').eq('workspace_id', scope.workspaceId),
  ])
  if (error || linksError) throw new Error(`could not read calendar accounts: ${(error ?? linksError)!.message}`)
  const linked = new Set(((links ?? []) as Array<{ account_id: string }>).map((l) => l.account_id))
  return ((accounts ?? []) as CalendarAccount[]).filter((a) => linked.has(a.id))
}

/**
 * The card's accounts (emails or ids) as the person's own account ids, or the
 * one thing to fix. Undefined in, undefined out: every account.
 */
export async function resolveCalendarAccounts(scope: CalendarScope, wanted: string[] | undefined): Promise<Checked<string[] | undefined>> {
  if (!wanted?.length) return { ok: true, value: undefined }
  const accounts = await calendarAccountsHere(scope)
  const ids: string[] = []
  for (const w of wanted) {
    const hit = accounts.find((a) => a.id.toLowerCase() === w.toLowerCase() || a.account_email?.toLowerCase() === w.toLowerCase())
    if (!hit) {
      const known = accounts.map((a) => a.account_email).filter(Boolean)
      return {
        ok: false,
        error: known.length
          ? `calendar.accounts: '${w}' is not one of your calendars here. Use one of: ${known.join(', ')}, or leave accounts out for all`
          : `calendar.accounts: you have no calendar account linked to this workspace to filter by. Leave accounts out`,
      }
    }
    if (!ids.includes(hit.id)) ids.push(hit.id)
  }
  return { ok: true, value: ids }
}

/**
 * The zone a card's dates are in: the one given, else the browser's (sent on
 * every chat turn, the zone the chat's clock reads in too), else null (UTC).
 * There is no stored zone to fall back on: the legacy `user_profiles` table
 * this once read has no `preferences` column, so that read always failed.
 */
function zoneFor(scope: CalendarScope, given: string | null | undefined): string | null {
  if (isTimeZone(given)) return given
  if (isTimeZone(scope.timeZone)) return scope.timeZone
  return null
}

/** A local date's midnight in `tz` as an ISO instant. */
function midnight(date: string, tz: string | null): string {
  const [y, m, d] = date.split('-').map(Number)
  return (tz ? zonedTimeToUtc(y, m, d, 0, 0, tz) : new Date(Date.UTC(y, m - 1, d))).toISOString()
}

function item(e: CalendarEvent): CalendarItem {
  return {
    id: e.id,
    title: e.title || '(no title)',
    start: e.start,
    end: e.end,
    ...(e.isAllDay ? { all_day: true } : {}),
    ...(e.accountEmail ? { account: e.accountEmail } : {}),
  }
}

/**
 * The events a calendar card's range holds, as the page would list them for
 * the same accounts: the person's own, in start order. `accountIds` are
 * already resolved (resolveCalendarAccounts).
 */
export async function listCalendarRange(
  scope: CalendarScope,
  query: CalendarQuery,
  accountIds: string[] | undefined,
  timeZone?: string | null,
): Promise<CalendarItem[]> {
  const tz = zoneFor(scope, timeZone)
  const events = await listCalendarEventsUnified(scope.userId, {
    timeMin: midnight(query.from, tz),
    timeMax: midnight(addDays(query.to, 1), tz),
    maxResults: CALENDAR_FETCH_MAX,
    workspaceId: scope.workspaceId,
    ...(accountIds?.length ? { accountIds } : {}),
  })
  return events.map(item)
}

/** `show` for a calendar card: the accounts checked, the range counted once. */
export async function showCalendar(
  scope: CalendarScope,
  spec: CalendarCardSpec,
  preview: number,
): Promise<Checked<{ card: CalendarCardSpec; count: number; items: CalendarItem[] }>> {
  const accounts = await resolveCalendarAccounts(scope, spec.calendar.accounts)
  if (!accounts.ok) return accounts
  // The card holds the account ids, so it filters the page however they were named.
  const card: CalendarCardSpec = {
    ...spec,
    calendar: { from: spec.calendar.from, to: spec.calendar.to, view: spec.calendar.view, ...(accounts.value ? { accounts: accounts.value } : {}) },
  }
  const events = await listCalendarRange(scope, card.calendar, accounts.value)
  return { ok: true, value: { card, count: events.length, items: events.slice(0, preview) } }
}
