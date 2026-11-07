/**
 * An email THREAD → what listen mode reads aloud as it opens: the whole
 * conversation, told the way a person would tell it, not just its latest
 * message (Liam, 2026-10-02: "if it's an email thread, it knows to read the
 * entire conversation and not just the latest one … like, oh, this person sent
 * an email first with this body … and then this person responded with
 * something else. If there's attachments, it would just say, Oh, there's a
 * couple of attachments, but it doesn't try to read out their signature").
 * He chose every message read in full, cleaned, and NO model: fixed sentence
 * templates around each message's own words, as the Listen briefs are
 * (@/lib/listen-briefs/speech).
 *
 * One message (drafts left out) reads exactly as a single email always has
 * (./email-speech's emailToSentences: "From Sarah Chen, about Q3 planning."
 * then its words), with one sentence after the preface when it carries files:
 * "It has two attachments."
 *
 * Several read oldest to newest (by date when every message has one, else in
 * the order given):
 *   "Q3 planning: a thread of three emails."
 *   "Sarah wrote first, on Monday." then Sarah's words;
 *   "Bob replied the next day, with two attachments." then Bob's;
 *   "Then you replied yesterday." then the user's.
 * Each message is only what its sender wrote in it (./email-speech's
 * emailBodyLines: no quoted history, so the earlier mail isn't read twice, no
 * signature, tagline or footer), and the first loses an opening line that
 * repeats the subject. Its closing "Best, Sarah" goes too, since the intro
 * just said who wrote it (a reply that is only "Thanks!" keeps it). Files are counted, never named. A reply with nothing
 * of its own is left out, unless it carries files ("Bob replied with an
 * attachment."). Drafts are never read: they aren't sent.
 *
 * Who: the user's own messages are "you" (`mine`, the caller's call: fails
 * safe to the sender's name). Anyone else by the given name ("Sarah"), or the
 * whole name when two senders share one ("Sarah Chen", "Sarah Park"); a name
 * that isn't a person's ("Acme Support", "The Dial8 Team") whole. Tags such as
 * "(EXT)" go, "Lee, Ann" is Ann Lee, and Outlook's "Ann LEE" is Ann Lee. With
 * no name, the address's own part as a name ("jordan.lee@…" is Jordan Lee),
 * never "at acme dot com". The same sender twice in a row "followed up" (or
 * "wrote again"); replies take turns: "replied", "Then … replied", "wrote
 * back". No he or she, ever: the name again, or "you".
 *
 * When: a day, said only when it differs from the message before's, relative
 * to now in the user's zone: "today", "yesterday", "the next day" (the day
 * after the one before), "on Monday" (this week), "last Thursday" (the week
 * before), "on September 3" (the Listen briefs' describeDay,
 * @/lib/listen-briefs/when).
 *
 * Generic on purpose: Mail's thread view (components/email/email-thread-detail.tsx)
 * reads through it, and any surface that can say who wrote what, when (a
 * thread open in the in-app browser) can too.
 *
 * Pure: no React. `now` and the zone can be passed in (tests); bodies go
 * through DOMParser like ./email-speech's.
 */

import { TZDate } from '@date-fns/tz'
import { differenceInCalendarDays, format, isValid } from 'date-fns'
import { describeDay, safeTimeZone } from '@/lib/listen-briefs/when'
import { numberWord } from '@/lib/listen-briefs/speech'
import {
  cleanSubject,
  dropClosingSignOff,
  dropSubjectEcho,
  emailBodyLines,
  emailPreface,
  emailToSentences,
} from './email-speech'
import { linesToSentences } from './sections'
import { plainTextToSpeech, splitSentences } from './speech-text'

/** One message of a thread, as read here (Mail's EmailMessageData maps onto it). */
export interface ThreadSpeechMessage {
  from: { name?: string | null; email?: string | null }
  /** The user sent it: read as "you". */
  mine?: boolean
  date?: string | Date | null
  /** Its own subject (a forward's "Fwd:" tells emailBodyLines it is one);
   *  else the thread's. */
  subject?: string | null
  bodyHtml?: string | null
  bodyText?: string | null
  /** Files it carries: counted aloud, never named. */
  attachmentCount?: number
  /** Unsent: never read. */
  isDraft?: boolean
}

export interface ThreadSpeech {
  subject?: string | null
  messages: readonly ThreadSpeechMessage[]
}

