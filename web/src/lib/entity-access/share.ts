/**
 * SHARE BY MENTION: a team-chat post that @-mentions a record some of the
 * channel's readers can't see opens it to them, when its author may share it
 * (migration 492's entity_access_can_share: a private document's or
 * capture's creator, a restricted contact's creator or a workspace admin, a
 * company's admin). The post's answer says so, and its composer toasts
 * "Shared “Q3 plan” with #launch · Undo"; Undo deletes the grant
 * (DELETE /api/account/entity-access/[id]). Act with undo: nothing asks
 * first.
 *
 * Phase 3's Share to a channel posts the same way, so it gets the same
 * (source 'channel_share' instead of 'mention').
 *
 * When the author can't share the record, nothing is granted and the mention
 * is as it was (fenced for its author on the way in, phase 2): readers who
 * can't see it still can't open it.
 *
 * "Readers can't see it" is the record's own rule hiding it from someone in
 * the workspace: a private document or capture, a contact that isn't
 * workspace-wide, a company with no workspace-wide contact. A record already
 * granted to this channel is left alone.
 *
 * SESSION CLIENT ONLY: every read and the insert run under the author's own
 * RLS, so the database re-checks everything decided here (the insert policy
 * is the enforcement; this only chooses what to ask for). Grants stay in the
 * channel's own workspace. Flat cost: one read per kind present, one of the
 * author's role, one of the channel's existing grants, one insert.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { dmOtherMember } from '@/lib/team-chat/types'
import { channelAudience, isGrantableType, type GrantableType, type SharedRecord } from './model'

export interface ShareWithChannelInput {
  workspaceId: string
  channelId: string
  /** The author: their auth user and their member row in the workspace. */
  userId: string
  memberId: string
  /** What the message mentions (already fenced for the author). */
  records: ReadonlyArray<{ type: string; id: string; label: string }>
  source: 'mention' | 'channel_share'
}

type Row = Record<string, unknown>

