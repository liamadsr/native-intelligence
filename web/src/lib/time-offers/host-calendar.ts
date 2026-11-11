/**
 * Which of the host's calendars a booked meeting is written to: an enabled
 * Google or Outlook calendar account of theirs in the workspace (the
 * desktop's Exchange rows can't take a provider event), their primary one
 * first, then Google, then the oldest. The booking keeps the account it
 * chose, so a retry writes to the same one with the same idempotency key.
 *
 * Server only. Throws on a failed read.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

interface AccountRow {
  id: string
  provider: string
  is_primary: boolean | null
  created_at: string | null
  account_email?: string | null
  display_name?: string | null
}

/** A calendar a new event can be written to: a connected account's own (primary) calendar. */
export interface WritableCalendar {
  id: string
  provider: 'google' | 'microsoft'
  /** What a picker shows: the account's address (or name). */
  label: string
}

/**
 * Every calendar a new event of the person's can be written to in this
 * workspace, the default first (primary, then Google, then the oldest).
 * Read-only calendars are never among them: an event is written to an
 * account's own calendar. Throws on a failed read.
 */
export async function writableCalendarAccounts(supabase: SupabaseClient, userId: string, workspaceId: string): Promise<WritableCalendar[]> {
  const { data: junction, error: junctionError } = await supabase.from('connected_account_workspace').select('account_id').eq('workspace_id', workspaceId)
  if (junctionError) throw new Error(`Calendar accounts could not be read: ${junctionError.message}`)
  const ids = ((junction as Array<{ account_id: string }> | null) ?? []).map((r) => r.account_id)
  if (!ids.length) return []
  const { data, error } = await supabase
    .from('connected_account')
    .select('id, provider, is_primary, created_at, account_email, display_name')
    .eq('user_id', userId)
    .eq('capability', 'calendar')
    .eq('is_enabled', true)
    .in('id', ids)
  if (error) throw new Error(`Calendar accounts could not be read: ${error.message}`)
  const rows = ((data as AccountRow[] | null) ?? []).filter((r) => r.provider === 'google' || r.provider === 'microsoft')
  rows.sort((a, b) => Number(b.is_primary === true) - Number(a.is_primary === true) || Number(b.provider === 'google') - Number(a.provider === 'google') || String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider as 'google' | 'microsoft',
    label: r.account_email || r.display_name || (r.provider === 'google' ? 'Google Calendar' : 'Outlook Calendar'),
  }))
}

export async function bookingCalendarAccount(supabase: SupabaseClient, userId: string, workspaceId: string): Promise<{ id: string; provider: 'google' | 'microsoft' } | null> {
  const first = (await writableCalendarAccounts(supabase, userId, workspaceId))[0]
  return first ? { id: first.id, provider: first.provider } : null
}
