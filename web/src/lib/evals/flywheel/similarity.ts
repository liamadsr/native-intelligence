/**
 * How much of an agent's draft survived the person's edits (the evals
 * flywheel's draft-rewrite signal, ./types.ts). Pure and client-safe.
 *
 * Word level: both texts are cut into lowercase words (letters and digits,
 * Unicode-aware; punctuation, spacing and case never count), and the score is
 * the Dice coefficient over their longest common subsequence:
 *
 *   similarity = 2 · LCS(draft, sent) / (words(draft) + words(sent))
 *
 * 1 is unchanged, 0 shares nothing. The subsequence keeps word order, so a
 * reworded reply scores low even when it reuses the draft's vocabulary, and
 * the sum below keeps additions in the score: keeping every draft word but
 * writing three times as much again reads as a rewrite.
 *
 * Fast enough for a send path: each side is cut at SIMILARITY_MAX_WORDS
 * words (an email past that is rare, and its opening says enough), and the
 * table is two Uint16 rows, so 2,000 words a side is 4M cheap steps and 8 KB.
 */
import { DRAFT_REWRITE_MIN_WORDS, DRAFT_REWRITE_SIMILARITY_MAX } from './types'

/** Words a side is cut at before comparing (keeps the LCS table small and fast). */
export const SIMILARITY_MAX_WORDS = 2000

/** A text's words: lowercase runs of letters and digits, in order. */
export function wordsOf(text: string | null | undefined): string[] {
  if (!text) return []
  return text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

/** The longest common subsequence's length (two rolling rows). */
function lcsLength(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  // The shorter side is the row, so the rows stay small.
  const [rows, cols] = a.length >= b.length ? [a, b] : [b, a]
  let prev = new Uint16Array(cols.length + 1)
  let curr = new Uint16Array(cols.length + 1)
  for (let i = 1; i <= rows.length; i++) {
    const word = rows[i - 1]
    for (let j = 1; j <= cols.length; j++) {
      curr[j] = word === cols[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1])
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[cols.length]
}

/** Word-level similarity of two texts, 0..1 (see the module note). Two empty texts are identical. */
export function wordSimilarity(before: string | null | undefined, after: string | null | undefined): number {
  return similarityOfWords(wordsOf(before), wordsOf(after))
}

function similarityOfWords(before: readonly string[], after: readonly string[]): number {
  const a = before.slice(0, SIMILARITY_MAX_WORDS)
  const b = after.slice(0, SIMILARITY_MAX_WORDS)
  if (a.length === 0 && b.length === 0) return 1
  return (2 * lcsLength(a, b)) / (a.length + b.length)
}

/** A draft against what was sent: the score, the word counts, and whether it was a heavy rewrite. */
export interface RewriteMeasure {
  similarity: number
  wordsBefore: number
  wordsAfter: number
  heavy: boolean
}

/**
 * Measure a send against its draft. Heavy: the draft had at least
 * DRAFT_REWRITE_MIN_WORDS words (a one-line reply says little) and the score
 * is under DRAFT_REWRITE_SIMILARITY_MAX. The score is rounded to 3 places.
 */
export function measureRewrite(before: string | null | undefined, after: string | null | undefined): RewriteMeasure {
  const a = wordsOf(before)
  const b = wordsOf(after)
  const similarity = Math.round(similarityOfWords(a, b) * 1000) / 1000
  return {
    similarity,
    wordsBefore: a.length,
    wordsAfter: b.length,
    heavy: a.length >= DRAFT_REWRITE_MIN_WORDS && similarity < DRAFT_REWRITE_SIMILARITY_MAX,
  }
}

/** Whether the sent text rewrote the draft heavily (measureRewrite's `heavy`). */
export function isHeavyRewrite(before: string | null | undefined, after: string | null | undefined): boolean {
  return measureRewrite(before, after).heavy
}
