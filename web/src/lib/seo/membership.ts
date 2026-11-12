/**
 * Whose standing the SEO area's money and standing choices rest on.
 *
 * A full member of the workspace (owner, admin, member) may spend the
 * workspace's search-data budget, set a schedule that spends it, and choose
 * the Google site or property the workspace reads. A workspace guest (role
 * `guest`) reads what the workspace already has, and nothing more: a guest
 * never spends the budget, a schedule never runs on a guest's standing, and
 * the workspace never reads Google through the connection of someone who is
 * a guest or has left.
 *
 * Every check here reads the member row with the service role, fenced on the
 * workspace and the person, and THROWS when the row can't be read: the
 * callers refuse rather than spend or read on an answer they don't have.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'

const FULL_MEMBER_ROLES: ReadonlySet<string> = new Set([
  'owner',
  'admin',
  'member',
])

export function isFullMemberRole(role: string | null | undefined): boolean {
  return typeof role === 'string' && FULL_MEMBER_ROLES.has(role)
}

export interface MemberStanding {
  /** The person's role in the workspace; null when they are not in it. */
  role: string | null
  /** Their display name there, for a sentence; null when unknown or not a member. */
  name: string | null
}

/** The person's member row in this workspace. Throws when it can't be read. */
export async function memberStanding(
  svc: SupabaseClient,
  workspaceId: string,
  userId: string,
): Promise<MemberStanding> {
  const { data, error } = await svc
    .from('member')
    .select('role, display_name')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .limit(1)
  if (error) throw new Error(`seo member read failed: ${error.message}`)
  const row = ((data ?? []) as Array<{
    role?: unknown
    display_name?: unknown
  }>)[0]
  if (!row) return { role: null, name: null }
  return {
    role: typeof row.role === 'string' ? row.role : null,
    name:
      typeof row.display_name === 'string' && row.display_name.trim()
        ? row.display_name.trim()
        : null,
  }
}

/** The person's role in this workspace, or null when they are not in it. Throws when it can't be read. */
export async function memberRole(
  svc: SupabaseClient,
  workspaceId: string,
  userId: string,
): Promise<string | null> {
  return (await memberStanding(svc, workspaceId, userId)).role
}
