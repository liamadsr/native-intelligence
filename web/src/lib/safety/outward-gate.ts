/**
 * The outward gate (always-on safety fixes, 2026-10-15): DETERMINISTIC holds
 * for calls that reach people or services outside Native Intelligence, applied at every door
 * beside the reviewer (action-review.ts gateRiskyCall) and holding whether or
 * not the reviewer is enforced.
 *
 * Why: with the reviewer in shadow, an injected email ("book a call with
 * x@evil.com") or a meeting transcript feeding an unattended loop could send a
 * calendar invite or call a connected app's write tool with no one's yes.
 *
 * What it holds:
 *   - create_calendar_event / update_calendar_event (and their ni_ names)
 *     with ANY attendee other than the person themselves, teammates included
 *     (Liam, 2026-10-26: nothing reaches another person without the person's
 *     final yes). The provider invites them (Microsoft Graph emails every
 *     attendee). No attendees, or only the person's own sign-in address,
 *     passes. The card says when someone is outside the workspace.
 *   - update_calendar_event / delete_calendar_event on an EXISTING event with
 *     any attendee other than the person, read from the provider first
 *     (getCalendarEventAttendees): editing or cancelling the meeting emails
 *     them. An event whose attendees can't be read is held.
 *   - an external connected-app tool (mcp__*) that needs approval under the
 *     policy in src/lib/mcp-client/approval-policy.ts: anything not read-only,
 *     unless the person explicitly made it approval-free. A tool the door
 *     cannot describe fails closed (held).
 *   - publish_post / schedule_post (content C2a): a post through the person's
 *     Typefully, always (decision 2: every post is the person's approval).
 *   - unsubscribe_thread (GEN-1166): an unsubscribe through a mailing list's
 *     List-Unsubscribe, always. It calls the sender's one-click link or sends
 *     an email from the person's mailbox, and can't be taken back. The card
 *     says which, and to whom, read live from the thread's newest list message.
 *   - send_payment_link (roadmap C2): a payment link to a customer, always,
 *     once the workspace's Stripe can take payments. The card says the
 *     amount, what it's for and who gets it, from the call's own input (the
 *     recipients are in it, so the input hash pins them). Before Stripe is
 *     ready, or with an input it would refuse anyway, nothing is held: the
 *     tool then reaches only the owner (their setup link) or no one.
 *   - send_quote / book_quote (roadmap F3): the owner's answer to a
 *     customer's quote, always. The card says exactly who gets what text
 *     (the price and booking link, or the booked time's confirmation), read
 *     from the quote and the business now (src/lib/customers/quote-reply.ts);
 *     the hash of its words rides on the approval, and the replay sends
 *     nothing when its own card's words differ. A call the tool would refuse
 *     anyway (not an owner or admin, no such quote, no way to reach the
 *     customer) or rows that can't be read: nothing is held, and the tool,
 *     which runs only as the card's replay, refuses it.
 *   - offer_times by email or text (availability phase 3a): times offered to
 *     an outside person, always. The card says exactly who gets what email
 *     or text, from the person's mailbox or the business's number
 *     (src/lib/time-offers/send.ts); the hash of its words rides on the
 *     approval with the offer made for it. The offer, its times held while
 *     the card waits, is made only once a card will really be raised (the
 *     hold's `prepare`); no card, no offer. By link it sends nothing and is
 *     not held here. A poll (several guests, phase 5) is the same card naming
 *     every guest and their address; so is nudge_time_offer, a reminder to
 *     its guests still to answer (nothing to make first: its card pins who).
 *
 * What a hold becomes is the trust authority's call, made in gateRiskyCall
 * (caller.ts decideAction(caller, 'outward', tool)): for the person, in the
 * app or remote, their approval card (approvals.ts, migration 335; the same
 * caps, 20 per person and 5 per conversation); for an unattended loop, a
 * relayed turn, a server turn, another person or an unknown caller, a
 * NEEDS_PERSON refusal, since nobody who may answer a card is there.
 */
