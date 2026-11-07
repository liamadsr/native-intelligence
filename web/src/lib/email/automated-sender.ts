import { isNoReplyAddress, mailboxAddresses } from './reply-policy'

/**
 * Automated mail never gets a drafted reply (Liam, 2026-10-15: the old daily
 * pass drafted to `gustonoreply@gusto.com`, a `reply+<token>@` notification
 * address and an `infobk@` sender). Deterministic and pure: no model, no
 * provider call. The index (src/lib/crm/email-sync.ts) records such a thread
 * as `needs_reply = false` with an automated category, and the reply gate
 * (src/lib/crm/email-reply-gate.ts) refuses it before any model call, so
 * arrival, the 05:00 safety net, the held-thread refresh and the agent's
 * automatic `create_email_draft` all stop here. The Jev reply decision keeps
 * deciding everything these rules let through.
 *
 * The rules, on the newest sent message of the thread:
 *  1. No-reply destination: the address the reply would go to (Reply-To when
 *     present, else From; the To of the person's own follow-up) has a local
 *     part CONTAINING noreply / no-reply / no_reply / no.reply, donotreply
 *     (any separators), notreply, mailer-daemon, postmaster or bounce, case
 *     insensitive and anywhere (`gustonoreply`, `alerts-noreply`,
 *     `bounces+x`), or a `no-reply` domain label (reply-policy.ts). A name
 *     that merely contains "reply" (`replyhq-founder@`) is NOT one.
 *  2. Automated-mail headers: Auto-Submitted (anything but `no`), Precedence
 *     bulk | list | junk | auto_reply, X-Autoreply / X-Autorespond,
 *     X-Auto-Response-Suppress naming All or OOF, List-Unsubscribe or List-Id
 *     (a mailing list or newsletter; this includes Google Groups mail).
 *  3. Notification addresses: a `reply+<token>@` / `reply-<token>@` local part
 *     whose token is long (16+ characters, with a digit); a local part that is
 *     itself an opaque token (32+ letters and digits with 6+ digits, or a
 *     UUID: Liam, 2026-10-20, a Square receipt's Reply-To was 64 hex
 *     characters `@reply2.squareup.com`); or a local part that
 *     is (or ends in, after a separator) notification(s), alert(s), update(s),
 *     news or newsletter(s). Automated UNLESS the person has sent a message in
 *     the thread: then they are conversing with it (a GitHub thread they
 *     answer by mail), and the reply decision is left to Jev.
 *     A reply-relay domain counts too (Liam, 2026-10-27, GEN-1164: Square's
 *     `reply2.squareup.com`, Sentry's `reply.getsentry.com`, Luma's
 *     `user.luma-mail.com`): a subdomain of one in RELAY_DOMAINS. Only
 *     services that relay their own notices: a marketplace relaying a buyer
 *     is a person writing.
 *  4. Transactional senders (GEN-1164: Stripe's `invoice+statements@`,
 *     Amazon's `auto-confirm@`, `receipts@`, `billing@`, `marketing@`,
 *     `events@`): the FROM address, whatever its Reply-To says, has a local
 *     part (before any `+tag`) that IS one of TRANSACTIONAL_ROLES, or is on a
 *     reply-relay domain. A receipt names a human merchant or support address
 *     in Reply-To, which rule 3 never sees. The same exception as rule 3:
 *     once the person has sent in the thread, Jev decides. A role mailbox's
 *     question (an events@ asking for a menu choice) still reaches the agent
 *     through the understanding pass (E2), not as a draft.
 *  5. Calendar mail (GEN-1164: invites and RSVPs are answered in the calendar,
 *     never by a drafted email): the newest message's own subject starts
 *     "Invitation:", "Updated invitation:", "Accepted:", "Declined:",
 *     "Canceled event:" and the like, AND carries the calendar's own shape: an
 *     " @ <date>" in the subject, or an .ics file. A person's "Invitation:
 *     speak at our conference" is neither. No exception.
 * Every destination must match rule 1 or 3: a human address beside a no-reply
 * one in Reply-To keeps the thread. Only addresses count, never display names
 * (rule 5 reads the subject: a person's "Re: Invitation: …" is not one).
 */

/** Why a message counts as automated. Fixed strings, safe to log or show a model. */
export type AutomatedReason =
  | 'no_reply_address'
  | 'notification_address'
  | 'auto_submitted'
  | 'precedence'
  | 'autoreply'
  | 'auto_response_suppress'
  | 'mailing_list'
  | 'transactional_sender'
  | 'calendar'
  /** Gmail filed it under Promotions or Forums (the reply gate, src/lib/crm/email-reply-gate.ts). */
  | 'bulk_category'
  /** Gmail filed it under Updates, from nobody the person knows (the reply gate). */
  | 'updates_category'

/** The headers rule 2 reads. Gmail's metadata read asks for these by name (src/lib/crm/email-sync.ts). */
export const AUTOMATED_HEADER_NAMES = [
  'Auto-Submitted',
  'Precedence',
  'X-Autoreply',
  'X-Autorespond',
  'X-Auto-Response-Suppress',
  'List-Unsubscribe',
  'List-Id',
] as const

