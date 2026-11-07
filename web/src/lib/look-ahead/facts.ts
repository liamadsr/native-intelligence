/**
 * The look-ahead's facts (docs/plans/look-ahead-heartbeat.md §4.3–4.4): for
 * each candidate, the mail that may explain it (read live, nothing stored:
 * migration 344), then ONE utility call that pulls out where to go, what to
 * bring and the confirmation code, then a check of every field against the
 * text it came from.
 *
 * WHAT GOES OUT. Only checked fields (LookAheadFacts) leave this module: never
 * a mail's words. The message is Dial8's template over them (./message.ts),
 * so a planted line in a mail can't reach the person. A field that doesn't
 * appear in its event or its mail is dropped (an invented address, a
 * requirement nobody wrote), and so is anything carrying a link.
 *
 * THE MAIL. Per candidate, one provider search (searchEmails: Gmail `q=`,
 * Graph `$search`) on the title's distinctive words plus booking words, from
 * the last LOOK_AHEAD_MAIL_DAYS days; the newest LOOK_AHEAD_MAIL_THREADS
 * threads, skipping any the email.trust pass marked suspicious or an
 * injection; of each, the newest message, clipped to LOOK_AHEAD_MAIL_CHARS.
 * The caller runs this inside one step that returns only the facts, so no
 * mail text is kept in the step's stored output either.
 *
 * BOOKINGS WITH NO CALENDAR ITEM (Slice 4, decision 3: live, nothing
 * stored). One more search, on booking words alone, from the same 30 days;
 * of the newest threads not already read for an item, the ones whose newest
 * message names the span's date (dateForms) are read as unmatched mail, and
 * the model may answer with an `extra` booking from them. An extra goes out
 * only when its time falls in the span and appears in its mail, and every
 * word of its title is the mail's own.
 *
 * A failed read or a failed model call is no facts for that item, never a
 * guess: the message then carries what the calendar says.
 */
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { LookAheadCandidate } from './candidates'

/** How far back the mail behind an item is searched. */
export const LOOK_AHEAD_MAIL_DAYS = 30
/** Threads read per item. */
export const LOOK_AHEAD_MAIL_THREADS = 2
/** A message's text, clipped to this before the model reads it. */
export const LOOK_AHEAD_MAIL_CHARS = 2_000

/** One item's checked facts: only what its event or mail says. */
export interface LookAheadFacts {
  /** The model judged it worth the message (an ordinary meeting is not). */
  include: boolean
  /** Where to go, copied from the event or the mail. */
  place: string | null
  /** At most 3 things to bring, each from the mail or the event. */
  bring: string[]
  /** A booking code, copied from the mail. */
  confirmation: string | null
  /** The model tied a mail of the person's own to it (their inbox backs the item up). */
  corroborated?: boolean
}

/** A booking from mail that no calendar item stands for, checked. */
export interface LookAheadExtraFact {
  /** "HH:MM", in the span's hours, as its mail gives it. */
  localTime: string
  /** In the mail's own words. */
  title: string
  place: string | null
  bring: string[]
  confirmation: string | null
}

/** Unmatched booking mails read per pass. */
export const LOOK_AHEAD_BOOKING_MAILS = 4

/** The model's answer, before the checks. */
// Forgiving on purpose: a field the model leaves out or answers null is read
// as empty (the checks below never trust it anyway), so a near-miss answer
// isn't a failed call. A failed call sends nothing for items only the model
// may let through.
export const LookAheadExtractSchema = z.object({
  items: z
    .array(
      z.object({
        index: z.number().nullish(),
        include: z.boolean().nullish(),
        place: z.string().nullish(),
        bring: z.array(z.string()).nullish(),
        confirmation: z.string().nullish(),
        mail: z.number().nullish(),
      }),
    )
    .nullish(),
  extra: z
    .array(
      z.object({
        mail: z.number().nullish(),
        title: z.string().nullish(),
        time: z.string().nullish(),
        place: z.string().nullish(),
        bring: z.array(z.string()).nullish(),
        confirmation: z.string().nullish(),
      }),
    )
    .nullish(),
})
export type LookAheadExtract = z.infer<typeof LookAheadExtractSchema>