import 'server-only'
import { findMembersByEmail } from '@/lib/workspace-member-emails'
import { getCalendarEventAttendees } from '@/lib/integrations/calendar'
import type { ServerToolMeta } from '@/lib/mcp-client/adapter'
import { typefullyCardCopy } from '@/lib/content/typefully'
import { readThreadListHeaders, unsubscribeMethod, unsubscribeMethodKey, type ThreadListHeaders } from '@/lib/email/unsubscribe'
import type { QuoteReplyApprovalContext, TimeOfferApprovalContext, UnsubscribeApprovalContext } from './approved-call'
import { mailboxAddresses } from '@/lib/email/reply-policy'
import { paymentsReady } from '@/lib/payments/ready'
import { paymentLinkCard, parsePaymentLinkCall, SEND_PAYMENT_LINK } from '@/lib/payments/tool-input'
import { BOOK_QUOTE_TOOL, SEND_QUOTE_TOOL } from '@/lib/customers/quote-reply-input'
import { bareToolName } from '@/lib/mcp/tool-names'
import { NUDGE_TIME_OFFER_TOOL, offerTimesSends, OFFER_TIMES_TOOL } from '@/lib/time-offers/input'
import type { TimeOfferHold } from '@/lib/time-offers/send'

/** The calendar writes that invite attendees (bare names). */
const CALENDAR_INVITE_TOOLS: ReadonlySet<string> = new Set(['create_calendar_event', 'update_calendar_event'])
/** The calendar writes on an existing event, whose attendees the provider emails (bare names). */
const CALENDAR_EXISTING_EVENT_TOOLS: ReadonlySet<string> = new Set(['update_calendar_event', 'delete_calendar_event'])

/** What the door knows about an external MCP tool (the adapter's meta for it). */
/**
 * An external tool's policy, as the adapter decides it. The server, the tool's
 * own name and alwaysAsks let the person's chat card offer Always allow
 * (action-review.ts holdOutward); absent, no offer (fail closed).
 */
export type ExternalToolPolicy = Pick<ServerToolMeta, 'serverName' | 'requiresApproval'> &
  Partial<Pick<ServerToolMeta, 'serverId' | 'toolName' | 'alwaysAsks' | 'pinnedRead'>>

export interface OutwardHold {
  /** Why, for the approval row's `reason` and the logs. */
  reason: 'outside_attendees' | 'teammate_attendees' | 'mcp_write' | 'public_post' | 'unsubscribe' | 'payment_link' | 'customer_quote' | 'time_offer'
  /** The approval card's words. */
  card: { title: string; why: string }
  /** What the model reads when there is no person to ask (NEEDS_PERSON). */
  refusal: string
  /** The hold's own check, kept on the approval for its replay (an unsubscribe card's method, a quote card's words). */
  context?: { unsubscribe?: UnsubscribeApprovalContext; quoteReply?: QuoteReplyApprovalContext; timeOffer?: Partial<TimeOfferApprovalContext> }
  /**
   * Work the hold does only once its card will really be raised (a time
   * offer's held times): more context for the approval, or why there is no
   * card after all (the model reads it; nothing ran). Never for a caller
   * who is refused.
   */
  prepare?: () => Promise<{ ok: true; context: { timeOffer: TimeOfferApprovalContext } } | { ok: false; message: string }>
  /** The card was raised: told its approval's id. Best effort. */
  held?: (context: { timeOffer?: TimeOfferApprovalContext }, approvalId: string) => Promise<void>
  /** No card came of a prepared hold: undo what prepare did. Best effort. */
  abandon?: (context: { timeOffer?: TimeOfferApprovalContext }) => Promise<void>
}

