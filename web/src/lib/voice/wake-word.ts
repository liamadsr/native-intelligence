/**
 * Interactive mode's wake word: does what the user just said address their
 * assistant by name ("Joseph, can you look something up for me?"), and if so,
 * what are they asking? Pure, so every rule is unit-tested
 * (./__tests__/wake-word.test.ts).
 *
 * The transcript is the desktop's on-device recogniser's, partial or final, so
 * the match forgives what it gets wrong:
 *  - case, punctuation and accents never matter ("JOSEPH!", "José");
 *  - a possessive or a contraction on the name still counts ("Joseph's");
 *  - a name of MIN_FUZZY_LETTERS or more letters also matches a word one edit
 *    away that starts with the same letter ("Josephs", "Joaeph"), or one that
 *    sounds the same by a simple phonetic key ("Josef", "Jozef"), or two
 *    words that run together into it ("Joe Seph"); a shorter name only
 *    matches exactly (fuzzy short names would fire on everyday words);
 *  - a name of several words ("Mary Jane", "Mary-Jane") matches them in a
 *    row, each word by the rules above, or run together ("Maryjane").
 *
 * The request is the utterance less the name, wherever it was (at the start,
 * in the middle or at the end), less a filler word just before it ("hey",
 * "ok") and the commas around it; an utterance with only the name (and
 * fillers) asks nothing ("Joseph?" → ''), and Interactive mode then answers
 * "Yes?" and takes the next turn as the request.
 *
 * The ECHO GUARD (isEchoOf): on laptop speakers, before the echo canceller
 * has converged, the mic can still carry the agent's own speech. A sentence
 * of the reading that names the assistant would then wake it, and the reply
 * being read would come back as a follow-up turn. So a transcript that
 * closely matches what was just said (@/lib/read-aloud/recent-speech: its
 * words all inside one sentence in order, or ECHO_OVERLAP of them in it) is
 * the agent's own voice, not the user's.
 *
 * PRIVACY: this only reads the text it is given. Nothing here keeps, logs or
 * sends it; the caller drops a transcript that doesn't match.
 */

export interface WakeMatch {
  /** The transcript addresses the assistant by name. */
  matched: boolean
  /** What is asked, without the name and filler: '' when nothing is (or no match). */
  request: string
}

/** Names this long (letters) or longer match fuzzily; shorter ones exactly. */
export const MIN_FUZZY_LETTERS = 5

/** Words said before (or as all of) a call that carry no request. */
const FILLERS = new Set([
  'hey',
  'hi',
  'hello',
  'ok',
  'okay',
  'yo',
  'um',
  'umm',
  'uh',
  'uhm',
  'er',
  'erm',
  'hmm',
  'oh',
  'so',
  'well',
])

/** Fillers that may lead straight into the name ("hey Joseph", "ok Joseph"). */
const LEAD_INS = new Set(['hey', 'hi', 'hello', 'ok', 'okay', 'yo', 'oh'])

const NO_MATCH: WakeMatch = Object.freeze({ matched: false, request: '' }) as WakeMatch

interface Word {
  /** Where it sits in the transcript. */
  start: number
  end: number
  /** Normalized for comparing: lower case, letters and digits only, no possessive. */
  norm: string
}

/** Lower case, accents stripped, letters and digits only. */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

