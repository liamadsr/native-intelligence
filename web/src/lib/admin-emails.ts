/**
 * The people who may use the admin panel, by address (security review
 * 2026-10-31): named, not "any @dial8.ai", because the `admin_env` cookie
 * hands an admin the PROD service-role client, and a new Workspace user or
 * alias on the domain would have been one on day one. PROD on 10-31 had two
 * @dial8.ai accounts; only this one shows admin use (the signup invites it
 * sent). Add a person here, never a domain.
 *
 * A leaf (no imports), so client-safe modules can read it too: lib/admin.ts
 * re-exports it for isAuthorizedAdmin, and lib/billing/access.ts exempts the
 * same people from billing. The database's usage gate names them too
 * (check_ai_usage_limit, migration 468): change both together, or
 * src/lib/__tests__/admin-emails-sql.test.ts fails.
 */
export const ADMIN_EMAILS: ReadonlySet<string> = new Set(['liam@dial8.ai'])

/** Whether `email` is one of ADMIN_EMAILS (trimmed, case-insensitive). */
export function isAdminEmail(email: string | null | undefined): boolean {
  return !!email && ADMIN_EMAILS.has(email.trim().toLowerCase())
}
