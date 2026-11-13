/**
 * Is this person's address proven theirs, firmly enough to let it open a
 * workspace on its own (auto-join by email domain, and claiming a domain)?
 *
 * Both have to hold:
 *   1. Supabase confirmed the address (`email_confirmed_at`), and
 *   2. a sign-in identity for THAT address says its provider verified it:
 *      `identity_data.email_verified === true` (a real boolean; a string
 *      "true" or a missing flag is not taken on trust).
 *
 * Microsoft (Supabase's `azure` provider) is held to more. Entra ID lets a
 * tenant admin put any address in a user's `email` claim, and Supabase counts
 * that claim as verified whenever the `xms_edov` claim is absent. So an
 * Azure identity vouches only when it also carries `xms_edov` saying the
 * domain's owner verified the address. Another identity (Google, a confirmed
 * password account) can still vouch for the same address.
 *
 * When anything is missing or unclear the answer is no: the cost of a false
 * no is clicking an invite link; the cost of a false yes is a stranger in the
 * workspace.
 */

export interface IdentityLike {
  provider?: string | null
  identity_data?: Record<string, unknown> | null
}

export interface UserLike {
  email?: string | null
  email_confirmed_at?: string | null
  identities?: IdentityLike[] | null
}

const AZURE_PROVIDERS = new Set(['azure'])

function isTrue(value: unknown): boolean {
  return value === true
}

/** `xms_edov` arrives as a boolean, or as "1"/"true" when a tenant passes it as a string. */
function domainOwnerVerified(value: unknown): boolean {
  return value === true || value === 'true' || value === '1' || value === 1
}

function identityVouches(identity: IdentityLike, email: string): boolean {
  const data = identity.identity_data
  if (!data || typeof data !== 'object') return false
  const identityEmail = typeof data.email === 'string' ? data.email.trim().toLowerCase() : null
  if (identityEmail !== email) return false
  if (!isTrue(data.email_verified)) return false
  if (AZURE_PROVIDERS.has((identity.provider ?? '').toLowerCase())) {
    return domainOwnerVerified(data.xms_edov)
  }
  return true
}

export function hasVerifiedEmail(user: UserLike | null | undefined): boolean {
  if (!user) return false
  const email = user.email?.trim().toLowerCase()
  if (!email) return false
  if (!user.email_confirmed_at) return false
  const identities = Array.isArray(user.identities) ? user.identities : []
  return identities.some((identity) => identityVouches(identity, email))
}
