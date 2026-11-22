/**
 * PER-ITEM ACCESS, the share dialog's reads and writes
 * (/api/account/entity-access): the grants on one record with their
 * grantees' names, whether the viewer may share it, and adding or removing
 * one grant.
 *
 * SESSION CLIENT ONLY. Everything runs under the viewer's RLS: they read a
 * record's grants only when they may share it or are a grantee, they add one
 * only when entity_access_can_share says they may (migration 492's insert
 * policy, which also holds a team to one they can see and a channel to one
 * they can read), and they remove one they may share or made. This file
 * decides nothing the database doesn't check again.
 *
 * Flat cost: one read of the record, one call of entity_access_can_share,
 * one read of its grants, then one read each of the members, teams and
 * channels they name.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { dmOtherMember } from '@/lib/team-chat/types'
import { GRANT_SOURCES, GRANTING_HELD_TYPES, isGrantLevel, isGranteeKind, type EntityAccessResponse, type EntityGrant, type GrantableType, type GranteeKind, type GrantLevel, type GrantSource } from './model'

type Row = Record<string, unknown>

/** The record as its own rule reads it, and whether that rule hides it from some members. Null: the viewer can't read it. */
async function readRestriction(supabase: SupabaseClient, workspaceId: string, type: GrantableType, id: string): Promise<boolean | null> {
  if (type === 'company') {
    const { data, error } = await supabase.from('company').select('id').eq('workspace_id', workspaceId).eq('id', id).maybeSingle()
    if (error || !data) return null
    // 235's rule: hidden from no member when one of its live contacts is workspace-wide.
    const { data: open, error: openError } = await supabase
      .from('contact')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('company_id', id)
      .eq('visibility', 'workspace')
      .is('merged_into_contact_id', null)
      .limit(1)
    if (openError) return null
    return (open ?? []).length === 0
  }
  const table = type === 'capture' ? 'captures' : type
  const { data, error } = await supabase.from(table).select('id, visibility').eq('workspace_id', workspaceId).eq('id', id).maybeSingle()
  if (error || !data) return null
  return (data as { visibility?: unknown }).visibility !== 'workspace'
}

/** May the viewer share this record? (492's entity_access_can_share, for auth.uid().) False on any error. */
export async function canShareEntity(supabase: SupabaseClient, workspaceId: string, type: GrantableType, id: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('entity_access_can_share', { p_type: type, p_id: id, p_workspace: workspaceId })
  return !error && data === true
}

/** The record's grants, named, oldest first; whether the viewer may share it; whether it is restricted. Null: not readable. */
export async function loadEntityAccess(
  supabase: SupabaseClient,
  scope: { workspaceId: string; memberId: string },
  type: GrantableType,
  id: string,
): Promise<EntityAccessResponse | null> {
  const { workspaceId, memberId } = scope
  const [restricted, canShare, grantsRes] = await Promise.all([
    readRestriction(supabase, workspaceId, type, id),
    canShareEntity(supabase, workspaceId, type, id),
    supabase
      .from('entity_access')
      .select('id, grantee_kind, grantee_member_id, grantee_team_id, grantee_channel_id, level, source, created_at')
      .eq('workspace_id', workspaceId)
      .eq('entity_type', type)
      .eq('entity_id', id)
      .order('created_at', { ascending: true }),
  ])
  if (restricted === null) return null
  if (grantsRes.error) throw new Error(grantsRes.error.message)
  const rows = (grantsRes.data ?? []) as Row[]
  const grants = await nameGrants(supabase, workspaceId, memberId, rows)
  return { can_share: canShare, restricted, grants }
}

export type AddGrantResult = { id: string } | { error: 'forbidden' | 'exists' | 'invalid' | 'failed'; message: string }

/** Add a grant (view unless said) on a record for one member, team or channel, as the viewer. */
export async function addEntityGrant(
  supabase: SupabaseClient,
  scope: { workspaceId: string; memberId: string },
  type: GrantableType,
  id: string,
  grantee: { kind: GranteeKind; id: string },
  level: GrantLevel = 'view',
  /** How it came about: by hand (the Share menu), or by an @-mention of the record (a comment's). */
  source: Extract<GrantSource, 'manual' | 'mention'> = 'manual',
): Promise<AddGrantResult> {
  if (GRANTING_HELD_TYPES.has(type)) return { error: 'forbidden', message: "This can't be shared yet" }
  const column = grantee.kind === 'member' ? 'grantee_member_id' : grantee.kind === 'team' ? 'grantee_team_id' : 'grantee_channel_id'
  const { data, error } = await supabase
    .from('entity_access')
    .insert({
      workspace_id: scope.workspaceId,
      entity_type: type,
      entity_id: id,
      grantee_kind: grantee.kind,
      [column]: grantee.id,
      level,
      granted_by: scope.memberId,
      source,
    })
    .select('id')
    .single()
  if (error) {
    const code = (error as { code?: string }).code
    if (code === '23505') return { error: 'exists', message: 'They already have access' }
    if (code === '42501') return { error: 'forbidden', message: "You can't share this" }
    if (code === '23514' || code === '23503' || code === '22P02') return { error: 'invalid', message: "That person, team or channel isn't in this workspace" }
    return { error: 'failed', message: error.message }
  }
  return { id: (data as { id: string }).id }
}

