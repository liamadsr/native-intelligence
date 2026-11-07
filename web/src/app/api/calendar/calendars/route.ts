import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { authenticateUser } from '@/lib/ai/auth'
import { getValidTokenForAccount } from '@/lib/oauth/token-manager'
import { listGoogleCalendars, listMicrosoftCalendars } from '@/lib/integrations/calendar'

export async function GET(req: Request) {
  try {
    const { user } = await authenticateUser(req)

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )

    // If workspace scoping is requested, get account IDs from junction table
    const url = new URL(req.url)
    const workspaceId = url.searchParams.get('workspaceId')
    let workspaceScopedIds: string[] | null = null
    if (workspaceId) {
      const { data: junctionRows } = await supabase
        .from('connected_account_workspace')
        .select('account_id')
        .eq('workspace_id', workspaceId)
      workspaceScopedIds = (junctionRows || []).map((r: { account_id: string }) => r.account_id)
      console.log('[Calendars] workspace filtering:', workspaceId, 'scoped account IDs:', workspaceScopedIds)
      if (workspaceScopedIds.length === 0) {
        return NextResponse.json({ accounts: [] })
      }
    }

    // Get all enabled calendar accounts
    let accountQuery = supabase
      .from('connected_account')
      .select('id, provider, account_email, display_name, color, is_enabled')
      .eq('user_id', user.id)
      .eq('capability', 'calendar')
      .eq('is_enabled', true)
      .order('created_at', { ascending: true })

    if (workspaceScopedIds) {
      accountQuery = accountQuery.in('id', workspaceScopedIds)
    }

    const { data: accounts } = await accountQuery

    if (!accounts?.length) {
      return NextResponse.json({ accounts: [] })
    }

    // Get account-level preferences
    const { data: accountPrefs } = await supabase
      .from('calendar_account_preference')
      .select('account_id, is_visible, color_override')
      .eq('user_id', user.id)

    // Get sub-calendar preferences
    const { data: subPrefs } = await supabase
      .from('calendar_sub_preference')
      .select('account_id, provider_calendar_id, calendar_name, calendar_color, is_visible')
      .eq('user_id', user.id)

    const accountPrefMap = new Map(
      (accountPrefs || []).map(p => [p.account_id, p]),
    )
    const subPrefMap = new Map<string, typeof subPrefs>()
    for (const pref of subPrefs || []) {
      const list = subPrefMap.get(pref.account_id) || []
      list.push(pref)
      subPrefMap.set(pref.account_id, list)
    }

    // Fetch sub-calendars from each account in parallel
    const enrichedAccounts = await Promise.all(
      accounts.map(async (account) => {
        const pref = accountPrefMap.get(account.id)
        const existingSubPrefs = subPrefMap.get(account.id) || []

        let subCalendars: Array<{
          id: string
          name: string
          color?: string
          primary: boolean
          is_visible: boolean
        }> = []

        try {
          const tokenResult = await getValidTokenForAccount(account.id)
          if (tokenResult) {
            const providerCalendars = account.provider === 'google'
              ? await listGoogleCalendars(tokenResult.token)
              : await listMicrosoftCalendars(tokenResult.token)

            subCalendars = providerCalendars.map(cal => {
              const subPref = existingSubPrefs.find(
                p => p.provider_calendar_id === cal.id,
              )
              return {
                id: cal.id,
                name: cal.summary,
                color: subPref?.calendar_color || cal.backgroundColor,
                primary: cal.primary || false,
                is_visible: subPref?.is_visible ?? true,
              }
            })
          }
        } catch (err) {
          console.error(`Failed to fetch calendars for account ${account.id}:`, err)
        }

        return {
          id: account.id,
          provider: account.provider,
          account_email: account.account_email,
          display_name: account.display_name,
          color: pref?.color_override || account.color,
          is_visible: pref?.is_visible ?? true,
          calendars: subCalendars,
        }
      }),
    )

    return NextResponse.json({ accounts: enrichedAccounts })
  } catch (error) {
    if (error instanceof Response) return error
    console.error('Calendar list error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch calendars' },
      { status: 500 },
    )
  }
}