export interface OutwardCheck {
  /** Whose calendar an existing event is read from. */
  userId?: string
  workspaceId: string
  toolName: string
  input: unknown
  /** The adapter's meta for an mcp__ tool; absent → the tool is held (fail closed). */
  externalTool?: ExternalToolPolicy | null
  /** Test seam: who in `emails` is a workspace member (lower-cased). */
  memberEmails?: (workspaceId: string, emails: string[]) => Promise<ReadonlySet<string>>
  /** Test seam: an existing event's attendees (null: could not be read). */
  eventAttendees?: (userId: string, eventId: string) => Promise<string[] | null>
  /** Test seam: which of `emails` are the person's own sign-in address (lower-cased). */
  ownEmails?: (workspaceId: string, userId: string, emails: string[]) => Promise<ReadonlySet<string>>
  /** Test seam: a thread's list headers (unsubscribe_thread's card). */
  listHeaders?: (userId: string, workspaceId: string, threadId: string) => Promise<ThreadListHeaders | null>
  /** Test seam: whether the workspace's Stripe can take payments (send_payment_link's card). */
  paymentsReady?: (workspaceId: string) => Promise<boolean>
  /** Test seam: a send_quote / book_quote call's card and check (null: the tool would refuse it anyway). */
  quoteCard?: (args: { workspaceId: string; userId: string; toolName: string; input: unknown }) => Promise<QuoteCardHold | null>
  /** Test seam: an offer_times call's card, check and offer (null: the tool would refuse it anyway). */
  timeOfferCard?: (args: { workspaceId: string; userId: string; input: unknown; toolName: string }) => Promise<TimeOfferHold | null>
}

/** A quote reply's card and the check its replay makes (src/lib/customers/quote-reply.ts quoteReplyHold). */
export interface QuoteCardHold {
  card: { title: string; why: string }
  context: { quoteReply: QuoteReplyApprovalContext }
}

/** Every attendee address in a calendar call's input, lower-cased and de-duplicated. */
export function attendeeEmailsOf(input: unknown): string[] {
  const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const out = new Set<string>()
  for (const key of ['attendees', 'add_attendees', 'required_attendees', 'optional_attendees']) {
    const list = args[key]
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      const raw = typeof entry === 'string'
        ? entry
        : entry && typeof entry === 'object' && typeof (entry as { email?: unknown }).email === 'string'
          ? (entry as { email: string }).email
          : ''
      const email = raw.trim().toLowerCase()
      if (email) out.add(email)
    }
  }
  return [...out]
}

async function defaultMemberEmails(workspaceId: string, emails: string[]): Promise<ReadonlySet<string>> {
  return new Set((await findMembersByEmail(workspaceId, emails)).keys())
}

async function defaultOwnEmails(workspaceId: string, userId: string, emails: string[]): Promise<ReadonlySet<string>> {
  const found = await findMembersByEmail(workspaceId, emails)
  return new Set([...found.values()].filter((member) => member.userId === userId).map((member) => member.email))
}

/** The existing event a calendar update or delete names (event_id). */
function existingEventId(input: unknown): string | null {
  const id = input && typeof input === 'object' ? (input as { event_id?: unknown }).event_id : undefined
  return typeof id === 'string' && id.trim() ? id.trim() : null
}

/**
 * unsubscribe_thread's card: who the list mail is from, and what accepting
 * does (the sender's one-click link, or an email from the person's mailbox).
 * Only addresses and a host are shown, never a display name or subject (the
 * sender writes those). Unreadable headers → a card that says what it may do.
 */
