/**
 * A chat or mail thread read from a web page → the sentences Read Anywhere
 * says (read-anywhere-chat.ts; it began as the retired in-app browser's).
 * Every other surface reads through ./speech-text, untouched by this.
 *
 * A CHAT reads as who said what (Liam, 2026-09-30: "Caitlin said … Natalia
 * then said …"): "Ann said: Sorry all, need to drop. Bob then said: Here is
 * our list of users. You then said: Thanks." A sender is named as people say
 * it: the given name ("Ann", or "Jian Min" of "Jian Min LIM"), the full name
 * when two senders share one, tags like "(EXT)" dropped and capitals softened
 * ("LEE" → "Lee"), in the messages too; one sender's messages in a row are
 * named once.
 *
 * - Microsoft Teams: the desktop says who wrote each highlighted message
 *   (`messages`, from the labels on Teams' message list: desktop
 *   selection_watch.js), with only what they wrote: no hidden headings,
 *   times, reactions, dividers, quotes or cards. Read as given.
 * - Outlook: the desktop gives the highlighted part of the open thread
 *   (`mail`): each message's sender and body HTML, and the subject when the
 *   highlight takes it in. A body reads through Dial8's own email reader
 *   (./email-speech: no quoted history, signature, footer), once Outlook's
 *   "x_" prefixes are off its markup. "From Ann, about the renewal. …" (with
 *   the subject) or "Ann wrote: …", then "Bob then wrote: …"; a collapsed
 *   message reads its preview line.
 * - Any other chat, from the page's text: a message opens with its sender's
 *   name and time, on one line or two ("Ann LEE (EXT)", then "12:33 PM").
 *   Plenty of pages look like that (a calendar's "Design Review / 10:00 AM",
 *   a byline), so a name needs a sign that it is a person's: a tag ("(EXT)"),
 *   a surname in capitals ("Ann LEE"), its avatar's initials on the line
 *   above, being "You", or Discord's "Bea — Today at 9:03 AM". Without one the
 *   page isn't read as a chat. In a chat, the times, avatars, reaction counts,
 *   dividers ("Last read", a date), controls ("Reply") and tables go, but a
 *   message's first line is always read.
 *
 * ANY PAGE: footnote markers ("[1]", "[citation needed]") and lines that are
 * only a page control ("Advertisement", "Share", "Read more") go; a file reads
 * without its extension (".docx", ".loop"); "34m 44s" reads as minutes and
 * seconds; a table reads row by row, its cells as a list.
 *
 * Fails safe, like ./email-speech: a message whose sender it can't tell (your
 * own, which most chats show without a name) is read without one, never under
 * someone else's name.
 *
 * Its naming and cleaning (speakerFromAuthor, namer, lineCleaner) also read
 * the whole conversation open in Teams or Outlook, with no highlight
 * (./browser-page-speech), so the two sound alike.
 *
 * Pure: no DOM, no network. PRIVACY: the text is the user's browsing; never
 * log it.
 */

import { cleanSubject, dropSubjectEcho, emailBodyLines, emailPreface } from './email-speech'
import { linesToSentences } from './sections'
import { plainTextToSentences, plainTextToSpeech, splitSentences } from './speech-text'

/** A highlighted chat message, as the desktop reports one from Teams
 *  (BrowserSelectionMessage in @/lib/tauri-bridge). */
export interface HighlightedMessage {
  text: string
  author?: string
  mine?: boolean
  event?: boolean
}

/** Outlook's highlighted thread, as the desktop reports it
 *  (BrowserSelectionMail in @/lib/tauri-bridge). */
export interface HighlightedMail {
  subject?: string
  messages: readonly { from?: string; html?: string; text?: string; preview?: boolean }[]
}

/** The sentences to read for a highlight in the in-app browser: `text` as the
 *  page shows it, and what the desktop read off the page: in Teams the
 *  `messages` it takes in, in Outlook the `mail`. */
export function browserSelectionToSentences(
  text: string,
  page: { messages?: readonly HighlightedMessage[]; mail?: HighlightedMail } = {},
): string[] {
  if (page.mail && page.mail.messages.length > 0) return readMail(page.mail)
  if (page.messages && page.messages.length > 0) return speakTurns(messageTurns(page.messages))
  const lines = selectionLines(text)
  const turns = chatTurns(lines)
  return turns ? speakTurns(turns) : readPage(lines)
}

