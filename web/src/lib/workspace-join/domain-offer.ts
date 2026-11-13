/**
 * Join by email domain, with one click.
 *
 * A workspace's owners and admins list their own verified domain
 * (workspace_join_domain, migration 645). After signing in, a person whose
 * VERIFIED address is on a listed domain is shown those workspaces on
 * /join/team, each with a Join button and a "Not now". Nobody is ever added
 * without the click.
 *
 * Offered: every workspace listing the person's domain that they are not in,
 * have not left or been removed from (marks.ts, LEFT_KEY) and have not said
 * "Not now" to (DISMISSED_KEY). Cheapest first: no query at all unless the
 * address is verified and not a public or relay provider, then ONE indexed
 * lookup by domain (workspace_join_domain_domain_idx); nearly every sign-in
 * stops there.
 *
 * When it is checked: once per sign-in (sign-in-check.ts). The server
 * callbacks send the person to /join/team instead of /account when there is
 * an offer; a password or desktop sign-in, finished in the browser, is
 * checked by the auth-session ping, which sends the browser there.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import { joinWorkspace, type JoiningUser } from './add-member'
import { addressDomain, isPublicEmailDomain } from './domains'
import { DISMISSED_KEY, LEFT_KEY, addMarks, marksOf, type MarkedUser } from './marks'
import { hasVerifiedEmail, type UserLike } from './verified-email'

export type DomainUser = JoiningUser & UserLike & MarkedUser

export interface DomainOffer {
  workspaceId: string
  name: string
  ownerName: string | null
}

/** The person's verified, non-public domain, or null (and then nothing is ever looked up). */
export function offerDomainOf(user: DomainUser | null | undefined): string | null {
  if (!user || !hasVerifiedEmail(user)) return null
  const domain = addressDomain(user.email)
  if (!domain || isPublicEmailDomain(domain)) return null
  return domain
}

/** The workspace ids on offer to this person (no names). */
export async function offeredWorkspaceIds(service: SupabaseClient, user: DomainUser): Promise<string[]> {
  const domain = offerDomainOf(user)
  if (!domain) return []

  const { data: listed, error } = await service.from('workspace_join_domain').select('workspace_id').eq('domain', domain)
  if (error) throw new Error(error.message)
  const skip = new Set([...marksOf(user, LEFT_KEY), ...marksOf(user, DISMISSED_KEY)])
  const candidates = [...new Set((listed ?? []).map((r) => r.workspace_id as string))].filter((id) => !skip.has(id))
  if (candidates.length === 0) return []

  const { data: mine, error: memberError } = await service
    .from('member')
    .select('workspace_id')
    .eq('user_id', user.id)
    .in('workspace_id', candidates)
  if (memberError) throw new Error(memberError.message)
  const inAlready = new Set((mine ?? []).map((m) => m.workspace_id as string))
  return candidates.filter((id) => !inAlready.has(id))
}

/** The offers with what the page shows: the workspace's name and its owner's. */
export async function findDomainOffers(service: SupabaseClient, user: DomainUser): Promise<DomainOffer[]> {
  const ids = await offeredWorkspaceIds(service, user)
  if (ids.length === 0) return []
  const [{ data: workspaces, error: wsError }, { data: owners, error: ownerError }] = await Promise.all([
    service.from('workspace').select('id, name').in('id', ids),
    service.from('member').select('workspace_id, display_name').in('workspace_id', ids).eq('role', 'owner'),
  ])
  if (wsError) throw new Error(wsError.message)
  if (ownerError) throw new Error(ownerError.message)
  const ownerOf = new Map((owners ?? []).map((o) => [o.workspace_id as string, (o.display_name as string) ?? null]))
  return (workspaces ?? [])
    .map((w) => ({ workspaceId: w.id as string, name: (w.name as string) ?? 'A workspace', ownerName: ownerOf.get(w.id as string) ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** At sign-in: is there anything to offer? Never throws (a sign-in must not fail on it). */
export async function hasDomainOfferAtSignIn(user: DomainUser | null | undefined): Promise<boolean> {
  // Most sign-ins stop here, before a client is even made.
  if (!user || !offerDomainOf(user)) return false
  try {
    return (await offeredWorkspaceIds(getServiceClient(), user)).length > 0
  } catch (err) {
    console.error('[workspace-join] domain offer check failed:', err instanceof Error ? err.message : err)
    return false
  }
}

export type DomainJoinResult =
  | { ok: true; workspaceId: string; alreadyMember: boolean }
  | { ok: false; status: 403 | 500; message: string }

/**
 * The Join button: checked again on the server (verified address, the
 * workspace still lists that domain, not left or removed), then the shared
 * member setup as `member`, joined_via 'domain', and the workspace cookie.
 */
export async function joinByDomain(service: SupabaseClient, user: DomainUser, workspaceId: string): Promise<DomainJoinResult> {
  const domain = offerDomainOf(user)
  if (!domain) return { ok: false, status: 403, message: 'Your email address can’t join workspaces by domain' }
  if (marksOf(user, LEFT_KEY).includes(workspaceId)) {
    return { ok: false, status: 403, message: 'You left this workspace. Ask someone there for an invite.' }
  }
  const { data: listed, error } = await service
    .from('workspace_join_domain')
    .select('workspace_id')
    .eq('workspace_id', workspaceId)
    .eq('domain', domain)
    .maybeSingle()
  if (error) return { ok: false, status: 500, message: 'Could not join the workspace' }
  if (!listed) return { ok: false, status: 403, message: 'This workspace is no longer open to your email domain' }

  const result = await joinWorkspace({ service, user, workspaceId, role: 'member', via: 'domain', activate: 'always' })
  if (!result.ok) return { ok: false, status: 500, message: 'Could not join the workspace' }
  return { ok: true, workspaceId, alreadyMember: result.alreadyMember }
}

/** "Not now": never offer these again. Only workspaces actually on offer are recorded. */
export async function dismissDomainOffers(service: SupabaseClient, user: DomainUser, workspaceIds: string[]): Promise<string[]> {
  const offered = new Set(await offeredWorkspaceIds(service, user))
  const dismissed = [...new Set(workspaceIds)].filter((id) => offered.has(id))
  await addMarks(service, user.id, DISMISSED_KEY, dismissed)
  return dismissed
}