async function unsubscribeHold(check: OutwardCheck): Promise<OutwardHold> {
  const threadId = check.input && typeof check.input === 'object' ? (check.input as { thread_id?: unknown }).thread_id : undefined
  let found: ThreadListHeaders | null = null
  if (check.userId && typeof threadId === 'string' && threadId.trim()) {
    try {
      found = await (check.listHeaders ?? readThreadListHeaders)(check.userId, check.workspaceId, threadId.trim())
    } catch {
      found = null
    }
  }
  const sender = found?.headers ? mailboxAddresses(found.headers.from)[0] : undefined
  const method = found?.headers ? unsubscribeMethod(found.headers.listUnsubscribe, found.headers.listUnsubscribePost) : null
  const mailbox = found?.mailbox.email ?? 'your mailbox'
  let host: string | null = null
  if (method?.kind === 'one_click') {
    try {
      host = new URL(method.url).hostname
    } catch {
      host = null
    }
  }
  // The mail's subject and body are the list's own words: shown, short, as what goes out.
  const quoted = (text: string) => `"${text.replace(/\s+/g, ' ').trim().slice(0, 120)}${text.length > 120 ? '…' : ''}"`
  const does =
    method?.kind === 'one_click'
      ? `Native Intelligence will use the sender's one-click unsubscribe link (${host ?? 'their site'}).`
      : method?.kind === 'mailto'
        ? `Native Intelligence will send an unsubscribe email from ${mailbox} to ${method.to}, subject ${quoted(method.subject)}${method.body === 'unsubscribe' ? '' : `, saying ${quoted(method.body)}`}.`
        : method?.kind === 'link'
          ? 'This sender only offers a web page: accepting gets you its link to open yourself, and nothing is sent.'
          : "Native Intelligence will use the sender's unsubscribe link, or send an unsubscribe email from your mailbox, whichever the list offers."
  return {
    reason: 'unsubscribe',
    card: {
      title: `Unsubscribe from ${sender ?? 'this mailing list'}?`,
      why: `${does} It leaves Native Intelligence and can't be undone here. It runs once, with exactly the inputs below, when you accept.`,
    },
    refusal:
      'Nothing was sent. unsubscribe_thread only ever runs on the person\'s own approval card, and nobody is here to give it. ' +
      'Do not retry; tell them which list you would have unsubscribed them from.',
    // The replay does only what this card says, or nothing (unsubscribe.ts pinned).
    ...(method ? { context: { unsubscribe: { method: method.kind, key: unsubscribeMethodKey(method) } } } : {}),
  }
}

function listed(emails: readonly string[]): string {
  const shown = emails.slice(0, 5).join(', ')
  return emails.length > 5 ? `${shown} and ${emails.length - 5} more` : shown
}

/**
 * send_payment_link's card (see the header). Not ready, or unreadable: no
 * hold, and the tool answers (the owner's setup link, or its refusal). A
 * readiness lookup that fails counts as ready: held.
 */
async function paymentLinkHold(check: OutwardCheck): Promise<OutwardHold | null> {
  const parsed = parsePaymentLinkCall(check.input)
  if (!parsed.ok) return null
  let ready = true
  try {
    ready = await (check.paymentsReady ?? paymentsReady)(check.workspaceId)
  } catch {
    ready = true
  }
  if (!ready) return null
  return {
    reason: 'payment_link',
    card: paymentLinkCard(parsed.call),
    refusal:
      `Nothing was sent. ${check.toolName} sends a customer a payment link, which only ever happens on the owner's own approval card, and nobody is here to give it. ` +
      'Do not retry; tell the owner what you would have sent.',
  }
}

async function defaultQuoteCard(args: { workspaceId: string; userId: string; toolName: string; input: unknown }): Promise<QuoteCardHold | null> {
  // Loaded on use: the quote and booking code stays out of every door's imports.
  const [{ getServiceClient }, { quoteReplyHold }] = await Promise.all([import('@/lib/admin'), import('@/lib/customers/quote-reply')])
  return quoteReplyHold(getServiceClient(), args)
}

/**
 * send_quote's or book_quote's card (see the header). A call the tool would
 * refuse anyway, or rows that can't be read: no hold, and the tool (which
 * runs only as the card's replay) refuses it.
 */
async function quoteReplyOutwardHold(check: OutwardCheck, bare: string): Promise<OutwardHold | null> {
  if (!check.userId) return null
  let found: QuoteCardHold | null = null
  try {
    found = await (check.quoteCard ?? defaultQuoteCard)({ workspaceId: check.workspaceId, userId: check.userId, toolName: bare, input: check.input })
  } catch (err) {
    console.warn('[outward-gate] quote card unreadable; the tool refuses unapproved:', err instanceof Error ? err.message : String(err))
    found = null
  }
  if (!found) return null
  const does = bare === SEND_QUOTE_TOOL ? 'sends a customer their quote' : "books a customer's job and texts them"
  return {
    reason: 'customer_quote',
    card: found.card,
    refusal:
      `Nothing was sent. ${check.toolName} ${does}, which only ever happens on the owner's own approval card, and nobody is here to give it. ` +
      'Do not retry; tell the owner what you would have sent.',
    context: found.context,
  }
}

