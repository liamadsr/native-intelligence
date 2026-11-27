/**
 * How much the person changed a held call before approving it
 * (docs/plans/earned-autonomy.md §1): the word-level edit distance between the
 * stored input's text and the edit's text, over the longer one's length.
 * 0 = unchanged, 1 = rewritten. Past MAX_WORDS a side it reads as 1 (the safe
 * side: a big edit never counts as trivial by accident). Pure.
 */

export const EDIT_RATIO_MAX_WORDS = 4000

/** The string values of a JSON value, depth-first in key order (so key order never matters). */
function textOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (typeof value === 'number' || typeof value === 'boolean') out.push(String(value))
  else if (Array.isArray(value)) for (const v of value) textOf(v, out)
  else if (value && typeof value === 'object') {
    for (const key of Object.keys(value as object).sort()) {
      out.push(`${key}:`)
      textOf((value as Record<string, unknown>)[key], out)
    }
  }
  return out
}

function words(value: unknown): string[] {
  return textOf(value).join(' ').split(/\s+/).filter(Boolean)
}

/** Levenshtein over words, two rows. */
function distance(a: string[], b: string[]): number {
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  let cur = new Array<number>(b.length + 1)
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    ;[prev, cur] = [cur, prev]
  }
  return prev[b.length]
}

export function editRatio(stored: unknown, edited: unknown): number {
  const a = words(stored)
  const b = words(edited)
  if (a.length > EDIT_RATIO_MAX_WORDS || b.length > EDIT_RATIO_MAX_WORDS) return 1
  const longest = Math.max(a.length, b.length)
  if (longest === 0) return 0
  return Math.min(1, distance(a, b) / longest)
}
