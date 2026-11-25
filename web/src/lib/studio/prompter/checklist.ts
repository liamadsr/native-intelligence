// The take's checklist: the points the person means to make, checked by hand at any time, and checked on their own
// (best effort) when what was just said clearly covers one. Clearly: most of the item's content words (stop words
// out, at least two of them) heard close together in the last stretch of final words. It would rather miss an item
// than check one wrongly, and it never checks an item the person unchecked: their hand wins for the rest of the take.
// Pure; tested in __tests__/checklist.test.ts.
import { contentStems, stem, type Token } from './normalize'

export type ChecklistItem = { id: string; text: string }
export type ChecklistState = {
  /** Checked item ids. */
  checked: ReadonlySet<string>
  /** Items the person unchecked by hand: auto-check leaves them alone. */
  heldOpen: ReadonlySet<string>
  /** How each check came about (for the "checked by itself" hint). */
  auto: ReadonlySet<string>
}
export const EMPTY_CHECKS: ChecklistState = { checked: new Set(), heldOpen: new Set(), auto: new Set() }

/** How many of the latest final words are looked at. */
export const RECENT_WORDS = 30
/** Share of an item's content words that must be heard. */
const SHARE = 0.75
/** Fewest content words an item needs to check itself (one word alone is too easy to say by chance). */
const MIN_WORDS = 2

/** Words that say what to do with a point rather than what it is ("Explain the forecast", "Show the board"): people
 *  make the point without saying them, so they don't count toward an item. */
const INSTRUCTIONS = new Set(['explain', 'show', 'mention', 'talk', 'cover', 'demo', 'demonstrate', 'describe', 'discuss',
  'introduce', 'present', 'walk', 'highlight', 'review', 'remind', 'tell', 'say', 'point', 'note', 'quick', 'quickly', 'briefly'].map(stem))

/** The words an item is checked on: its content words, the instruction words out. */
export function itemStems(text: string): string[] {
  return contentStems(text).filter((s) => !INSTRUCTIONS.has(s))
}

/** Item text as typed: a leading "1.", "-", "•" or "[ ]" is the list's, not the item's. */
export function cleanItemText(text: string): string {
  return text.replace(/^\s*(?:[-*•]|\d+[.)]|\[\s?\]|\[x\])\s*/i, '').trim()
}

/** Items from pasted lines (one per line). */
export function itemsFromText(text: string, makeId: (i: number) => string): ChecklistItem[] {
  return text.split(/\r?\n/).map(cleanItemText).filter(Boolean).map((t, i) => ({ id: makeId(i), text: t }))
}

/** Whether `heard` (final words, oldest first) covers an item whose content stems are `stems`. */
export function covers(stems: string[], heard: Token[]): boolean {
  const n = stems.length
  if (n < MIN_WORDS) return false
  const need = Math.max(MIN_WORDS, Math.ceil(n * SHARE))
  const span = 2 * n + 4
  const wanted = new Set(stems)
  const hits = heard.map((t, i) => ({ i, stem: t.stem })).filter((h) => wanted.has(h.stem))
  // The smallest stretch of hits holding `need` different stems, within `span` words.
  for (let a = 0; a < hits.length; a++) {
    const seen = new Set<string>()
    for (let b = a; b < hits.length && hits[b]!.i - hits[a]!.i < span; b++) {
      seen.add(hits[b]!.stem)
      if (seen.size >= need) return true
    }
  }
  return false
}

/** The state with the items `heard` covers checked (never one held open, never one already checked). */
export function autoCheck(items: ChecklistItem[], state: ChecklistState, heard: Token[]): ChecklistState {
  const recent = heard.slice(-RECENT_WORDS)
  const add = items.filter((item) => !state.checked.has(item.id) && !state.heldOpen.has(item.id) && covers(itemStems(item.text), recent))
  if (!add.length) return state
  return { ...state, checked: new Set([...state.checked, ...add.map((i) => i.id)]), auto: new Set([...state.auto, ...add.map((i) => i.id)]) }
}

/** A click: checks or unchecks. Unchecking by hand holds the item open for the rest of the take. */
export function toggle(state: ChecklistState, id: string): ChecklistState {
  const checked = new Set(state.checked), heldOpen = new Set(state.heldOpen), auto = new Set(state.auto)
  auto.delete(id)
  if (checked.has(id)) { checked.delete(id); heldOpen.add(id) }
  else { checked.add(id); heldOpen.delete(id) }
  return { checked, heldOpen, auto }
}

/** The first item not checked: the one to make next (highlighted). Null when all are done. */
export function nextItem(items: ChecklistItem[], state: ChecklistState): string | null {
  return items.find((i) => !state.checked.has(i.id))?.id ?? null
}