/** A message's headers as a lookup by name (any case); '' when absent. */
export type HeaderLookup = (name: string) => string

/** A header lookup over a provider's `{ name, value }` list (Gmail payload.headers, Graph internetMessageHeaders). */
export function headerLookup(headers: ReadonlyArray<{ name?: unknown; value?: unknown }> | null | undefined): HeaderLookup {
  const list = Array.isArray(headers) ? headers : []
  return (name) => {
    const wanted = name.toLowerCase()
    const found = list.find((h) => typeof h?.name === 'string' && h.name.toLowerCase() === wanted)
    return typeof found?.value === 'string' ? found.value : ''
  }
}

/** Rule 2: the automated-mail header a message carries, or null. */
export function automatedHeaderReason(header: HeaderLookup): AutomatedReason | null {
  const value = (name: string) => header(name).trim().toLowerCase()
  const autoSubmitted = value('Auto-Submitted').split(';')[0].trim()
  if (autoSubmitted && autoSubmitted !== 'no') return 'auto_submitted'
  if (['bulk', 'list', 'junk', 'auto_reply', 'auto-reply'].includes(value('Precedence'))) return 'precedence'
  for (const name of ['X-Autoreply', 'X-Autorespond']) {
    const v = value(name)
    if (v && !['no', 'false', '0'].includes(v)) return 'autoreply'
  }
  const suppress = value('X-Auto-Response-Suppress').split(/[\s,;]+/)
  if (suppress.includes('all') || suppress.includes('oof')) return 'auto_response_suppress'
  if (value('List-Unsubscribe') || value('List-Id')) return 'mailing_list'
  return null
}

/**
 * Reply-relay domains a service sends its own notices through (rules 3 and
 * 4), matched as a parent of the domain: `reply2.squareup.com`,
 * `messaging.squareup.com`, `reply.getsentry.com`, `user.luma-mail.com`.
 */
export const RELAY_DOMAINS = ['luma-mail.com', 'getsentry.com', 'squareup.com'] as const

/** A subdomain of a RELAY_DOMAINS entry. */
function isRelayDomain(domain: string): boolean {
  return RELAY_DOMAINS.some((relay) => domain.endsWith(`.${relay}`))
}

/** Rule 3 without the conversing exception: a notification-style address. */
export function isNotificationAddress(address: string): boolean {
  const addresses = mailboxAddresses(address)
  if (addresses.length !== 1) return false
  const [local, domain] = addresses[0].split('@')
  if (isRelayDomain(domain)) return true
  const replyToken = local.match(/^reply[+-]([a-z0-9._=-]+)$/)
  if (replyToken && replyToken[1].length >= 16 && /\d/.test(replyToken[1])) return true
  const base = local.split('+')[0]
  if (isOpaqueToken(base)) return true
  return /(?:^|[._-])(?:notifications?|alerts?|updates?|news|newsletters?)$/.test(base)
}

/**
 * Rule 4's role mailboxes: what receipts, statements, order confirmations,
 * marketing and event blasts are sent from. The whole local part before any
 * `+tag` (`invoice+statements`, `auto-confirm`), never part of a person's
 * (`jane.event`, `head-of-marketing`, `eventsmith`).
 */
export const TRANSACTIONAL_ROLES = [
  'invoice', 'invoices', 'invoicing', 'receipt', 'receipts', 'billing', 'statement', 'statements',
  'auto-confirm', 'confirmation', 'confirmations', 'order-update', 'order-updates',
  'marketing', 'promo', 'promotions', 'event', 'events',
] as const

const TRANSACTIONAL_LOCAL = new RegExp(`^(?:${TRANSACTIONAL_ROLES.map((r) => r.replace('-', '[._-]?')).join('|')})$`)

/** Rule 4 without the conversing exception: a transactional FROM address (a role mailbox, or a reply relay). */
export function isTransactionalSender(address: string): boolean {
  const addresses = mailboxAddresses(address)
  if (addresses.length !== 1) return false
  const [local, domain] = addresses[0].split('@')
  return isRelayDomain(domain) || TRANSACTIONAL_LOCAL.test(local.split('+')[0])
}

const CALENDAR_SUBJECT =
  /^(?:(?:updated |new )?invitation|invitation from google calendar|(?:new|updated|canceled|cancelled) event|event (?:updated|canceled|cancelled)|canceled|cancelled|accepted|declined|tentative(?:ly accepted)?)(?: with note)?\s*:/i

/** A calendar's " @ Thu Oct 16, 2026 3pm" in a subject: an @ followed by a date or time. */
const CALENDAR_WHEN = /\s@\s[^@]*(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\d{4})/i

/**
 * Rule 5: calendar mail, from the message's own subject and attachment
 * names: a calendar prefix with the calendar's own shape (an " @ <when>" or
 * an .ics file). A reply or forward of an invite ("Re: Invitation: …") is a
 * person writing, and keeps the thread. Pure.
 */
