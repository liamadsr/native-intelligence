import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'

/**
 * Resolve which connected email accounts are visible in a workspace, healing
 * the common case where the inbox is empty because no account was ever linked
 * to the workspace.
 *
 * The web inbox scopes email_thread_index rows by the
 * connected_account_workspace junction. If that junction has no rows for the
 * current workspace, the inbox returns nothing and "Sync" appears to do
 * nothing — even though mail exists. This happens when an account is connected
 * without a workspace context (e.g. during onboarding, before a workspace is
 * active, so the OAuth callback skips the junction insert).
 *
 * When the junction is empty for this workspace, we self-heal by linking the
 * user's enabled email accounts that have NEVER been linked to ANY workspace —
 * the true onboarding orphan (connected before a workspace was active, so the
 * OAuth callback skipped the junction insert). An account already linked to some
 * OTHER workspace is deliberately scoped and must NOT be inherited here:
 * auto-linking it is exactly the cross-workspace contact leak this guards
 * against — a brand-new workspace silently re-deriving another workspace's
 * mailbox-derived contact graph.
 *
 * @param userSupabase  request-scoped (RLS) client, used for the read
 * @returns the account ids whose threads should be shown in this workspace
 */
export async function getWorkspaceEmailAccountIds(
  userSupabase: SupabaseClient,
  userId: string,
  workspaceId: string,
): Promise<string[]> {
  const { data: junctionRows } = await userSupabase
    .from('connected_account_workspace')
    .select('account_id')
    .eq('workspace_id', workspaceId)

  if (junctionRows && junctionRows.length > 0) {
    return junctionRows.map((r) => r.account_id)
  }

  // Self-heal: link only the user's enabled email accounts that are true
  // orphans (never linked to any workspace).
  const admin = getServiceClient()
  const { data: accounts } = await admin
    .from('connected_account')
    .select('id')
    .eq('user_id', userId)
    .eq('capability', 'email')
    .eq('is_enabled', true)

  if (!accounts || accounts.length === 0) return []

  const accountIds = accounts.map((a) => a.id)

  // Which of these accounts already carry a junction row ANYWHERE? Those were
  // deliberately scoped to some workspace, so they are off-limits to this
  // self-heal — otherwise a second workspace inherits an account (and its
  // contact graph) that belongs to another.
  const { data: linkedRows } = await admin
    .from('connected_account_workspace')
    .select('account_id')
    .in('account_id', accountIds)

  const alreadyLinked = new Set((linkedRows || []).map((r) => r.account_id))
  const orphanIds = accountIds.filter((id) => !alreadyLinked.has(id))

  if (orphanIds.length === 0) return []

  await admin
    .from('connected_account_workspace')
    .upsert(
      orphanIds.map((id) => ({ account_id: id, workspace_id: workspaceId })),
      { onConflict: 'account_id,workspace_id', ignoreDuplicates: true },
    )

  // Its threads were indexed wherever its sync ran; now they belong here.
  await Promise.all(orphanIds.map((id) => reconcileThreadCopies(id)))

  return orphanIds
}

/** A mailbox a tool may read: one of the user's own connected email accounts. */
export interface ReadableEmailAccount {
  id: string
  provider: 'google' | 'microsoft'
  account_email: string | null
}

/**
 * The user's OWN enabled email accounts that a tool running in `workspaceId`
 * may read (list_emails): those linked to this workspace through the
 * connected_account_workspace junction or, when none of them are, the
 * never-linked orphans getWorkspaceEmailAccountIds would link here on the
 * inbox's next visit. An account linked only to OTHER workspaces is never
 * returned, so a chat, skill run or work run in one workspace can't list the
 * mail of a mailbox scoped to another.
 *
 * Read-only (the inbox does the self-heal), on the service client: tools run
 * without a user session. Fails closed: a lookup that errors returns nothing
 * rather than treating every account as an orphan.
 */
export async function readableWorkspaceEmailAccounts(
  userId: string,
  workspaceId: string,
  admin: SupabaseClient = getServiceClient(),
): Promise<ReadableEmailAccount[]> {
  const { data: accounts, error: accountsError } = await admin
    .from('connected_account')
    .select('id, provider, account_email')
    .eq('user_id', userId)
    .eq('capability', 'email')
    .eq('is_enabled', true)
    .order('created_at', { ascending: true })
  if (accountsError || !accounts || accounts.length === 0) return []

  const { data: links, error: linksError } = await admin
    .from('connected_account_workspace')
    .select('account_id, workspace_id')
    .in(
      'account_id',
      accounts.map((a) => a.id),
    )
  if (linksError || !links) return []

  const linkedHere = new Set(links.filter((l) => l.workspace_id === workspaceId).map((l) => l.account_id))
  const linkedAnywhere = new Set(links.map((l) => l.account_id))
  const readable = linkedHere.size > 0
    ? accounts.filter((a) => linkedHere.has(a.id))
    : accounts.filter((a) => !linkedAnywhere.has(a.id))
  return readable as ReadableEmailAccount[]
}

/**
 * The workspaces whose copy of a mailbox's threads a write updates.
 *
 * email_thread_index keeps one copy of each thread per workspace (each copy
 * carries that workspace's own contact link, labels and work touches), Mail
 * lists only the current workspace's copies, and so every write lands in
 * every workspace the account is linked to. An account linked nowhere yet
 * (connected before a workspace was active), or no account at all, writes to
 * `fallbackWorkspaceId` as before; linking it later reconciles its copies.
 */
export async function threadCopyWorkspaceIds(
  accountId: string | null | undefined,
  fallbackWorkspaceId: string,
  admin: SupabaseClient = getServiceClient(),
): Promise<string[]> {
  if (!accountId) return [fallbackWorkspaceId]
  const { data, error } = await admin
    .from('connected_account_workspace')
    .select('workspace_id')
    .eq('account_id', accountId)
  if (error) throw new Error(`thread copy workspaces: ${error.message}`)
  const linked = (data ?? []).map((r) => r.workspace_id as string)
  return linked.length > 0 ? linked : [fallbackWorkspaceId]
}

/**
 * Bring an account's thread copies in line with the workspaces it is linked
 * to (reconcile_email_thread_copies, migration 301): every linked workspace
 * gets a current copy of each thread, and copies in workspaces it is no
 * longer linked to go. Run after an account's links change. Logs rather than
 * throws: the links are already saved, and the next change runs it again.
 */
export async function reconcileThreadCopies(accountId: string): Promise<void> {
  const { error } = await getServiceClient().rpc('reconcile_email_thread_copies', { p_account_id: accountId })
  if (error) console.error('[email] reconcile_email_thread_copies failed:', error.message)
}
