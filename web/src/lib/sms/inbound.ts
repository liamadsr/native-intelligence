/**
 * What an inbound text to the Dial8 number, or to a business's own number,
 * does (docs/plans/text-and-calling.md, Phase 1), after the webhook
 * (src/app/api/twilio/sms/route.ts) verified its Twilio signature. In this
 * order:
 *
 *   1. a `From` that isn't E.164 is dropped;
 *   2. the ledger row, keyed on the MessageSid: a second delivery of the same
 *      message (Twilio's fallback URL after a timeout) stops here;
 *  2b. THE NUMBER THAT WAS TEXTED (`To`, roadmap B2) decides who the sender
 *      is. On the Dial8 number: the phone's Dial8-line account
 *      (findLinkedPhone), never a business-line one. On a business's own
 *      number: one of that business's own people (businessPerson: a verified
 *      row of the phone whose person is a member there, a business-line row
 *      first, then the Dial8-line one), in the business's workspace; anyone
 *      else there is its customer. So one phone can talk to two accounts' (or
 *      two workspaces') agents, each on its own number (migration 464).
 *      Everything below runs on that sender;
 *   3. the compliance keywords, before anything else the text could mean
 *      (../twilio/keywords.ts): STOP sets the opt-out and says nothing back
 *      (the carrier and Twilio send the mandated confirmation, and nothing
 *      may follow it); START / UNSTOP clear it and say so (YES too, but only
 *      for a sender that is opted out, as Twilio does; any other YES is a
 *      message for the agent); HELP answers. Per number, as the carrier
 *      enforces it (Twilio's opt-out is per sending number): to the Dial8
 *      number, the phone's Dial8-line row; to a business's number, exactly
 *      the row that number resolves the phone to (2b), on either line, the
 *      one whose opt-out the texts from that number read (nothing when it
 *      resolves to no one). Guests and customers (setGuestOptOut) and the
 *      ledger as before. A business's customer who says STOP to a reminder
 *      it texted them: the owner is told (customerStopped,
 *      src/lib/customers/reminder-replies.ts). When Twilio
 *      answered the keyword itself (a Messaging Service's Advanced Opt-Out
 *      sets `OptOutType`), its keyword wins, since its opt-out state is the one
 *      carriers enforce, and nothing is said back: Twilio already replied;
 *   4. an opted-out sender is ignored (nothing could be texted back);
 *   5. the per-number rate limit: past it, the text is ignored;
 *   5b. a text to a business's own number from someone who isn't one of its
 *      people is its customer's (src/lib/customers/texting.ts); its people go
 *      on below as by the Dial8 number but in the business's workspace. HELP
 *      and START to a business's number name the business. Only a text to the
 *      Dial8 number reaches the branches below as a stranger;
 *   6. a number no one linked may be a guest's (guest access,
 *      src/lib/guests/texting.ts): an active guest's text goes to their own
 *      agent, an invite code activates them, a JOIN asks an owner. Otherwise
 *      it is someone signing up (./signup.ts): their text gets a sign-up
 *      code, and the code texted back makes their account. (Without the
 *      `signupText` dep: ONE reply pointing to Settings → Phone, ever, then
 *      silence.);
 *   7. a reply saying yes or no to one of the sender's pending approvals by
 *      its code ("yes K7Q4MX") answers it, as their own click
 *      (./approvals.ts); wrong codes are capped per day;
 *   8. a person no longer in their number's workspace (on a business's
 *      number: that business's) gets one notice a day;
 *   9. a text with no words (a picture alone) gets a short note;
 *  10. otherwise the text is delivered: written into the person's home thread
 *      as their message and a text turn is requested (`deliverText`). The turn
 *      never runs inside the webhook.
 *
 * Against SMS pumping, a reply to a text Dial8 can't tie to a person (HELP,
 * START, an unknown sender, a sign-up code) goes only to a US/Canada number
 * (isNanpNumber) and only while the global hourly cap
 * (SMS_AUTO_REPLY_HOURLY_CAP) holds.
 *
 * Pure over {@link InboundDeps}, so the order and every branch is testable;
 * {@link supabaseInboundDeps} is the real store.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { classifySmsKeyword } from '@/lib/twilio/keywords'
import { isE164, isNanpNumber, normalizeE164 } from '@/lib/twilio/phone'
import { twilioPhoneNumber } from '@/lib/twilio/config'
import { TEXT_MAX_CHARS } from '@/lib/chat/text-turn'
import { answerApprovalByText, supabaseTextApprovalDeps, textApprovalHandled, type TextApprovalResult } from './approvals'
import { HELP_REPLY } from './consent'
import type { SignupOutcome, SignupResult } from './signup'
import { handleGuestText, supabaseGuestTextDeps, type GuestTextDeps, type GuestTextOutcome, type GuestTextResult } from '@/lib/guests/texting'
import { setGuestOptOut } from '@/lib/guests/store'
import { findBusinessNumber, type BusinessNumber } from '@/lib/customers/numbers'
import { businessName } from '@/lib/customers/store'
import { remindersStopped } from '@/lib/customers/reminder-replies'
import {
  businessHelpReply,
  businessStartReply,
  handleBusinessText,
  supabaseBusinessTextDeps,
  type BusinessTextDeps,
  type BusinessTextOutcome,
  type BusinessTextResult,
} from '@/lib/customers/texting'
import {
  SMS_AUTO_REPLY_HOURLY_CAP,
  SMS_AUTO_REPLY_KINDS,
  SMS_INBOUND_RATE_LIMIT,
  SMS_INBOUND_RATE_WINDOW_MS,
  countInboundSince,
  countOutboundKindsSince,
  findBusinessPerson,
  findLinkedPhone,
  forgetInbound,
  hasOutbound,
  isWorkspaceMember,
  recordInbound,
  recordOutbound,
  setPhoneOptOut,
  setPhoneRowOptOut,
  unlinkedNumberOptedOut,
  type LinkedPhone,
  type SmsInboundKind,
  type SmsOutboundKind,
} from './store'
import { saveTextedFiles, textedFilesNote, type InboundMedia, type SavedTextedFile } from './media'

/** One inbound text, from Twilio's form fields. */
export interface InboundSms {
  /** `From`, as Twilio sends it (E.164). */
  from: string
  body: string
  /** `MessageSid` (null only in a malformed request). */
  sid: string | null
  /** `NumMedia`: files attached. Pictures are not read; a contacts file is (./media.ts). */
  numMedia: number
  /** The attached files (`MediaUrlN`, `MediaContentTypeN`). */
  media?: InboundMedia[]
  /** `OptOutType` (STOP, START or HELP): Twilio matched an opt-out keyword and already replied. Absent otherwise. */
  optOutType?: string | null
  /** `To`: the number that was texted (the Dial8 number, or a business's own). Absent: the Dial8 number. */
  to?: string | null
}