export interface ThreadSpeechOptions {
  /** Days are said relative to this. Defaults to now. */
  now?: Date
  /** IANA zone the days are counted in. Defaults to the runtime's own. */
  timeZone?: string
}

/** What listen mode reads for a thread: see the header. */
export function emailThreadToSentences(thread: ThreadSpeech, options: ThreadSpeechOptions = {}): string[] {
  const sent = thread.messages.filter((message) => !message.isDraft)
  if (sent.length === 0) return []
  if (sent.length === 1) return oneMessage(sent[0], thread.subject)
  return wholeThread(inOrder(sent), thread.subject, options)
}

// ── One message: as a single email reads ───────────────────────────────────

function oneMessage(message: ThreadSpeechMessage, threadSubject: string | null | undefined): string[] {
  const email = {
    from: message.from,
    subject: message.subject ?? threadSubject ?? null,
    bodyHtml: message.bodyHtml,
    bodyText: message.bodyText,
  }
  const sentences = emailToSentences(email)
  const files = attachments(message)
  if (!files) return sentences
  // After the preface ("From Sarah Chen, about Q3 planning."), before the words.
  const preface = emailPreface(email)
  const lead = preface ? splitSentences(preface).length : 0
  return [...sentences.slice(0, lead), `It has ${files}.`, ...sentences.slice(lead)]
}

// ── Several: who wrote what, when ──────────────────────────────────────────

/** Oldest first, when every message says when it was sent; else as given. */
function inOrder(messages: ThreadSpeechMessage[]): ThreadSpeechMessage[] {
  const times = messages.map((message) => timeOf(message.date))
  if (times.some((time) => time === null)) return messages
  return messages
    .map((message, i) => ({ message, time: times[i] as number }))
    .sort((a, b) => a.time - b.time)
    .map(({ message }) => message)
}

function timeOf(value: string | Date | null | undefined): number | null {
  if (!value) return null
  const at = value instanceof Date ? value : new Date(value)
  return isValid(at) ? at.getTime() : null
}

/** What a reply after someone else's is introduced with, in turn, so a long
 *  thread doesn't say "replied" every time. */
const REPLIED = [
  (name: Named) => `${name.start} replied`,
  (name: Named) => `Then ${name.inside} replied`,
  (name: Named) => `${name.start} wrote back`,
]
/** What a message after the sender's own last one is introduced with, in turn. */
const FOLLOWED_UP = [
  (name: Named) => `${name.start} followed up`,
  (name: Named) => `${name.start} wrote again`,
]

function wholeThread(
  messages: ThreadSpeechMessage[],
  threadSubject: string | null | undefined,
  options: ThreadSpeechOptions,
): string[] {
  const zone = safeTimeZone(options.timeZone ?? runtimeTimeZone())
  const now = options.now ?? new Date()
  const today = calendarDay(now, zone) as TZDate
  const subject = threadSubject ?? messages[0].subject ?? ''
  const senders = samePeople(messages.map((message) => (message.mine ? YOU : senderOf(message.from))))
  const say = namer(senders)

  const topic = plainTextToSpeech(cleanSubject(subject)).replace(/[\s.,;:!?…]+$/, '')
  const count = `a thread of ${numberWord(messages.length)} emails.`
  const sentences = splitSentences(topic ? `${topic}: ${count}` : count[0].toUpperCase() + count.slice(1))

  let previous: { key: string; day: TZDate | null } | null = null
  let replies = 0
  let followUps = 0
  messages.forEach((message, i) => {
    const lines = dropClosingSignOff(
      emailBodyLines({
        bodyHtml: message.bodyHtml,
        bodyText: message.bodyText,
        subject: message.subject ?? subject,
      }),
    )
    const words = linesToSentences(i === 0 ? dropSubjectEcho(lines, cleanSubject(subject)) : lines)
    const files = attachments(message)
    // A reply with nothing of its own (only the mail it quotes): nothing to say.
    if (words.length === 0 && !files) return

    const sender = senders[i]
    const name = say(sender)
    const day = calendarDay(message.date, zone, today)
    const when = dayPhrase(day, previous?.day ?? null, today, zone, now)
    let intro: string
    if (i === 0) {
      intro = `${name.start} wrote first${when ? `, ${when}` : ''}${files ? `, with ${files}` : ''}.`
    } else {
      const lead =
        previous?.key === sender.key
          ? FOLLOWED_UP[followUps++ % FOLLOWED_UP.length](name)
          : REPLIED[replies++ % REPLIED.length](name)
      intro = `${lead}${when ? ` ${when}` : ''}${files ? `${when ? ',' : ''} with ${files}` : ''}.`
    }
    sentences.push(...splitSentences(intro), ...words)
    previous = { key: sender.key, day }
  })
  return sentences
}

