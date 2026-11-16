/**
 * What is new on a page since the last read, without a model. Pure.
 *
 * Each line of the page's text (./text.ts) is normalized and hashed; a read
 * stores the set of hashes (its fingerprint), and the next read's new lines
 * are the ones whose hash is not in it. Order does not matter, so a block
 * that moved is not news, and a line that left the page is not news either
 * (a watch tells a person what appeared, not what went away).
 *
 * Normalizing removes only what is certainly noise, the parts of a line that
 * change on every visit while nothing happened: relative times ("5 minutes
 * ago", "just now"), ticking countdowns, the date after a stamping word
 * ("Last updated ..."), full machine timestamps with seconds, and ids made to
 * be unique (UUIDs, cache busters, nonces). Everything else is kept as it
 * is: prices, plain dates, counts and names are exactly what a person
 * watches a page for, so a change in them must show.
 */

/** At most this many new lines are kept from one read. */
export const ADDED_LINES_MAX = 40
/** Each kept line is cut to this many characters. */
export const ADDED_LINE_MAX_CHARS = 300

const UNIT_ANY = '(?:s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?|mos?|months?|y|yrs?|years?)'
const UNIT_SHORT = '(?:secs?|seconds?|mins?|minutes?|hrs?|hours?)'
/* One or more amounts of time in a row: 4h 12m, 3 days 2 hours, 20 min. */
const UNIT_AMOUNT = String.raw`\d+\s*(?:d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)\b`
const UNIT_RUN = String.raw`\b${UNIT_AMOUNT}(?:[\s,]*${UNIT_AMOUNT})*`
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
const WEEKDAY = '(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)'

/*
 * The noise rules, applied in order. Each swaps what it finds for a fixed
 * placeholder, so "3 minutes ago" and "an hour ago" read the same.
 */
const NOISE: Array<[RegExp, string]> = [
  // An ISO 8601 timestamp with seconds: 2026-11-15T09:30:12Z, 2026-11-15 09:30:12.123+01:00.
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:\s?(?:Z|[+-]\d{2}:?\d{2}|UTC|GMT))?\b/gi, '‹ts›'],
  // An RFC 2822 timestamp: Sun, 15 Nov 2026 09:30:12 +0000.
  [new RegExp(`\\b${WEEKDAY},?\\s+\\d{1,2}\\s+${MONTH}\\s+\\d{4}\\s+\\d{2}:\\d{2}:\\d{2}(?:\\s+(?:[+-]\\d{4}|[A-Z]{2,5}))?\\b`, 'gi'), '‹ts›'],
  // A UUID.
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '‹id›'],
  // A ticking countdown or timer: 01:23:45, or units ending in seconds (2d 4h 13m 22s, 4 hours 12 minutes 3 seconds).
  [/\b\d{1,3}:\d{2}:\d{2}\b(?!\s*[ap]\.?m\b)/gi, '‹timer›'],
  [/\b(?:\d+\s*(?:d|days?|h|hrs?|hours?|m|mins?|minutes?)\b[\s,:]*){1,3}\d+\s*(?:s|secs?|seconds?)\b/gi, '‹timer›'],
  // A countdown without seconds, said as one: "ends in 4h 12m", "3 days 2 hours left".
  [new RegExp(`\\b(?:ends?|starts?|closes?|opens?|expires?|launch(?:es)?|begins?|resets?)\\s+in\\s+${UNIT_RUN}`, 'gi'), '‹timer›'],
  [new RegExp(`${UNIT_RUN}\\s*(?:left|remaining|to go)\\b`, 'gi'), '‹timer›'],
  // A relative time in the past: 5 minutes ago, 2h ago, an hour ago, a few seconds ago.
  [new RegExp(`\\b(?:\\d+|an?|one|a few|few|several)\\s*${UNIT_ANY}\\.?\\s+ago\\b`, 'gi'), '‹ago›'],
  [/\b(?:just now|moments? ago|seconds ago|minutes ago|yesterday)\b/gi, '‹ago›'],
  // A relative time a short way ahead: in 3 hours, in 20 minutes, in a minute.
  [new RegExp(`\\bin\\s+(?:\\d+|an?|one|a few)\\s*${UNIT_SHORT}\\b`, 'gi'), '‹soon›'],
]


