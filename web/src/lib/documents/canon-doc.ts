/**
 * One canon document by key (canon documents D1/D2): what read_canon and the
 * section edits address. Workspace-scoped, never cross-workspace; a personal
 * key is always the caller's OWN (their content brief, their voice notes),
 * never another member's.
 *
 *   product       the workspace product doc pointer's document
 *                 (workspace.settings.product_doc) when it is set and
 *                 eligible, else the document keyed `product`. Creating the
 *                 product canon sets the pointer, so the two are one document
 *                 and everything that reads the product doc (the live agent,
 *                 the admin-only edit rule) reads the canon.
 *   person:…,     the caller's own document with that key (migration 375:
 *   content-brief:…  unique per person).
 *   anything else the document with that key.
 *
 * Never an archived document (a system document can't be archived anyway),
 * and never one the caller can't see (migration 369). SERVICE-ROLE SAFE: every
 * read is scoped by workspace id.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchWorkspaceSettings } from '@/lib/workspace-settings'
import { isProductDocEligible, readProductDocPointer } from '@/lib/workspace/product-doc'
import { DOCUMENT_ACCESS_COLUMNS, documentVisibleToMember, type DocumentAccessRow } from './access'
import { isPersonalCanonKey } from './canon'

/** The columns a canon read and a canon edit need. */
export const CANON_DOC_COLUMNS = `${DOCUMENT_ACCESS_COLUMNS}, title, content, revision, updated_at, last_edited_by`

export interface CanonDocRow extends DocumentAccessRow {
  title: string | null
  content: string | null
  revision: number | null
  updated_at: string | null
  last_edited_by?: string | null
}

export type CanonLookup =
  | { ok: true; doc: CanonDocRow; memberId: string | null; viaPointer: boolean }
  | { ok: false; reason: 'not_found' | 'not_member' }
  | { ok: false; reason: 'error'; error: string }

/** The caller's member row in the workspace, or null. */
export async function memberIdIn(supabase: SupabaseClient, workspaceId: string, userId: string): Promise<string | null> {
  const { data } = await supabase.from('member').select('id').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle()
  const id = (data as { id?: unknown } | null)?.id
  return typeof id === 'string' ? id : null
}

/**
 * The canon document `key` names for this caller (see the header). Two or
 * three reads, issued together where they can be.
 */
export async function resolveCanonDocument(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; key: string; settings?: unknown },
): Promise<CanonLookup> {
  const { workspaceId, key } = args
  try {
    const [memberId, settings] = await Promise.all([
      memberIdIn(supabase, workspaceId, args.userId),
      key === 'product' ? (args.settings !== undefined ? args.settings : fetchWorkspaceSettings(supabase, workspaceId)) : null,
    ])
    if (!memberId) return { ok: false, reason: 'not_member' }

    if (key === 'product') {
      const pointer = readProductDocPointer(settings)
      if (pointer) {
        const { data, error } = await supabase
          .from('document')
          .select(CANON_DOC_COLUMNS)
          .eq('id', pointer.document_id)
          .eq('workspace_id', workspaceId)
          .maybeSingle()
        if (error) return { ok: false, reason: 'error', error: error.message }
        const doc = data as unknown as CanonDocRow | null
        if (doc && isProductDocEligible(doc) && documentVisibleToMember(doc, memberId)) return { ok: true, doc, memberId, viaPointer: true }
      }
    }

    let query = supabase
      .from('document')
      .select(CANON_DOC_COLUMNS)
      .eq('workspace_id', workspaceId)
      .eq('canon_key', key)
      .neq('status', 'archived')
    if (isPersonalCanonKey(key)) query = query.eq('created_by', memberId)
    const { data, error } = await query.limit(1).maybeSingle()
    if (error) return { ok: false, reason: 'error', error: error.message }
    const doc = data as unknown as CanonDocRow | null
    if (!doc || !documentVisibleToMember(doc, memberId)) return { ok: false, reason: 'not_found' }
    return { ok: true, doc, memberId, viaPointer: false }
  } catch (err) {
    return { ok: false, reason: 'error', error: err instanceof Error ? err.message : String(err) }
  }
}

/** Who owns a canon document, as the tools say it: its creator for personal canon, else the admins. Pure. */
export function canonOwnerLabel(key: string, doc: Pick<CanonDocRow, 'created_by'>, memberId: string | null): 'you' | 'admins' | 'its creator' {
  if (!isPersonalCanonKey(key)) return 'admins'
  return doc.created_by && doc.created_by === memberId ? 'you' : 'its creator'
}

/** The most owners a canon card goes to (workspace canon: owners and admins). */
export const CANON_CARD_MAX_OWNERS = 5

/** Who owns a canon document: its creator (personal canon), else the workspace's owners and admins. */
export async function canonOwnerMemberIds(supabase: SupabaseClient, workspaceId: string, doc: { created_by: string | null }, personal: boolean): Promise<string[]> {
  if (personal) return doc.created_by ? [doc.created_by] : []
  const { data } = await supabase.from('member').select('id').eq('workspace_id', workspaceId).in('role', ['owner', 'admin']).order('created_at', { ascending: true }).limit(CANON_CARD_MAX_OWNERS)
  return ((data ?? []) as Array<{ id?: unknown }>).map((r) => String(r.id))
}
