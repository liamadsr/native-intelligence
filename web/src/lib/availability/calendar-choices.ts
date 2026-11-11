/**
 * Which of a person's calendars count as busy, for Settings > Availability:
 * the same accounts and calendars GET /api/calendar/calendars lists, scoped
 * to the workspace as the busy read is (./busy.ts countedCalendarIds), each
 * calendar with whether it counts now (the person's choice, else the
 * default: the primary and the ones they own) and what the default is.
 *
 * Unlike the busy read this never throws for one account: an account that
 * can't be listed comes back with its error, so the page can say which one
 * needs signing in again while the others stay editable.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getValidTokenForAccount } from '@/lib/oauth/token-manager'
import { listGoogleCalendars, listMicrosoftCalendars } from '@/lib/integrations/calendar'
import { countsByDefault } from './busy'

export interface CalendarChoice {
  id: string
  name: string
  color: string | null
  primary: boolean
  /** Whether its events make the person busy now. */
  counts: boolean
  /** What it would be with no choice saved. */
  countsByDefault: boolean
}

export interface CalendarAccountChoices {
  id: string
  provider: string
  accountEmail: string | null
  /** Why its calendars could not be listed; then `calendars` is empty. */
  error: string | null
  calendars: CalendarChoice[]
}

export interface CalendarChoicesDeps {
  token?: typeof getValidTokenForAccount
  googleCalendars?: typeof listGoogleCalendars
  microsoftCalendars?: typeof listMicrosoftCalendars
}

interface AccountRow {
  id: string
  provider: string
  account_email: string | null
}

/** The person's calendar accounts in the workspace, each with its calendars and whether each counts. Throws only on a failed database read. */
export async function listCalendarChoices(supabase: SupabaseClient, userId: string, workspaceId: string, deps: CalendarChoicesDeps = {}): Promise<CalendarAccountChoices[]> {
  const [accounts, junction, prefs] = await Promise.all([
    supabase.from('connected_account').select('id, provider, account_email').eq('user_id', userId).eq('capability', 'calendar').eq('is_enabled', true).order('created_at', { ascending: true }),
    supabase.from('connected_account_workspace').select('account_id').eq('workspace_id', workspaceId),
    supabase.from('calendar_sub_preference').select('account_id, provider_calendar_id, counts_as_busy').eq('user_id', userId).not('counts_as_busy', 'is', null),
  ])
  if (accounts.error) throw new Error(`Calendar accounts could not be read: ${accounts.error.message}`)
  if (junction.error) throw new Error(`Calendar accounts could not be read: ${junction.error.message}`)
  if (prefs.error) throw new Error(`Calendar choices could not be read: ${prefs.error.message}`)
  const inWorkspace = new Set(((junction.data as Array<{ account_id: string }> | null) ?? []).map((r) => r.account_id))
  const choices = new Map<string, boolean>()
  for (const row of (prefs.data as Array<{ account_id: string; provider_calendar_id: string; counts_as_busy: boolean }> | null) ?? []) {
    // An account id is a uuid: no colon in it.
    choices.set(`${row.account_id}:${row.provider_calendar_id}`, row.counts_as_busy)
  }

  const rows = ((accounts.data as AccountRow[] | null) ?? []).filter((a) => inWorkspace.has(a.id))
  return Promise.all(
    rows.map(async (account): Promise<CalendarAccountChoices> => {
      const base = { id: account.id, provider: account.provider, accountEmail: account.account_email }
      try {
        const token = await (deps.token ?? getValidTokenForAccount)(account.id)
        if (!token) return { ...base, error: 'Needs signing in again', calendars: [] }
        const calendars = account.provider === 'google' ? await (deps.googleCalendars ?? listGoogleCalendars)(token.token) : await (deps.microsoftCalendars ?? listMicrosoftCalendars)(token.token)
        return {
          ...base,
          error: null,
          calendars: calendars.map((calendar) => {
            const byDefault = countsByDefault(calendar, account)
            return {
              id: calendar.id,
              name: calendar.summary || calendar.id,
              color: calendar.backgroundColor ?? null,
              primary: calendar.primary === true,
              counts: choices.get(`${account.id}:${calendar.id}`) ?? byDefault,
              countsByDefault: byDefault,
            }
          }),
        }
      } catch {
        return { ...base, error: "Its calendars couldn't be listed", calendars: [] }
      }
    }),
  )
}

/** Save whether one of the person's calendars counts as busy. Throws when the account isn't theirs, or on a failed write. */
export async function saveCalendarChoice(supabase: SupabaseClient, userId: string, choice: { accountId: string; calendarId: string; counts: boolean }): Promise<void> {
  const { data: account, error } = await supabase.from('connected_account').select('id').eq('id', choice.accountId).eq('user_id', userId).eq('capability', 'calendar').maybeSingle()
  if (error) throw new Error(`Calendar account could not be read: ${error.message}`)
  if (!account) throw new Error('Unknown calendar account')
  const { error: writeError } = await supabase
    .from('calendar_sub_preference')
    .upsert({ user_id: userId, account_id: choice.accountId, provider_calendar_id: choice.calendarId, counts_as_busy: choice.counts }, { onConflict: 'user_id,account_id,provider_calendar_id' })
  if (writeError) throw new Error(`Calendar choice could not be saved: ${writeError.message}`)
}
