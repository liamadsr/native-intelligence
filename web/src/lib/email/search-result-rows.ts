import type { SupabaseClient } from '@supabase/supabase-js'
import type { HeldThreadRef } from './held-threads'
import type { LiveSearchHit } from './live-thread-search'

/**
 * Mail's search results as list rows (GET /api/account/email/threads?search=).
 * Every row is a provider hit (live-thread-search.ts) and shows the provider's
 * subject, preview and sender. Where this workspace's index has the thread,
 * its row is the base (its id, labels, needs_reply, trust, linked contact), so
 * the actions on it work as on any listed thread; where it hasn't (older than
 * the index's 30 days, or not indexed yet), the row is built from the hit
 * alone, with `live: true` and an id of its own, and opens by its provider
 * thread id and account (GET /threads/[threadId]?account=).
 *
 * Index-only filters (needs_reply, auto_classified) keep only indexed rows
 * that match; starred reads the provider's mark, or the index's.
 */

export interface SearchRowFilters {
  isStarred: boolean | null
  needsReply: boolean
  autoClassified: string | null
}

interface AccountChip {
  id: string
  account_email: string
  display_name: string | null
  color: string
}

/** A hit's id when the index doesn't have it (never an index row id: those are uuids). */
export function liveRowId(hit: Pick<LiveSearchHit, 'accountId' | 'threadId'>): string {
  return `live:${hit.accountId}:${hit.threadId}`
}

export async function searchResultRows(
  supabase: SupabaseClient,
  args: {
    userId: string
    workspaceId: string
    hits: readonly LiveSearchHit[]
    held: readonly HeldThreadRef[]
    filters: SearchRowFilters
  },
): Promise<Array<Record<string, unknown>>> {
  const { hits } = args
  if (!hits.length) return []
  const accountIds = [...new Set(hits.map((h) => h.accountId))]
  const threadIds = [...new Set(hits.map((h) => h.threadId))]

  const [indexResult, accountResult] = await Promise.all([
    supabase
      .from('email_thread_index')
      .select('*, connected_account:account_id(id, account_email, display_name, color)')
      .eq('user_id', args.userId)
      .eq('workspace_id', args.workspaceId)
      .in('account_id', accountIds)
      .in('provider_thread_id', threadIds),
    supabase
      .from('connected_account')
      .select('id, account_email, display_name, color')
      .eq('user_id', args.userId)
      .in('id', accountIds),
  ])
  const indexed = new Map<string, Record<string, unknown>>()
  for (const row of (indexResult.data ?? []) as Array<Record<string, unknown>>) {
    indexed.set(`${row.account_id}:${row.provider_thread_id}`, row)
  }
  const chips = new Map(((accountResult.data ?? []) as AccountChip[]).map((a) => [a.id, a]))

  // Labels live on index rows only.
  const labelsByThread: Record<string, Array<{ id: string; name: string; color: string }>> = {}
  const indexIds = [...indexed.values()].map((r) => r.id as string)
  if (indexIds.length) {
    try {
      const { data } = await supabase.from('email_thread_label').select('thread_id, label:label(id, name, color)').in('thread_id', indexIds)
      for (const row of (data ?? []) as Array<{ thread_id: string; label: unknown }>) {
        const label = row.label as { id: string; name: string; color: string } | null
        if (label) (labelsByThread[row.thread_id] ??= []).push(label)
      }
    } catch {
      // No labels then.
    }
  }

  const heldBy = new Map(args.held.map((h) => [`${h.account_id ?? ''}:${h.provider_thread_id}`, h]))
  const rows: Array<Record<string, unknown>> = []
  for (const hit of hits) {
    const key = `${hit.accountId}:${hit.threadId}`
    const base = indexed.get(key)
    const live = {
      subject: hit.subject,
      snippet: hit.snippet,
      from_name: hit.fromName ?? (base?.from_name as string | null | undefined) ?? null,
      header_unavailable: false,
      live: true,
    }
    const row: Record<string, unknown> = base
      ? {
          ...base,
          ...live,
          from_email: (base.from_email as string | null) ?? hit.fromEmail,
          is_unread: hit.isUnread,
          is_starred: hit.isStarred || base.is_starred === true,
          labels: labelsByThread[base.id as string] ?? [],
          indexed: true,
        }
      : {
          id: liveRowId(hit),
          provider: hit.provider,
          provider_thread_id: hit.threadId,
          provider_message_id: hit.messageId,
          account_id: hit.accountId,
          connected_account: chips.get(hit.accountId) ?? null,
          ...live,
          from_email: hit.fromEmail,
          is_unread: hit.isUnread,
          is_starred: hit.isStarred,
          has_attachments: hit.hasAttachments,
          needs_reply: false,
          message_count: 1,
          last_message_at: hit.date,
          folder: hit.folder,
          labels: [],
          indexed: false,
        }
    if (args.filters.isStarred !== null && row.is_starred !== args.filters.isStarred) continue
    if (args.filters.needsReply && row.needs_reply !== true) continue
    if (args.filters.autoClassified && row.auto_classified !== args.filters.autoClassified) continue
    const hold = heldBy.get(key)
    rows.push(hold ? { ...row, held: true, held_subject: hold.subject, held_stale: hold.stale } : row)
  }
  return rows
}
