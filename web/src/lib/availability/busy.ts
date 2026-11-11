/**
 * A person's busy time for the availability engine (./engine.ts): every
 * calendar of theirs that counts, read strictly.
 *
 * Which calendars count: on each connected account, the primary calendar and
 * every other calendar the person owns (a second "Personal" calendar is real
 * busy time), never one they only follow (a coworker's, holidays, birthdays:
 * someone else's day doesn't make them busy). The person's own choice wins
 * either way (calendar_sub_preference.counts_as_busy, migration 550). The
 * desktop's Exchange rows always count.
 *
 * Strict: an account that needs signing in again, a calendar list or an
 * events read that fails, throws. A time is never free because a calendar
 * couldn't be read.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import { getValidTokenForAccount } from '@/lib/oauth/token-manager'
import { listCalendarEventsUnified, listGoogleCalendars, listMicrosoftCalendars, type CalendarEvent, type SubCalendar } from '@/lib/integrations/calendar'

interface CalendarAccount {
  id: string
  provider: string
  account_email: string | null
}

/** Whether a calendar counts as busy with no choice saved: the primary, or one the person owns. Pure. */
export function countsByDefault(calendar: SubCalendar, account: Pick<CalendarAccount, 'provider' | 'account_email'>): boolean {
  if (calendar.primary) return true
  if (account.provider === 'google') return calendar.accessRole === 'owner'
  // Outlook: the person's own mailbox's calendars, not ones shared with them.
  const owner = calendar.ownerEmail?.trim().toLowerCase()
  return !!owner && owner === account.account_email?.trim().toLowerCase()
}

/** The calendars that count out of an account's list, the saved choices applied. Pure. */
export function countedOf(calendars: readonly SubCalendar[], account: Pick<CalendarAccount, 'provider' | 'account_email'>, choices: ReadonlyMap<string, boolean>): string[] {
  return calendars.filter((calendar) => choices.get(calendar.id) ?? countsByDefault(calendar, account)).map((calendar) => calendar.id)
}

export interface CountedCalendarsDeps {
  supabase?: SupabaseClient
  token?: typeof getValidTokenForAccount
  googleCalendars?: typeof listGoogleCalendars
  microsoftCalendars?: typeof listMicrosoftCalendars
}

/**
 * The calendars that count as busy, per connected calendar account of the
 * person's in the workspace: { accountId: [calendarId, ...] }. An account
 * with none is there with an empty list (it is left out of the read). Throws
 * when an account can't be read.
 */
export async function countedCalendarIds(userId: string, workspaceId: string | undefined, deps: CountedCalendarsDeps = {}): Promise<Record<string, string[]>> {
  const supabase = deps.supabase ?? getServiceClient()
  let accountQuery = supabase.from('connected_account').select('id, provider, account_email').eq('user_id', userId).eq('capability', 'calendar').eq('is_enabled', true)
  if (workspaceId) {
    const { data: junction, error } = await supabase.from('connected_account_workspace').select('account_id').eq('workspace_id', workspaceId)
    if (error) throw new Error(`Calendar accounts could not be read: ${error.message}`)
    accountQuery = accountQuery.in('id', ((junction as Array<{ account_id: string }> | null) ?? []).map((r) => r.account_id))
  }
  const [accounts, prefs] = await Promise.all([
    accountQuery,
    supabase.from('calendar_sub_preference').select('account_id, provider_calendar_id, counts_as_busy').eq('user_id', userId).not('counts_as_busy', 'is', null),
  ])
  if (accounts.error) throw new Error(`Calendar accounts could not be read: ${accounts.error.message}`)
  if (prefs.error) throw new Error(`Calendar choices could not be read: ${prefs.error.message}`)

  const choices = new Map<string, Map<string, boolean>>()
  for (const row of (prefs.data as Array<{ account_id: string; provider_calendar_id: string; counts_as_busy: boolean }> | null) ?? []) {
    const perAccount = choices.get(row.account_id) ?? new Map<string, boolean>()
    perAccount.set(row.provider_calendar_id, row.counts_as_busy)
    choices.set(row.account_id, perAccount)
  }

  const out: Record<string, string[]> = {}
  await Promise.all(
    ((accounts.data as CalendarAccount[] | null) ?? []).map(async (account) => {
      const token = await (deps.token ?? getValidTokenForAccount)(account.id)
      if (!token) throw new Error('A calendar account needs signing in again')
      const calendars = account.provider === 'google' ? await (deps.googleCalendars ?? listGoogleCalendars)(token.token) : await (deps.microsoftCalendars ?? listMicrosoftCalendars)(token.token)
      out[account.id] = countedOf(calendars, account, choices.get(account.id) ?? new Map())
    }),
  )
  return out
}

/**
 * Whether the person has a calendar the read would see: an enabled calendar
 * account of theirs in the workspace (the same scoping countedCalendarIds
 * reads), or the desktop's Exchange rows. Without one the read finds no
 * events, which is not the same as free. Throws on a failed read.
 */
export async function hasCountedCalendar(userId: string, workspaceId: string | undefined, deps: { supabase?: SupabaseClient } = {}): Promise<boolean> {
  const supabase = deps.supabase ?? getServiceClient()
  const [accounts, local] = await Promise.all([
    supabase.from('connected_account').select('id').eq('user_id', userId).eq('capability', 'calendar').eq('is_enabled', true),
    supabase.from('local_calendar_event').select('id', { count: 'exact', head: true }).eq('user_id', userId).limit(1),
  ])
  if (accounts.error) throw new Error(`Calendar accounts could not be read: ${accounts.error.message}`)
  if (local.error) throw new Error(`Exchange calendar could not be read: ${local.error.message}`)
  if ((local.count ?? 0) > 0) return true
  const ids = ((accounts.data as Array<{ id: string }> | null) ?? []).map((r) => r.id)
  if (!ids.length) return false
  if (!workspaceId) return true
  const junction = await supabase.from('connected_account_workspace').select('account_id').eq('workspace_id', workspaceId).in('account_id', ids).limit(1)
  if (junction.error) throw new Error(`Calendar accounts could not be read: ${junction.error.message}`)
  return ((junction.data as unknown[] | null) ?? []).length > 0
}

export interface CountedEventsOptions {
  timeMin: string
  timeMax: string
  maxResults?: number
  workspaceId?: string
  /** Always read strictly; accepted so a caller of listCalendarEventsUnified can pass its options as they are. */
  strict?: boolean
}

export interface CountedEventsDeps extends CountedCalendarsDeps {
  listEvents?: typeof listCalendarEventsUnified
}

/**
 * The person's events on every calendar that counts as busy, read strictly
 * (see the header). The same call shape as listCalendarEventsUnified.
 */
export async function listCountedEvents(userId: string, options: CountedEventsOptions, deps: CountedEventsDeps = {}): Promise<CalendarEvent[]> {
  const calendarIds = await countedCalendarIds(userId, options.workspaceId, deps)
  return (deps.listEvents ?? listCalendarEventsUnified)(userId, { timeMin: options.timeMin, timeMax: options.timeMax, maxResults: options.maxResults, workspaceId: options.workspaceId, calendarIds, strict: true })
}