async function defaultTimeOfferCard(args: { workspaceId: string; userId: string; input: unknown; toolName: string }): Promise<TimeOfferHold | null> {
  // Loaded on use: the offer and sending code stays out of every door's imports.
  const [{ getServiceClient }, { timeOfferHold }] = await Promise.all([import('@/lib/admin'), import('@/lib/time-offers/send')])
  return timeOfferHold(getServiceClient(), args)
}

/**
 * offer_times's card when it sends (see the header). A call the tool would
 * refuse anyway, or rows that can't be read: no hold, and the tool (which
 * sends only as the card's replay) refuses it, saying why.
 */
async function timeOfferOutwardHold(check: OutwardCheck, bare: string): Promise<OutwardHold | null> {
  if (!check.userId || !offerTimesSends(bare, check.input)) return null
  let found: TimeOfferHold | null = null
  try {
    found = await (check.timeOfferCard ?? defaultTimeOfferCard)({ workspaceId: check.workspaceId, userId: check.userId, input: check.input, toolName: bare })
  } catch (err) {
    console.warn('[outward-gate] time offer card unreadable; the tool refuses unapproved:', err instanceof Error ? err.message : String(err))
    found = null
  }
  if (!found) return null
  return {
    reason: 'time_offer',
    card: found.card,
    refusal:
      `Nothing was sent. ${check.toolName} by email or text sends outside people times to meet, which only ever happens on the person's own approval card, and nobody is here to give it. ` +
      "Do not retry; use send_by 'link' instead (the person sends it themselves), or tell the person what you would have sent.",
    context: found.context,
    prepare: found.prepare,
    held: found.held,
    abandon: found.abandon,
  }
}

/**
 * The hold this call needs, or null when it may go on to the reviewer. Never
 * throws: a membership lookup that fails counts nobody as a member (held).
 */