export function isCalendarMessage(message: { subject?: string | null; attachmentNames?: readonly string[] | null }): boolean {
  const subject = (message.subject ?? '').trim()
  if (!CALENDAR_SUBJECT.test(subject)) return false
  return CALENDAR_WHEN.test(subject) || (message.attachmentNames ?? []).some((name) => /\.ics$/i.test(name.trim()))
}

/** A local part no person picks: 32+ letters and digits with 6+ digits, or a UUID. */
function isOpaqueToken(local: string): boolean {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(local)) return true
  return /^[a-z0-9]{32,}$/.test(local) && (local.match(/\d/g)?.length ?? 0) >= 6
}

export interface AutomatedEvidence {
  /** The address header the reply would go to (Reply-To, else From; or the person's own To). Unparseable: rules 1 and 3 can't apply. */
  destination?: string | null
  /** The newest message's From, for rule 4 (absent, or the person's own message: rule 4 can't apply). */
  sender?: string | null
  /** The newest message's headers, when the read fetched them. */
  header?: HeaderLookup | null
  /** A rule-2 reason already worked out from the headers (the live read carries this, not the raw headers). */
  headerReason?: AutomatedReason | null
  /** The person has sent a message in the thread (rule 3's exception). */
  personSent: boolean
}

/** Why the newest message is automated mail (rules 1-4), or null when it may get a reply. Pure. */
export function automatedSenderReason(evidence: AutomatedEvidence): AutomatedReason | null {
  const headerReason = evidence.headerReason ?? (evidence.header ? automatedHeaderReason(evidence.header) : null)
  if (headerReason) return headerReason
  const destinations = mailboxAddresses(evidence.destination?.trim() ?? '')
  if (destinations.length && destinations.every((address) => isNoReplyAddress(address))) return 'no_reply_address'
  if (evidence.personSent) return null
  if (destinations.length && destinations.every((address) => isNoReplyAddress(address) || isNotificationAddress(address))) {
    return 'notification_address'
  }
  return evidence.sender && isTransactionalSender(evidence.sender) ? 'transactional_sender' : null
}

/**
 * The category the index stores for an automated thread: a list, or Gmail's
 * Promotions or Forums, is a newsletter; a transactional sender's mail is
 * transactional (as email-sync's classifyThread always filed receipts@); the
 * rest notifications.
 */
export function automatedCategory(reason: AutomatedReason): 'newsletter' | 'notification' | 'transactional' {
  if (reason === 'mailing_list' || reason === 'bulk_category') return 'newsletter'
  return reason === 'transactional_sender' ? 'transactional' : 'notification'
}

/**
 * Gmail's own sorting of the thread's newest message (the index row's
 * label_ids; the reply gate and the agent's draft tool read it): Promotions and Forums are bulk mail; Updates is where receipts,
 * confirmations, statements and notices land (Liam, 2026-10-27, GEN-1164).
 * Null for anything else, and for Outlook (no labels). Pure.
 */
export function gmailCategory(labelIds: unknown): 'bulk' | 'updates' | null {
  const labels = Array.isArray(labelIds) ? labelIds : []
  if (labels.includes('CATEGORY_PROMOTIONS') || labels.includes('CATEGORY_FORUMS')) return 'bulk'
  return labels.includes('CATEGORY_UPDATES') ? 'updates' : null
}

/** The fields of a live-read message (EmailMessageForAI) the thread check reads. */
export interface AutomatedMessageEvidence {
  from: string
  to?: string
  replyTo?: string
  replyToKnown?: boolean
  isDraft?: boolean
  automatedBy?: AutomatedReason
  /** Rule 5 (calendar mail) reads these; a read without them skips it. */
  subject?: string
  attachmentNames?: string[]
}

/**
 * Rules 1-5 over a thread as the live read returns it (oldest first): the
 * newest sent message, its reply destination and sender, and whether the
 * person (the mailbox, when known) sent any message in it. An unknown mailbox counts as
 * "has not sent", which only ever holds more back. Pure.
 */
export function automatedThreadReason(
  messages: readonly AutomatedMessageEvidence[] | null | undefined,
  mailbox: string | null | undefined,
): AutomatedReason | null {
  const sent = (messages ?? []).filter((m) => !m.isDraft)
  const latest = sent.at(-1)
  if (!latest) return null
  const own = mailbox ? mailboxAddresses(mailbox)[0] ?? null : null
  const fromOwn = (m: AutomatedMessageEvidence) => !!own && mailboxAddresses(m.from)[0] === own
  const personSent = sent.some(fromOwn)
  // The person's own follow-up answers its To; otherwise Reply-To, else From.
  // A Reply-To the read could not verify leaves only the header rule.
  const destination = fromOwn(latest)
    ? latest.to ?? ''
    : latest.replyToKnown === false ? '' : latest.replyTo?.trim() || latest.from
  const reason = automatedSenderReason({
    destination, headerReason: latest.automatedBy ?? null, personSent, sender: fromOwn(latest) ? null : latest.from,
  })
  return reason ?? (isCalendarMessage(latest) ? 'calendar' : null)
}