/** The keyword Twilio itself answered, from `OptOutType`, or null. */
function twilioAnsweredKeyword(optOutType: string | null | undefined): 'stop' | 'start' | 'help' | null {
  switch (typeof optOutType === 'string' ? optOutType.trim().toUpperCase() : '') {
    case 'STOP':
      return 'stop'
    case 'START':
      return 'start'
    case 'HELP':
      return 'help'
    default:
      return null
  }
}

export interface InboundDeps {
  recordInbound(row: { phone: string; kind: SmsInboundKind; sid: string | null }): Promise<'new' | 'duplicate'>
  /** Drop the inbound row again (delivery failed), so a second delivery of the message is not a duplicate. */
  forgetInbound(sid: string): Promise<void>
  /** The phone's Dial8-line account: who a text to the Dial8 number is from (./store.ts). */
  findLinkedPhone(phone: string): Promise<LinkedPhone | null>
  /**
   * Who a text to `workspaceId`'s business number is from when it is one of
   * that business's own people: the phone's verified row whose person is a
   * member there, a business-line row first (./store.ts findBusinessPerson).
   * The same rule as the customer path's isBusinessPerson.
   */
  businessPerson(phone: string, workspaceId: string): Promise<LinkedPhone | null>
  /** STOP / START to the Dial8 number: the phone's Dial8-line row. */
  setPhoneOptOut(phone: string, optedOut: boolean): Promise<void>
  /** STOP / START to a business's number: the row it resolved the phone to (`businessPerson`), on either line. */
  setPhoneRowOptOut(id: string, optedOut: boolean): Promise<void>
  unlinkedNumberOptedOut(phone: string): Promise<boolean>
  countInboundSince(phone: string, sinceMs: number): Promise<number>
  /** Replies of these kinds sent to anyone since `sinceMs` (the global auto-reply cap). */
  countOutboundKindsSince(kinds: readonly SmsOutboundKind[], sinceMs: number): Promise<number>
  hasOutbound(phone: string, kind: SmsOutboundKind, sinceMs?: number): Promise<boolean>
  recordOutbound(row: { phone: string; kind: SmsOutboundKind; userId?: string | null; guestId?: string | null }): Promise<void>
  isWorkspaceMember(userId: string, workspaceId: string): Promise<boolean>
  /** Answer a pending approval the text names by its code (./approvals.ts); absent, every text goes to the agent. */
  answerApproval?(args: { linked: LinkedPhone; text: string; sid: string }): Promise<TextApprovalResult>
  /**
   * A text from a number no one linked, as a guest's (src/lib/guests/texting.ts):
   * its result, or null when it isn't one. `reply` and `noticedSince` are this
   * handler's (NANP only, the global auto-reply cap). Absent: no guests.
   */
  guestText?(
    input: { phone: string; text: string; sid: string | null; numMedia: number },
    tools: Pick<GuestTextDeps, 'autoReply' | 'noticedSince'>,
  ): Promise<GuestTextResult | null>
  /**
   * A text from a number nobody linked that isn't a guest's: someone signing
   * up (./signup.ts). `autoReply` is this handler's (NANP only, the global
   * cap). Absent: the one-time unknown-number reply.
   */
  signupText?(
    input: { phone: string; text: string; sid: string | null },
    tools: { autoReply(kind: 'signup_code' | 'auto_reply', text: string): Promise<string | null> },
  ): Promise<SignupResult>
  /** STOP / START from a guest's number, for the People tab (best-effort; the ledger is what stops texts). */
  setGuestOptOut?(phone: string, optedOut: boolean): Promise<void>
  /** Save a linked person's texted contact files to their chat uploads (./media.ts). Absent: files are not read. */
  saveTextedFiles?(args: { linked: LinkedPhone; media: InboundMedia[] }): Promise<SavedTextedFile[]>
  /** The business whose own number `to` is, with its name, or null for the Dial8 number (roadmap B2). Absent: no business numbers. */
  businessLine?(to: string): Promise<{ number: BusinessNumber; name: string } | null>
  /**
   * A text to a business's number from someone who isn't one of its people
   * (src/lib/customers/texting.ts): its result, or null when the sender is one
   * of the business's own people after all. `reply` and `noticedSince` are
   * this handler's (NANP only, the global auto-reply cap).
   */
  /** A business's customer (not one of its people) said STOP to its number: their open reminders tell the owner. Best effort. */
  customerStopped?(business: { number: BusinessNumber; name: string }, phone: string): Promise<unknown>
  businessText?(
    input: { number: BusinessNumber; phone: string; text: string; sid: string | null; numMedia: number },
    tools: Pick<BusinessTextDeps, 'autoReply' | 'noticedSince'>,
  ): Promise<BusinessTextResult | null>
  /** Write the text into the person's home thread and request its turn. */
  deliverText(args: { linked: LinkedPhone; text: string; sid: string }): Promise<void>
  /** The app's origin, for the links in the replies. */
  origin: string
  now?: () => number
}