export async function outwardHoldOf(check: OutwardCheck): Promise<OutwardHold | null> {
  const bare = bareToolName(check.toolName)
  // A post through the person's Typefully (C2a): ALWAYS their card, whatever
  // trust anyone has earned (decision 2, "user always approves"). The card
  // says exactly what goes out, from the call's own input.
  if (bare === 'publish_post' || bare === 'schedule_post') {
    const input = (check.input && typeof check.input === 'object' ? check.input : {}) as { surface?: unknown; text?: unknown; parts?: unknown }
    return {
      reason: 'public_post',
      // The account a model names is never said on the card (only a post card's own, server-stamped one is).
      card: typefullyCardCopy(bare, { surface: input.surface, text: input.text, parts: input.parts }),
      refusal:
        `Nothing was posted. ${check.toolName} posts publicly, which only ever happens on the person's own approval card, and nobody is here to give it. ` +
        'Do not retry; leave the draft for them.',
    }
  }
  if (bare === 'unsubscribe_thread') return unsubscribeHold(check)
  if (bare === SEND_PAYMENT_LINK) return paymentLinkHold(check)
  if (bare === SEND_QUOTE_TOOL || bare === BOOK_QUOTE_TOOL) return quoteReplyOutwardHold(check, bare)
  if (bare === OFFER_TIMES_TOOL || bare === NUDGE_TIME_OFFER_TOOL) return timeOfferOutwardHold(check, bare)
  if (CALENDAR_INVITE_TOOLS.has(bare) || CALENDAR_EXISTING_EVENT_TOOLS.has(bare)) {
    const added = CALENDAR_INVITE_TOOLS.has(bare) ? attendeeEmailsOf(check.input) : []
    // An existing event's attendees, from the provider: editing or cancelling
    // the meeting emails them. Unreadable → held (the call can't be checked).
    let existing: string[] = []
    let unreadable = false
    const eventId = existingEventId(check.input)
    if (CALENDAR_EXISTING_EVENT_TOOLS.has(bare) && eventId) {
      let read: string[] | null = null
      try {
        read = check.userId ? await (check.eventAttendees ?? getCalendarEventAttendees)(check.userId, eventId) : null
      } catch {
        read = null
      }
      if (read === null) unreadable = true
      else existing = read.map((email) => email.trim().toLowerCase()).filter(Boolean)
    }
    const emails = [...new Set([...added, ...existing])]
    // Everyone but the person themselves: inviting, changing or cancelling
    // with any of them emails them. Unknown whose address it is → not theirs.
    let own: ReadonlySet<string> = new Set()
    if (emails.length && check.userId) {
      try {
        own = await (check.ownEmails ?? defaultOwnEmails)(check.workspaceId, check.userId, emails)
      } catch {
        own = new Set()
      }
    }
    const others = emails.filter((email) => !own.has(email))
    if (!others.length && !unreadable) return null
    let outside: string[] = []
    if (others.length) {
      let members: ReadonlySet<string>
      try {
        members = await (check.memberEmails ?? defaultMemberEmails)(check.workspaceId, others)
      } catch {
        members = new Set()
      }
      outside = others.filter((email) => !members.has(email))
    }
    // Who the card names: the outsiders first, since they matter most.
    const named = [...outside, ...others.filter((email) => !outside.includes(email))]
    const who = named.length ? listed(named) : 'its attendees, who could not be checked'
    const reason: OutwardHold['reason'] = outside.length || unreadable ? 'outside_attendees' : 'teammate_attendees'
    // Who it reaches, in words: only outsiders read as before; a mix names
    // everyone and says who is outside.
    const allOutside = outside.length > 0 && outside.length === named.length
    const reaches = (workspace: 'your' | 'the') =>
      !named.length ? who
        : allOutside ? `people outside ${workspace} workspace (${who})`
        : outside.length ? `${who}, including people outside ${workspace} workspace (${listed(outside)})`
        : who
    // A new invite (or an update that only adds people) reads as an invite;
    // touching a meeting that already has them reads as a change or cancel.
    const touchesOthers = unreadable || others.some((email) => existing.includes(email))
    if (bare === 'create_calendar_event' || !touchesOthers) {
      return {
        reason,
        card: {
          title: `Send a calendar invite to ${who}?`,
          why: `This invites ${reaches('your')}, and their calendar may email them. Nothing reaches another person without your yes. It runs once, with exactly the inputs below, when you accept.`,
        },
        refusal:
          `Nothing ran. ${check.toolName} would invite ${reaches('the')}, which needs the person's approval, and nobody is here to give it. ` +
          'Do not retry; report what you would have scheduled so the person can do it.',
      }
    }
    const verb = bare === 'delete_calendar_event' ? 'Cancel' : 'Change'
    return {
      reason,
      card: {
        title: `${verb} a meeting with ${who}?`,
        why: `This ${verb === 'Cancel' ? 'cancels' : 'changes'} a meeting with ${reaches('your')}, and their calendar may email them. Nothing reaches another person without your yes. It runs once, with exactly the inputs below, when you accept.`,
      },
      refusal:
        `Nothing ran. ${check.toolName} would ${verb === 'Cancel' ? 'cancel' : 'change'} a meeting with ${reaches('the')}, which emails them and needs the person's approval, and nobody is here to give it. ` +
        'Do not retry; report what you would have changed.',
    }
  }
  if (check.toolName.startsWith('mcp__')) {
    const policy = check.externalTool
    if (policy && !policy.requiresApproval) return null
    const server = policy?.serverName ?? 'a connected app'
    return {
      reason: 'mcp_write',
      card: {
        title: `Approve ${check.toolName}?`,
        why: `This runs a tool on ${server} that can change something outside Native Intelligence. It runs once, with exactly the inputs below, when you accept. You can let this tool run without asking in Settings > Connectors, on this app's page.`,
      },
      refusal:
        `Nothing ran. ${check.toolName} changes something in ${server}, which needs the person's approval, and nobody is here to give it. ` +
        'Do not retry; report what you would have done.',
    }
  }
  return null
}
