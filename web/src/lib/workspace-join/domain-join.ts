/**
 * Auto-join by email domain, run at sign-in.
 *
 * Where it runs: the server end of every sign-in (src/app/auth/callback for
 * Supabase's providers, magic links and signup confirmations;
 * /auth/google/callback and /auth/chatgpt/callback on the web), and once per
 * sign-in from /api/analytics/auth-session, the ping every authenticated
 * surface sends, which is how a password or desktop sign-in (both finished in
 * the browser) reaches it. Not in the signup trigger: the address may not be
 * confirmed when the user row is inserted.
 *
 * What it does, cheapest first:
 *   1. the address must be verified (verified-email.ts) and not on a public
 *      provider; otherwise stop, with no query at all;
 *   2. ONE indexed lookup: the workspace that claimed this domain
 *      (workspace_join_settings_domain_key). Nearly every sign-in stops here;
 *   3. never twice: a workspace this person was ever auto-joined to is
 *      remembered on their account (app_metadata), so someone who left or
 *      was removed is not pulled back in at their next sign-in. The mark is
 *      written BEFORE the join, so a failure leaves them out, never in twice;
 *   4. join as `member` (never admin) through the shared setup
 *      (add-member.ts), landing them there only if they have nowhere else
 *      yet (a brand-new account).
 *
 * It never throws: a sign-in must not fail because of it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import { joinWorkspace, type JoiningUser } from './add-member'
import { emailDomain, isPublicEmailDomain } from './domains'
import { hasVerifiedEmail, type UserLike } from './verified-email'

/** app_metadata key: the workspaces auto-join has added this person to, ever. */
export const DOMAIN_JOINED_KEY = 'ni_domain_joined'

export type DomainJoinUser = JoiningUser & UserLike & { app_metadata?: Record<string, unknown> | null }

export type DomainJoinOutcome =
  | { joined: true; workspaceId: string; activated: boolean }
  | {
      joined: false
      reason: 'unverified' | 'public_provider' | 'no_claim' | 'already_member' | 'joined_before' | 'failed'
    }

function joinedBefore(user: DomainJoinUser): string[] {
  const value = user.app_metadata?.[DOMAIN_JOINED_KEY]
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

export async function joinByEmailDomain(service: SupabaseClient, user: DomainJoinUser): Promise<DomainJoinOutcome> {
  if (!hasVerifiedEmail(user)) return { joined: false, reason: 'unverified' }
  const domain = emailDomain(user.email)
  if (!domain || isPublicEmailDomain(domain)) return { joined: false, reason: 'public_provider' }

  const { data: claim, error: claimError } = await service
    .from('workspace_join_settings')
    .select('workspace_id')
    .eq('auto_join_domain', domain)
    .maybeSingle()
  if (claimError) return { joined: false, reason: 'failed' }
  if (!claim) return { joined: false, reason: 'no_claim' }
  const workspaceId = claim.workspace_id as string

  const before = joinedBefore(user)
  if (before.includes(workspaceId)) return { joined: false, reason: 'joined_before' }

  const { data: member, error: memberError } = await service
    .from('member')
    .select('id')
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (memberError) return { joined: false, reason: 'failed' }
  if (member) return { joined: false, reason: 'already_member' }

  // Remember first: if this write fails, they stay out (and the next sign-in tries again).
  const { error: markError } = await service.auth.admin.updateUserById(user.id, {
    app_metadata: { [DOMAIN_JOINED_KEY]: [...before, workspaceId] },
  })
  if (markError) {
    console.error('[workspace-join] domain join mark failed:', markError.message)
    return { joined: false, reason: 'failed' }
  }

  const result = await joinWorkspace({
    service,
    user,
    workspaceId,
    role: 'member',
    via: 'domain',
    activate: 'if-fresh',
  })
  if (!result.ok) {
    console.error('[workspace-join] domain join failed:', result.error)
    return { joined: false, reason: 'failed' }
  }
  if (result.alreadyMember) return { joined: false, reason: 'already_member' }
  return { joined: true, workspaceId, activated: result.activated }
}

/** The sign-in hook: the service client, and nothing ever thrown. */
export async function joinByEmailDomainAtSignIn(user: DomainJoinUser | null | undefined): Promise<DomainJoinOutcome | null> {
  // Most sign-ins stop here, before a client is even made.
  if (!user || !hasVerifiedEmail(user)) return null
  try {
    return await joinByEmailDomain(getServiceClient(), user)
  } catch (err) {
    console.error('[workspace-join] domain join threw:', err instanceof Error ? err.message : err)
    return null
  }
}