export type InboundOutcome =
  | 'invalid'
  | 'duplicate'
  | 'stop'
  | 'start'
  | 'help'
  | 'opted_out'
  | 'rate_limited'
  | 'unknown_replied'
  | 'unknown_ignored'
  | SignupOutcome
  | 'not_member'
  | 'not_member_ignored'
  | 'no_text'
  | 'approval_answered'
  | 'approval_refused'
  | 'code_miss'
  | 'code_answered'
  | 'codes_paused'
  | 'code_needed'
  | 'queued'
  | GuestTextOutcome
  | BusinessTextOutcome

export interface InboundResult {
  outcome: InboundOutcome
  /** Said back at once, as the webhook's TwiML `<Message>`; null for silence. */
  reply: string | null
}

/** A day, for the once-a-day notices; an hour, for the global auto-reply cap. */
const DAY_MS = 24 * 60 * 60_000
const HOUR_MS = 60 * 60_000

/** The HELP auto-reply: the exact copy carriers reviewed (./consent.ts). */
export function helpReply(_origin?: string): string {
  return HELP_REPLY
}

export const START_REPLY = "You're subscribed to Dial8 texts again. Text this number anytime to reach your AI agent. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help."

export function unknownNumberReply(origin: string): string {
  return `This number isn't linked to a Dial8 account. To text your Dial8 agent, add it in Settings > Phone: ${origin}/account/settings/phone . Reply STOP to opt out.`
}

