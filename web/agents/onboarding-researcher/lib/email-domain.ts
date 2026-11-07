/**
 * Email-domain classification for the research branch decision.
 *
 * A PERSONAL domain (gmail, outlook, icloud, proton, …) tells us nothing about
 * where the person works, so the agent skips company research (light mode). A
 * BUSINESS domain is a strong signal of an employer/org worth researching.
 *
 * This is a pure, deterministic helper so the branch is testable and the same
 * verdict is available to the kickoff route, the instructions, and tests.
 */

/**
 * Known consumer/webmail domains. Superset of the app's PERSONAL_DOMAINS in
 * src/lib/crm/contacts.ts, extended with the providers named in the Phase-1
 * spec (proton/pm.me, hey, gmx, fastmail, aol, me, googlemail, …). Lowercase.
 */
export const PERSONAL_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  // Google
  'gmail.com',
  'googlemail.com',
  // Microsoft
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  // Yahoo / AOL
  'yahoo.com',
  'ymail.com',
  'aol.com',
  // Apple
  'icloud.com',
  'me.com',
  'mac.com',
  // Proton
  'proton.me',
  'protonmail.com',
  'pm.me',
  // Other consumer webmail
  'gmx.com',
  'gmx.net',
  'mail.com',
  'fastmail.com',
  'fastmail.fm',
  'hey.com',
  'zoho.com',
  'yandex.com',
  'tutanota.com',
  'hushmail.com',
])

/** Lowercased domain part of an email address, or null when malformed. */
export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null
  const at = email.lastIndexOf('@')
  if (at < 0) return null
  const domain = email.slice(at + 1).trim().toLowerCase()
  return domain.length > 0 && domain.includes('.') ? domain : null
}

export interface DomainClassification {
  /** Lowercased domain, or null when the email is malformed. */
  domain: string | null
  /** True for a known consumer/webmail domain (or a malformed/absent email). */
  isPersonal: boolean
  /** True only for a well-formed, non-personal (business) domain. */
  isBusiness: boolean
}

/**
 * Classify an email into personal (light mode) vs business (company research).
 * A malformed/absent email is treated as personal (isBusiness = false) — with
 * no usable domain there is nothing to company-research.
 */
export function classifyEmailDomain(
  email: string | null | undefined
): DomainClassification {
  const domain = emailDomain(email)
  if (!domain) return { domain: null, isPersonal: true, isBusiness: false }
  const isPersonal = PERSONAL_EMAIL_DOMAINS.has(domain)
  return { domain, isPersonal, isBusiness: !isPersonal }
}

/** Convenience: true when the email's domain is a business domain. */
export function isBusinessEmail(email: string | null | undefined): boolean {
  return classifyEmailDomain(email).isBusiness
}
