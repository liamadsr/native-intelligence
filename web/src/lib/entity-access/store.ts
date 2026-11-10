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
import { GRANT_SOURCES, isGranteeKind, type EntityAccessResponse, type EntityGrant, type GrantableType, type GranteeKind, type GrantSource } from './model'

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
      .select('id, grantee_kind, grantee_member_id, grantee_team_id, grantee_channel_id, source, created_at')
      .eq('workspace_id', workspaceId)
      .eq('entity_type', type)
      .eq('entity_id', id)
      .order('created_at', { ascending: true }),
  ])
  if (restricted === null) return null
  if (grantsRes.error) throw new Error(grantsRes.error.message)
  const rows = (grantsRes.data ?? []) as Row[]

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
      source: ((GRANT_SOURCES as readonly string[]).includes(r.source as string) ? r.source : 'manual') as GrantSource,
      created_at: r.created_at as string,
    })
  }
  return { can_share: canShare, restricted, grants }
}

export type AddGrantResult = { id: string } | { error: 'forbidden' | 'exists' | 'invalid' | 'failed'; message: string }

/** Add a view grant on a record for one member, team or channel, as the viewer. */
export async function addEntityGrant(
  supabase: SupabaseClient,
  scope: { workspaceId: string; memberId: string },
  type: GrantableType,
  id: string,
  grantee: { kind: GranteeKind; id: string },
): Promise<AddGrantResult> {
  const column = grantee.kind === 'member' ? 'grantee_member_id' : grantee.kind === 'team' ? 'grantee_team_id' : 'grantee_channel_id'
  const { data, error } = await supabase
    .from('entity_access')
    .insert({
      workspace_id: scope.workspaceId,
      entity_type: type,
      entity_id: id,
      grantee_kind: grantee.kind,
      [column]: grantee.id,
      level: 'view',
      granted_by: scope.memberId,
      source: 'manual',
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

/** Remove one grant the viewer may remove (they may share its record, or made it). False: none removed. */
export async function removeEntityGrant(supabase: SupabaseClient, workspaceId: string, grantId: string): Promise<boolean> {
  const { data, error } = await supabase.from('entity_access').delete().eq('workspace_id', workspaceId).eq('id', grantId).select('id')
  if (error) throw new Error(error.message)
  return (data ?? []).length > 0
}
