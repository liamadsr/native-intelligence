/**
 * CRM noise filter (GEN-139).
 *
 * Contact auto-creation pollutes the CRM: GitHub bots, Chase, Equinox, and
 * Nelnet land as "contacts", and in one real workspace 110 of 167 contacts had
 * full_name == email address. A CRM full of no-reply senders and transactional
 * bots is not a substrate the sales-shaped skills can stand on.
 *
 * This is a pure predicate applied at the AUTO-creation seams (email sync,
 * calendar sync, capture participants) — NOT at manual creation. A user who
 * deliberately adds billing@vendor.com is making a real choice; the email
 * sync ingesting noreply@github.com is not. The caller passes `source`, and
 * only the auto sources are filtered (see shouldAutoCreateContact).
 *
 * Governing bias: this only ever REFUSES to CREATE new junk. It never touches,
 * merges, or deletes an existing contact — so there is no data-loss surface.
 * The worst case is a borderline real contact not auto-created; the user can
 * still add them manually, and they'll be re-offered on the next human-shaped
 * interaction. We bias toward NOT creating on weak signal, because a CRM the
 * user trusts is worth more than one extra auto-captured lead.
 */

/**
 * Local-parts (the bit before @) that denote a role/transactional/automated
 * mailbox rather than a person. Matched as the whole local-part OR as a
 * prefix/suffix segment (so `noreply-123`, `github-notifications` also hit).
 */
const ROLE_LOCALPARTS = [
  'noreply', 'no-reply', 'no_reply', 'donotreply', 'do-not-reply', 'do_not_reply',
  'notifications', 'notification', 'notify', 'alerts', 'alert', 'updates',
  'support', 'help', 'helpdesk', 'contact', 'info', 'hello', 'hi', 'team',
  'admin', 'administrator', 'root', 'postmaster', 'mailer-daemon', 'mailerdaemon',
  'bounce', 'bounces', 'delivery', 'mail', 'email', 'newsletter', 'news',
  'billing', 'invoices', 'invoice', 'receipts', 'receipt', 'payments', 'payment',
  'accounts', 'accounting', 'orders', 'order', 'sales', 'marketing',
  'security', 'privacy', 'legal', 'compliance', 'abuse', 'feedback',
  'careers', 'jobs', 'hr', 'recruiting', 'press', 'media',
  'bot', 'bots', 'automated', 'auto', 'system', 'daemon', 'service', 'services',
  'webmaster', 'hostmaster', 'nobody', 'unsubscribe', 'reply', 'replies',
  'confirm', 'confirmation', 'verify', 'verification', 'account', 'members',
  'concierge', 'welcome', 'store', 'shop', 'community', 'events', 'event',
  'rewards', 'offers', 'deals', 'promo', 'promotions', 'digest', 'weekly',
]

/**
 * Sub-domain labels that mark a marketing/transactional mail stream even when
 * the local-part looks human (e.g. americanexpress@WELCOME.americanexpress.com,
 * disneyplus@TRX.MAIL2.disneyplus.com). If ANY of these appears as a dot-
 * delimited label in the domain, the sender is a brand mail stream, not a
 * person.
 */
const MARKETING_SUBDOMAIN_LABELS = new Set([
  'welcome', 'mail2', 'mail1', 'trx', 'mailer', 'mailers', 'email', 'emails',
  'e', 'em', 'news', 'newsletter', 'marketing', 'notify', 'notifications',
  'reply', 'noreply', 'no-reply', 'send', 'sender', 'bounce', 'bounces',
  'campaign', 'campaigns', 'promo', 'offers', 'account', 'accounts', 'info',
])

/**
 * Domains (or domain suffixes) whose mail is essentially always automated /
 * transactional, so no sender from them is a person worth a CRM row.
 */