/*
 * One word of a date or time: 15, 15th, 2026, 09:30, 9:30am, 9am,
 * 15/11/2026, 2026-11-15, 15.11.2026, Nov, Monday, pm, at. A number with one
 * dot ("4.25") or a version ("2.4.1") is not one.
 */
const NUMBER_DATE_WORD = String.raw`\d{1,2}(?:st|nd|rd|th)?|(?:19|20)\d{2}|\d{1,2}:\d{2}(?::\d{2})?(?:am|pm)?|\d{1,2}(?:am|pm)|\d{1,4}[/-]\d{1,2}[/-]\d{1,4}|\d{1,2}\.\d{1,2}\.(?:19|20)\d{2}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}`
const DATE_WORD = new RegExp(`^(?:${NUMBER_DATE_WORD}|${MONTH}\\.?|${WEEKDAY}\\.?|[ap]\\.?m\\.?|at|on|of|the)$`, 'i')
/* A time zone as pages write it: UTC, GMT, Z, CET, PST, AEDT (capitals only, so "best" is not one). */
const ZONE_WORD = /^(?:UTC|GMT|Z|[A-Z]{2,4}T)$/
/*
 * A word that makes the run a date or time for certain: a month or weekday
 * name, a full date written with / or - (or dots around a year), or a clock
 * time. A bare number or year never does: "Updated 3 plans" and "Updated
 * 2027 pricing" keep their numbers.
 */
const STRONG_WORD = new RegExp(String.raw`^(?:\d{1,2}:\d{2}(?::\d{2})?(?:am|pm)?|\d{1,4}[/-]\d{1,2}[/-]\d{1,4}|\d{1,2}\.\d{1,2}\.(?:19|20)\d{2}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|${MONTH}\.?|${WEEKDAY}\.?)$`, 'i')
const CONNECTOR = /^(?:at|on|of|the)$/i

/* How many characters of `rest` (what follows a stamping word) are a date or time; 0 when it does not start with one. */
function dateRunLength(rest: string): number {
  const parts = rest.split(/(\s+)/)
  let end = 0
  let strong = false
  let length = 0
  for (let i = 0; i < parts.length; i += 2) {
    const word = parts[i].replace(/[,;:)]+$/, '')
    if (!word || !(DATE_WORD.test(word) || ZONE_WORD.test(word))) break
    length += (i > 0 ? parts[i - 1].length : 0) + parts[i].length
    if (STRONG_WORD.test(word)) strong = true
    // A run never ends on a connecting word ("Updated Nov 3 on the site" keeps "on the"),
    // nor takes the punctuation after its last word ("Nov 3: $10" keeps the colon).
    if (!CONNECTOR.test(word)) end = length - (parts[i].length - word.length)
    if (word.length !== parts[i].length && /[;:)]$/.test(parts[i])) break
  }
  return strong ? end : 0
}

/* Words that stamp the time a page was made, not anything on it. */
const STAMP_SOURCE = String.raw`\b(?:last updated|last modified|last checked|last refreshed|updated|modified|refreshed|as of|generated|fetched|retrieved|cached|rendered|server time|current time|page loaded)\b(?:\s*(?:on|at))?\s*:?\s*`

/* The date and time written right after a stamping word, swapped for a placeholder (the word itself stays). */
function stripStamps(line: string): string {
  const stamp = new RegExp(STAMP_SOURCE, 'gi')
  let out = ''
  let last = 0
  let match: RegExpExecArray | null
  while ((match = stamp.exec(line))) {
    const after = match.index + match[0].length
    const length = dateRunLength(line.slice(after))
    if (length > 0) {
      out += `${line.slice(last, after)}\u2039when\u203a`
      last = after + length
      stamp.lastIndex = last
    } else if (match[0].length === 0) {
      stamp.lastIndex += 1
    }
  }
  return out + line.slice(last)
}

/*
 * A cache buster, nonce or build hash: a run of 16 or more hex digits, or of
 * 16 or more base64-like characters that switches between letters and digits
 * at least six times. Never a run that touches a hyphen or is one of
 * several hyphenated words, so a product name ("iPhone-16-Pro-Max-256GB")
 * or a part number stays what it is.
 */
const TOKEN_RUN = /(?<![\w+/=-])[A-Za-z0-9+/=_]{16,}(?![\w+/=-])/g

