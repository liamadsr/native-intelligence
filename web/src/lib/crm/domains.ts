/**
 * Pure domain helpers shared by CRM enrichment (./enrichment.ts), contact
 * dedup and prospecting, including code that ships to the browser (the
 * prospecting UI imports src/lib/prospecting/icp.ts, which normalizes
 * domains). Kept apart from ./enrichment.ts, which reaches Supabase's service
 * client and the person's plan search (server-only): nothing here imports
 * anything.
 */

/**
 * Free-mail domains that must never be treated as a company signal. This is
 * THE list for the TypeScript side — `contact-dedup.ts` and every other caller
 * reads it through {@link isPersonalDomain} rather than keeping a copy. Its
 * one remaining twin is `public.is_personal_email_domain` (migration 232),
 * which has to exist in SQL for the autolink trigger; drift between the two
 * produces phantom companies.
 */
const PERSONAL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'icloud.com', 'aol.com', 'protonmail.com', 'proton.me', 'live.com', 'me.com',
  'mail.com', 'ymail.com', 'msn.com', 'zoho.com', 'fastmail.com', 'gmx.com',
])

/**
 * Is this a free-mail / webmail domain, i.e. one that carries no company
 * signal? The single exported gate over {@link PERSONAL_DOMAINS}.
 *
 * Behaviour matches the private membership checks it replaces exactly: the
 * input is trimmed and lowercased, and anything falsy is `false` (not a
 * personal domain — the callers' guards handle empty values themselves).
 */
export function isPersonalDomain(domain: string | null | undefined): boolean {
  if (!domain) return false
  return PERSONAL_DOMAINS.has(domain.trim().toLowerCase())
}

/** Lowercased domain part of an email, or null. Free-mail domains are dropped:
 *  jane@gmail.com carries no company signal. */
export function companyDomainFromEmail(email: string | null | undefined): string | null {
  if (!email) return null
  const at = email.lastIndexOf('@')
  if (at < 0) return null
  const domain = email.slice(at + 1).trim().toLowerCase()
  if (!domain || !domain.includes('.')) return null
  if (PERSONAL_DOMAINS.has(domain)) return null
  return domain
}

/** Normalize a discovered domain to the `company.domain` storage form:
 *  lowercase, no scheme, no www., no path. Returns null when unusable. */
export function normalizeDomain(raw: string | null | undefined): string | null {
  if (!raw) return null
  let d = raw.trim().toLowerCase()
  d = d.replace(/^https?:\/\//, '')
  d = d.replace(/^www\./, '')
  d = d.split('/')[0].split('?')[0].split('#')[0]
  d = d.replace(/\.+$/, '')
  if (!d || !d.includes('.') || d.includes(' ')) return null
  return d
}