/** One mail excerpt the model reads, by its index. */
export interface LookAheadMail {
  /** Which candidate it was found for, or -1: a booking no calendar item is tied to. */
  item: number
  /** Its thread (so the booking search skips one already read). */
  threadId?: string
  from: string
  subject: string
  date: string
  text: string
}

// ── The search ───────────────────────────────────────────────────────────────

/** Words a title shares with every calendar, which find nothing on their own. */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'your', 'you', 'our', 'meeting', 'call', 'sync', 'tomorrow', 'today', 'morning', 'pick', 'up', 'at', 'to', 'in', 'on', 'of', 'a', 'an', 'my',
])

/**
 * The provider query for an item: up to 3 of its title's distinctive words
 * (and its place's first word when the title gives fewer), OR'd with
 * booking words, so a "Pick up rental car" block finds Enterprise's
 * "Your reservation is confirmed". Null when nothing distinctive is left. Pure.
 */
export function mailQueryFor(c: Pick<LookAheadCandidate, 'meeting'>): string | null {
  const words = (s: string | null | undefined) =>
    (s ?? '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
  const picked = [...new Set([...words(c.meeting.title), ...words(c.meeting.location).slice(0, 1)])].slice(0, 3)
  if (picked.length === 0) return null
  return `(${picked.join(' OR ')}) (confirmation OR confirmed OR reservation OR booking OR itinerary OR appointment)`
}

/** Reads, for tests to stub: the live search and message read the chat's own tools use. */
export interface LookAheadMailDeps {
  search: (userId: string, workspaceId: string, options: { query: string; after: string; limit: number }) => Promise<Array<{ threadId: string; messageId?: string; subject: string; from: { email: string; name: string | null }; date: string; snippet: string }>>
  readMessage: (userId: string, messageId: string, workspaceId: string) => Promise<{ subject?: string; bodyText?: string; from?: unknown; date?: string } | null>
  /** Thread ids the email.trust pass marked suspicious or an injection. */
  untrusted: (userId: string, threadIds: readonly string[]) => Promise<Set<string>>
}

/** The live implementations (imported lazily: this module stays light for the cron's plan). */
export function liveMailDeps(supabase: SupabaseClient): LookAheadMailDeps {
  return {
    search: async (userId, workspaceId, options) => {
      const { searchEmails } = await import('@/lib/email/email-search-service')
      return (await searchEmails(userId, workspaceId, options)).results
    },
    readMessage: async (userId, messageId, workspaceId) => {
      const { readEmailMessage } = await import('@/lib/email/email-read-service')
      return (await readEmailMessage(userId, messageId, workspaceId)) as { subject?: string; bodyText?: string; date?: string } | null
    },
    untrusted: async (userId, threadIds) => {
      if (!threadIds.length) return new Set()
      const { data, error } = await supabase.from('email_thread_index').select('provider_thread_id, trust').eq('user_id', userId).in('provider_thread_id', [...threadIds])
      // A failed read trusts nothing: those threads are left out.
      if (error) return new Set(threadIds)
      return new Set(
        ((data as Array<{ provider_thread_id?: unknown; trust?: unknown }> | null) ?? [])
          .filter((r) => r.trust === 'suspicious' || r.trust === 'injection')
          .map((r) => String(r.provider_thread_id)),
      )
    },
  }
}

/**
 * The mail behind each candidate, newest first, at most
 * LOOK_AHEAD_MAIL_THREADS per item, each the newest message's text clipped.
 * A failed search or read is no mail for that item. Never throws.
 */
export async function readLookAheadMail(
  deps: LookAheadMailDeps,
  args: { userId: string; workspaceId: string; candidates: readonly LookAheadCandidate[]; nowMs: number },
): Promise<LookAheadMail[]> {
  const after = new Date(args.nowMs - LOOK_AHEAD_MAIL_DAYS * 86_400_000).toISOString().slice(0, 10)
  // Two items at a time: each search costs a metadata read per hit, and a
  // burst near the provider's per-user rate would drop facts silently.
  const found = await inPool(
    args.candidates.map((c, item) => async (): Promise<LookAheadMail[]> => {
      const query = mailQueryFor(c)
      if (!query) return []
      try {
        const hits = await deps.search(args.userId, args.workspaceId, { query, after, limit: 5 })
        const bad = await deps.untrusted(args.userId, hits.map((h) => h.threadId))
        // A calendar invitation's own email isn't a confirmation: it only repeats the invite.
        const threads = hits.filter((h) => !bad.has(h.threadId) && h.messageId && !isInvitationMail(h)).slice(0, LOOK_AHEAD_MAIL_THREADS)
        const read = await Promise.all(
          threads.map(async (h): Promise<LookAheadMail | null> => {
            const message = await deps.readMessage(args.userId, h.messageId!, args.workspaceId).catch(() => null)
            const text = (message?.bodyText ?? h.snippet ?? '').replace(/\s+/g, ' ').trim().slice(0, LOOK_AHEAD_MAIL_CHARS)
            return text ? { item, threadId: h.threadId, from: h.from.email, subject: (message?.subject ?? h.subject ?? '').slice(0, 200), date: h.date, text } : null
          }),
        )
        return read.filter((m): m is LookAheadMail => m !== null)
      } catch {
        return []
      }
    }),
    2,
  )
  return found.flat()
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/**
 * How mail writes a date (YYYY-MM-DD): "Oct 28", "October 28", "28 Oct",
 * "10/28", "2026-10-28", lower case, for a `contains` test. Pure.
 */
export function dateForms(date: string): string[] {
  const [y, m, d] = date.split('-').map(Number)
  const long = MONTHS[m - 1].toLowerCase()
  const short = long.slice(0, 3)
  const mm = String(m).padStart(2, '0')
  const dd = String(d).padStart(2, '0')
  return [`${short} ${d}`, `${short}. ${d}`, `${long} ${d}`, `${d} ${short}`, `${d} ${long}`, `${m}/${d}`, `${mm}/${dd}`, date, `${y}/${mm}/${dd}`]
}

/** Whether a mail's words name the date (dateForms), not a later day ("Oct 28" inside "Oct 280", "10/2" inside "10/28"). Pure. */
export function namesDate(text: string, date: string): boolean {
  const t = ` ${text.toLowerCase().replace(/\s+/g, ' ')} `
  return dateForms(date).some((form) => {
    let at = t.indexOf(form)
    while (at !== -1) {
      const before = t[at - 1] ?? ' '
      const after = t[at + form.length] ?? ' '
      if (!/[0-9]/.test(before) && !/[0-9]/.test(after)) return true
      at = t.indexOf(form, at + 1)
    }
    return false
  })
}

/** The booking words, with the date as mail writes it: a confirmation for that day, not last month's order. Pure. */
export function bookingQuery(date: string): string {
  const [, m, d] = date.split('-').map(Number)
  const month = MONTHS[m - 1]
  const nth = d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th'
  const forms = [`"${month.slice(0, 3)} ${d}"`, `"${month} ${d}"`, `"${month} ${d}${nth}"`, `"${d} ${month.slice(0, 3)}"`, `"${m}/${d}"`, `"${date}"`]
  return `(confirmation OR confirmed OR reservation OR booking OR itinerary OR appointment OR pickup) (${forms.join(' OR ')})`
}

/** A forwarded mail's subject: someone else's booking, sent on. */
const FORWARDED_RE = /^\s*(fwd?|fw)\s*:/i
/** A calendar invitation's own email (Google's, Outlook's): it repeats the invite, it never backs it up. */
const INVITATION_SUBJECT_RE = /^\s*(updated\s+)?invitation(\s+\(updated\))?\s*:|^\s*(accepted|declined|tentative|canceled|cancelled)( event)?\s*:/i
const CALENDAR_SENDER_RE = /^(calendar-notification@google\.com|calendar-server@|.*noreply.*calendar)/i

/** Whether a mail is a calendar invitation's own (by its subject or sender). Pure. */
export function isInvitationMail(m: { subject?: string | null; from: { email: string } | string }): boolean {
  const from = typeof m.from === 'string' ? m.from : m.from.email ?? ''
  return INVITATION_SUBJECT_RE.test(m.subject ?? '') || CALENDAR_SENDER_RE.test(from)
}

/**
 * Whether a mail backs an item up as the person's own booking: not the
 * organizer's own mail (a stranger's invite could carry its "confirmation"),
 * not an invitation, not forwarded. Pure.
 */
export function backsUp(mail: LookAheadMail, candidate: LookAheadCandidate): boolean {
  const organizer = candidate.meeting.organizer ?? null
  return !FORWARDED_RE.test(mail.subject) && !isInvitationMail(mail) && !(organizer && mail.from.toLowerCase() === organizer)
}

/** Run these tasks, at most `limit` at once, in order. Never throws what they don't. */
async function inPool<T>(tasks: ReadonlyArray<() => Promise<T>>, limit: number): Promise<T[]> {
  const out = new Array<T>(tasks.length)
  let next = 0
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++
      out[i] = await tasks[i]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
  return out
}

/**
 * Booking mail no calendar item stands for (see the header): newest first,
 * threads not already read, only those whose newest message names the
 * span's date, at most LOOK_AHEAD_BOOKING_MAILS. `item` is -1 on each. A
 * failed search or read is none. Never throws.
 */
export async function readBookingMail(
  deps: LookAheadMailDeps,
  args: { userId: string; workspaceId: string; date: string; nowMs: number; readThreads: ReadonlySet<string> },
): Promise<LookAheadMail[]> {
  const after = new Date(args.nowMs - LOOK_AHEAD_MAIL_DAYS * 86_400_000).toISOString().slice(0, 10)
  try {
    const hits = await deps.search(args.userId, args.workspaceId, { query: bookingQuery(args.date), after, limit: 8 })
    const bad = await deps.untrusted(args.userId, hits.map((h) => h.threadId))
    const fresh = hits.filter((h) => !bad.has(h.threadId) && !args.readThreads.has(h.threadId) && h.messageId && !FORWARDED_RE.test(h.subject ?? '')).slice(0, 6)
    const read = await Promise.all(
      fresh.map(async (h): Promise<LookAheadMail | null> => {
        const message = await deps.readMessage(args.userId, h.messageId!, args.workspaceId).catch(() => null)
        const subject = (message?.subject ?? h.subject ?? '').slice(0, 200)
        const text = (message?.bodyText ?? h.snippet ?? '').replace(/\s+/g, ' ').trim().slice(0, LOOK_AHEAD_MAIL_CHARS)
        if (FORWARDED_RE.test(subject)) return null
        return text && namesDate(`${subject} ${text}`, args.date) ? { item: -1, threadId: h.threadId, from: h.from.email, subject, date: h.date, text } : null
      }),
    )
    return read.filter((m): m is LookAheadMail => m !== null).slice(0, LOOK_AHEAD_BOOKING_MAILS)
  } catch {
    return []
  }
}

// ── The model's read ─────────────────────────────────────────────────────────

/** Text that can't open or close a fence: either tag, any case or spacing. */
function fenceSafe(text: string): string {
  return text.replace(/<\s*\/?\s*(event|mail)\b/gi, '‹')
}

/** The utility task's message: each item fenced, its mail fenced under it, then the booking mails tied to no item. Pure. */
export function buildExtractMessage(candidates: readonly LookAheadCandidate[], mail: readonly LookAheadMail[], args: { date: string; fromHour: number; toHour: number }): string {
  const hour = (h: number) => `${String(h).padStart(2, '0')}:00`
  const lines: string[] = [`The day is ${args.date}, from ${hour(args.fromHour)} to ${hour(args.toHour)}. The person's calendar items then:${candidates.length ? '' : ' none.'}`]
  candidates.forEach((c, i) => {
    const m = c.meeting
    const event = [
      `title: ${m.title ?? ''}`,
      `time: ${c.localTime ?? 'all day'}`,
      ...(m.location ? [`location: ${m.location}`] : []),
      ...(m.description ? [`description: ${m.description}`] : []),
    ].join('\n')
    lines.push(`\nItem ${i}:\n<event>\n${fenceSafe(event)}\n</event>`)
  })
  mail.forEach((m, j) => {
    const tie = m.item >= 0 ? `for item ${m.item}` : 'a booking no calendar item is tied to'
    lines.push(`\nMail ${j} (${tie}), from ${m.from}, ${m.date}:\n<mail>\nsubject: ${fenceSafe(m.subject)}\n${fenceSafe(m.text)}\n</mail>`)
  })
  return lines.join('\n')
}

// ── The checks ───────────────────────────────────────────────────────────────

/** Lower case, punctuation as spaces, one space between words. Pure. */
function norm(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** A link, a web address of any domain, or an email address: never in what goes out. */
const LINK_RE = /https?:\/\/|www\.|@|\b[a-z0-9-]{2,}\.[a-z]{2,24}\b/i

/** What a person brings: an ID, a card, a ticket, a document. Anything else isn't a thing to bring. */
const BRING_OK_RE = /\b(licen[cs]e|id|identification|passport|credit card|debit card|card|payment method|ticket|boarding pass|insurance|vaccination|proof of \w+|voucher|printed|print-?out|registration|keys?|documents?|car seat|helmet)\b/i
/** Money, codes and secrets: a planted "wire $500" or "your password" is never a thing to bring. */
const BRING_BAD_RE = /[$€£]|\b(wire|transfer|send|pay|venmo|zelle|cash ?app|bitcoin|crypto|gift ?cards?|cash|password|pin|code|otp)\b/i

/** A mail's section heading, not a thing to bring ("Rental Details", "Pickup Information"). */
const HEADING_WORD_RE = /\b(details|information|info|summary|instructions|overview|policy|policies|terms)\b/i

/**
 * The model's answer for one item, checked (see the header): the place and
 * each thing to bring must appear in its event or the mail it named, the
 * confirmation word for word in that mail, no field may carry a link, and
 * each is clipped. Pure.
 */
export function checkFacts(
  answer: NonNullable<LookAheadExtract['items']>[number] | undefined,
  args: { candidate: LookAheadCandidate; mail: LookAheadMail | null },
): LookAheadFacts {
  const none: LookAheadFacts = { include: false, place: null, bring: [], confirmation: null }
  if (!answer) return none
  const m = args.candidate.meeting
  const eventText = norm([m.title, m.location, m.description].filter(Boolean).join(' '))
  const mailText = args.mail ? norm(`${args.mail.subject} ${args.mail.text}`) : ''
  const source = `${eventText} ${mailText}`
  const appears = (value: string) => {
    const v = norm(value)
    return v.length > 0 && source.includes(v)
  }
  const clean = (value: string, max: number) => value.replace(/\s+/g, ' ').trim().slice(0, max)

  const place = clean(answer.place ?? '', 140)
  const bring = (answer.bring ?? [])
    .map((b) => clean(b, 48))
    .filter((b) => b && !LINK_RE.test(b) && !HEADING_WORD_RE.test(b) && BRING_OK_RE.test(b) && !BRING_BAD_RE.test(b))
    // Each thing to bring: most of its words are in the event or the mail.
    .filter((b) => {
      const words = norm(b).split(' ').filter((w) => w.length >= 3)
      return words.length > 0 && words.filter((w) => source.includes(w)).length * 2 >= words.length + 1
    })
    .slice(0, 3)
  // A booking code: 5 to 12 letters and digits, no separators, at most 7 digits (a phone number is never one).
  const code = clean(answer.confirmation ?? '', 24)
  const digits = (code.match(/[0-9]/g) ?? []).length
  const confirmation = code && /^[A-Za-z0-9]{5,12}$/.test(code) && digits <= 7 && args.mail && args.mail.text.toLowerCase().includes(code.toLowerCase()) ? code : null
  return {
    include: answer.include === true,
    place: place && !LINK_RE.test(place) && appears(place) ? place : null,
    bring,
    confirmation,
    ...(args.mail && backsUp(args.mail, args.candidate) ? { corroborated: true } : {}),
  }
}

/**
 * Whether mail writes this time: "7:30 am" / "7:30AM" / "7:30 a.m." with the
 * right half of the day, or the 24-hour "07:30" / "19:30" with no am or pm
 * after it; never inside a longer number ("11:30" doesn't hold "1:30"). Pure.
 */
export function writesTime(text: string, hh: number, mm: number): boolean {
  const m = String(mm).padStart(2, '0')
  const h12 = hh % 12 === 0 ? 12 : hh % 12
  const half = hh < 12 ? 'a' : 'p'
  const twelve = new RegExp(`(?<![0-9:])${h12}:${m}\\s?${half}\\.?\\s?m\\b`, 'i')
  const twentyFour = new RegExp(`(?<![0-9:])${String(hh).padStart(2, '0')}:${m}(?![0-9])(?!\\s?[ap]\\.?\\s?m\\b)`, 'i')
  return twelve.test(text) || twentyFour.test(text)
}

/**
 * The bookings with no calendar item, checked (see the header): from an
 * unmatched mail only, one per mail; a time in the span's hours that the
 * mail writes; a title in the mail's own words; and the item checks for the
 * rest, against that mail. At most LOOK_AHEAD_BOOKING_MAILS. Pure.
 */
export function extraFactsFor(mail: readonly LookAheadMail[], answer: LookAheadExtract | null, span: { fromHour: number; toHour: number }): LookAheadExtraFact[] {
  const out: LookAheadExtraFact[] = []
  const usedMail = new Set<number>()
  for (const e of answer?.extra ?? []) {
    const at = typeof e.mail === 'number' && Number.isInteger(e.mail) ? e.mail : -1
    const m = at >= 0 && at < mail.length && mail[at].item === -1 ? mail[at] : null
    if (!m || usedMail.has(at)) continue
    const time = /^(\d{1,2}):(\d{2})$/.exec((e.time ?? '').trim())
    if (!time) continue
    const hh = Number(time[1])
    const mm = Number(time[2])
    if (hh > 23 || mm > 59 || hh < span.fromHour || hh >= span.toHour) continue
    if (!writesTime(`${m.subject} ${m.text}`, hh, mm)) continue
    const title = (e.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
    const words = norm(title).split(' ').filter((w) => w.length >= 3)
    const mailWords = norm(`${m.subject} ${m.text}`)
    if (!words.length || !words.every((w) => mailWords.includes(w)) || LINK_RE.test(title)) continue
    // The item checks, against this mail alone (no calendar item stands for it).
    const stand: LookAheadCandidate = { meeting: { ref: 'calendar_event', id: '', meetingKey: '', workspaceId: '', userId: '', title: null, startIso: '', attendees: [], calendarEventId: null, captureId: null }, why: ['travel'], localTime: null }
    const f = checkFacts({ index: 0, include: true, place: e.place ?? '', bring: e.bring ?? [], confirmation: e.confirmation ?? '', mail: 0 }, { candidate: stand, mail: m })
    usedMail.add(at)
    out.push({ localTime: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`, title, place: f.place, bring: f.bring, confirmation: f.confirmation })
  }
  return out.slice(0, LOOK_AHEAD_BOOKING_MAILS)
}

/** The facts for every candidate, in order, from the model's answer and the mail it read. Pure. */
export function factsFor(candidates: readonly LookAheadCandidate[], mail: readonly LookAheadMail[], answer: LookAheadExtract | null): LookAheadFacts[] {
  return candidates.map((candidate, i) => {
    const a = (answer?.items ?? []).find((x) => x.index === i)
    const at = a?.mail ?? -1
    const used = a && Number.isInteger(at) && at >= 0 && at < mail.length && mail[at].item === i ? mail[at] : null
    return checkFacts(a, { candidate, mail: used })
  })
}
