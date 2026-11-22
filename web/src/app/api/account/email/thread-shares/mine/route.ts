/**
 * /api/account/email/thread-shares/mine (migration 673): the mail threads the
 * caller shared with teammates by an @-mention (decision 1), so the OWNER can
 * see and end them (removing the mention does not revoke; only this does).
 *   GET                         → every active share of theirs, newest first.
 *   GET ?thread=<index id>      → only that thread's shares.
 *   GET ?providerThread=<id>    → only that provider thread's shares.
 * The list is the caller's OWN shares only (listOwnerThreadShares keys on
 * owner_user_id), so a non-owner gets an empty list — never another person's.
 * Each share carries a `source` the UI can link to: the record that carried
 * the mention, its title read on the CALLER's own RLS client (so nothing is
 * named they could not read). An unreadable or unknown source is "a mention"
 * with no link; a comment is "a comment" (its parent is not stored). A failed
 * label read never fails the list. Bearer callers are refused (as the siblings).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { NextRequest } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { noStore, shareCaller } from '@/lib/email-share/http'
import { listOwnerThreadShares, type OwnerThreadShare } from '@/lib/email-share/member-share'
import { isUuid } from '@/lib/team-chat/types'

/** The source record that carried a mention, named for the UI to link to. */
interface ShareSource {
  type: string
  /** Null when there is nothing to open (a comment, or a record the caller can't read). */
  id: string | null
  label: string
}

interface ThreadMentionShare {
  id: string
  threadIndexId: string | null
  providerThreadId: string
  granteeMemberId: string
  granteeName: string
  createdAt: string
  source: ShareSource
}

/** The source kinds whose title is cheap to read, and where it lives. */
const SOURCE_TABLE: Record<string, { table: string; column: string }> = {
  document: { table: 'document', column: 'title' },
  action: { table: 'actions', column: 'title' },
  project: { table: 'projects', column: 'name' },
  initiative: { table: 'initiative', column: 'name' },
  contact: { table: 'contact', column: 'full_name' },
  capture: { table: 'captures', column: 'title' },
}

const UNKNOWN: ShareSource = { type: 'mention', id: null, label: 'a mention' }

/**
 * A title for each (type, id) source among the shares, read on the CALLER's own
 * RLS client (one read per kind). What they may not read, or a kind with no
 * cheap title, is left out — those become "a mention". Never throws.
 */
async function resolveSourceLabels(
  supabase: SupabaseClient,
  shares: readonly OwnerThreadShare[],
): Promise<Map<string, string>> {
  const byType = new Map<string, Set<string>>()
  for (const s of shares) {
    const spec = s.sourceType ? SOURCE_TABLE[s.sourceType] : undefined
    if (!spec || !s.sourceId || !isUuid(s.sourceId)) continue
    ;(byType.get(s.sourceType!) ?? byType.set(s.sourceType!, new Set()).get(s.sourceType!)!).add(s.sourceId)
  }
  const labels = new Map<string, string>()
  for (const [type, ids] of byType) {
    const spec = SOURCE_TABLE[type]
    try {
      const { data } = await supabase.from(spec.table).select(`id, ${spec.column}`).in('id', [...ids])
      for (const row of (data ?? []) as unknown as Array<Record<string, unknown>>) {
        const id = typeof row.id === 'string' ? row.id : null
        const raw = row[spec.column]
        const label = typeof raw === 'string' ? raw.trim() : ''
        if (id && label) labels.set(`${type}:${id}`, label)
      }
    } catch {
      // A failed read names nothing: those shares fall back to "a mention".
    }
  }
  return labels
}

function sourceOf(share: OwnerThreadShare, labels: Map<string, string>): ShareSource {
  if (share.sourceType === 'comment') return { type: 'comment', id: null, label: 'a comment' }
  if (!share.sourceType || !SOURCE_TABLE[share.sourceType] || !share.sourceId || !isUuid(share.sourceId)) return UNKNOWN
  const label = labels.get(`${share.sourceType}:${share.sourceId}`)
  if (!label) return UNKNOWN
  return { type: share.sourceType, id: share.sourceId, label }
}

export async function GET(request: NextRequest) {
  const caller = await shareCaller(request)
  if (caller instanceof Response) return caller
  const threadIndexId = request.nextUrl.searchParams.get('thread')
  const providerThreadId = request.nextUrl.searchParams.get('providerThread')
  const shares = await listOwnerThreadShares(getServiceClient(), {
    ownerUserId: caller.userId,
    workspaceId: caller.workspaceId,
    threadIndexId,
    providerThreadId,
  })
  const labels = await resolveSourceLabels(caller.supabase, shares)
  const out: ThreadMentionShare[] = shares.map((s) => ({
    id: s.id,
    threadIndexId: s.threadIndexId,
    providerThreadId: s.providerThreadId,
    granteeMemberId: s.granteeMemberId,
    granteeName: s.granteeName,
    createdAt: s.createdAt,
    source: sourceOf(s, labels),
  }))
  return noStore({ shares: out })
}
