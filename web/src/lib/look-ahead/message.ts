/**
 * The look-ahead's messages (docs/plans/look-ahead-heartbeat.md §3, §4.5):
 * Native Intelligence's template over the checked facts, never a model's free text, and
 * their writes:
 *   • the home thread: one assistant message per slot and date (the evening's
 *     `look-ahead:<date>`, the morning's `look-ahead:<date>:later`, a
 *     departure's `look-ahead:travel:<meeting key>:<start>`), written once
 *     (the unique message id; no model turn of its own: text-and-calling
 *     decision 5);
 *   • the agent log: one `look_ahead` line, which the main agent reads in its
 *     `log` section, so "what time was the car again?" is answered from it;
 *   • one `agent_look_ahead` notice from the Assistant (the one face);
 *   • its text (`metadata.look_ahead_sms`), which the router takes to the
 *     person when they are away from the app (src/lib/reach/route.ts):
 *     outside quiet hours, once per person, slot and date (reach_notice,
 *     under {@link lookAheadTextKey}). The run only asks for the route.
 * Nothing at all when no item made it (the hide-empty rule).
 *
 * WHAT MAY GO OUT. Every title and place is scrubbed of phone numbers (any
 * separators, vanity ones too, and any run of seven or more digits), links,
 * web addresses and email addresses (scrub), after Unicode normalization: a
 * stranger's invite or a planted mail can't put "call 1-888-…" or a domain on
 * the person's phone. A thing to bring goes out as Native Intelligence's own words for it
 * (canonicalBring: "driver's license", "a payment card in your name"), never
 * the mail's. A text names a place only when it is the calendar's own or
 * shaped like a street address. A booking found only in mail (an extra) stays in the
 * app: it never goes by text, and the log line and the notice name only
 * calendar items, so no mail-derived words are kept beyond the message
 * itself (decision 344). So does an invite they never answered unless a mail
 * of theirs backs it up (`appOnly`), or one of their guests sent it and the
 * invite's own data backs her up (candidates.ts guestConfirmed).
 *
 *   For tomorrow morning:
 *   - **7:30 am** Pick up rental car, at Enterprise, 1250 Market St
 *     (confirmation 4417XK). Bring: driver's license, credit card in your name.
 *   - **9:00 am** Dentist, at 450 Sutter St.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { appendLogLine } from '@/lib/log/agent-log'
import { createNotification } from '@/lib/notifications'
import { createHash } from 'node:crypto'
import { botNoticeCopy, botNoticeMetadata, noticeTeammateName } from '@/lib/bots/bot-notice'
import { QUIET_END_HOUR, QUIET_START_HOUR } from '@/lib/reach/dispatch'
import { systemTeammateId } from '@/lib/work/system-teammates'
import { zonedInstant, type LookAheadCandidate, type LookAheadSlot } from './candidates'
import type { LookAheadExtraFact, LookAheadFacts } from './facts'
import { LOOK_AHEAD_MESSAGE_KIND } from './message-kind'

export { LOOK_AHEAD_MESSAGE_KIND }

/** What a message is: a slot's look-ahead, or one departure's heads-up. */
export type LookAheadMessageFor = { slot: LookAheadSlot; date: string } | { travel: { meetingKey: string; startIso: string } }

/** The home-thread message's id: one per slot and date, or per departure. Pure. */
export function lookAheadMessageId(of: LookAheadMessageFor): string {
  if ('travel' in of) return `look-ahead:travel:${of.travel.meetingKey}:${of.travel.startIso}`
  return of.slot === 'evening' ? `look-ahead:${of.date}` : `look-ahead:${of.date}:later`
}

/** One item a message carries. */
export interface LookAheadLine {
  /** "7:30 am", or "All day". */
  when: string
  title: string
  place: string | null
  bring: string[]
  confirmation: string | null
  /** "HH:MM" for ordering, null for all day. */
  sortKey: string | null
  /** A booking found only in mail: shown in the app, never texted, never in the log line or the notice. */
  fromMail?: boolean
  /** The place is the calendar's own location (else the mail's). */
  placeFromCalendar?: boolean
  /**
   * Shown in the app, never texted: an invite the person never answered that
   * no mail of theirs backs up (a stranger's invite has no confirmation in
   * their inbox), and no confirmed guest's (candidateAppOnly).
   */
  appOnly?: boolean
}

