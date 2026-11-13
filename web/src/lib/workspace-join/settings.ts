/**
 * The joining switches, listed domains and the join link (migration 645).
 * All three tables are the service role's alone, so every read and write
 * here takes the service client; the API routes check the caller's role first.
 *
 * No settings row reads as off; no link row reads as no link.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { newJoinToken } from './token'

export interface JoinLink {
  token: string
  enabled: boolean
}

export interface JoinSettings {
  membersCanInvite: boolean
  /** Domains whose verified addresses may join with one click, sorted. */
  domains: string[]
  link: JoinLink | null
}

export async function readJoinSettings(service: SupabaseClient, workspaceId: string): Promise<JoinSettings> {
  const [settings, domains, link] = await Promise.all([
    service.from('workspace_join_settings').select('members_can_invite').eq('workspace_id', workspaceId).maybeSingle(),
    service.from('workspace_join_domain').select('domain').eq('workspace_id', workspaceId),
    service.from('workspace_join_link').select('token, enabled').eq('workspace_id', workspaceId).maybeSingle(),
  ])
  for (const r of [settings, domains, link]) if (r.error) throw new Error(r.error.message)
  return {
    membersCanInvite: settings.data?.members_can_invite === true,
    domains: ((domains.data ?? []) as Array<{ domain: string }>).map((d) => d.domain).sort(),
    link: link.data ? { token: link.data.token as string, enabled: link.data.enabled === true } : null,
  }
}

/** Just the "members can invite" switch (the invites route's one read). */
export async function readMembersCanInvite(service: SupabaseClient, workspaceId: string): Promise<boolean> {
  const { data, error } = await service
    .from('workspace_join_settings')
    .select('members_can_invite')
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data?.members_can_invite === true
}

export async function setMembersCanInvite(
  service: SupabaseClient,
  workspaceId: string,
  value: boolean,
  userId: string,
): Promise<void> {
  const { error } = await service
    .from('workspace_join_settings')
    .upsert(
      { workspace_id: workspaceId, members_can_invite: value, updated_by: userId, updated_at: new Date().toISOString() },
      { onConflict: 'workspace_id' },
    )
  if (error) throw new Error(error.message)
}

/**
 * List a domain (the caller derived it from its own verified address,
 * claimableDomain). Listing one that is already there changes nothing.
 * Other workspaces may list the same domain.
 */
export async function addJoinDomain(service: SupabaseClient, workspaceId: string, domain: string, userId: string): Promise<void> {
  const { error } = await service
    .from('workspace_join_domain')
    .upsert({ workspace_id: workspaceId, domain, added_by: userId }, { onConflict: 'workspace_id,domain', ignoreDuplicates: true })
  if (error) throw new Error(error.message)
}

export async function removeJoinDomains(service: SupabaseClient, workspaceId: string, domains: string[]): Promise<void> {
  if (domains.length === 0) return
  const { error } = await service.from('workspace_join_domain').delete().eq('workspace_id', workspaceId).in('domain', domains)
  if (error) throw new Error(error.message)
}

/**
 * Switch the link on or off. Switching on the first time makes the token
 * (an insert that leaves an existing row alone, so two admins switching it
 * on at once both succeed); after that the token stays as it is until a
 * reset (switching off and on again brings the same link back; Reset is
 * what kills it).
 */
export async function setJoinLinkEnabled(
  service: SupabaseClient,
  workspaceId: string,
  enabled: boolean,
  userId: string,
): Promise<JoinLink | null> {
  if (enabled) {
    const { error } = await service
      .from('workspace_join_link')
      .upsert(
        { workspace_id: workspaceId, token: newJoinToken(), enabled: true, created_by: userId },
        { onConflict: 'workspace_id', ignoreDuplicates: true },
      )
    if (error) throw new Error(error.message)
  }
  const { data, error } = await service
    .from('workspace_join_link')
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .select('token, enabled')
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data ? { token: data.token as string, enabled: data.enabled === true } : null
}

/** A new token: the old link stops working at once. Keeps the on/off state. */
export async function resetJoinLink(service: SupabaseClient, workspaceId: string, userId: string): Promise<JoinLink> {
  const token = newJoinToken()
  const { data, error } = await service
    .from('workspace_join_link')
    .upsert(
      { workspace_id: workspaceId, token, created_by: userId, updated_at: new Date().toISOString() },
      { onConflict: 'workspace_id' },
    )
    .select('token, enabled')
    .single()
  if (error || !data) throw new Error(error?.message ?? 'Could not reset the link')
  return { token: data.token as string, enabled: data.enabled === true }
}

/** The workspace a link opens, or null when the token is unknown or the link is off. */
export async function findOpenJoinLink(
  service: SupabaseClient,
  token: string,
): Promise<{ workspaceId: string } | null> {
  const { data, error } = await service
    .from('workspace_join_link')
    .select('workspace_id, enabled')
    .eq('token', token)
    .maybeSingle()
  if (error || !data) return null
  if (data.enabled !== true) return null
  return { workspaceId: data.workspace_id as string }
}