/** "an attachment", "two attachments"; '' for none. */
function attachments(message: ThreadSpeechMessage): string {
  const n = Math.max(0, Math.floor(message.attachmentCount ?? 0))
  if (n === 0) return ''
  return n === 1 ? 'an attachment' : `${numberWord(n)} attachments`
}

// ── Days ───────────────────────────────────────────────────────────────────

function runtimeTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return undefined
  }
}

/** The calendar day a moment falls on in `zone`, as its midnight there; never
 *  after `latest` (a clock running ahead doesn't send mail tomorrow). */
function calendarDay(value: string | Date | null | undefined, zone: string, latest?: TZDate): TZDate | null {
  const time = timeOf(value)
  if (time === null) return null
  const at = new TZDate(time, zone)
  const day = new TZDate(at.getFullYear(), at.getMonth(), at.getDate(), zone)
  return latest && day.getTime() > latest.getTime() ? latest : day
}

/**
 * When a message was sent, if it is news: '' on the same day as the message
 * before it (or with no date). "today" and "yesterday" first, as the most
 * useful; then "the next day" after the one before; else describeDay's "on
 * Monday", "last Thursday", "on September 3".
 */
function dayPhrase(day: TZDate | null, before: TZDate | null, today: TZDate, zone: string, now: Date): string {
  if (!day) return ''
  if (before && differenceInCalendarDays(day, before) === 0) return ''
  const fromToday = differenceInCalendarDays(day, today)
  if (fromToday === 0) return 'today'
  if (fromToday === -1) return 'yesterday'
  if (before && differenceInCalendarDays(day, before) === 1) return 'the next day'
  return describeDay(format(day, 'yyyy-MM-dd'), { now, timeZone: zone }) ?? ''
}

// ── Who ────────────────────────────────────────────────────────────────────

interface Sender {
  /** One per person: their address, else their name. */
  key: string
  /** "Sarah", "Jian Min"; a name that isn't a person's, whole. */
  given: string
  /** "Sarah Chen". */
  full: string
  you: boolean
}

/** A sender as said: at the start of a sentence, and inside one ("Then you"). */
interface Named {
  start: string
  inside: string
}

const YOU: Sender = { key: 'you', given: 'You', full: 'You', you: true }

/** A trailing tag on a display name: (EXT), [External], (Acme), (she/her). */
const TRAILING_TAG_RE = /\s*[([][^()[\]]{1,30}[)\]]$/
/** A word in capitals: Outlook's and Teams' "Ann LEE". */
const CAPITALS_WORD_RE = /^\p{Lu}{2,}(?:-\p{Lu}{2,})*$/u
/** A word of a person's name: Capitalized, in capitals, hyphenated, with an
 *  apostrophe, or an initial. */
const NAME_WORD_RE = /^(?:\p{Lu}[\p{L}'’]*(?:-\p{Lu}[\p{L}'’]*)*|\p{Lu}\.)$/u
/** Lowercase words a person's name can carry after its first ("Maria de la Cruz"). */
const NAME_PARTICLES = new Set(['de', 'da', 'del', 'della', 'der', 'den', 'di', 'du', 'dos', 'das', 'la', 'le', 'van', 'von', 'bin', 'binti', 'al', 'el', 'y', 'zu', 'ter', 'ten'])
/** Words a sender's name carries when it is a team, a service or a company,
 *  not a person: said whole ("Acme Support replied", never "Acme replied"). */
const NOT_A_PERSON = new Set(
  (
    'the team support help helpdesk service services customer care success notifications notification ' +
    'alerts alert updates update news newsletter digest no-reply noreply donotreply info hello hi admin ' +
    'billing accounts account payments invoices sales marketing security community bot calendar mail ' +
    'mailer system inc inc. llc ltd ltd. corp corp. co co. group hq app and & at of for from'
  ).split(' '),
)

/** A display name tidied: quotes, a bracketed address, " via Google Docs" and
 *  trailing tags off, whitespace collapsed, emoji gone. '' if nothing's left
 *  or it is an address itself. */