/**
 * Text selected in a chat or mail app on the Mac (Read anywhere,
 * ./read-anywhere-chat): who said what when it is a chat, else null, and the
 * desktop reads it as it would anywhere (its own splitter, which joins
 * hard-wrapped lines and cuts run-ons). Only a known tag ("(EXT)", "(Guest)",
 * pronouns) marks a name here: a meeting's "Weekly Sync (Microsoft Teams)"
 * over its time is a title, not a person.
 */
export function chatSelectionToSentences(text: string): string[] | null {
  const turns = chatTurns(selectionLines(text), true)
  return turns ? speakTurns(turns) : null
}

// ── Lines ──────────────────────────────────────────────────────────────────

/** Zero-width spaces and joiners, word joiner, BOM, soft hyphen (not the
 *  emoji joiner U+200D: plainTextToSpeech drops emoji whole). */
const INVISIBLE_RE = /[\u200B\u200C\u2060\uFEFF\u00AD]/g

function selectionLines(text: string): string[] {
  return text
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(INVISIBLE_RE, '')
    .replace(/\u00A0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/ {2,}/g, ' ').trim())
    .filter(Boolean)
}

/** A line that is only a page's control. */
const PAGE_CONTROL_RE =
  /^(?:advertisement|sponsored|skip to (?:main )?content|share(?: this)?|copy link|copied|(?:see|show|read|load|view) (?:more|less)|back to top|open in app)[.…:]*$/i

/** A line that is only a chat's control or a message's status. */
const CHAT_CONTROL_RE = new RegExp(
  '^(?:' +
    [
      'repl(?:y|ies)',
      'more',
      'less',
      'like',
      'forward',
      'translate',
      'see translation',
      'view original',
      'last read',
      'new messages?',
      'unread(?: messages)?',
      '\\(?edited\\)?',
      'seen',
      'delivered',
      'sent',
      'sending',
      'failed to send',
      'jump to (?:present|latest)',
      '(?:un)?follow',
      '\\d+ (?:repl(?:y|ies)|comments?|likes?|reactions?)',
      'view \\d+ more repl(?:y|ies)',
      'last reply .{0,20}',
      '(?:seen|read) by .{1,30}',
      // Teams' hidden reaction label, and its count: "2 Like reactions.2".
      '\\d+ .{1,30} reactions?\\.?\\d*',
    ].join('|') +
    ')[.…:]*$',
  'i',
)

// ── Any page ───────────────────────────────────────────────────────────────

function readPage(lines: string[]): string[] {
  return lines.flatMap((line) => {
    if (PAGE_CONTROL_RE.test(line)) return []
    const text = line.includes('\t') ? tableRow(line) : line
    return plainTextToSentences(cleanText(text))
  })
}

/** A table row (cells split by tabs) as a list: "Ann Lee, Design". */
function tableRow(line: string): string {
  return line
    .split('\t')
    .map((cell) => cell.trim())
    .filter(Boolean)
    .join(', ')
}

/** Footnote markers: [1], [2–4], [citation needed], [edit], [note 3]. */
const FOOTNOTE_RE = /\[(?:\d{1,3}(?:\s?[-–,]\s?\d{1,3})*|citation needed|clarification needed|edit|note \d+|nb \d+)\]/gi

/** A file named with its extension: "Q3 plan.docx", "User List.loop" (not an
 *  extension that is also a web address's ending: .md, .zip, .mov). */
const FILE_EXTENSION_RE = /(\S)\.(?:loop|fluid|docx?|xlsx?|pptx?|pdf|csv|txt|png|jpe?g|gif|mp4|vsdx)\b(?![\w/-])/gi

/** A compact duration, hours → minutes → seconds, at least two of them:
 *  "34m 44s", "1h 20m", "2h 5m 3s", "1hr 20min" (not "60s 70s", "100m"). */
const DURATION_RE =
  /\b(\d+)\s?h(?:rs?)?\s+(\d+)\s?m(?:ins?)?(?:\s+(\d+)\s?s(?:ecs?)?)?\b|\b(\d+)\s?m(?:ins?)?\s+(\d+)\s?s(?:ecs?)?\b/g

