/**
 * Candidate identity — Layer 1 of the dedup story (spec §6).
 *
 * Every candidate reduces to one stable `candidate_key` BEFORE any comparison
 * happens, and that key is what `UNIQUE (list_id, candidate_key)` (migration
 * 248) and the whole exclusion set operate over. A candidate that cannot
 * produce a key is `invalid` and never becomes a row.
 *
 * Both normalizers are deliberately borrowed rather than reimplemented:
 *   * `normalizeDomain` is the same function `company.domain`'s uniqueness
 *     relies on, so the set difference against the CRM is EXACT rather than
 *     approximate;
 *   * `normalizeLinkedInProfileUrl` is the same one the contact enrichment
 *     path uses to compare a profile against its citations.
 *
 * Nothing here touches the network or the database — pure string work.
 */
import { isPersonalDomain, normalizeDomain } from '@/lib/crm/domains'
import { normalizeLinkedInProfileUrl } from '@/lib/exa/deep-search'

/**
 * The `candidate_key` for a company: its normalized primary domain.
 *
 * Accepts a bare domain or a full URL — discovery harvests both (`companies[]`
 * gives `domain`, `results[]` gives a URL) — and returns null for anything
 * unusable, which the caller records as `outcome='invalid'`.
 *
 * Personal / webmail domains are rejected: `gmail.com` is a mail provider that
 * turned up as a result host, never a prospect. Rejecting it here is what
 * `suppressed_by='personal_domain'` is for, and it is the same rule
 * `companyDomainFromEmail()` applies on the CRM side.
 */
export function companyCandidateKey(domainOrUrl: string | null | undefined): string | null {
  const domain = normalizeDomain(domainOrUrl)
  if (!domain) return null
  if (isPersonalDomain(domain)) return null
  return domain
}

export interface PersonCandidateKeyInput {
  /** Their LinkedIn profile URL, in any form (full URL, bare host+path). */
  linkedinUrl?: string | null
  email?: string | null
  /** Full name. Only usable together with `domain`. */
  name?: string | null
  /** The ACCOUNT's domain — the company the person was found at. */
  domain?: string | null
}

/**
 * The `candidate_key` for a person, in strict preference order:
 *
 *   1. `linkedin.com/in/<slug>` — the strongest identity, and the common one:
 *      the anchored people search returns LinkedIn URLs for essentially every
 *      person it finds. This is why it is the PRIMARY key and not a fallback.
 *   2. `lower(email)` — exact, when we have one. Most discovered people do not.
 *   3. `lower(name)@domain` — a weak last resort, and deliberately SCOPED TO
 *      THE CANDIDATE ACCOUNT rather than workspace-global, because two people
 *      with the same name at two companies are two people. Without a domain
 *      this tier does not apply at all.
 *
 * Returns null when none of the three can be produced — the caller records the
 * candidate as `invalid` rather than inventing an identity.
 */
export function personCandidateKey(input: PersonCandidateKeyInput): string | null {
  const profile = normalizeLinkedInProfileUrl(input.linkedinUrl)
  if (profile) return profile

  const email = input.email?.trim().toLowerCase()
  // A "name" masquerading as an email ("Sarah Hale (ext)") has no '@' and
  // must not become a key — the same guard findOrCreateContact applies.
  if (email && email.includes('@') && !email.startsWith('@') && !email.endsWith('@')) {
    return email
  }

  // The weak tier needs BOTH halves. A bare name is not an identity, and a
  // personal-domain account is not an account.
  const domain = companyCandidateKey(input.domain)
  const name = normalizeCandidateName(input.name)
  if (domain && name) return `${name}@${domain}`

  return null
}

/**
 * Collapse a display name to the comparable form used in the weak person key:
 * lowercase, punctuation dropped, internal whitespace collapsed to one space.
 * "Dr. Sarah  O'Brien " and "dr sarah obrien" produce the same key, which is
 * the point — the tier exists to catch the same person written two ways in one
 * account, not to be a globally unique identifier.
 */
function normalizeCandidateName(raw: string | null | undefined): string | null {
  if (!raw) return null
  const cleaned = raw
    .toLowerCase()
    // Strip anything that is not a letter, digit or space (unicode-aware, so
    // accented names survive intact).
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return null
  // A single character is noise, not a name.
  if (cleaned.length < 2) return null
  return cleaned
}
