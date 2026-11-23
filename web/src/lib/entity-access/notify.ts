/**
 * The notice to the person a record was shared with (migration 688's
 * `record_shared`, docs/plans/record-sharing.md, Phase 2). Sent by the Share
 * routes after a grant is made, or raised to edit, by hand:
 *   - to a MEMBER grantee only (a team's or a channel's grant says nothing:
 *     Share to a channel already posts in the channel);
 *   - never to the sharer themself (createNotification drops that too);
 *   - never on removal;
 *   - only for the kinds whose sharing this plan adds (a spreadsheet, a
 *     canvas). Documents, captures, contacts, companies and tables keep
 *     their quiet shares.
 * In-app only, best effort: it never fails the share.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createNotification } from '@/lib/notifications'
import { isGrantableType, isGrantLevel, isGranteeKind, type GrantableType, type GrantLevel, type GranteeKind } from './model'

/** The kinds a share notifies about, and the notification target each is. */
export const SHARE_NOTICE_TYPES = ['spreadsheet', 'canvas'] as const
export type ShareNoticeType = (typeof SHARE_NOTICE_TYPES)[number]

export function isShareNoticeType(type: unknown): type is ShareNoticeType {
  return typeof type === 'string' && (SHARE_NOTICE_TYPES as readonly string[]).includes(type)
}

const NOUN: Record<ShareNoticeType, string> = { spreadsheet: 'a spreadsheet', canvas: 'a canvas' }

/** A record's name as the notice quotes it: trimmed, short, or what it is. */
function quoted(title: string | null, type: ShareNoticeType): string {
  const t = (title ?? '').trim()
  if (!t) return NOUN[type]
  return `“${t.length > 80 ? `${t.slice(0, 79)}…` : t}”`
}

/** The words of the notice. `raised`: an existing grant became edit. */
export function shareNoticeText(input: { actor: string; title: string | null; type: ShareNoticeType; level: GrantLevel; raised?: boolean }): { title: string; body: string } {
  const what = quoted(input.title, input.type)
  if (input.raised) return { title: `${input.actor} gave you edit access to ${what}`, body: 'Can edit' }
  return { title: `${input.actor} shared ${what} with you`, body: input.level === 'edit' ? 'Can edit' : 'Can view' }
}

export interface ShareNoticeInput {
  workspaceId: string
  /** The sharer's member id. */
  actorMemberId: string
  type: GrantableType
  id: string
  granteeKind: GranteeKind
  granteeId: string
  level: GrantLevel
  raised?: boolean
}

/** One grant as the share notice needs it. */
export interface GrantForNotice {
  type: GrantableType
  id: string
  granteeKind: GranteeKind
  granteeId: string
  level: GrantLevel
}

/**
 * One grant, read under the person's RLS before its level changes (so a
 * notice says only a real view-to-edit raise). Null on any failure: a
 * notice is never worth failing the change for.
 */
export async function readGrantForNotice(supabase: SupabaseClient, workspaceId: string, grantId: string): Promise<GrantForNotice | null> {
  try {
    const { data, error } = await supabase
      .from('entity_access')
      .select('entity_type, entity_id, grantee_kind, grantee_member_id, grantee_team_id, grantee_channel_id, level')
      .eq('workspace_id', workspaceId)
      .eq('id', grantId)
      .maybeSingle()
    const row = data as Record<string, unknown> | null
    if (error || !row) return null
    const granteeId = (row.grantee_member_id ?? row.grantee_team_id ?? row.grantee_channel_id) as string | null
    if (!isGrantableType(row.entity_type) || !isGranteeKind(row.grantee_kind) || !isGrantLevel(row.level) || !granteeId || typeof row.entity_id !== 'string') return null
    return { type: row.entity_type, id: row.entity_id, granteeKind: row.grantee_kind, granteeId, level: row.level }
  } catch {
    return null
  }
}

/**
 * Notify the member a record was shared with. `supabase` is the sharer's own
 * client: it reads the record's title and the sharer's name under their RLS
 * (they may read both). Never throws.
 */
export async function notifyRecordShared(supabase: SupabaseClient, input: ShareNoticeInput): Promise<void> {
  try {
    if (!isShareNoticeType(input.type) || input.granteeKind !== 'member' || input.granteeId === input.actorMemberId) return
    const [record, actor] = await Promise.all([
      supabase.from(input.type).select('title').eq('workspace_id', input.workspaceId).eq('id', input.id).maybeSingle(),
      supabase.from('member').select('display_name').eq('workspace_id', input.workspaceId).eq('id', input.actorMemberId).maybeSingle(),
    ])
    const title = ((record.data as { title?: unknown } | null)?.title as string | undefined) ?? null
    const actorName = (((actor.data as { display_name?: unknown } | null)?.display_name as string | undefined) ?? '').trim() || 'A teammate'
    const text = shareNoticeText({ actor: actorName, title, type: input.type, level: input.level, raised: input.raised })
    await createNotification({
      workspaceId: input.workspaceId,
      recipientId: input.granteeId,
      actorId: input.actorMemberId,
      type: 'record_shared',
      title: text.title,
      body: text.body,
      targetType: input.type,
      targetId: input.id,
      metadata: { level: input.level, ...(input.raised ? { raised: true } : {}) },
    })
  } catch (err) {
    console.warn('[entity-access] share notice failed:', err instanceof Error ? err.message : 'unknown')
  }
}