export function notMemberReply(origin: string): string {
  return `Your phone is linked to a Dial8 workspace you're no longer in. Link it again in Settings > Phone: ${origin}/account/settings/phone`
}

export const NO_TEXT_REPLY = "I can only read words for now, not pictures. Text me what you need."

/**
 * Reply `text` to a text nobody can be held to (HELP, START, an unknown
 * sender), recorded as `kind`: only to a US/Canada number, and only while the
 * global hourly cap holds; else silence.
 */
async function autoReply(
  deps: InboundDeps,
  phone: string,
  kind: 'auto_reply' | 'unknown_reply' | 'guest_welcome' | 'guest_notice' | 'signup_code',
  text: string,
  now: number,
  guestId: string | null = null,
): Promise<string | null> {
  if (!isNanpNumber(phone)) return null
  if ((await deps.countOutboundKindsSince(SMS_AUTO_REPLY_KINDS, now - HOUR_MS)) >= SMS_AUTO_REPLY_HOURLY_CAP) {
    console.warn('[twilio-sms] auto-reply cap reached: reply withheld')
    return null
  }
  await deps.recordOutbound({ phone, kind, ...(guestId ? { guestId } : {}) })
  return text
}

/** Handle one verified inbound text. Throws on a failed store call (the webhook logs it and answers empty TwiML). */
export async function handleInboundSms(input: InboundSms, deps: InboundDeps): Promise<InboundResult> {
  const now = (deps.now ?? Date.now)()
  const phone = input.from.trim()
  if (!isE164(phone)) return { outcome: 'invalid', reply: null }

  // The number that was texted (roadmap B2): a business's own makes a stranger
  // its customer, and decides which of the phone's accounts is texting (464).
  const business = input.to && deps.businessLine ? await deps.businessLine(input.to.trim()) : null
  const sender = async (): Promise<LinkedPhone | null> => {
    if (!business) return deps.findLinkedPhone(phone)
    const person = await deps.businessPerson(phone, business.number.workspaceId)
    // One of the business's own people talks to that business's agent on its
    // number, whichever workspace their row is linked to (their texts about
    // it come from that number too: textPerson).
    return person ? { ...person, workspaceId: business.number.workspaceId } : null
  }

  const answeredByTwilio = twilioAnsweredKeyword(input.optOutType)
  let keyword = answeredByTwilio ?? classifySmsKeyword(input.body)
  // YES re-subscribes only a sender that is opted out (Twilio's own rule);
  // otherwise it is the person answering the agent.
  let linked: LinkedPhone | null | undefined
  if (keyword === 'yes') {
    linked = await sender()
    const optedOut = linked ? linked.optedOut : await deps.unlinkedNumberOptedOut(phone)
    keyword = optedOut ? 'start' : null
  }
  const recorded = await deps.recordInbound({ phone, kind: keyword ?? 'text', sid: input.sid })
  if (recorded === 'duplicate') return { outcome: 'duplicate', reply: null }

  if (keyword === 'stop' || keyword === 'start') {
    const optedOut = keyword === 'stop'
    // Per number, as the carrier enforces it: on a business's number, exactly
    // the row it resolves to (the one its texts read); never another number's account.
    if (business) {
      if (linked === undefined) linked = await sender()
      if (linked) await deps.setPhoneRowOptOut(linked.id, optedOut)
    } else {
      await deps.setPhoneOptOut(phone, optedOut)
    }
    await deps.setGuestOptOut?.(phone, optedOut).catch(() => {})
    if (optedOut && business && !linked) await deps.customerStopped?.(business, phone).catch(() => {})
    if (optedOut) return { outcome: 'stop', reply: null }
    return { outcome: 'start', reply: answeredByTwilio ? null : await autoReply(deps, phone, 'auto_reply', business ? businessStartReply(business.name) : START_REPLY, now) }
  }
  if (keyword === 'help') {
    return { outcome: 'help', reply: answeredByTwilio ? null : await autoReply(deps, phone, 'auto_reply', business ? businessHelpReply(business.name) : helpReply(), now) }
  }

  if (linked === undefined) linked = await sender()
  if (linked ? linked.optedOut : await deps.unlinkedNumberOptedOut(phone)) return { outcome: 'opted_out', reply: null }

  if ((await deps.countInboundSince(phone, now - SMS_INBOUND_RATE_WINDOW_MS)) > SMS_INBOUND_RATE_LIMIT) {
    return { outcome: 'rate_limited', reply: null }
  }

  // A business's number from someone who isn't one of its people: its customer (src/lib/customers/texting.ts).
  if (business && deps.businessText && !linked) {
    let handled: BusinessTextResult | null
    try {
      handled = await deps.businessText(
        { number: business.number, phone, text: input.body.trim().slice(0, TEXT_MAX_CHARS), sid: input.sid, numMedia: input.numMedia },
        {
          autoReply: (to, kind, text, guestId) => autoReply(deps, to, kind, text, now, guestId),
          noticedSince: (to, sinceMs) => deps.hasOutbound(to, 'guest_notice', sinceMs),
        },
      )
      // Null: one of its own people after all (a member row added between the
      // two reads). Find which; never the stranger path below for a text to a
      // business's number.
      if (!handled) linked = await sender()
    } catch (err) {
      // Not handled: forget the sid, as a failed delivery below does.
      if (input.sid) await deps.forgetInbound(input.sid).catch(() => {})
      throw err
    }
    if (handled) return handled
    if (!linked) {
      if (input.sid) await deps.forgetInbound(input.sid).catch(() => {})
      return { outcome: 'unknown_ignored', reply: null }
    }
    if (linked.optedOut) return { outcome: 'opted_out', reply: null }
  }

  if (!linked) {
    if (deps.guestText) {
      let guest: GuestTextResult | null
      try {
        guest = await deps.guestText(
          { phone, text: input.body.trim().slice(0, TEXT_MAX_CHARS), sid: input.sid, numMedia: input.numMedia },
          {
            autoReply: (to, kind, text, guestId) => autoReply(deps, to, kind, text, now, guestId),
            noticedSince: (to, sinceMs) => deps.hasOutbound(to, 'guest_notice', sinceMs),
          },
        )
      } catch (err) {
        // Not handled: forget the sid, as a failed delivery below does.
        if (input.sid) await deps.forgetInbound(input.sid).catch(() => {})
        throw err
      }
      if (guest) return guest
    }
    if (deps.signupText) {
      try {
        return await deps.signupText(
          { phone, text: input.body.trim().slice(0, TEXT_MAX_CHARS), sid: input.sid },
          { autoReply: (kind, text) => autoReply(deps, phone, kind, text, now) },
        )
      } catch (err) {
        // Not handled: forget the sid, as a failed delivery below does.
        if (input.sid) await deps.forgetInbound(input.sid).catch(() => {})
        throw err
      }
    }
    if (await deps.hasOutbound(phone, 'unknown_reply')) return { outcome: 'unknown_ignored', reply: null }
    const reply = await autoReply(deps, phone, 'unknown_reply', unknownNumberReply(deps.origin), now)
    return { outcome: reply ? 'unknown_replied' : 'unknown_ignored', reply }
  }

  // Before the phone's workspace check: an approval is fenced on its own
  // workspace's member row (./approvals.ts), and the ping that carried the
  // code may have come from another workspace.
  const words = input.body.trim().slice(0, TEXT_MAX_CHARS)
  if (deps.answerApproval && words && input.sid) {
    const answered = await deps.answerApproval({ linked, text: words, sid: input.sid })
    if (textApprovalHandled(answered.outcome)) return { outcome: answered.outcome as InboundOutcome, reply: answered.reply }
  }

  if (!(await deps.isWorkspaceMember(linked.userId, linked.workspaceId))) {
    if (await deps.hasOutbound(phone, 'notice', now - DAY_MS)) return { outcome: 'not_member_ignored', reply: null }
    await deps.recordOutbound({ phone, kind: 'notice', userId: linked.userId })
    return { outcome: 'not_member', reply: notMemberReply(deps.origin) }
  }

  let text = input.body.trim().slice(0, TEXT_MAX_CHARS)
  // A texted spreadsheet or phone contacts: saved, and named for the agent (roadmap track G1).
  const files = deps.saveTextedFiles && input.media?.length ? await deps.saveTextedFiles({ linked, media: input.media }) : []
  if (files.length) text = [text, textedFilesNote(files)].filter(Boolean).join('\n\n')
  if (!text || !input.sid) {
    return input.numMedia > 0 ? { outcome: 'no_text', reply: NO_TEXT_REPLY } : { outcome: 'no_text', reply: null }
  }

  try {
    await deps.deliverText({ linked, text, sid: input.sid })
  } catch (err) {
    // Not delivered: forget the sid, so a second delivery of this message
    // (Twilio's fallback URL, if one is set) is handled in full rather than
    // dropped as a duplicate. Twilio itself never retries a 5xx.
    await deps.forgetInbound(input.sid).catch(() => {})
    throw err
  }
  return { outcome: 'queued', reply: null }
}

