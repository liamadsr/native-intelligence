/**
 * Add a person to a workspace: the ONE member setup every way in shares
 * (an emailed invite, the shareable link, auto-join by email domain).
 *
 *   1. the member row, onboarding skipped (they already have an account),
 *      with `joined_via` saying which way they came;
 *   2. their CRM contact in that workspace (ensureMemberContact);
 *   3. the analytics event: `invite_accepted` for an invite (as before),
 *      `workspace_joined` with `{ via }` for the link and the domain;
 *   4. optionally, the active-workspace cookie, so they land there.
 *
 * Runs on the service client: the person is not a member yet, so RLS would
 * hide the workspace from them, and member inserts are server-only (306).
 * The caller has already decided they may join (a valid invite, an enabled
 * link, a verified address on a claimed domain).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { ensureMemberContact } from '@/lib/crm/contacts'
import { trackServerEvent } from '@/lib/posthog'
import { WORKSPACE_COOKIE } from '@/lib/workspace'

export type JoinVia = 'invite' | 'link' | 'domain'
export type JoinRole = 'admin' | 'member' | 'guest'

export interface JoiningUser {
  id: string
  email?: string | null
  user_metadata?: { full_name?: string; name?: string; avatar_url?: string } | null
}

/**
 * When to make the workspace the active one:
 *   always    the person chose to join (invite accepted, link opened)
 *   if-fresh  only when they have nowhere else yet: none of their other
 *             memberships has finished onboarding (a brand-new account,
 *             whose own workspace was made by the signup trigger moments ago)
 *   never     just add the membership; it shows in the workspace switcher
 */
export type Activate = 'always' | 'if-fresh' | 'never'

export interface JoinWorkspaceInput {
  service: SupabaseClient
  user: JoiningUser
  workspaceId: string
  role: JoinRole
  via: JoinVia
  activate: Activate
  /** The invite being accepted, for its event. */
  inviteId?: string
}

export type JoinWorkspaceResult =
  | { ok: true; memberId: string; alreadyMember: boolean; activated: boolean }
  | { ok: false; error: string }

/** Postgres unique_violation: the (user_id, workspace_id) row already exists (a race with another join). */
const UNIQUE_VIOLATION = '23505'

export async function joinWorkspace(input: JoinWorkspaceInput): Promise<JoinWorkspaceResult> {
  const { service, user, workspaceId, role, via, activate } = input

  const { data: existing, error: lookupError } = await service
    .from('member')
    .select('id')
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (lookupError) return { ok: false, error: lookupError.message }
  if (existing) {
    // Already in: nothing to add. Only someone who chose this workspace
    // (an invite or the link) is moved into it.
    const activated = activate === 'always'
    if (activated) await setActiveWorkspace(workspaceId)
    return { ok: true, memberId: existing.id as string, alreadyMember: true, activated }
  }

  const { data: created, error: insertError } = await service
    .from('member')
    .insert({
      user_id: user.id,
      workspace_id: workspaceId,
      role,
      display_name: user.user_metadata?.full_name || user.email?.split('@')[0] || 'User',
      onboarding_completed_at: new Date().toISOString(),
      joined_via: via,
    })
    .select('id')
    .single()

  if (insertError || !created) {
    if (insertError?.code === UNIQUE_VIOLATION) {
      const { data: raced } = await service
        .from('member')
        .select('id')
        .eq('user_id', user.id)
        .eq('workspace_id', workspaceId)
        .maybeSingle()
      if (raced) return { ok: true, memberId: raced.id as string, alreadyMember: true, activated: false }
    }
    return { ok: false, error: insertError?.message ?? 'Could not add the member' }
  }
  const memberId = created.id as string

  try {
    await ensureMemberContact(workspaceId, memberId, {
      id: user.id,
      email: user.email ?? undefined,
      user_metadata: user.user_metadata ?? undefined,
    })
  } catch (err) {
    // The membership stands; a missing contact row is not worth failing the join.
    console.error('[workspace-join] member contact failed:', err instanceof Error ? err.message : err)
  }

  if (via === 'invite') {
    // Virality: the bottom of the invite loop — a recipient actually joined.
    // Bucketed against `invite_sent` this is the K-factor numerator.
    trackServerEvent(
      'invite_accepted',
      { userId: user.id, workspaceId, email: user.email },
      { invite_id: input.inviteId, role },
    )
  } else {
    trackServerEvent('workspace_joined', { userId: user.id, workspaceId, email: user.email }, { via, role })
  }

  let activated = false
  if (activate === 'always') activated = true
  else if (activate === 'if-fresh') activated = await hasNowhereElse(service, user.id, workspaceId)
  if (activated) await setActiveWorkspace(workspaceId)

  return { ok: true, memberId, alreadyMember: false, activated }
}

/**
 * True when none of the person's other memberships has finished onboarding:
 * their own workspace is brand new, and no invite has taken them anywhere.
 * A failed read counts as "has somewhere": the cookie stays as it is.
 */
export async function hasNowhereElse(service: SupabaseClient, userId: string, exceptWorkspaceId: string): Promise<boolean> {
  const { data, error } = await service
    .from('member')
    .select('workspace_id, onboarding_completed_at')
    .eq('user_id', userId)
    .neq('workspace_id', exceptWorkspaceId)
  if (error || !data) return false
  return (data as Array<{ onboarding_completed_at: string | null }>).every((m) => !m.onboarding_completed_at)
}

/** The active-workspace cookie, as /api/account/workspace/switch sets it. */
export async function setActiveWorkspace(workspaceId: string): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.set(WORKSPACE_COOKIE, workspaceId, {
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365,
  })
}
