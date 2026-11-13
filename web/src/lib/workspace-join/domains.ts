/**
 * Which domain a workspace may claim for auto-join.
 *
 * The domain is never typed: it is ALWAYS the domain of the verified address
 * of the owner or admin switching auto-join on. A public mail provider is
 * refused (anyone can get an address there). The list of those providers is
 * the one the signup gate already keeps, FREE_EMAIL_DOMAINS in
 * src/lib/auth/work-email.ts: one list in one module, broader than the
 * well-known names (ISP and throwaway domains are refused too).
 */
import { FREE_EMAIL_DOMAINS, emailDomain } from '@/lib/auth/work-email'
import { hasVerifiedEmail, type UserLike } from './verified-email'

export { emailDomain }

/** Is this domain a public / free mail provider (gmail.com, outlook.com, …)? */
export function isPublicEmailDomain(domain: string | null | undefined): boolean {
  if (!domain) return false
  return FREE_EMAIL_DOMAINS.has(domain.trim().toLowerCase())
}

export type ClaimableDomain =
  | { ok: true; domain: string }
  | { ok: false; domain: string | null; reason: 'no_email' | 'unverified' | 'public_provider' }

/** The domain this person may switch auto-join on for: their own verified one. */
export function claimableDomain(user: UserLike | null | undefined): ClaimableDomain {
  const domain = emailDomain(user?.email)
  if (!domain) return { ok: false, domain: null, reason: 'no_email' }
  if (isPublicEmailDomain(domain)) return { ok: false, domain, reason: 'public_provider' }
  if (!hasVerifiedEmail(user)) return { ok: false, domain, reason: 'unverified' }
  return { ok: true, domain }
}

/** One line on why the switch can't be turned on, for the settings page. */
export function claimRefusalText(result: ClaimableDomain): string | null {
  if (result.ok) return null
  switch (result.reason) {
    case 'public_provider':
      return `@${result.domain} is a public email provider, so anyone could join. Sign in with your work address to use this.`
    case 'unverified':
      return 'Your email address is not verified yet, so it can’t open the workspace to your domain.'
    default:
      return 'Your account has no email address to take a domain from.'
  }
}

/** The clash message when another workspace already uses the domain. */
export function domainClashText(domain: string): string {
  return `Another workspace already uses @${domain}`
}