/**
 * Change one grant's level, as someone who may share its record (migration
 * 512's update policy; only `level` is writable). False: none changed (no
 * such grant, or not theirs to change).
 */
export async function setEntityGrantLevel(supabase: SupabaseClient, workspaceId: string, grantId: string, level: GrantLevel): Promise<boolean> {
  const { data, error } = await supabase.from('entity_access').update({ level }).eq('workspace_id', workspaceId).eq('id', grantId).select('id')
  if (error) {
    // The update policy refuses with no row, a column privilege with 42501: both "not yours".
    if ((error as { code?: string }).code === '42501') return false
    throw new Error(error.message)
  }
  return (data ?? []).length > 0
}

/** Remove one grant the viewer may remove (they may share its record, or made it). False: none removed. */
export async function removeEntityGrant(supabase: SupabaseClient, workspaceId: string, grantId: string): Promise<boolean> {
  const { data, error } = await supabase.from('entity_access').delete().eq('workspace_id', workspaceId).eq('id', grantId).select('id')
  if (error) throw new Error(error.message)
  return (data ?? []).length > 0
}

/** What a record's header says about its sharing (docs/plans/record-sharing.md, Phase 3). */
export interface RecordSharing {
  /** The viewer may add and remove grants on it (entity_access_can_share: its owner). */
  can_share: boolean
  /** The app makes no new grants on this kind yet (GRANTING_HELD_TYPES): no Share item. */
  held: boolean
  /** How many people, teams and channels it is shared with: counted for whoever may share only. */
  grant_count: number
  /** The viewer sees it only because it was shared with them (494's entity_grant_only). */
  shared_with_me: boolean
}

/**
 * The record's sharing, for its header's Share item and its "Shared" chips.
 * Under the viewer's RLS. Never throws: a failure reads as not shared and not
 * shareable, which only hides a chip or the Share item; the database decides
 * every grant in any case.
 */
export async function loadRecordSharing(supabase: SupabaseClient, workspaceId: string, type: GrantableType, id: string): Promise<RecordSharing> {
  const held = GRANTING_HELD_TYPES.has(type)
  try {
    const [canShare, onlyByGrant] = await Promise.all([
      canShareEntity(supabase, workspaceId, type, id).catch(() => false),
      Promise.resolve(supabase.rpc('entity_grant_only', { p_type: type, p_id: id }))
        .then(({ data, error }) => !error && data === true)
        .catch(() => false),
    ])
    let grantCount = 0
    if (canShare) {
      const { count, error } = await supabase
        .from('entity_access')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .eq('entity_type', type)
        .eq('entity_id', id)
      if (!error) grantCount = count ?? 0
    }
    return { can_share: canShare, held, grant_count: grantCount, shared_with_me: !canShare && onlyByGrant }
  } catch {
    return { can_share: false, held, grant_count: 0, shared_with_me: false }
  }
}

/**
 * Name a record's grant rows (oldest first, as read): a member's name, a
 * team's, a channel's "#name", a DM's other person's. `memberId`: who is
 * looking, so a DM is named by its other person.
 */
async function nameGrants(supabase: SupabaseClient, workspaceId: string, memberId: string, rows: Row[]): Promise<EntityGrant[]> {

  const memberIds = new Set<string>()
  const teamIds = new Set<string>()
  const channelIds = new Set<string>()
  for (const r of rows) {
    if (r.grantee_kind === 'member' && typeof r.grantee_member_id === 'string') memberIds.add(r.grantee_member_id)
    if (r.grantee_kind === 'team' && typeof r.grantee_team_id === 'string') teamIds.add(r.grantee_team_id)
    if (r.grantee_kind === 'channel' && typeof r.grantee_channel_id === 'string') channelIds.add(r.grantee_channel_id)
  }
  const channels = channelIds.size
    ? (((await supabase.from('team_chat_channel').select('id, kind, name, dm_key').in('id', [...channelIds])).data ?? []) as Row[])
    : []
  // A DM's name is its other person's.
  for (const c of channels) {
    const other = c.kind === 'dm' ? dmOtherMember(c.dm_key as string | null, memberId) : null
    if (other) memberIds.add(other)
  }
  const [members, teams] = await Promise.all([
    memberIds.size ? supabase.from('member').select('id, display_name').eq('workspace_id', workspaceId).in('id', [...memberIds]) : null,
    teamIds.size ? supabase.from('team').select('id, name').eq('workspace_id', workspaceId).in('id', [...teamIds]) : null,
  ])
  const memberName = new Map(((members?.data ?? []) as Row[]).map((m) => [m.id as string, (m.display_name as string) || 'Someone']))
  const teamName = new Map(((teams?.data ?? []) as Row[]).map((t) => [t.id as string, (t.name as string) || 'A team']))
  const channelName = new Map(
    channels.map((c) => {
      if (c.kind === 'dm') {
        const other = dmOtherMember(c.dm_key as string | null, memberId)
        return [c.id as string, other && memberName.get(other) ? `${memberName.get(other)} (direct message)` : 'A direct message']
      }
      if (c.kind === 'meeting') return [c.id as string, c.name ? `${c.name as string} (meeting)` : 'A meeting']
      return [c.id as string, c.name ? `#${c.name as string}` : 'A channel']
    }),
  )

  const grants: EntityGrant[] = []
  for (const r of rows) {
    const kind = r.grantee_kind
    if (!isGranteeKind(kind)) continue
    const granteeId = (kind === 'member' ? r.grantee_member_id : kind === 'team' ? r.grantee_team_id : r.grantee_channel_id) as string
    const name =
      kind === 'member' ? memberName.get(granteeId) : kind === 'team' ? teamName.get(granteeId) : channelName.get(granteeId)
    grants.push({
      id: r.id as string,
      grantee_kind: kind,
      grantee_id: granteeId,
      grantee_name: name ?? (kind === 'channel' ? 'A channel' : kind === 'team' ? 'A team' : 'Someone'),
      level: isGrantLevel(r.level) ? r.level : 'view',
      source: ((GRANT_SOURCES as readonly string[]).includes(r.source as string) ? r.source : 'manual') as GrantSource,
      created_at: r.created_at as string,
    })
  }
  return grants
}

