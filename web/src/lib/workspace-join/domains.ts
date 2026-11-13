/**
 * Which domain a workspace may list for join-by-domain.
 *
 * The domain is never typed: it is ALWAYS the domain of the verified address
 * of the owner or admin switching it on. A public, relay/alias, ISP or
 * throwaway mail domain is refused (strangers share those): JOIN_BLOCKED_DOMAINS,
 * the signup gate's FREE_EMAIL_DOMAINS (src/lib/auth/work-email.ts) plus
 * relay/alias services and more consumer ISPs.
 *
 * The extra domains are for joining ONLY. They are deliberately not in
 * FREE_EMAIL_DOMAINS or public.is_free_email_domain, which decide who may
 * sign up (and agent links, 436): an Apple Hide-My-Email address may still
 * create an account; it just can't open a workspace to everyone on its
 * domain. The claim is written by the server alone (service role), so no
 * SQL needs this list.
 *
 * Domains are compared in ASCII: an internationalised domain becomes its
 * punycode form (`bücher.example` → `xn--bcher-kva.example`), on both the
 * listing and the sign-in side, and anything that is not a plain host name
 * is refused with a reason rather than reaching the database.
 */
import { FREE_EMAIL_DOMAINS, emailDomain } from '@/lib/auth/work-email'
import { hasVerifiedEmail, type UserLike } from './verified-email'

/** Shared by strangers, so never a workspace's join domain (on top of FREE_EMAIL_DOMAINS). */
export const JOIN_ONLY_BLOCKED_DOMAINS: ReadonlySet<string> = new Set([
  // Relay and alias services: one domain, every user
  'privaterelay.appleid.com', 'mozmail.com', 'relay.firefox.com',
  'simplelogin.com', 'simplelogin.co', 'slmail.me', 'aleeas.com',
  'anonaddy.com', 'anonaddy.me', 'addy.io', 'passmail.net', 'passmail.com',
  'passinbox.com', '33mail.com', 'duck.com',
  // Consumer ISP mailboxes
  'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'cox.net', 'charter.net',
  'spectrum.net', 'earthlink.net', 'rr.com', 'roadrunner.com', 'frontier.com',
  'windstream.net', 'centurylink.net', 'xfinity.com', 'btinternet.com', 'sky.com',
  'virginmedia.com', 'ntlworld.com', 'talktalk.net', 'blueyonder.co.uk', 'orange.fr',
  'free.fr', 'wanadoo.fr', 't-online.de', 'web.de', 'libero.it', 'shaw.ca',
  'rogers.com', 'bell.net', 'sympatico.ca', 'telus.net', 'videotron.ca',
  'optusnet.com.au', 'bigpond.com', 'bigpond.net.au', 'iinet.net.au',
])

/** Every domain a workspace may not list for join-by-domain. */
export const JOIN_BLOCKED_DOMAINS: ReadonlySet<string> = new Set([...FREE_EMAIL_DOMAINS, ...JOIN_ONLY_BLOCKED_DOMAINS])

const DOMAIN_SHAPE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

/** A domain as stored and compared: lowercased ASCII (punycode for an IDN), or null when it isn't a host name. */
export function normalizeDomain(raw: string | null | undefined): string | null {
  if (!raw) return null
  let domain = raw.trim().toLowerCase().replace(/\.$/, '')
  if (!domain) return null
  if (/[^\x20-\x7e]/.test(domain)) {
    try {
      domain = new URL(`http://${domain}`).hostname
    } catch {
      return null
    }
  }
  if (domain.length < 3 || domain.length > 253 || !DOMAIN_SHAPE.test(domain)) return null
  return domain
}

/** The ASCII domain of an address, or null. */
export function addressDomain(email: string | null | undefined): string | null {
  return normalizeDomain(emailDomain(email))
}

/** Is this domain a public / relay / ISP / throwaway mail provider (for joining)? */
export function isPublicEmailDomain(domain: string | null | undefined): boolean {
  if (!domain) return false
  return JOIN_BLOCKED_DOMAINS.has(domain.trim().toLowerCase())
}

export type ClaimableDomain =
  | { ok: true; domain: string }
  | {
      ok: false
      domain: string | null
      reason: 'no_email' | 'unsupported_domain' | 'unverified' | 'public_provider'
    }

/** The domain this person may switch join-by-domain on for: their own verified one. */
export function claimableDomain(user: UserLike | null | undefined): ClaimableDomain {
  const raw = emailDomain(user?.email)
  if (!raw) return { ok: false, domain: null, reason: 'no_email' }
  const domain = normalizeDomain(raw)
  if (!domain) return { ok: false, domain: raw, reason: 'unsupported_domain' }
  if (isPublicEmailDomain(domain)) return { ok: false, domain, reason: 'public_provider' }
  if (!hasVerifiedEmail(user)) return { ok: false, domain, reason: 'unverified' }
  return { ok: true, domain }
}

/** One line on why this person can't switch it on, for the settings page and the API. */
export function claimRefusalText(result: ClaimableDomain): string | null {
  if (result.ok) return null
  switch (result.reason) {
    case 'public_provider':
      return `@${result.domain} is a public or shared email provider, so anyone could use it. Sign in with your work address to turn this on.`
    case 'unverified':
      return 'Your email address is not verified yet.'
    case 'unsupported_domain':
      return `@${result.domain} can’t be used as a workspace domain.`
    default:
      return 'Your account has no email address to take a domain from.'
  }
}