/** What separates a number's digits: spaces, brackets, dots, slashes, underscores, middle dots and every dash. */
const SEP = '[\\s().\\-\\u2010-\\u2015\\u2212/_\\u00b7]'
/** A phone number: 10 or more digits, any separators. */
const PHONE_RE = new RegExp(`(?:\\+?\\(?\\d${SEP}*){10,}`, 'g')
/** A vanity number ("1-800-FLY-DELTA", "(888) GET-HELP", "800-FLY-UNITED"): letters in it, its parts joined by dashes; never a street number ("845 Market St"). */
const VANITY_RE = new RegExp(`(?:\\b1${SEP}+\\(?8\\d\\d\\)?${SEP}+|\\(8\\d\\d\\)${SEP}*|\\b8\\d\\d-)(?=[a-z0-9-]*[a-z])[a-z0-9]{2,}(?:-[a-z0-9]{2,})*`, 'gi')
/** Any run of seven or more digits, whatever separates them. */
const LONG_DIGITS_RE = new RegExp(`\\d(?:${SEP}*\\d){6,}`, 'g')
/** A link, a web address of any domain, or an email address (spelled out with "at" and "dot" too). */
const ADDRESS_RE =
  /https?:\/\/\S+|www\.\S+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|[\w.+-]+\s*[[(]\s*at\s*[\])]\s*[\w-]+\s*[[(]\s*dot\s*[\])]\s*[a-z]{2,}|\b[a-z0-9][a-z0-9-]{1,62}(?:\.[a-z0-9-]{1,63})*\.[a-z]{2,24}\b(?:\/\S*)?/gi