function spokenDuration(...parts: Array<string | undefined>): string {
  const [hours, hMinutes, hSeconds, minutes, seconds] = parts
  const unit = (count: string | undefined, word: string) => (count ? `${count} ${word}${count === '1' ? '' : 's'}` : '')
  const said = hours
    ? [unit(hours, 'hour'), unit(hMinutes, 'minute'), unit(hSeconds, 'second')]
    : [unit(minutes, 'minute'), unit(seconds, 'second')]
  return said.filter(Boolean).join(' ')
}

function cleanText(text: string): string {
  return text
    .replace(FOOTNOTE_RE, '')
    .replace(FILE_EXTENSION_RE, '$1')
    .replace(DURATION_RE, (_m, ...groups: Array<string | undefined>) => spokenDuration(...groups.slice(0, 5)))
    .replace(/\s*\(edited\)\s*$/i, '')
}

// ── Times ──────────────────────────────────────────────────────────────────

const CLOCK = String.raw`\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]\.?\s?m\.?)?`
const WEEKDAY = String.raw`(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\.?`
const MONTH = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`
const DAY_OF_MONTH = String.raw`\d{1,2}(?:st|nd|rd|th)?`
const DATE =
  String.raw`(?:today|yesterday|` +
  String.raw`(?:${WEEKDAY},?\s+)?(?:${MONTH}\s+${DAY_OF_MONTH}|${DAY_OF_MONTH}\s+${MONTH})(?:,?\s+\d{4})?|` +
  String.raw`${WEEKDAY}|\d{1,2}/\d{1,2}(?:/\d{2,4})?|\d{1,2}\.\d{1,2}\.\d{2,4}|\d{4}-\d{2}-\d{2})`
/** A message's time: "12:33 PM", "Yesterday 4:02 PM", "9/29 3:12 PM", "Today at 12:33". */
const STAMP = String.raw`(?:${DATE}(?:,?\s+at\s+|,?\s+))?${CLOCK}`
const EDITED = String.raw`(?:\s*[·•]?\s*\(?edited\)?)?`

const TIME_LINE_RE = new RegExp(String.raw`^${STAMP}${EDITED}$`, 'i')
/** A chat's date divider: "Today", "Monday, September 29", "Sep 29, 2026". */
const DATE_LINE_RE = new RegExp(String.raw`^${DATE}$`, 'i')
/** A header on one line: the name, a separator, the time. */
const HEADER_LINE_RE = new RegExp(String.raw`^(.+?)(\s*[,·•|—–-]\s*|\s+)(${STAMP})${EDITED}$`, 'i')
/** A time a line opens with ("12:36 PM Meeting ended…"). */
const LEADING_STAMP_RE = new RegExp(String.raw`^${STAMP}\s+`, 'i')

/** Discord's header: "Bea — Today at 9:03 AM": a dash or dot, then a day. */
function isMarkedHeader(header: RegExpExecArray): boolean {
  return /[—·•]/.test(header[2]) && /\b(?:today|yesterday)\b|\d\/\d|\d{4}/i.test(header[3])
}

/** A chat's own events: read as they are, under no one's name ("Meeting
 *  ended: 34m 44s" reads its duration through cleanText). */
const SYSTEM_EVENT_RE =
  /^(?:meeting ended(?::.*)?|meeting started|(?:recording|transcription) (?:has )?(?:started|stopped))\.?$/i
const MEMBER_EVENT_RE =
  /^(.{1,80}?) (?:added .{1,160} to the (?:chat|team|channel|meeting)|(?:has )?(?:left|joined) the (?:chat|meeting|conversation|team|channel)|(?:renamed|named) the (?:group|chat|meeting)\b|changed the (?:group |chat )?(?:name|picture|photo)\b)/i

/** The event a line reports, without its time; null when it is no event. */
function eventLine(line: string): string | null {
  const event = line.replace(LEADING_STAMP_RE, '')
  if (SYSTEM_EVENT_RE.test(event)) return event
  const member = MEMBER_EVENT_RE.exec(event)
  return member && (member[1] === 'You' || parseName(member[1])) ? event : null
}

// ── Names ──────────────────────────────────────────────────────────────────

/** A tag after a name: (EXT), [External], (Guest), (she/her), (Acme). */
const TRAILING_TAG_RE = /\s*[([][^()[\]]{1,30}[)\]]$/
/** The tags that also go from the messages ("@Ann Lee (EXT) here is…"). */
const KNOWN_TAG_RE =
  /\s*[([](?:ext|external|extern|externe|guest|invité|gast|(?:he|she|they|ze|xe)\/(?:him|her|hers|them|theirs|zir|xem))[)\]]/gi
/** One of those, alone (no `g`: safe to `test`). */
const KNOWN_TAG_ONE_RE = new RegExp(`^${KNOWN_TAG_RE.source}$`, 'i')

/** A name's word: Capitalized, ALL CAPS, hyphenated, with an apostrophe, or
 *  an initial ("J."). */
const NAME_WORD_RE = /^(?:\p{Lu}[\p{Ll}\p{Lu}'’]*(?:-\p{Lu}[\p{Ll}\p{Lu}'’]*)*|\p{Lu}\.)$/u
const CAPITALS_WORD_RE = /^\p{Lu}{2,}(?:-\p{Lu}{2,})*$/u
/** Lowercase words a name can carry after its first ("Maria de la Cruz"). */
const NAME_PARTICLES = new Set(['de', 'da', 'del', 'della', 'der', 'den', 'di', 'du', 'dos', 'das', 'la', 'le', 'van', 'von', 'bin', 'binti', 'al', 'el', 'y', 'zu', 'ter', 'ten'])
/** Capitalized words a short message starts or ends with ("Thanks Bob",
 *  "Sounds Good", "Hi Team") that no name carries. */
const NOT_NAME_WORDS = new Set(
  (
    'thanks thank thx hi hello hey dear ok okay sounds good great cool nice perfect awesome done agreed noted ' +
    'yes yeah yep no nope sure absolutely exactly definitely totally correct right same please sorry welcome ' +
    'congrats congratulations happy lol haha morning afternoon evening night team all everyone guys folks ' +
    'see talk let lets got it this that the a an i we you they my our your to for on in at of with and or but ' +
    'so is are was be do did have has not just also fyi re meeting call update notes today tomorrow yesterday ' +
    'here there what when where who why how by from via new last next read reply edited seen sent best regards'
  ).split(' '),
)

interface Name {
  /** As the page shows it, tags and all ("Ann LEE (EXT)"). */
  raw: string
  /** Without its tags ("Ann LEE"). */
  shown: string
  /** Its words, given names first ("Lee, Ann" → Ann, Lee). */
  words: string[]
  tagged: boolean
  /** One of its tags is a known one: (EXT), (Guest), pronouns. */
  knownTag: boolean
}

/** `raw` without its trailing tags, whether it had any, and whether one is
 *  a known tag. */
function untagged(raw: string): { bare: string; tagged: boolean; knownTag: boolean } {
  let bare = raw.trim()
  let tagged = false
  let knownTag = false
  for (let tag = TRAILING_TAG_RE.exec(bare); tag; tag = TRAILING_TAG_RE.exec(bare)) {
    knownTag ||= KNOWN_TAG_ONE_RE.test(tag[0])
    bare = bare.slice(0, tag.index).trim()
    tagged = true
  }
  return { bare, tagged, knownTag }
}

/** A person's name as a chat header shows one, or null. */
function parseName(raw: string): Name | null {
  const { bare, tagged, knownTag } = untagged(raw)
  if (!bare || bare.length > 60 || /[\d@:;!?"“”()[\]]/.test(bare) || DATE_LINE_RE.test(bare)) return null
  if (bare === 'You') return { raw, shown: bare, words: [bare], tagged, knownTag }
  // "Lee, Ann": surname first.
  const lastFirst = /^([^,]+),\s*([^,]+)$/.exec(bare)
  if (!lastFirst && bare.includes(',')) return null
  const words = (lastFirst ? `${lastFirst[2]} ${lastFirst[1]}` : bare).split(/\s+/)
  if (words.length > 5 || !NAME_WORD_RE.test(words[0])) return null
  const fits = words.every(
    (word) => (NAME_WORD_RE.test(word) || NAME_PARTICLES.has(word)) && !NOT_NAME_WORDS.has(word.toLowerCase()),
  )
  return fits ? { raw, shown: bare, words, tagged, knownTag } : null
}

/** "You", as some chats head your own messages. */
function isYou(name: Name): boolean {
  return name.words.length === 1 && name.words[0] === 'You'
}

/** A word in capitals softened: "LEE" → "Lee", "GARCIA-LOPEZ" → "Garcia-Lopez". */
function soften(word: string): string {
  return word
    .split('-')
    .map((part) => (/^\p{Lu}{2,}$/u.test(part) ? part[0] + part.slice(1).toLowerCase() : part))
    .join('-')
}

/** Teams' "Given SURNAME": given names in Title Case, a surname in capitals. */
function hasCapitalsSurname(name: Name): boolean {
  return !CAPITALS_WORD_RE.test(name.words[0]) && name.words.some((word, i) => i > 0 && CAPITALS_WORD_RE.test(word))
}

/** An avatar's initials line: one to three capitals. */
const INITIALS_RE = /^\p{Lu}{1,3}$/u

function initialsMatch(line: string | undefined, name: Name): boolean {
  if (!line || !INITIALS_RE.test(line)) return false
  const first = name.words[0][0]
  const last = name.words.length > 1 ? name.words[name.words.length - 1][0] : ''
  return line === `${first}${last}`.toUpperCase() || line === first.toUpperCase()
}

/** A sign that a header's name is a person's, not a title above a time.
 *  `strict` (text from an app, ./read-anywhere-chat): only a known tag counts,
 *  so "Weekly Sync (Microsoft Teams)" over a time stays a title. */
function isPersonsName(name: Name, above: string | undefined, strict = false): boolean {
  const tagSign = strict ? name.knownTag : name.tagged
  return tagSign || isYou(name) || hasCapitalsSurname(name) || initialsMatch(above, name)
}

// ── Who said what ──────────────────────────────────────────────────────────

/** A chat's sender, as said (exported for ./browser-page-speech, which reads
 *  a whole Teams chat or channel the same way). */
export interface Speaker {
  /** One per person. */
  key: string
  /** "Ann", "Jian Min"; "You". */
  given: string
  /** "Ann Lee". */
  full: string
  you: boolean
  /** How the page writes the name, to soften where a message names them. */
  forms: string[]
}

interface Turn {
  /** null: the sender isn't told (your own message in most chats, an event). */
  speaker: Speaker | null
  lines: string[]
}

export const YOU: Speaker = { key: 'you', given: 'You', full: 'You', you: true, forms: [] }

function speakerOf(name: Name): Speaker {
  if (isYou(name)) return YOU
  // The given names: the words before a surname in capitals, else the first.
  const surname = name.words.findIndex((word, i) => i > 0 && CAPITALS_WORD_RE.test(word))
  const given = name.words.slice(0, surname > 0 ? surname : 1).map(soften).join(' ')
  const full = name.words.map(soften).join(' ')
  return { key: full.toLowerCase(), given, full, you: false, forms: [name.raw, name.shown] }
}

/** A sender's name as Teams gives it ("Ann LEE (EXT)", "Lee, Ann"). */
export function speakerFromAuthor(author: string): Speaker | null {
  const name = parseName(author)
  if (name) return speakerOf(name)
  // Not shaped like a header's name (digits, a lowercase word): as written.
  const { bare, tagged, knownTag } = untagged(author)
  const words = bare.split(/\s+/).filter(Boolean)
  return words.length > 0 ? speakerOf({ raw: author, shown: bare, words, tagged, knownTag }) : null
}

/**
 * A name that is surely a person's, whole, as said: "Ann LEE (EXT)" → "Ann
 * Lee", "LEE, Ann" → "Ann Lee". Null when it isn't surely one (a channel's or
 * a meeting's name, "Q3 OKR sync", "Ann" alone, "You"), so a title is never
 * re-cased by mistake. Surname first only with the surname in capitals: "Ann,
 * Bob" is two people.
 */
export function personsFullName(raw: string): string | null {
  const name = parseName(raw)
  if (!name || isYou(name)) return null
  const comma = name.shown.indexOf(',')
  if (comma >= 0 && !name.shown.slice(0, comma).trim().split(/\s+/).every((word) => CAPITALS_WORD_RE.test(word))) return null
  return name.tagged || comma >= 0 || hasCapitalsSurname(name) ? speakerOf(name).full : null
}

function messageTurns(messages: readonly HighlightedMessage[]): Turn[] {
  return messages.map((message) => ({
    speaker: message.event ? null : message.mine ? YOU : message.author ? speakerFromAuthor(message.author) : null,
    lines: (message.event ? eventText(message.text) : message.text).split('\n'),
  }))
}

/** A chat event's words without the time it opens with ("12:36 PM Meeting
 *  ended: 34m 44s" → "Meeting ended: 34m 44s"). */
export function eventText(text: string): string {
  return text.replace(LEADING_STAMP_RE, '')
}

/** Senders whose names are softened in the messages, at most. */
const MENTION_NAMES_MAX = 40

/** How to say each of these speakers: the given name, the full name when two
 *  share one, "You". */
export function namer(speakers: Iterable<Speaker | null>): (speaker: Speaker) => string {
  const people = new Map<string, Speaker>()
  for (const speaker of speakers) if (speaker && !speaker.you) people.set(speaker.key, speaker)
  const sharing = new Map<string, number>()
  for (const person of people.values()) sharing.set(person.given, (sharing.get(person.given) ?? 0) + 1)
  return (speaker) => (speaker.you ? 'You' : (sharing.get(speaker.given) ?? 0) > 1 ? speaker.full : speaker.given)
}

/**
 * How a chat message's line is cleaned to be read: a sender named in it reads
 * as they're named in the header ("Ann LEE (EXT) here is…" → "Ann Lee here
 * is…"), tags like "(EXT)" go, and so do what any page loses (cleanText).
 */
export function lineCleaner(people: readonly Speaker[]): (line: string) => string {
  const mentions = people
    .slice(0, MENTION_NAMES_MAX)
    .flatMap((person) => person.forms.filter((form) => form.length > 1).map((form) => ({ form, as: person.full })))
    .sort((a, b) => b.form.length - a.form.length)
    .map(({ form, as }) => ({ re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(form)}(?![\\p{L}\\p{N}])`, 'gu'), as }))
  return (line: string) => {
    let text = line
    for (const { re, as } of mentions) text = text.replace(re, as)
    return cleanText(text.replace(KNOWN_TAG_RE, ''))
  }
}

