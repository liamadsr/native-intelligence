import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { authenticateUser } from '@/lib/ai/auth'
import { missingScopes } from '@/lib/oauth/scope-diff'

export async function GET(req: Request) {
  try {
    const { user } = await authenticateUser(req)

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )

    // Fetch all connected accounts with their preferences
    const { data: accounts } = await supabase
      .from('connected_account')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })

    // Fetch email preferences
    const { data: emailPrefs } = await supabase
      .from('email_account_preference')
      .select('account_id, is_visible, notification_enabled')
      .eq('user_id', user.id)

    // Fetch calendar preferences
    const { data: calendarPrefs } = await supabase
      .from('calendar_account_preference')
      .select('account_id, is_visible, color_override')
      .eq('user_id', user.id)

    // Fetch sync state for email accounts
    const { data: syncStates } = await supabase
      .from('email_sync_state')
      .select('account_id, initial_import_status, last_sync_at, last_sync_error')
      .eq('user_id', user.id)

    // Fetch the granted scopes per account so the client can detect when a
    // connection predates a newly-required scope (e.g. Microsoft's Mail.Send,
    // HubSpot's crm.objects.contacts.write) and show the reconnect banner.
    // scopes is text[] of provider-GRANTED scopes (the callback parses the
    // token exchange's scope field; rows written before that fix hold the
    // requested set, which still diffs correctly for newly-added scopes).
    // Prefer the most recently updated token when an account has multiple rows.
    const { data: tokenScopes } = await supabase
      .from('user_oauth_tokens')
      .select('account_id, scopes, updated_at')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false })

    // Fetch workspace assignments from junction table
    const accountIds = (accounts || []).map((a) => a.id)
    const { data: workspaceAssignments } = accountIds.length > 0
      ? await supabase
          .from('connected_account_workspace')
          .select('account_id, workspace_id')
          .in('account_id', accountIds)
      : { data: [] }

    const workspaceMap = new Map<string, string[]>()
    for (const row of workspaceAssignments || []) {
      const list = workspaceMap.get(row.account_id) || []
      list.push(row.workspace_id)
      workspaceMap.set(row.account_id, list)
    }

    const emailPrefMap = new Map(
      (emailPrefs || []).map((p) => [p.account_id, p]),
    )
    const calendarPrefMap = new Map(
      (calendarPrefs || []).map((p) => [p.account_id, p]),
    )
    const syncStateMap = new Map(
      (syncStates || []).map((s) => [s.account_id, s]),
    )
    // Ordered updated_at DESC, so the FIRST row seen per account_id is the most
    // recent — set() only if not already present to keep it.
    const scopesMap = new Map<string, string[]>()
    for (const row of tokenScopes || []) {
      if (!row.account_id || scopesMap.has(row.account_id)) continue
      scopesMap.set(row.account_id, (row.scopes as string[] | null) ?? [])
    }

    const enrichedAccounts = (accounts || []).map((account) => {
      const pref =
        account.capability === 'email'
          ? emailPrefMap.get(account.id)
          : calendarPrefMap.get(account.id)
      const sync = syncStateMap.get(account.id)

      return {
        id: account.id,
        provider: account.provider,
        capability: account.capability,
        account_email: account.account_email,
        display_name: account.display_name,
        color: account.color,
        is_enabled: account.is_enabled,
        is_primary: account.is_primary,
        is_visible: pref?.is_visible ?? true,
        workspace_ids: workspaceMap.get(account.id) || [],
        scopes: scopesMap.get(account.id) ?? [],
        missing_scopes: missingScopes(
          account.provider,
          account.capability,
          scopesMap.get(account.id) ?? [],
        ),
        // When the provider first refused this connection's refresh token for
        // good (null = healthy). The select above is '*', so before migration
        // 348 adds the column the field is simply absent and this reads null.
        reauth_required_at: (account.reauth_required_at as string | null | undefined) ?? null,
        ...(account.capability === 'email' && {
          notification_enabled: (pref as { notification_enabled?: boolean })?.notification_enabled ?? true,
          sync_status: sync?.initial_import_status ?? null,
          last_sync_at: sync?.last_sync_at ?? null,
          last_sync_error: sync?.last_sync_error ?? null,
        }),
        ...(account.capability === 'calendar' && {
          color_override: (pref as { color_override?: string })?.color_override ?? null,
        }),
      }
    })

    // Also build the legacy per-provider status for backward compatibility
    const legacyStatus: Record<
      string,
      Record<string, { connected: boolean; email?: string }>
    > = {
      google: {
        calendar: { connected: false },
        email: { connected: false },
      },
      microsoft: {
        calendar: { connected: false },
        email: { connected: false },
      },
    }

    for (const account of accounts || []) {
      // Skip providers not in the legacy status map (e.g. github)
      if (legacyStatus[account.provider]) {
        legacyStatus[account.provider][account.capability] = {
          connected: true,
          email: account.account_email || undefined,
        }
      }
    }

    // Also check for legacy tokens without connected_account
    const { data: legacyTokens } = await supabase
      .from('user_oauth_tokens')
      .select('provider, capability, email')
      .eq('user_id', user.id)
      .is('account_id', null)

    for (const token of legacyTokens || []) {
      if (!legacyStatus[token.provider]) continue
      const cap = token.capability || 'both'
      if (cap === 'both') {
        legacyStatus[token.provider].calendar = {
          connected: true,
          email: token.email || undefined,
        }
        legacyStatus[token.provider].email = {
          connected: true,
          email: token.email || undefined,
        }
      } else {
        legacyStatus[token.provider][cap] = {
          connected: true,
          email: token.email || undefined,
        }
      }
    }

    return NextResponse.json({
      accounts: enrichedAccounts,
      // Legacy format for backward compatibility
      ...legacyStatus,
    })
  } catch (error) {
    if (error instanceof Response) return error
    return NextResponse.json(
      { error: 'Failed to get status' },
      { status: 500 },
    )
  }
}