/** Text that may go out: no phone number, link, web or email address, on one line. Pure. */
export function scrub(text: string): string {
  return text
    .normalize('NFKC')
    .replace(ADDRESS_RE, ' ')
    .replace(PHONE_RE, ' ')
    .replace(VANITY_RE, ' ')
    .replace(LONG_DIGITS_RE, ' ')
    .replace(/\s+([,.;:)])/g, '$1')
    .replace(/([,;:(])\s*(?=[,;:)]|$)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The things a person brings, in Native Intelligence's own words: the mail's are never sent. */
const BRING_WORDS: ReadonlyArray<[RegExp, (raw: string) => string]> = [
  [/boarding pass/i, () => 'boarding pass'],
  [/passport/i, () => 'passport'],
  [/driver.?s?\s*licen[cs]e|licen[cs]e/i, () => "driver's license"],
  [/\b(photo\s*)?id\b|identification/i, () => 'photo ID'],
  [/credit card|debit card|payment (card|method)|\bcard\b/i, (raw) => (/your name/i.test(raw) ? 'a payment card in your name' : 'a payment card')],
  [/insurance/i, () => 'insurance card'],
  [/ticket/i, () => 'your tickets'],
  [/voucher/i, () => 'the voucher'],
  [/car seat/i, () => 'car seat'],
  [/helmet/i, () => 'helmet'],
  [/\bkeys?\b/i, () => 'keys'],
]

/** A thing to bring in Native Intelligence's words, or null when it isn't one it knows. Pure. */
export function canonicalBring(raw: string): string | null {
  for (const [re, say] of BRING_WORDS) if (re.test(raw)) return say(raw)
  return null
}

/** Each thing once, in Native Intelligence's words. Pure. */
function bringList(raw: readonly string[]): string[] {
  return [...new Set(raw.map(canonicalBring).filter((b): b is string => !!b))].slice(0, 3)
}

/** A place shaped like a street address: a number and a street word, or a postcode. Pure. */
export function addressShaped(place: string): boolean {
  return /\d/.test(place) && /\b(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|pl|place|ct|court|hwy|highway|pkwy|parkway|sq|square|terrace|row|route|rte)\b|\b[A-Z]{2}\s?\d{5}\b|\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b|\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/i.test(place)
}

/** A title as a message shows it: one line, no links or markup, clipped. Pure. */
export function plainTitle(title: string | null): string {
  const t = scrub(
    (title ?? '')
      // A markdown link keeps its words, never its target.
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\(\s*\)/g, '')
      .replace(/[*_`[\]<>#|]/g, ''),
  ).replace(/\(\s*\)/g, '')
  return t.slice(0, 80).trim() || 'Untitled'
}

/** A place as a message shows it: one line, without a trailing country name. Pure. */
export function shortPlace(place: string | null | undefined): string | null {
  if (!place) return null
  const p = scrub(place.replace(/[*_`[\]<>#|]/g, ''))
    .replace(/,?\s*(USA|United States( of America)?|US)\.?\s*$/i, '')
    .trim()
  return p.slice(0, 140) || null
}

/** "07:30" as "7:30 am". Pure. */
export function clockLabel(localTime: string | null): string {
  if (!localTime) return 'All day'
  const [h, m] = localTime.split(':').map(Number)
  const suffix = h < 12 ? 'am' : 'pm'
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}:${String(m).padStart(2, '0')} ${suffix}`
}

/**
 * Whether a candidate's line stays in the app, never texted: an invite the
 * person never answered (or a meeting with others they didn't say yes to)
 * that no mail of theirs backs up, unless a guest of theirs sent it and the
 * invite's own data backs her up (candidates.ts guestConfirmed: their wife's
 * plans, Liam 2026-10-31; an emailed invite that only NAMES a guest as its
 * organizer is not enough). The departure heads-up follows it (run.ts). Pure.
 */
export function candidateAppOnly(c: LookAheadCandidate, f: LookAheadFacts | null | undefined): boolean {
  const unanswered = c.meeting.accepted === false || (c.needsModel === true && c.meeting.accepted !== true)
  return unanswered && !f?.corroborated && !(c.trusted === true && c.guestConfirmed === true)
}

/**
 * The items that go out, all-day first then by time: each candidate the
 * model kept, with what the checks let through (the calendar's own place
 * when the mail gave none), and each checked booking from mail that no
 * calendar item stands for, unless one already goes out at that time.
 * Without a model answer (`facts` null: the call failed), an item goes out
 * on its calendar alone only when it's travel or early: a place on its own
 * isn't worth a message without the model's yes. Pure.
 */
export function lookAheadLines(candidates: readonly LookAheadCandidate[], facts: readonly LookAheadFacts[] | null, extras: readonly LookAheadExtraFact[] = []): LookAheadLine[] {
  const out: LookAheadLine[] = []
  candidates.forEach((c, i) => {
    const f = facts?.[i]
    // A meeting with others goes out only on the model's yes, never on the calendar alone.
    const keep = facts ? f?.include === true : !c.needsModel && (c.why.includes('travel') || c.why.includes('early'))
    if (!keep) return
    const calendarPlace = c.meeting.location && c.why.includes('place') ? c.meeting.location : null
    const appOnly = candidateAppOnly(c, f)
    const place = shortPlace(f?.place ?? calendarPlace)
    out.push({
      when: clockLabel(c.localTime),
      title: plainTitle(c.meeting.title),
      place,
      bring: bringList(f?.bring ?? []),
      confirmation: f?.confirmation ?? null,
      sortKey: c.localTime,
      ...(place && !f?.place ? { placeFromCalendar: true } : {}),
      ...(appOnly ? { appOnly } : {}),
    })
  })
  for (const e of extras) {
    // The same booking the calendar already stands for (its code, or its street address), at whatever time the mail says.
    if (out.some((l) => l.sortKey === e.localTime || sameBooking(l, e))) continue
    out.push({ when: clockLabel(e.localTime), title: plainTitle(e.title), place: shortPlace(e.place), bring: bringList(e.bring), confirmation: e.confirmation, sortKey: e.localTime, fromMail: true })
  }
  return out.sort((a, b) => (a.sortKey ?? '').localeCompare(b.sortKey ?? ''))
}

/** A place's street number and the word after it ("305 e"), lower case, or null. Pure. */
function streetKey(place: string | null | undefined): string | null {
  const m = /\b(\d{1,5})\s+([a-z]+)/i.exec(place ?? '')
  return m ? `${m[1]} ${m[2].toLowerCase()}` : null
}

/** Whether a booking from mail is one a line already carries: the same code, or the same street address. Pure. */
function sameBooking(line: LookAheadLine, extra: { place: string | null; confirmation: string | null }): boolean {
  if (extra.confirmation && line.confirmation && extra.confirmation.toLowerCase() === line.confirmation.toLowerCase()) return true
  const a = streetKey(line.place)
  return !!a && a === streetKey(extra.place)
}

/** Each slot's heading. */
const HEADINGS: Record<LookAheadSlot, string> = { evening: 'For tomorrow morning:', morning: 'For later today:' }

/** One line of a message, in markdown. Pure. */
function markdownLine(l: LookAheadLine): string {
  let line = `- **${l.when}** ${l.title}`
  if (l.place) line += `, at ${l.place}`
  if (l.confirmation) line += ` (confirmation ${l.confirmation})`
  line += '.'
  return l.bring.length ? `${line} Bring: ${l.bring.join(', ')}.` : line
}

/** One line of a text message: plain, no markdown, a place only when it is the calendar's own or a street address. Pure. */
function plainLine(l: LookAheadLine): string {
  const place = l.place && (l.placeFromCalendar || addressShaped(l.place)) ? l.place : null
  return `${l.when}: ${l.title}${place ? `, ${place}` : ''}${l.confirmation ? ` (conf ${l.confirmation})` : ''}${l.bring.length ? `. Bring ${l.bring.join(', ')}` : ''}.`
}

/** A slot's message in markdown, or null with no lines. Pure. */
export function lookAheadText(lines: readonly LookAheadLine[], slot: LookAheadSlot = 'evening'): string | null {
  if (lines.length === 0) return null
  return [HEADINGS[slot], ...lines.map(markdownLine)].join('\n')
}

/** The same as a text message (bookings found only in mail, and unanswered invites nothing backs up, stay in the app), or null with nothing to text. Pure. */
export function lookAheadSmsText(lines: readonly LookAheadLine[], slot: LookAheadSlot = 'evening'): string | null {
  const texted = lines.filter((l) => !l.fromMail && !l.appOnly)
  if (texted.length === 0) return null
  return [slot === 'evening' ? 'Tomorrow morning:' : 'Later today:', ...texted.map(plainLine)].join('\n')
}

/** A departure's heads-up, in markdown and as a text. Pure. */
export function travelText(line: LookAheadLine): { markdown: string; sms: string } {
  return { markdown: `Coming up in about 3 hours:\n${markdownLine(line)}`, sms: `In about 3 hours: ${plainLine(line)}` }
}

/**
 * The agent-log line (≤200 chars at the table): what the main agent reads
 * back. The calendar's times and titles only: a place or a thing to bring may
 * be the mail's words, and a booking found only in mail is counted, never
 * named (decision 344 keeps no mail in the log). Pure.
 */
export function lookAheadLogLine(label: string, lines: readonly LookAheadLine[]): string {
  const items = lines.filter((l) => !l.fromMail).map((l) => `${l.when} ${l.title}`)
  const fromMail = lines.filter((l) => l.fromMail).length
  const more = fromMail ? `${items.length ? '; ' : ''}${fromMail === 1 ? 'a booking' : `${fromMail} bookings`} from their mail` : ''
  return `Look-ahead sent for ${label} (details in the thread): ${items.join('; ')}${more}`
}

/** The notice's words: Native Intelligence's, the first calendar item's time and title (a booking from mail is never named), and how many more. Pure. */
export function lookAheadNoticeCopy(lines: readonly LookAheadLine[], of: LookAheadMessageFor): { title: string; sentence: string } {
  const title = 'travel' in of ? 'Coming up in about 3 hours' : of.slot === 'evening' ? 'For tomorrow morning' : 'For later today'
  const first = lines.find((l) => !l.fromMail)
  const more = lines.length > 1 ? ` and ${lines.length - 1} more` : ''
  return { title, sentence: first ? `${first.when}: ${first.title}${more}. Details are in our thread.` : 'A booking from your mail. Details are in our thread.' }
}

/** A message's markdown and its text (null: nothing to text), or null with no lines. Pure. */
export function lookAheadBodies(of: LookAheadMessageFor, lines: readonly LookAheadLine[]): { markdown: string; sms: string | null } | null {
  if (lines.length === 0) return null
  if ('travel' in of) return travelText(lines[0])
  return { markdown: lookAheadText(lines, of.slot)!, sms: lookAheadSmsText(lines, of.slot) }
}

/**
 * The person-wide key a message's text is claimed under (reach_notice.ref_id,
 * ref_type 'look_ahead'): one text per person, slot and date, whichever
 * workspace's home thread the router finds it in first. Keyed on the message's
 * id (lookAheadMessageId), which the router reads off the row. Pure.
 */
export function lookAheadTextKey(userId: string, messageId: string): string {
  const h = createHash('sha256').update(`look-ahead-text:${userId}:${messageId}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

export interface LookAheadWriteArgs {
  workspaceId: string
  userId: string
  memberId: string
  conversationId: string
  of: LookAheadMessageFor
  lines: LookAheadLine[]
  /** The departures the message names, by their calendar keys: kept on the row so a retried run still schedules them. */
  departures?: ReadonlyArray<{ meetingKey: string; startIso: string }>
  /** The person's zone (the run's): it dates the message's shelf life (lookAheadShelfEnd). */
  timeZone?: string
}

/** The local date before `date` (YYYY-MM-DD). Pure. */
function previousDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)
}

/**
 * When a message stops being worth a text (`look_ahead_until`, which the
 * router reads, src/lib/reach/route-policy.ts): a departure's heads-up at the
 * departure; the evening's message at quiet start that evening (21:00, before
 * any item of tomorrow morning); "later today" at its first item's start or
 * 21:00 that day, whichever is earlier. Null without a zone. Pure.
 */
export function lookAheadShelfEnd(of: LookAheadMessageFor, lines: readonly LookAheadLine[], timeZone: string | undefined): number | null {
  if ('travel' in of) {
    const start = Date.parse(of.travel.startIso)
    return Number.isFinite(start) ? start : null
  }
  if (!timeZone) return null
  try {
    if (of.slot === 'evening') return zonedInstant(previousDate(of.date), QUIET_START_HOUR, timeZone)
    const quietStart = zonedInstant(of.date, QUIET_START_HOUR, timeZone)
    const starts = lines
      .map((l) => (l.sortKey && /^\d{2}:\d{2}$/.test(l.sortKey) ? l.sortKey.split(':').map(Number) : null))
      .filter((hm): hm is number[] => !!hm)
      .map(([h, m]) => zonedInstant(of.date, h, timeZone) + m * 60_000)
    return Math.min(quietStart, ...starts)
  } catch {
    return null
  }
}

export interface LookAheadWriteDeps {
  appendLog?: typeof appendLogLine
  notify?: typeof createNotification
}

/**
 * What one write did: the message's row (whether this call wrote it or a
 * first try did: a retried step still texts once and schedules its
 * departures), and whether this call wrote it. Never the message's words:
 * the caller's step output stays free of mail-derived text.
 */
export type LookAheadWritten = { rowId: string; first: boolean } | null

/**
 * Write the message, then (only the write that made it) the log line and the
 * notice, each on its own so a failed one never loses the rest. The text goes
 * separately (the router, src/lib/reach/route.ts), read back from the row.
 * Never throws; null when there is no message or it couldn't be written.
 */
export async function writeLookAhead(supabase: SupabaseClient, args: LookAheadWriteArgs, deps: LookAheadWriteDeps = {}): Promise<LookAheadWritten> {
  const bodies = lookAheadBodies(args.of, args.lines)
  if (!bodies) return null
  try {
    const messageId = lookAheadMessageId(args.of)
    const metadata = {
      kind: LOOK_AHEAD_MESSAGE_KIND,
      ...('travel' in args.of ? { look_ahead_travel: args.of.travel.meetingKey } : { look_ahead_slot: args.of.slot, look_ahead_date: args.of.date }),
      // The text's words, kept with the message they repeat (never in a step's output), and when they go stale.
      ...(bodies.sms ? { look_ahead_sms: bodies.sms } : {}),
      ...(() => {
        const until = bodies.sms ? lookAheadShelfEnd(args.of, args.lines, args.timeZone) : null
        return until !== null ? { look_ahead_until: new Date(until).toISOString() } : {}
      })(),
      ...(args.departures?.length ? { look_ahead_departures: args.departures.map((d) => ({ meetingKey: d.meetingKey, startIso: d.startIso })) } : {}),
    }
    const { data, error } = await supabase
      .from('chat_messages')
      .upsert(
        {
          conversation_id: args.conversationId,
          user_id: args.userId,
          workspace_id: args.workspaceId,
          role: 'assistant',
          ui_message: { id: messageId, role: 'assistant', parts: [{ type: 'text', text: bodies.markdown }], metadata },
        },
        { onConflict: 'conversation_id,ui_message_id', ignoreDuplicates: true },
      )
      .select('id')
    if (error) {
      console.warn('[look-ahead] message not written:', error.message)
      return null
    }
    const wrote = Array.isArray(data) && typeof (data[0] as { id?: unknown } | undefined)?.id === 'string' ? (data[0] as { id: string }).id : null
    if (!wrote) {
      // Already there (a retried step): the first write sent the log line and the notice.
      const { data: existing } = await supabase.from('chat_messages').select('id').eq('conversation_id', args.conversationId).eq('ui_message_id', messageId).limit(1)
      const id = Array.isArray(existing) && typeof (existing[0] as { id?: unknown } | undefined)?.id === 'string' ? (existing[0] as { id: string }).id : null
      return id ? { rowId: id, first: false } : null
    }
    void supabase
      .from('chat_conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', args.conversationId)
      .then(undefined, () => {})

    const label = 'travel' in args.of ? 'a departure' : args.of.slot === 'evening' ? `${args.of.date} morning` : `${args.of.date} afternoon and evening`
    try {
      await (deps.appendLog ?? appendLogLine)(
        { workspaceId: args.workspaceId, userId: args.userId, kind: 'look_ahead', line: lookAheadLogLine(label, args.lines), dedupeKey: messageId, refType: 'chat_message', refId: wrote },
        supabase,
      )
    } catch (err) {
      console.warn('[look-ahead] log line skipped:', err instanceof Error ? err.message : String(err))
    }
    try {
      const face = await systemTeammateId(supabase, args.workspaceId, 'assistant').catch(() => null)
      const copy = lookAheadNoticeCopy(args.lines, args.of)
      const bot = face ? botNoticeMetadata({ teammateId: face, teammateName: await noticeTeammateName(supabase, args.workspaceId, face), sentence: copy.sentence }) : {}
      const said = botNoticeCopy(bot, { title: copy.title, body: copy.sentence })
      await (deps.notify ?? createNotification)({
        workspaceId: args.workspaceId,
        recipientId: args.memberId,
        type: 'agent_look_ahead',
        title: said.title,
        body: said.body,
        groupKey: `agent_look_ahead:${messageId}`,
        metadata: { conversation_id: args.conversationId, look_ahead_message: messageId, ...bot },
      })
    } catch (err) {
      console.warn('[look-ahead] notice skipped:', err instanceof Error ? err.message : String(err))
    }
    return { rowId: wrote, first: true }
  } catch (err) {
    console.warn('[look-ahead] write failed:', err instanceof Error ? err.message : String(err))
    return null
  }
}

// ── Quiet hours ──────────────────────────────────────────────────────────────

/** Quiet hours by the local hour (text-and-calling decision 6): a departure inside them gets no heads-up (run.ts). */
export function inQuietHours(hour: number): boolean {
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR
}