/** One line of the agent's "who it is shared with" for a record's owner. */
export interface SharedWithLine {
  name: string
  kind: GranteeKind
  level: GrantLevel
}

/**
 * Who a spreadsheet or canvas is shared with, for its OWNER only (the
 * agent's read tools, docs/plans/record-sharing.md, Phase 3). These tools may
 * run on a service-role client, where entity_access_can_share (auth.uid())
 * cannot answer for the person, so the owner is checked here for the explicit
 * user: a spreadsheet's maker, a canvas's owner, as 688's can_share arms.
 * Null for anyone else, and on any failure.
 */
export async function sharedWithForOwner(
  supabase: SupabaseClient,
  scope: { workspaceId: string; userId: string },
  type: 'spreadsheet' | 'canvas',
  id: string,
): Promise<SharedWithLine[] | null> {
  try {
    const ownerColumn = type === 'spreadsheet' ? 'created_by' : 'owner_member_id'
    const [me, record] = await Promise.all([
      supabase.from('member').select('id').eq('workspace_id', scope.workspaceId).eq('user_id', scope.userId).maybeSingle(),
      supabase.from(type).select(`id, ${ownerColumn}`).eq('workspace_id', scope.workspaceId).eq('id', id).maybeSingle(),
    ])
    const memberId = (me.data as { id?: string } | null)?.id
    const owner = (record.data as Record<string, unknown> | null)?.[ownerColumn]
    if (!memberId || !owner || owner !== memberId) return null
    const { data, error } = await supabase
      .from('entity_access')
      .select('id, grantee_kind, grantee_member_id, grantee_team_id, grantee_channel_id, level, source, created_at')
      .eq('workspace_id', scope.workspaceId)
      .eq('entity_type', type)
      .eq('entity_id', id)
      .order('created_at', { ascending: true })
    if (error) return null
    const grants = await nameGrants(supabase, scope.workspaceId, memberId, (data ?? []) as Row[])
    return grants.map((g) => ({ name: g.grantee_name, kind: g.grantee_kind, level: g.level }))
  } catch {
    return null
  }
}

/** A list row's word on sharing: how many it is shared with (its owner's), or that it was shared with the viewer. */
export interface ListSharing {
  shared_count: number
  shared_with_me: boolean
}

/**
 * Sharing for a page of records the viewer can read (a list's chips,
 * docs/plans/record-sharing.md, Phase 3), in ONE grants read under their RLS
 * (which shows an owner the grants on their records). `owner` is the
 * record's owner member (a canvas's owner, a spreadsheet's maker). A private
 * record the viewer reads but does not own reads only through a grant: shared
 * with them. Never throws: a failure says nothing.
 */
export async function listSharingByRecord(
  supabase: SupabaseClient,
  scope: { workspaceId: string; memberId: string },
  type: GrantableType,
  rows: ReadonlyArray<{ id: string; owner: string | null; visibility: string }>,
): Promise<Map<string, ListSharing>> {
  const out = new Map<string, ListSharing>()
  for (const r of rows) out.set(r.id, { shared_count: 0, shared_with_me: r.visibility === 'private' && r.owner !== scope.memberId })
  const own = rows.filter((r) => r.owner === scope.memberId).map((r) => r.id)
  if (own.length === 0) return out
  try {
    for (let i = 0; i < own.length; i += 200) {
      const { data, error } = await supabase
        .from('entity_access')
        .select('entity_id')
        .eq('workspace_id', scope.workspaceId)
        .eq('entity_type', type)
        .in('entity_id', own.slice(i, i + 200))
      if (error) return out
      for (const g of (data ?? []) as Row[]) {
        const hit = out.get(g.entity_id as string)
        if (hit) hit.shared_count += 1
      }
    }
  } catch {
    /* no chips: a failure only hides them */
  }
  return out
}
