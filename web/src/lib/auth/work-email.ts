/**
 * Work-email signup policy.
 *
 * Dial8 is a team product for businesses, so a NEW account must be created
 * with an email on a company-owned domain. Personal / free-mail addresses
 * (Gmail, Yahoo, Outlook.com, iCloud, …) cannot sign up.
 *
 * WHERE THE RULE IS ENFORCED. The gate that actually matters is server-side:
 * Supabase Auth's `before-user-created` hook calls
 * `public.hook_require_work_email` (migration 241), which rejects user
 * creation for free-mail domains on EVERY signup path — password, magic link
 * and Google OAuth alike. Nothing in this file is load-bearing for security;
 * it exists so the login form can say no BEFORE a round-trip, and so the
 * OAuth callback can translate the hook's rejection into a clear message.
 *
 * EXISTING USERS ARE UNAFFECTED. The hook runs only when a user row is about
 * to be created. A gmail.com account created before this policy shipped keeps
 * signing in normally, with password, magic link or Google — none of those
 * create a user, so the hook never fires for them.
 *
 * INVITED PEOPLE ARE EXEMPT. A pending workspace invite addressed to the
 * signup email lets a personal address through — the hook checks
 * `public.invite`, which is why the client pre-check is skipped when the
 * login form was reached from an invite link (`?redirect=/invite/...`).
 *
 * KEEP `FREE_EMAIL_DOMAINS` IN SYNC with `public.is_free_email_domain`
 * (migration 241). The database list is the one that decides; this list only
 * decides whether the form bothers the server. Drift is not a security bug,
 * just a worse error message (the server's) instead of the inline one.
 *
 * This list is deliberately BROADER than the CRM's `PERSONAL_DOMAINS`
 * (src/lib/crm/*), which answers a different question — "does this address
 * carry a company signal?" — and must stay conservative to avoid phantom
 * companies. A signup gate wants the opposite bias.
 */

export const FREE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  // Google
  'gmail.com', 'googlemail.com',
  // Microsoft
  'outlook.com', 'outlook.co.uk', 'hotmail.com', 'hotmail.co.uk', 'hotmail.fr',
  'live.com', 'live.co.uk', 'msn.com',
  // Yahoo
  'yahoo.com', 'yahoo.co.uk', 'yahoo.fr', 'yahoo.de', 'yahoo.ca', 'yahoo.com.au',
  'ymail.com', 'rocketmail.com',
  // Apple
  'icloud.com', 'me.com', 'mac.com',
  // Privacy-first / other consumer providers
  'proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me',
  'tutanota.com', 'tuta.io', 'tuta.com',
  'hey.com', 'fastmail.com', 'fastmail.fm', 'duck.com',
  'aol.com', 'mail.com', 'email.com', 'zoho.com', 'zohomail.com',
  'gmx.com', 'gmx.de', 'gmx.net', 'web.de', 't-online.de',
  'yandex.com', 'yandex.ru', 'mail.ru', 'bk.ru', 'inbox.ru', 'list.ru',
  'qq.com', '163.com', '126.com', 'sina.com', 'foxmail.com',
  'naver.com', 'daum.net', 'hanmail.net',
  'rediffmail.com', 'laposte.net', 'orange.fr', 'wanadoo.fr', 'free.fr', 'sfr.fr',
  'libero.it', 'virgilio.it', 'seznam.cz', 'op.pl', 'wp.pl', 'interia.pl',
  // US ISP mailboxes
  'comcast.net', 'att.net', 'sbcglobal.net', 'verizon.net', 'bellsouth.net',
  'cox.net', 'charter.net', 'earthlink.net', 'optonline.net',
  // Disposable / throwaway
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'temp-mail.org',
  'yopmail.com', 'sharklasers.com', 'trashmail.com', 'getnada.com',
])

/**
 * The message the server hook returns when it rejects a signup. The client
 * shows the same words so the inline pre-check and the server rejection read
 * identically. Also used as the marker the OAuth callback matches on.
 */
export const WORK_EMAIL_REQUIRED_MESSAGE =
  'Dial8 requires a business email to sign up. Personal addresses like Gmail or Yahoo aren\'t accepted.'

/** Short hint shown under the email field on the signup form. */
export const WORK_EMAIL_HINT = 'Business email required.'

/** `?error=` code the login page maps to WORK_EMAIL_REQUIRED_MESSAGE. */
export const WORK_EMAIL_REQUIRED_ERROR_CODE = 'work_email_required'

/** Lowercased domain part of an email, or null when there isn't a usable one. */
export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null
  const trimmed = email.trim().toLowerCase()
  const at = trimmed.lastIndexOf('@')
  if (at <= 0 || at === trimmed.length - 1) return null
  const domain = trimmed.slice(at + 1)
  return domain.includes('.') ? domain : null
}

/**
 * True when the address is on a free-mail / personal domain and therefore
 * may NOT create a new account. Malformed input is not "personal" — the
 * server (and the `type="email"` input) reject that on their own terms.
 */
export function isFreeEmailDomain(email: string | null | undefined): boolean {
  const domain = emailDomain(email)
  return domain !== null && FREE_EMAIL_DOMAINS.has(domain)
}

/** True when a syntactically usable address is NOT on a free-mail domain. */
export function isWorkEmail(email: string | null | undefined): boolean {
  const domain = emailDomain(email)
  return domain !== null && !FREE_EMAIL_DOMAINS.has(domain)
}

/**
 * Does an auth error (from Supabase directly, or an `error_description`
 * carried on an OAuth redirect) originate from the work-email hook?
 *
 * Matched on wording rather than a code because Supabase Auth forwards a
 * Postgres hook's `message` verbatim and does not surface a stable code for
 * hook rejections. The phrase "business email" appears in no other error
 * Dial8 or Supabase emits on the signup path.
 */
export function isWorkEmailRejection(message: string | null | undefined): boolean {
  return !!message && /business email/i.test(message)
}
