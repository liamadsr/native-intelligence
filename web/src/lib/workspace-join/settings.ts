/**
 * The joining switches and the join link (migration 644). Both tables are the
 * service role's alone, so every read and write here takes the service
 * client; the API routes check the caller's role first.
 *
 * No settings row reads as all off; no link row reads as no link.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { newJoinToken } from './token'

export interface JoinLink {
  token: string
  enabled: boolean
}

export interface JoinSettings {
  membersCanInvite: boolean
  autoJoinDomain: string | null
  link: JoinLink | null
}

const UNIQUE_VIOLATION = '23505'

export async function readJoinSettings(service: SupabaseClient, workspaceId: string): Promise<JoinSettings> {
  const [{ data: settings, error: settingsError }, { data: link, error: linkError }] = await Promise.all([
    service
      .from('workspace_join_settings')
      .select('members_can_invite, auto_join_domain')
      .eq('workspace_id', workspaceId)
      .maybeSingle(),
    service.from('workspace_join_link').select('token, enabled').eq('workspace_id', workspaceId).maybeSingle(),
  ])
  if (settingsError) throw new Error(settingsError.message)
  if (linkError) throw new Error(linkError.message)
  return {
    membersCanInvite: settings?.members_can_invite === true,
    autoJoinDomain: (settings?.auto_join_domain as string | null | undefined) ?? null,
    link: link ? { token: link.token as string, enabled: link.enabled === true } : null,
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

async function writeSettings(
  service: SupabaseClient,
  workspaceId: string,
  patch: { members_can_invite?: boolean; auto_join_domain?: string | null },
  userId: string,
) {
  return service
    .from('workspace_join_settings')
    .upsert(
      { workspace_id: workspaceId, ...patch, updated_by: userId, updated_at: new Date().toISOString() },
      { onConflict: 'workspace_id' },
    )
}

export async function setMembersCanInvite(
  service: SupabaseClient,
  workspaceId: string,
  value: boolean,
  userId: string,
): Promise<void> {
  const { error } = await writeSettings(service, workspaceId, { members_can_invite: value }, userId)
  if (error) throw new Error(error.message)
}

/**
 * Claim `domain` for auto-join, or release it (null). The caller derived the
 * domain from its own verified address (claimableDomain); this only writes.
 * A domain another workspace holds comes back as `{ ok: false, clash: true }`.
 */
export async function setAutoJoinDomain(
  service: SupabaseClient,
  workspaceId: string,
  domain: string | null,
  userId: string,
): Promise<{ ok: true } | { ok: false; clash: true }> {
  const { error } = await writeSettings(service, workspaceId, { auto_join_domain: domain }, userId)
  if (error?.code === UNIQUE_VIOLATION) return { ok: false, clash: true }
  if (error) throw new Error(error.message)
  return { ok: true }
}

/**
 * Switch the link on or off. Switching on the first time makes the token;
 * after that the token stays as it is until a reset (switching off and on
 * again brings the same link back; Reset is what kills it).
 */
export async function setJoinLinkEnabled(
  service: SupabaseClient,
  workspaceId: string,
  enabled: boolean,
  userId: string,
): Promise<JoinLink | null> {
  const { data: existing, error: readError } = await service
    .from('workspace_join_link')
    .select('token')
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (readError) throw new Error(readError.message)
  if (!existing) {
    if (!enabled) return null
    const token = newJoinToken()
    const { error } = await service
      .from('workspace_join_link')
      .insert({ workspace_id: workspaceId, token, enabled: true, created_by: userId })
    if (error) throw new Error(error.message)
    return { token, enabled: true }
  }
  const { error } = await service
    .from('workspace_join_link')
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
  if (error) throw new Error(error.message)
  return { token: existing.token as string, enabled }
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
  if (error || !data || data.enabled !== true) return null
  return { workspaceId: data.workspace_id as string }
}
