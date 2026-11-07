import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The person's held threads, as Mail lists them (the "To review" view, and the
 * subject of a held row in any folder: its hold has it, so no live call).
 * Owner-only both ways: RLS on a session client, and the explicit user fence
 * for a service client. Never throws: a failed read holds nothing.
 */

export interface HeldThreadRef {
  hold_id: string
  provider_thread_id: string
  account_id: string | null
  subject: string | null
  trust: string | null
  /** Its open reply draft is stale (a new message came after the person edited it). */
  stale: boolean
}

/** At most this many holds are listed: a review pile, not an archive. */
export const HELD_LIST_MAX = 200

export async function heldThreadsFor(
  supabase: SupabaseClient,
  args: { userId: string; workspaceId?: string; providerThreadIds?: readonly string[] },
): Promise<HeldThreadRef[]> {
  if (args.providerThreadIds && args.providerThreadIds.length === 0) return []
  try {
    let query = supabase
      .from('email_hold')
      .select('id, provider_thread_id, account_id, subject, trust, drafts:email_draft(stale, status)')
      .eq('user_id', args.userId)
    if (args.workspaceId) query = query.eq('workspace_id', args.workspaceId)
    if (args.providerThreadIds) query = query.in('provider_thread_id', [...args.providerThreadIds])
    const { data, error } = await query.order('created_at', { ascending: false }).limit(HELD_LIST_MAX)
    if (error || !Array.isArray(data)) return []
    return (data as Array<Record<string, unknown>>).map((h) => ({
      hold_id: String(h.id),
      provider_thread_id: String(h.provider_thread_id),
      account_id: typeof h.account_id === 'string' ? h.account_id : null,
      subject: typeof h.subject === 'string' ? h.subject : null,
      trust: typeof h.trust === 'string' ? h.trust : null,
      stale: Array.isArray(h.drafts) && (h.drafts as Array<{ stale?: unknown }>).some((d) => d.stale === true),
    }))
  } catch {
    return []
  }
}

/** How many threads wait in the person's review pile in a workspace. Never throws. */
export async function heldThreadCount(supabase: SupabaseClient, userId: string, workspaceId: string): Promise<number> {
  try {
    const { count, error } = await supabase
      .from('email_hold')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('workspace_id', workspaceId)
    return error ? 0 : (count ?? 0)
  } catch {
    return 0
  }
}