function isNoiseToken(token: string): boolean {
  if (!/\d/.test(token) || !/[A-Za-z]/.test(token)) return false
  if (/^[0-9a-f]+$/i.test(token)) return true
  const switches = token.match(/(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])/g)?.length ?? 0
  return switches >= 6
}

function dropMixedTokens(line: string): string {
  return line.replace(TOKEN_RUN, (token) => (isNoiseToken(token) ? '‹id›' : token))
}

/** The line with its certain noise swapped for placeholders, whitespace collapsed. */
export function normalizeLine(line: string): string {
  let out = line.replace(/\s+/g, ' ').trim()
  for (const [pattern, placeholder] of NOISE) out = out.replace(pattern, placeholder)
  out = stripStamps(out)
  out = dropMixedTokens(out)
  return out.replace(/\s+/g, ' ').trim()
}

/*
 * cyrb53: a small, fast 53-bit string hash. Not for secrets; for telling a
 * page's lines apart, where its collision odds over a few thousand lines are
 * nil. Pure JavaScript, so this file needs no runtime module.
 */
function hash53(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/** One line's hash, after normalizing. */
export function lineHash(line: string): string {
  return hash53(normalizeLine(line))
}

/** A read's fingerprint: the distinct hashes of its lines, in the order they first appear. */
export function fingerprint(lines: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const line of lines) {
    if (!normalizeLine(line)) continue
    seen.add(lineHash(line))
  }
  return [...seen]
}

/** How many good reads a watch remembers: a line seen in any of them is not news. */
export const FINGERPRINT_READS = 3

/**
 * The reads a watch remembers, newest first, from its stored `fingerprints`
 * (jsonb): an array of up to FINGERPRINT_READS arrays of hashes. A flat
 * array of hashes reads as one read. Anything else is no read at all. Pure.
 */
export function readSets(stored: unknown): string[][] {
  if (!Array.isArray(stored) || stored.length === 0) return []
  if (stored.every((v) => typeof v === 'string')) return [stored as string[]]
  return stored
    .filter((set): set is unknown[] => Array.isArray(set))
    .map((set) => set.filter((h): h is string => typeof h === 'string'))
    .slice(0, FINGERPRINT_READS)
}

/** Every hash the remembered reads hold: the union a new read is compared with. Pure. */
export function knownHashes(sets: readonly (readonly string[])[]): Set<string> {
  const known = new Set<string>()
  for (const set of sets) for (const h of set) known.add(h)
  return known
}

/** The reads to store after a good read: this one first, the oldest dropped past FINGERPRINT_READS. Pure. */
export function rememberRead(sets: readonly string[][], current: readonly string[]): string[][] {
  return [[...current], ...sets].slice(0, FINGERPRINT_READS)
}

export interface LineDiff {
  /** The new lines to report, as the page wrote them (see addedLines). */
  added: string[]
  /** New lines past the cap, by hash: left out of the stored read so they come up again next time. */
  unreported: string[]
}

/**
 * The lines of this read whose normalized hash is not in `known`, as the page
 * wrote them: each once, cut to ADDED_LINE_MAX_CHARS, at most ADDED_LINES_MAX
 * of them, in page order; and the hashes of the new lines past that cap.
 */
export function diffLines(known: ReadonlySet<string> | readonly string[], currentLines: readonly string[]): LineDiff {
  const before = known instanceof Set ? known : new Set(known as readonly string[])
  const taken = new Set<string>()
  const added: string[] = []
  const unreported: string[] = []
  for (const line of currentLines) {
    if (!normalizeLine(line)) continue
    const hash = lineHash(line)
    if (before.has(hash) || taken.has(hash)) continue
    taken.add(hash)
    if (added.length >= ADDED_LINES_MAX) {
      unreported.push(hash)
      continue
    }
    const flat = line.replace(/\s+/g, ' ').trim()
    added.push(flat.length > ADDED_LINE_MAX_CHARS ? flat.slice(0, ADDED_LINE_MAX_CHARS) : flat)
  }
  return { added, unreported }
}

/** The new lines alone (diffLines' `added`). */
export function addedLines(previousFingerprints: readonly string[], currentLines: readonly string[]): string[] {
  return diffLines(previousFingerprints, currentLines).added
}