const NOISE_DOMAIN_SUFFIXES = [
  'users.noreply.github.com',
  'noreply.github.com',
  'github.com', // notifications@github.com etc — GH person mail uses users.noreply
  'sndr.email', 'bounce.email', 'bounces.email',
  'mailchimp.com', 'mailchimpapp.net', 'sendgrid.net', 'sendgrid.com',
  'amazonses.com', 'mailgun.org', 'postmarkapp.com', 'sparkpostmail.com',
  'intercom-mail.com', 'intercom.io', 'zendesk.com',
  'e.stripe.com', 'stripe.com',
  'reply.github.com',
]

/**
 * Sub-strings that, when they appear in the local-part, signal an automated
 * or per-message mailbox (VERP / bounce tokens, long hashes).
 */
const NOISE_LOCALPART_SUBSTRINGS = ['mailer-daemon', 'bounce', 'noreply', 'no-reply', 'donotreply']

function localPart(email: string): string {
  return email.split('@')[0]?.toLowerCase() ?? ''
}

function domainOf(email: string): string {
  return email.split('@')[1]?.toLowerCase() ?? ''
}

/** Split a local-part into its word segments (split on . _ - + digits). */
function localSegments(local: string): string[] {
  return local
    .split(/[.\-_+]|\d+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** True if the email address itself denotes a role/bot/transactional mailbox. */
export function isRoleOrBotAddress(email: string): boolean {
  const e = email.trim().toLowerCase()
  if (!e.includes('@')) return true // not a real address → not a person

  const domain = domainOf(e)
  if (NOISE_DOMAIN_SUFFIXES.some((d) => domain === d || domain.endsWith(`.${d}`))) return true

  // A marketing/transactional SUBDOMAIN (welcome., trx.mail2., e., mailer.)
  // marks a brand mail stream even with a human-looking local-part. We only
  // treat a label as marketing when it's a genuine subdomain — i.e. the domain
  // has 3+ labels (label.brand.tld), so a 2-label root like "email.com" or a
  // company whose root happens to match isn't caught.
  const labels = domain.split('.')
  if (labels.length >= 3) {
    const subdomainLabels = labels.slice(0, -2) // drop brand + tld
    if (subdomainLabels.some((l) => MARKETING_SUBDOMAIN_LABELS.has(l))) return true
  }

  const local = localPart(e)
  if (NOISE_LOCALPART_SUBSTRINGS.some((s) => local.includes(s))) return true

  // Whole local-part is a role word, or any of its segments is.
  if (ROLE_LOCALPARTS.includes(local)) return true
  const segs = localSegments(local)
  if (segs.some((s) => ROLE_LOCALPARTS.includes(s))) return true

  // A long hex/opaque token local-part (e.g. a per-message reply address) is
  // machine-generated, not a person.
  if (/^[0-9a-f]{16,}$/.test(local)) return true

  return false
}

/**
 * True if `fullName` carries a genuine human-name signal.
 *
 * The pollution pattern (110/167 contacts) is `full_name == email ADDRESS` —
 * the whole "chase@chase.com" or "noreply@equinox.com" stored as the name. That
 * is what we reject. A single given name that happens to equal the email's
 * local-part is NOT junk — "Toby" <toby@dial8.ai> is a real person whose email
 * is seeded from their name; rejecting that would drop legitimate humans.
 *
 * Accepts: any name that isn't empty, isn't an email address, and isn't a bare
 * role word. Rejects: empty, a name containing '@' (it's an address), the email
 * verbatim, or a single role word ("Billing", "Support").
 */
export function hasHumanNameSignal(fullName: string | null | undefined, email: string): boolean {
  const name = (fullName ?? '').trim()
  if (name.length === 0) return false

  const e = email.trim().toLowerCase()
  const nameLower = name.toLowerCase()

  // name is literally the email, or contains an @ (it's an address, not a name).
  // This is the core "name == email" pollution signal.
  if (nameLower === e) return false
  if (name.includes('@')) return false

  // A single bare role word as the name ("Billing", "Support") is not a person.
  if (!/\s/.test(name) && ROLE_LOCALPARTS.includes(nameLower)) return false

  // Must contain at least one letter (a name that's only digits/punctuation is
  // not a human name — e.g. a phone number or an id landed in the name field).
  if (!/\p{L}/u.test(name)) return false

  return true
}

/**
 * Humanize an email's local-part into a display name.
 *
 * Used when a meeting-derived contact arrives with no usable name (the
 * provider sent none, or sent the address back as the "name"). Storing the
 * raw ADDRESS as the name is the exact pollution this module exists to stop,
 * so we store one of two things instead:
 *
 *   - A confident guess, when the local-part is clearly a person's name —
 *     2+ alphabetic segments split on . _ or -, each ≥2 letters, no digits
 *     anywhere ("nikhil.rao" → "Nikhil Rao"). This may simply stand.
 *   - Otherwise the bare local-part ("jsmith42" → "jsmith42"), which
 *     `isPlaceholderName` in crm/enrichment.ts recognizes as a placeholder,
 *     so web enrichment fills the real name in later.
 *
 * Never returns the full address, and never returns empty for a real address.
 */
export function placeholderNameFromEmail(email: string): string {
  const local = (email.split('@')[0] ?? '').trim()
  if (local === '') return ''

  const segments = local.split(/[._-]+/).filter((s) => s.length > 0)
  const looksLikePerson =
    segments.length >= 2 && segments.every((s) => s.length >= 2 && /^\p{L}+$/u.test(s))

  // Not name-shaped → hand back the raw local-part verbatim. isPlaceholderName
  // matches on the local-part exactly, so any transformation here (casing
  // included) would hide the row from the enricher.
  if (!looksLikePerson) return local

  return segments
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
    .join(' ')
}

/** Contact-creation sources that are AUTOMATED (filtered) vs user-intended. */
const AUTO_SOURCES = new Set(['email_sync', 'calendar_sync', 'capture_participant'])

/**
 * Auto sources where the INTERACTION itself is the human signal.
 *
 * Being on a real meeting's invite list, or in the room for a capture, is a
 * deliberate human act by someone — so a missing display name is a gap in the
 * provider's payload, not evidence of a bot. (Google routinely omits
 * `displayName` for external attendees; that is exactly how a real person like
 * nikhil.rao@pagetrail.ai ended up with no CRM row at all.) These sources
 * still have to clear the role/bot address bar.
 *
 * `email_sync` is deliberately NOT in here: an inbound message proves nothing
 * about the sender being a person, which is the whole premise of GEN-139's
 * newsletter/transactional filter.
 */
const INTERACTION_SOURCES = new Set(['calendar_sync', 'capture_participant'])

export interface ContactCandidate {
  email: string
  fullName: string | null | undefined
  /** creation source; only AUTO_SOURCES are filtered. */
  source?: string | null
}

export interface NoiseVerdict {
  create: boolean
  reason?: string
}

/**
 * Decide whether an auto-creation candidate should become a contact.
 *
 * Manual / member sources ALWAYS pass (the user or the system chose them).
 * Auto sources must clear the role/bot address bar. `email_sync` must ALSO
 * carry a human-name signal; the meeting-derived sources (calendar / capture
 * participant) do not, because the invitation is itself the human signal — see
 * INTERACTION_SOURCES. Callers creating from those sources are responsible for
 * storing `placeholderNameFromEmail(email)` rather than the address itself.
 */
export function shouldAutoCreateContact(candidate: ContactCandidate): NoiseVerdict {
  const source = candidate.source ?? 'manual'
  if (!AUTO_SOURCES.has(source)) return { create: true }

  if (isRoleOrBotAddress(candidate.email)) {
    return { create: false, reason: 'role/transactional/bot address' }
  }
  if (INTERACTION_SOURCES.has(source)) return { create: true }
  if (!hasHumanNameSignal(candidate.fullName, candidate.email)) {
    return { create: false, reason: 'no human-name signal (name missing or equals the email)' }
  }
  return { create: true }
}