async function read(q: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<Row[] | null> {
  const { data, error } = await q
  if (error) {
    console.warn('[entity-access] share read failed:', error.message)
    return null
  }
  return (data ?? []) as Row[]
}

/**
 * Grant the channel view access to each mentioned record its readers can't
 * all see and the author may share. Returns what it granted (none on any
 * failure: a share is never worth failing the post it rides).
 */
export async function shareRecordsWithChannel(supabase: SupabaseClient, input: ShareWithChannelInput): Promise<SharedRecord[]> {
  const byType = new Map<GrantableType, Map<string, string>>()
  for (const r of input.records) {
    if (!isGrantableType(r.type) || typeof r.id !== 'string') continue
    ;(byType.get(r.type) ?? byType.set(r.type, new Map()).get(r.type)!).set(r.id, r.label)
  }
  if (byType.size === 0) return []
  try {
    const { workspaceId, userId, memberId } = input
    const ws = workspaceId
    const ids = (t: GrantableType) => [...(byType.get(t)?.keys() ?? [])]
    const none = Promise.resolve([] as Row[])
    const needsRole = byType.has('contact') || byType.has('company')
    const [docs, caps, contacts, companies, openContacts, role, existing] = await Promise.all([
      byType.has('document') ? read(supabase.from('document').select('id, visibility, created_by').eq('workspace_id', ws).in('id', ids('document'))) : none,
      byType.has('capture') ? read(supabase.from('captures').select('id, visibility, user_id, is_eval, notes_channel_id').eq('workspace_id', ws).in('id', ids('capture'))) : none,
      byType.has('contact') ? read(supabase.from('contact').select('id, visibility, created_by_member_id').eq('workspace_id', ws).in('id', ids('contact'))) : none,
      byType.has('company') ? read(supabase.from('company').select('id').eq('workspace_id', ws).in('id', ids('company'))) : none,
      // A company is hidden from no member when one of its live contacts is workspace-wide (235's rule).
      byType.has('company')
        ? read(
            supabase
              .from('contact')
              .select('company_id')
              .eq('workspace_id', ws)
              .eq('visibility', 'workspace')
              .is('merged_into_contact_id', null)
              .in('company_id', ids('company')),
          )
        : none,
      needsRole ? read(supabase.from('member').select('role').eq('id', memberId).eq('workspace_id', ws)) : none,
      read(
        supabase
          .from('entity_access')
          .select('entity_type, entity_id')
          .eq('workspace_id', ws)
          .eq('grantee_kind', 'channel')
          .eq('grantee_channel_id', input.channelId)
          .in('entity_id', [...byType.values()].flatMap((m) => [...m.keys()])),
      ),
    ])
    if (!docs || !caps || !contacts || !companies || !openContacts || !role || !existing) return []
    const admin = role.some((r) => r.role === 'owner' || r.role === 'admin')
    const already = new Set(existing.map((r) => `${r.entity_type as string}:${r.entity_id as string}`))
    const openCompanies = new Set(openContacts.map((r) => r.company_id as string))

    const toGrant: Array<{ type: GrantableType; id: string }> = []
    for (const d of docs) if (d.visibility === 'private' && d.created_by === memberId) toGrant.push({ type: 'document', id: d.id as string })
    // A team call's notes (notes_channel_id, migration 566) are shared with their own conversation
    // and nowhere else: never granted here (the database would refuse the whole insert).
    for (const c of caps) {
      if (c.visibility === 'private' && c.user_id === userId && c.is_eval !== true && !c.notes_channel_id) toGrant.push({ type: 'capture', id: c.id as string })
    }
    for (const c of contacts) {
      if (c.visibility !== 'workspace' && (c.created_by_member_id === memberId || admin)) toGrant.push({ type: 'contact', id: c.id as string })
    }
    if (admin) for (const c of companies) if (!openCompanies.has(c.id as string)) toGrant.push({ type: 'company', id: c.id as string })

    const fresh = toGrant.filter((g) => !already.has(`${g.type}:${g.id}`))
    if (fresh.length === 0) return []
    const { data, error } = await supabase
      .from('entity_access')
      .insert(
        fresh.map((g) => ({
          workspace_id: ws,
          entity_type: g.type,
          entity_id: g.id,
          grantee_kind: 'channel',
          grantee_channel_id: input.channelId,
          level: 'view',
          granted_by: memberId,
          source: input.source,
        })),
      )
      .select('id, entity_type, entity_id')
    if (error) {
      console.warn('[entity-access] share insert failed:', error.message)
      return []
    }
    return ((data ?? []) as Row[])
      .filter((r) => isGrantableType(r.entity_type) && typeof r.id === 'string')
      .map((r) => ({
        grant_id: r.id as string,
        type: r.entity_type as GrantableType,
        id: r.entity_id as string,
        label: byType.get(r.entity_type as GrantableType)?.get(r.entity_id as string) ?? '',
      }))
  } catch (err) {
    console.warn('[entity-access] share threw:', err instanceof Error ? err.message : 'unknown')
    return []
  }
}

/** The channel a post went to, as the message routes read it. */
export interface PostedChannel {
  id: string
  kind: string
  name: string | null
  dm_key?: string | null
}

/**
 * The message routes' share step: shareRecordsWithChannel for a post's
 * mentions, and who it reached in words ("#launch", a DM's other person) for
 * the composer's toast. A note to self reaches no one else: nothing to
 * share.
 */
export async function shareMentionedRecords(
  supabase: SupabaseClient,
  input: Omit<ShareWithChannelInput, 'channelId'> & { channel: PostedChannel },
): Promise<{ shared: SharedRecord[]; shared_with: string | null }> {
  const { channel, ...rest } = input
  if (rest.records.length === 0) return { shared: [], shared_with: null }
  const other = channel.kind === 'dm' ? dmOtherMember(channel.dm_key, rest.memberId) : null
  if (channel.kind === 'dm' && (!other || other === rest.memberId)) return { shared: [], shared_with: null }
  const shared = await shareRecordsWithChannel(supabase, { ...rest, channelId: channel.id })
  if (shared.length === 0) return { shared, shared_with: null }
  let otherName: string | null = null
  if (other) {
    const { data } = await supabase.from('member').select('display_name').eq('id', other).eq('workspace_id', rest.workspaceId).maybeSingle()
    otherName = ((data as { display_name?: unknown } | null)?.display_name as string | undefined) ?? null
  }
  return { shared, shared_with: channelAudience(channel, otherName) }
}