/** Turns → sentences: "Ann said: …", "Bob then said: …". */
function speakTurns(turns: Turn[]): string[] {
  const people = new Map<string, Speaker>()
  for (const { speaker } of turns) if (speaker && !speaker.you) people.set(speaker.key, speaker)
  const say = namer(people.values())
  const cleanLine = lineCleaner([...people.values()])

  const sentences: string[] = []
  let anyNamed = false
  let previous: Turn | null = null
  for (const turn of turns) {
    const said = plainTextToSentences(turn.lines.map(cleanLine).join('\n'))
    if (said.length === 0) continue
    const { speaker } = turn
    if (speaker && previous?.speaker?.key !== speaker.key) {
      said[0] = `${say(speaker)} ${anyNamed ? 'then said' : 'said'}: ${said[0]}`
      anyNamed = true
    }
    sentences.push(...said)
    previous = turn
  }
  return sentences
}

// ── Outlook ────────────────────────────────────────────────────────────────

/** Outlook's markup with its "x_" prefixes off class and id names (a reply's
 *  "x_x_Signature" too), so ./email-speech knows its signature, reply header
 *  and quote containers. */
export function unprefixOutlook(html: string): string {
  return html.replace(
    /(\s(?:class|id)\s*=\s*)(["'])([^"']*)\2/gi,
    (_m, attr: string, quote: string, value: string) => `${attr}${quote}${value.replace(/(^|\s)(?:x_)+/g, '$1')}${quote}`,
  )
}

/** Outlook's highlighted thread → "From Ann, about the renewal. … Bob then
 *  wrote: …". */
function readMail(mail: HighlightedMail): string[] {
  const subject = mail.subject ?? ''
  const speakers = mail.messages.map((message) => (message.from ? speakerFromAuthor(message.from) : null))
  const say = namer(speakers)
  const sentences: string[] = []
  let started = false
  let previous: Speaker | null = null
  mail.messages.forEach((message, i) => {
    const speaker = speakers[i]
    const body = message.html
      ? linesToSentences(
          dropSubjectEcho(emailBodyLines({ bodyHtml: unprefixOutlook(message.html), subject }), cleanSubject(subject)),
        )
      : plainTextToSentences(cleanText(message.text ?? ''))
    if (!started && subject) {
      // The thread's subject highlighted: the email reader's own preface.
      const preface = emailPreface({ from: { name: speaker ? say(speaker) : null }, subject })
      sentences.push(...splitSentences(preface), ...body)
      started = true
    } else if (body.length > 0) {
      if (speaker && previous?.key !== speaker.key) {
        body[0] = `${say(speaker)} ${started ? 'then wrote' : 'wrote'}: ${body[0]}`
      }
      sentences.push(...body)
      started = true
    } else {
      return
    }
    previous = speaker
  })
  return sentences
}

// ── A chat, from the page's text ───────────────────────────────────────────

/** Longer than any header ("Name, tags, a date and a time"): not matched as
 *  one, which also keeps the header patterns linear on a long line. */
const HEADER_MAX_CHARS = 120

interface Header {
  name: Name
  /** Lines it takes: 1 ("Ann Lee 12:33 PM") or 2 (the name, then the time). */
  span: 1 | 2
}

/** Message headers whose name is surely a person's, by the line they start
 *  on (`strict`: see isPersonsName). */
function findHeaders(lines: string[], strict = false): Map<number, Header> {
  const headers = new Map<number, Header>()
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.length > HEADER_MAX_CHARS || TIME_LINE_RE.test(line)) continue
    const oneLine = HEADER_LINE_RE.exec(line)
    const name = oneLine ? parseName(oneLine[1]) : null
    if (oneLine && name) {
      if (isPersonsName(name, lines[i - 1], strict) || isMarkedHeader(oneLine)) headers.set(i, { name, span: 1 })
      continue
    }
    if (i + 1 < lines.length && TIME_LINE_RE.test(lines[i + 1])) {
      const named = parseName(line)
      if (named && isPersonsName(named, lines[i - 1], strict)) {
        headers.set(i, { name: named, span: 2 })
        i++
      }
    }
  }
  return headers
}

