/**
 * The people who may use the admin panel, by address: ADMIN_EMAILS, a
 * comma-separated list (spaces and case don't matter). Unset or empty means
 * no admins. Named people, never "any @domain" (security review 2026-10-31),
 * because the `admin_env` cookie hands an admin the second ("production")
 * project's service-role client, and a new user or alias on a domain would
 * have been one on day one. An entry that isn't a whole address is dropped.
 *
 * A leaf (no imports), so client-safe modules can read it too: lib/admin.ts
 * gates the panel with it (isAuthorizedAdmin), and lib/billing/access.ts
 * exempts the same people from billing. Server-side only in practice: the
 * browser bundle has no ADMIN_EMAILS, so there it is always empty.
 *
 * The hosted service's database also exempts its admins from the AI usage
 * gate, by address in SQL (check_ai_usage_limit, migration 468). That list is
 * history and stays as it is; src/lib/__tests__/admin-emails-sql.test.ts
 * pins it to the hosted admins, whose ADMIN_EMAILS must name the same people.
 */

/** One whole address: a local part, @, a domain. No wildcard, no bare domain. */
const ADDRESS = /^[^@\s,*]+@[^@\s,*]+$/

/** Parse an ADMIN_EMAILS value: split on commas, trimmed, lower-cased, whole addresses only. */
export function parseAdminEmails(raw: string | null | undefined): ReadonlySet<string> {
  const emails = new Set<string>()
  for (const part of (raw ?? '').split(',')) {
    const email = part.trim().toLowerCase()
    if (ADDRESS.test(email)) emails.add(email)
  }
  return emails
}

let cache: { raw: string | undefined; emails: ReadonlySet<string> } | null = null

/** This deployment's admins (ADMIN_EMAILS). Empty when it names none. */
export function adminEmails(): ReadonlySet<string> {
  const raw = process.env.ADMIN_EMAILS
  if (!cache || cache.raw !== raw) cache = { raw, emails: parseAdminEmails(raw) }
  return cache.emails
}

/** Whether `email` is one of adminEmails() (trimmed, case-insensitive). */
export function isAdminEmail(email: string | null | undefined): boolean {
  return !!email && adminEmails().has(email.trim().toLowerCase())
}

/**
 * The email domain every admin shares, for Google's `hd` account-chooser hint
 * on the admin sign-in (a hint only: the ADMIN_EMAILS check is the gate).
 * Null when there are no admins or they span more than one domain.
 */
export function adminEmailDomain(): string | null {
  const domains = new Set([...adminEmails()].map((email) => email.slice(email.indexOf('@') + 1)))
  return domains.size === 1 ? [...domains][0] : null
}
