/**
 * Learning a word from the person's own fix (Liam, 10-25: "if you change the
 * word … it learns after two times"). After Dictate anywhere pastes, the
 * desktop watches the field and reports the words swapped in the paste
 * (dictate.rs watch_edits: `dictate://edit`, what was heard and what was
 * typed, never the text round it). Here:
 *
 *  - only a fix counts: the typed word sounds or is spelled like the heard one
 *    (the corrector's own measures, @/lib/vocabulary/sound-match), so a
 *    rewrite ("tomorrow" → "Friday") is never learned, nor a capital put on a
 *    sentence's first word;
 *  - the same spelling fixed to twice (counted on this device, whatever it was
 *    heard as each time) adds it to the person's own vocabulary, every way it
 *    was heard as how it sounds
 *    (POST /api/account/vocabulary, personal: merged into the word if it's
 *    there), and it's corrected from then on;
 *  - what was learned goes back to the panel, which shows it a moment
 *    ("Learned  Koka Link → KokoLink"). Nothing else is ever shown.
 *
 * PRIVACY: only the swapped words are kept (their counts, on this device), and
 * logged to the desktop's debug log as the vocabulary's corrections are.
 */
import { letters, similarity, soundKey, spoken } from './sound-match'
import { invalidateVocabulary } from './client'
import { writeVocabularyLog } from './log'

export interface WordEdit {
  heard: string
  typed: string
}

/** How many times the same fix makes it a word. */
export const LEARN_AFTER = 2
/** The least a fix sounds or is spelled like what was heard (0–1). */
export const LIKE_ENOUGH = 0.6

const STORE_KEY = 'dial8:vocabulary:learned-fixes'
/** Fixes remembered at most (the oldest go). */
const STORE_MAX = 200

/** Is `typed` a fix of `heard` (not a rewrite, nor only a sentence's capital)? */
export function isFix({ heard, typed }: WordEdit): boolean {
  const h = heard.trim()
  const t = typed.trim()
  if (!h || !t || h === t || !/[a-z]/i.test(t)) return false
  // Only the first letter's case changed: a sentence's start, not a spelling.
  if (h.slice(1) === t.slice(1) && h[0].toLowerCase() === t[0].toLowerCase()) return false
  // Case alone otherwise (apim → APIM) is a spelling: always a fix.
  if (h.toLowerCase() === t.toLowerCase()) return true
  const bySound = similarity(soundKey(spoken(h)), soundKey(spoken(t)))
  const bySpelling = similarity(letters(h), letters(t))
  return Math.max(bySound, bySpelling) >= LIKE_ENOUGH
}

/**
 * Counted by the fix, not by what was heard (Liam, 10-25: corrected to
 * "Giang" three times, never learned): the engine mishears a word a new way
 * each time ("Jay Ng's", "G Yang"), so the same spelling typed twice is what
 * counts, and every way it was heard comes along as how it sounds.
 */
interface Fixes {
  /** The typed spelling → how many times, the ways it was heard, and whether it's been added. */
  [typed: string]: { n: number; heard: string[]; added?: boolean }
}

const HEARD_MAX = 5

function readFixes(): Fixes {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    return parsed && typeof parsed === 'object' ? (parsed as Fixes) : {}
  } catch {
    return {}
  }
}

function writeFixes(fixes: Fixes) {
  try {
    const keys = Object.keys(fixes)
    for (const k of keys.slice(0, Math.max(0, keys.length - STORE_MAX))) delete fixes[k]
    localStorage.setItem(STORE_KEY, JSON.stringify(fixes))
  } catch {
    /* storage off: nothing counts across fixes */
  }
}

/** One more fix to this spelling: how many now, and every way it was heard. */
export function countFix({ heard, typed }: WordEdit): { n: number; heard: string[]; added: boolean } {
  const fixes = readFixes()
  const key = typed.trim()
  const prev = fixes[key] ?? { n: 0, heard: [] }
  const h = heard.trim()
  const ways = prev.heard.some((w) => w.toLowerCase() === h.toLowerCase()) ? prev.heard : [...prev.heard, h].slice(-HEARD_MAX)
  const next = { n: prev.n + 1, heard: ways, added: prev.added }
  delete fixes[key] // re-added last: the newest stay
  fixes[key] = next
  writeFixes(fixes)
  return { n: next.n, heard: next.heard, added: !!next.added }
}

function markAdded(typed: string) {
  const fixes = readFixes()
  const key = typed.trim()
  if (fixes[key]) fixes[key].added = true
  writeFixes(fixes)
}

/** Add `typed` to the person's own vocabulary, heard as each of `heard`. */
async function addWord(typed: string, heard: string[]): Promise<boolean> {
  try {
    const res = await fetch('/api/account/vocabulary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term: typed.trim(), sounds_like: heard, scope: 'personal' }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** The person's fixes to a paste: the ones learned now (a spelling fixed to twice, saved). */
export async function learnFromEdits(edits: readonly WordEdit[]): Promise<WordEdit[]> {
  const learned: WordEdit[] = []
  const log: string[] = []
  for (const edit of edits) {
    if (!isFix(edit)) {
      log.push(`not a fix (a rewrite): "${edit.heard}" → "${edit.typed}"`)
      continue
    }
    const count = countFix(edit)
    log.push(`fix ${Math.min(count.n, LEARN_AFTER)} of ${LEARN_AFTER}: "${edit.heard}" → "${edit.typed}"`)
    if (count.n < LEARN_AFTER || count.added) continue
    if (await addWord(edit.typed, count.heard)) {
      markAdded(edit.typed)
      learned.push({ heard: edit.heard.trim(), typed: edit.typed.trim() })
      log.push(`learned "${edit.typed.trim()}" (heard as ${count.heard.map((w) => `"${w}"`).join(', ')})`)
    } else {
      log.push(`couldn't save "${edit.typed.trim()}": tries again next fix`)
    }
  }
  writeVocabularyLog({ surface: 'anywhere' }, log)
  if (learned.length) await invalidateVocabulary()
  return learned
}