/** A marked header whose name isn't one parseName reads (a lowercase handle,
 *  "ann — Today at 9:02 AM"): still a header, not a message. */
function isUnreadHeader(line: string): boolean {
  if (line.length > HEADER_MAX_CHARS) return false
  const oneLine = HEADER_LINE_RE.exec(line)
  return !!oneLine && isMarkedHeader(oneLine) && oneLine[1].split(/\s+/).length <= 5 && !/[.!?:;]/.test(oneLine[1])
}

/** The highlight as a chat's turns, or null when no header in it is a person's. */
function chatTurns(lines: string[], strict = false): Turn[] | null {
  const headers = findHeaders(lines, strict)
  if (headers.size === 0) return null

  const turns: Turn[] = []
  let current: Turn | null = null
  /** The line after a header or a time: the message itself, always read. */
  let opening = false
  const start = (speaker: Speaker | null) => {
    current = { speaker, lines: [] }
    turns.push(current)
    return current
  }

  for (let i = 0; i < lines.length; i++) {
    const header = headers.get(i)
    if (header) {
      start(speakerOf(header.name))
      opening = true
      i += header.span - 1
      continue
    }
    const line = lines[i]
    // A time with no name, or a name it can't read: a message whose sender
    // isn't told.
    if (TIME_LINE_RE.test(line) || isUnreadHeader(line)) {
      start(null)
      opening = true
      continue
    }
    // A shared table (a card) is never a message's words.
    if (line.includes('\t')) continue
    const first = opening
    opening = false
    const event = eventLine(line)
    if (event) {
      start(null).lines.push(event)
      continue
    }
    if (!first) {
      // The avatar above a header, dividers, controls, a reaction's count.
      const next = headers.get(i + 1)
      if (next && initialsMatch(line, next.name)) continue
      if (DATE_LINE_RE.test(line) || CHAT_CONTROL_RE.test(line) || PAGE_CONTROL_RE.test(line)) continue
      if (/^\d{1,4}$/.test(plainTextToSpeech(line))) continue
    }
    ;(current ?? start(null)).lines.push(line)
  }
  return turns
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