/** The real store behind {@link handleInboundSms}, on the service client. */
export function supabaseInboundDeps(
  supabase: SupabaseClient,
  args: { origin: string; deliverText: InboundDeps['deliverText']; signupText?: InboundDeps['signupText'] },
): InboundDeps {
  return {
    saveTextedFiles: ({ linked, media }) => saveTextedFiles(supabase, { userId: linked.userId, media }),
    ...(args.signupText ? { signupText: args.signupText } : {}),
    recordInbound: (row) => recordInbound(supabase, row),
    forgetInbound: (sid) => forgetInbound(supabase, sid),
    findLinkedPhone: (phone) => findLinkedPhone(supabase, phone),
    businessPerson: (phone, workspaceId) => findBusinessPerson(supabase, phone, workspaceId),
    setPhoneOptOut: (phone, optedOut) => setPhoneOptOut(supabase, phone, optedOut),
    setPhoneRowOptOut: (id, optedOut) => setPhoneRowOptOut(supabase, id, optedOut),
    unlinkedNumberOptedOut: (phone) => unlinkedNumberOptedOut(supabase, phone),
    countInboundSince: (phone, sinceMs) => countInboundSince(supabase, phone, sinceMs),
    countOutboundKindsSince: (kinds, sinceMs) => countOutboundKindsSince(supabase, kinds, sinceMs),
    hasOutbound: (phone, kind, sinceMs) => hasOutbound(supabase, phone, kind, sinceMs),
    recordOutbound: (row) => recordOutbound(supabase, row),
    isWorkspaceMember: (userId, workspaceId) => isWorkspaceMember(supabase, userId, workspaceId),
    answerApproval: (input) => answerApprovalByText(input, supabaseTextApprovalDeps(supabase)),
    guestText: (input, tools) => handleGuestText(input, supabaseGuestTextDeps(supabase, tools)),
    businessLine: async (to) => {
      // The Dial8 number is never a business's: no read at all for it.
      if (normalizeE164(twilioPhoneNumber()) === normalizeE164(to)) return null
      try {
        const number = await findBusinessNumber(supabase, to)
        return number ? { number, name: await businessName(supabase, number.workspaceId) } : null
      } catch (err) {
        // A failed lookup must never cost a STOP or a person's own text: read as the Dial8 line.
        console.error('[twilio-sms] ALERT business number lookup failed, taken as the Dial8 line:', err instanceof Error ? err.message : String(err))
        return null
      }
    },
    businessText: (input, tools) => handleBusinessText(input, supabaseBusinessTextDeps(supabase, tools)),
    customerStopped: (business, phone) => remindersStopped(supabase, { workspaceId: business.number.workspaceId, phone, businessName: business.name }),
    setGuestOptOut: (phone, optedOut) => setGuestOptOut(supabase, phone, optedOut),
    deliverText: args.deliverText,
    origin: args.origin,
  }
}