/** A word as compared: folded, and a trailing possessive or contraction ('s, 'd, 'll…) dropped. */
function normalizeWord(raw: string): string {
  const unquoted = raw.replace(/[’‘`]/g, "'")
  const base = unquoted.replace(/'(?:s|d|ll|re|ve)$/i, '')
  return fold(base)
}

const WORD_RE = /[\p{L}\p{N}]+(?:['’‘`][\p{L}\p{N}]+)*/gu

function words(text: string): Word[] {
  const out: Word[] = []
  for (const m of text.matchAll(WORD_RE)) {
    const norm = normalizeWord(m[0])
    if (norm) out.push({ start: m.index!, end: m.index! + m[0].length, norm })
  }
  return out
}

/** The name's words, normalized ("Mary-Jane O'Neil" → mary, jane, oneil). */
function nameWords(name: string): string[] {
  return name
    .split(/[\s\p{Pd}]+/u)
    .map((w) => fold(w.replace(/[’‘`']/g, '')))
    .filter(Boolean)
}

/** Levenshtein distance, giving up past `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const value = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      cur.push(value)
      if (value < best) best = value
    }
    if (best > max) return max + 1
    prev = cur
  }
  return prev[b.length]
}

/**
 * A simple phonetic key: how a word sounds, roughly, so ASR spellings of one
 * name meet ("Joseph", "Josef", "Jozef" → jsf). Spellings that sound alike
 * are folded together (ph → f, z → s, ck → k, c before e/i/y → s, other c and
 * q → k, x → ks, a silent h dropped), then the vowels after the first letter
 * go, and doubled letters collapse.
 */
export function phoneticKey(word: string): string {
  let w = fold(word).replace(/[0-9]/g, '')
  if (!w) return ''
  w = w
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/qu/g, 'kw')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/[cq]/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/z/g, 's')
    .replace(/dg/g, 'j')
  // An h after another letter is (mostly) silent: "Joseph" → "josef" above,
  // "Sarah" → "sara", "Hannah" → "hanna".
  w = w[0] + w.slice(1).replace(/h/g, '')
  w = w[0] + w.slice(1).replace(/[aeiouyw]/g, '')
  return w.replace(/(.)\1+/g, '$1')
}

/** One name word against one heard word (or two run together). */
function wordMatches(nameWord: string, heard: string): boolean {
  if (heard === nameWord) return true
  if (nameWord.length < MIN_FUZZY_LETTERS) return false
  // One slip in a longer name, the first sound right.
  if (heard[0] === nameWord[0] && editDistance(heard, nameWord, 1) <= 1) return true
  // Sounds the same, and about as long (so a short word can't stand in).
  if (Math.abs(heard.length - nameWord.length) > 2) return false
  const key = phoneticKey(nameWord)
  return key.length >= 2 && phoneticKey(heard) === key
}

/** Where the name is, as [first word, last word] indices, or null. */
function findName(heard: Word[], name: string[]): [number, number] | null {
  if (name.length === 0) return null
  const joinedName = name.join('')
  for (let i = 0; i < heard.length; i++) {
    // The name's words in a row, each matched on its own.
    if (i + name.length <= heard.length && name.every((w, k) => wordMatches(w, heard[i + k].norm))) {
      return [i, i + name.length - 1]
    }
    // Several name words heard as one ("Maryjane").
    if (name.length > 1 && wordMatches(joinedName, heard[i].norm)) return [i, i]
    // Two heard words that run together into the name ("Joe Seph"), exactly or by sound.
    if (i + 1 < heard.length && joinedName.length >= MIN_FUZZY_LETTERS) {
      const pair = heard[i].norm + heard[i + 1].norm
      if (pair === joinedName || (Math.abs(pair.length - joinedName.length) <= 2 && phoneticKey(pair) === phoneticKey(joinedName))) {
        return [i, i + 1]
      }
    }
  }
  return null
}

/** The request around the name: the text before and after it, joined, tidied. */
function requestAround(text: string, heard: Word[], first: number, last: number): string {
  // A lead-in right before the name, with only fillers before it, goes with it.
  let cutStart = heard[first].start
  if (first > 0 && heard.slice(0, first).every((w) => FILLERS.has(w.norm))) cutStart = 0
  else if (first > 0 && LEAD_INS.has(heard[first - 1].norm)) cutStart = heard[first - 1].start
  let before = text.slice(0, cutStart).replace(/[\s,;:–—-]+$/u, '')
  let after = text.slice(heard[last].end)
  // The question mark or full stop that ended the sentence stays with the request.
  const ending = /^[\s,;:]*([?!.])\s*$/u.exec(after)
  after = after.replace(/^[\s,;:.!?–—-]+/u, '')
  if (ending && before) before += ending[1]
  const joined = [before.trim(), after.trim()].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  // Nothing but fillers and punctuation: no request.
  const rest = words(joined)
  if (rest.length === 0 || rest.every((w) => FILLERS.has(w.norm))) return ''
  return joined.charAt(0).toUpperCase() + joined.slice(1)
}

/**
 * Does `transcript` address the assistant called `name`, and what does it ask?
 * The first time the name is heard counts. An empty name never matches.
 */
export function matchWakeWord(transcript: string, name: string): WakeMatch {
  const wanted = nameWords(name)
  if (wanted.length === 0 || !transcript) return NO_MATCH
  const heard = words(transcript)
  const at = findName(heard, wanted)
  if (!at) return NO_MATCH
  return { matched: true, request: requestAround(transcript, heard, at[0], at[1]) }
}

/** This share of a transcript's words found in one thing just said makes it an echo. */
export const ECHO_OVERLAP = 0.7

/**
 * Whether `heard` is the agent's own speech coming back through the mic: its
 * words, in order, inside one of the sentences just said (or the last two
 * run together: an echo can straddle them), or ECHO_OVERLAP of its words
 * found in one sentence (one only: across several, a short question of the
 * user's would share too many words by chance). Empty, or nothing just said:
 * not an echo.
 */
export function isEchoOf(heard: string, spoken: readonly string[]): boolean {
  const said = words(heard).map((w) => w.norm)
  if (said.length === 0 || spoken.length === 0) return false
  const inOrder = ` ${said.join(' ')} `
  const flat = (text: string) => words(text).map((w) => w.norm)
  if (spoken.length > 1 && ` ${flat(spoken.slice(-2).join(' ')).join(' ')} `.includes(inOrder)) return true
  for (const sentence of spoken) {
    const theirs = flat(sentence)
    if (theirs.length === 0) continue
    if (` ${theirs.join(' ')} `.includes(inOrder)) return true
    const vocabulary = new Set(theirs)
    const shared = said.filter((w) => vocabulary.has(w)).length
    if (shared / said.length >= ECHO_OVERLAP) return true
  }
  return false
}