function displayName(raw: string | null | undefined): string {
  let name = plainTextToSpeech(
    (raw ?? '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+via\s+.+$/i, ''),
  )
  // Tags and quotes in either order: '"Ann LEE" (EXT)', '"Ann LEE (EXT)"'.
  for (let previous = ''; previous !== name; ) {
    previous = name
    name = name.replace(TRAILING_TAG_RE, '').replace(/^["'“‘]+|["'”’]+$/g, '').trim()
  }
  if (!name || name.includes('@')) return ''
  // "Lee, Ann": surname first.
  const lastFirst = /^([^,]+),\s*([^,]+)$/.exec(name)
  if (lastFirst && isPersonsName(lastFirst[1].split(' ')) && isPersonsName(lastFirst[2].split(' '))) {
    name = `${lastFirst[2]} ${lastFirst[1]}`
  }
  return name
}

function isPersonsName(words: string[]): boolean {
  return (
    words.length > 0 &&
    words.length <= 5 &&
    NAME_WORD_RE.test(words[0]) &&
    words.every((word) => (NAME_WORD_RE.test(word) || NAME_PARTICLES.has(word)) && !NOT_A_PERSON.has(word.toLowerCase()))
  )
}

/** "LEE" → "Lee", "GARCIA-LOPEZ" → "Garcia-Lopez". */
function soften(word: string): string {
  return word
    .split('-')
    .map((part) => (/^\p{Lu}{2,}$/u.test(part) ? part[0] + part.slice(1).toLowerCase() : part))
    .join('-')
}

/** A person with no name, from their address: "jordan.lee+x@acme.com" →
 *  "Jordan Lee". Only the part before the @ is ever said. */
function nameFromAddress(address: string | null | undefined): string {
  const local = address?.split('@')[0]?.split('+')[0]?.trim() ?? ''
  const words = local.split(/[._-]+/).filter((word) => /\p{L}/u.test(word))
  return words.map((word) => word[0].toUpperCase() + word.slice(1)).join(' ')
}

function senderOf(from: ThreadSpeechMessage['from']): Sender {
  const address = from.email?.trim().toLowerCase() ?? ''
  const name = displayName(from.name)
  if (name) {
    const words = name.split(' ')
    if (!isPersonsName(words)) return { key: address || `name:${name.toLowerCase()}`, given: name, full: name, you: false }
    // Outlook's "Ann LEE": given names in Title Case, the surname in capitals.
    const surname = CAPITALS_WORD_RE.test(words[0]) ? -1 : words.findIndex((word, i) => i > 0 && CAPITALS_WORD_RE.test(word))
    const full = words.map((word, i) => (surname > 0 && i >= surname ? soften(word) : word)).join(' ')
    const given = words.slice(0, surname > 0 ? surname : 1).join(' ')
    return { key: address || `name:${full.toLowerCase()}`, given, full, you: false }
  }
  const fromAddress = nameFromAddress(address)
  if (fromAddress) return { key: address, given: fromAddress, full: fromAddress, you: false }
  return { key: 'someone', given: 'Someone', full: 'Someone', you: false }
}

/** One person writing from two addresses under one name is one sender (so
 *  they "followed up"): each sender whose full name came earlier under
 *  another address, as that earlier one. */
function samePeople(senders: Sender[]): Sender[] {
  const byFull = new Map<string, Sender>()
  return senders.map((sender) => {
    if (sender.you) return sender
    const full = sender.full.toLowerCase()
    const same = byFull.get(full)
    if (same) return same
    byFull.set(full, sender)
    return sender
  })
}

/** How to say each sender: the given name, or the full one when two people in
 *  the thread share a given name; "You", or "you" inside a sentence. */
function namer(senders: Sender[]): (sender: Sender) => Named {
  const people = new Map<string, Sender>()
  for (const sender of senders) if (!sender.you) people.set(sender.key, sender)
  const sharing = new Map<string, number>()
  for (const person of people.values()) {
    const given = person.given.toLowerCase()
    sharing.set(given, (sharing.get(given) ?? 0) + 1)
  }
  return (sender) => {
    if (sender.you) return { start: 'You', inside: 'you' }
    const said = (sharing.get(sender.given.toLowerCase()) ?? 0) > 1 ? sender.full : sender.given
    return { start: said, inside: said }
  }
}
