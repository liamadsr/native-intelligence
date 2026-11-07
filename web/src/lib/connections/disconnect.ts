/**
 * Disconnecting a connection (flows-connectors F2 §2.1), one way for every
 * door: the OAuth disconnect route, and the disconnect tool's card once the
 * person accepts it.
 *
 *   An integration (connected_account): the provider-side teardown first,
 *   while the rows and the token still exist (Asana and Jira webhooks, a
 *   Linear token revoke; each best effort and dispatched on the STORED row,
 *   never on a caller's provider), then the account row (its tokens and
 *   preferences cascade), then, when it was primary, the next account of
 *   that capability is promoted.
 *   An app (connected_mcp_server): the row. Its OAuth tokens go with it.
 *
 * And the loops that needed it (dependents.ts) are switched off, never left
 * to fail: only when nothing else the person has still provides what they
 * need (a second calendar keeps a calendar loop on), and only the person's
 * own loops, in every workspace.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { tearDownAsanaWebhooksForAccount } from '@/lib/tasks/asana-webhook'
import { tearDownJiraWebhooksForAccount } from '@/lib/tasks/jira-webhook'
import { revokeLinearTokenForAccount } from '@/lib/tasks/linear-config'
import { loadLoopNeeds, loopsNeeding, needOfIntegration, type DependentLoop } from './dependents'

export interface ConnectionRef {
  kind: 'integration' | 'app'
  id: string
  name: string
  /** integration: its provider and capability. */
  provider?: string
  capability?: string
  account?: string | null
}

/** One of the caller's connections by id (either table), or null. */
export async function findConnection(supabase: SupabaseClient, userId: string, id: string): Promise<ConnectionRef | null> {
  const [{ data: account }, { data: app }] = await Promise.all([
    supabase.from('connected_account').select('id, provider, capability, account_email').eq('id', id).eq('user_id', userId).maybeSingle(),
    supabase.from('connected_mcp_server').select('id, display_name').eq('id', id).eq('user_id', userId).maybeSingle(),
  ])
  const a = account as { id: string; provider: string; capability: string; account_email: string | null } | null
  if (a) return { kind: 'integration', id: a.id, name: `${a.provider}:${a.capability}`, provider: a.provider, capability: a.capability, account: a.account_email }
  const s = app as { id: string; display_name: string } | null
  if (s) return { kind: 'app', id: s.id, name: s.display_name }
  return null
}

/**
 * The loops that would stop working if this connection went: the person's
 * own, in any workspace, that need what it provides, when no other enabled
 * account of theirs provides it too.
 */
export async function loopsLosing(supabase: SupabaseClient, userId: string, ref: ConnectionRef): Promise<DependentLoop[]> {
  if (ref.kind !== 'integration' || !ref.provider || !ref.capability) return []
  const need = needOfIntegration(ref.provider, ref.capability)
  if (!need) return []
  const { data: others } = await supabase
    .from('connected_account')
    .select('id, provider, capability')
    .eq('user_id', userId)
    .eq('is_enabled', true)
    .neq('id', ref.id)
  const covered = ((others ?? []) as Array<{ provider: string; capability: string }>).some((o) => needOfIntegration(o.provider, o.capability) === need)
  if (covered) return []
  return loopsNeeding(await loadLoopNeeds(supabase, { userId, workspaceId: null }), need)
}

/** What a disconnect did. */
export interface DisconnectResult {
  removed: boolean
  /** The person's loops it switched off because they needed this connection. */
  loopsSwitchedOff: DependentLoop[]
}

/**
 * Remove one OAuth account, as the person: the Settings route's and the
 * chat card's one path, so both switch off the loops that needed it.
 */
export async function disconnectOAuthAccount(supabase: SupabaseClient, userId: string, accountId: string): Promise<DisconnectResult> {
  const { data } = await supabase
    .from('connected_account')
    .select('id, is_primary, capability, provider, account_email')
    .eq('id', accountId)
    .eq('user_id', userId)
    .maybeSingle()
  const account = data as { id: string; is_primary: boolean | null; capability: string; provider: string; account_email?: string | null } | null
  // Already gone: nothing to do (the caller moves on).
  if (!account) return { removed: false, loopsSwitchedOff: [] }
  // Which loops lose what they need (read before the row goes; best effort).
  const losing = await loopsLosing(supabase, userId, {
    kind: 'integration',
    id: account.id,
    name: `${account.provider}:${account.capability}`,
    provider: account.provider,
    capability: account.capability,
  }).catch(() => [] as DependentLoop[])
  // Provider-side teardown, dispatched on the STORED row's provider (never a
  // caller's): a Google account named through /api/oauth/linear/disconnect
  // must never have its token handed to Linear's revoke endpoint.
  if (account.provider === 'asana') await tearDownAsanaWebhooksForAccount(accountId)
  else if (account.provider === 'jira') await tearDownJiraWebhooksForAccount(accountId)
  else if (account.provider === 'linear') await revokeLinearTokenForAccount(accountId)

  await supabase.from('connected_account').delete().eq('id', accountId).eq('user_id', userId)

  if (account.is_primary) {
    const { data: next } = await supabase
      .from('connected_account')
      .select('id')
      .eq('user_id', userId)
      .eq('capability', account.capability)
      .eq('is_enabled', true)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    const nextId = (next as { id: string } | null)?.id
    if (nextId) await supabase.from('connected_account').update({ is_primary: true, updated_at: new Date().toISOString() }).eq('id', nextId)
  }
  // Never left to fail silently: the loops that needed it are switched off.
  const loopsSwitchedOff = await switchLoopsOff(supabase, userId, losing).catch(() => [] as DependentLoop[])
  return { removed: true, loopsSwitchedOff }
}

/** Remove one connected app, as the person. */
export async function disconnectApp(supabase: SupabaseClient, userId: string, serverId: string): Promise<DisconnectResult> {
  const { data, error } = await supabase.from('connected_mcp_server').delete().eq('id', serverId).eq('user_id', userId).select('id')
  // No loop can reach a connected app yet (F4), so none is switched off.
  return { removed: !error && Array.isArray(data) && data.length > 0, loopsSwitchedOff: [] }
}

/** Switch the person's own loops off (a disconnect took what they need). Returns the ones switched. */
export async function switchLoopsOff(supabase: SupabaseClient, userId: string, loops: readonly DependentLoop[]): Promise<DependentLoop[]> {
  const on = loops.filter((l) => l.on)
  if (!on.length) return []
  const { data } = await supabase
    .from('flow')
    .update({ enabled: false, updated_at: new Date().toISOString() })
    .in('id', on.map((l) => l.id))
    .eq('created_by', userId)
    .eq('enabled', true)
    .select('id')
  const switched = new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id))
  return on.filter((l) => switched.has(l.id))
}
