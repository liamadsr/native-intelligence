// Where the speaker is in the script, from the last few words they were heard saying. Never word for word: the
// last ~8 spoken words are aligned against the script near the current place (an ordered local alignment that lets
// either side skip words), and the place moves only on a confident match — at least three content words in order,
// ending on one of the most recent words. Forward is preferred and nearby; a jump back, or a recovery after a
// skip beyond the look-ahead, needs a stronger match, and a recovery must be unambiguous (a phrase the script
// repeats never pulls the place to its other copy). Pure; tested in __tests__/follow.test.ts.
import { tokenize, type Token } from './normalize'

export type ScriptLine = { text: string; label?: string }
export type ScriptToken = Token & { line: number }
export type ScriptIndex = { lines: ScriptLine[]; tokens: ScriptToken[]; /** Each line's first token (its next line's when it has none). */ lineStart: number[] }

/** How many spoken words are compared. */
export const SPOKEN_WINDOW = 10
/** Tokens behind and ahead of the place the local search covers. */
export const LOOK_BACK = 15
export const LOOK_AHEAD = 80
/** The alignment must end on one of the last this-many spoken words (older ones are where the speaker was). */
const RECENT = 3

const MATCH_CONTENT = 1
const MATCH_STOP = 0.25
const MISMATCH = -0.6
const SPOKEN_EXTRA = -0.25 // an ad-lib or a recognizer's extra word
const SCRIPT_SKIPPED = -0.35 // a script word not said

/** Moving forward (or staying). */
const FORWARD = { content: 3, score: 2.5 }
/** Moving back more than a couple of words: a line read again. */
const BACKWARD = { content: 4, score: 3.5, density: 0.5 }
/** Beyond the local window: a skip. */
const RECOVER = { content: 4, score: 3.5, margin: 1, apart: 20 }

export function indexScript(lines: ScriptLine[]): ScriptIndex {
  const tokens: ScriptToken[] = [], lineStart: number[] = []
  lines.forEach((line, i) => {
    lineStart.push(tokens.length)
    for (const t of tokenize(line.text)) tokens.push({ ...t, line: i })
  })
  return { lines, tokens, lineStart }
}

/** Script text as lines: one per paragraph or line, blank lines dropped. */
export function linesOf(text: string): ScriptLine[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((t) => ({ text: t }))
}

/** A place in the script is the index of the last token read (-1: before the first). */
export function lineAt(index: ScriptIndex, token: number): number {
  if (!index.tokens.length) return 0
  if (token < 0) return index.tokens[0]!.line
  return index.tokens[Math.min(token, index.tokens.length - 1)]!.line
}

/** The line to show as current: the place's line, or the next one once the place is its line's last word. */
export function currentLine(index: ScriptIndex, token: number): number {
  const at = index.tokens[token], next = index.tokens[token + 1]
  return at && next && next.line !== at.line ? next.line : lineAt(index, token)
}

/** The place just before `line` (so it is the line being read), for "start here". */
export function placeBeforeLine(index: ScriptIndex, line: number): number {
  return (index.lineStart[Math.max(0, Math.min(line, index.lineStart.length - 1))] ?? 0) - 1
}

type Candidate = { end: number; start: number; score: number; content: number }

/** Every alignment of `spoken` with tokens [lo, hi) that ends on a match with a recent spoken word, best per end. */
function align(index: ScriptIndex, spoken: Token[], lo: number, hi: number): Candidate[] {
  const m = spoken.length, n = hi - lo
  if (!m || n <= 0) return []
  // Rolling rows: score, content matched, first script index of the path.
  type Cell = { s: number; c: number; f: number }
  const zero: Cell = { s: 0, c: 0, f: -1 }
  let prev: Cell[] = Array.from({ length: n + 1 }, () => zero)
  const best = new Map<number, Candidate>()
  for (let i = 1; i <= m; i++) {
    const row: Cell[] = [zero]
    const said = spoken[i - 1]!
    for (let j = 1; j <= n; j++) {
      const at = lo + j - 1, tok = index.tokens[at]!
      const same = said.stem === tok.stem
      const diag = prev[j - 1]!
      let cell: Cell = zero
      const take = (s: number, c: number, f: number) => { if (s > cell.s) cell = { s, c, f } }
      if (same) take(diag.s + (tok.content ? MATCH_CONTENT : MATCH_STOP), diag.c + (tok.content ? 1 : 0), diag.s > 0 ? diag.f : at)
      else if (diag.s > 0) take(diag.s + MISMATCH, diag.c, diag.f)
      const up = prev[j]!, left = row[j - 1]!
      if (up.s > 0) take(up.s + SPOKEN_EXTRA, up.c, up.f)
      if (left.s > 0) take(left.s + SCRIPT_SKIPPED, left.c, left.f)
      row.push(cell)
      if (same && i > m - RECENT && cell.s > 0) {
        const had = best.get(at)
        if (!had || cell.s > had.score) best.set(at, { end: at, start: cell.f, score: cell.s, content: cell.c })
      }
    }
    prev = row
  }
  return [...best.values()]
}

/**
 * The new place given what was just said (`spoken`: the last words, oldest first) and the current place `at`, or
 * null to stay. Interim words may be included: the caller decides whether a result is confirmed.
 */
export function locate(index: ScriptIndex, spoken: Token[], at: number): number | null {
  const words = spoken.slice(-SPOKEN_WINDOW)
  if (words.filter((w) => w.content).length < FORWARD.content) return null
  const total = index.tokens.length
  const lo = Math.max(0, at - LOOK_BACK), hi = Math.min(total, at + 1 + LOOK_AHEAD)
  const local = align(index, words, lo, hi)

  // Forward (or here): the best, and among near-equals the nearest ahead (a repeated phrase stays on this copy).
  const ahead = local.filter((c) => c.end >= at - 2 && c.content >= FORWARD.content && c.score >= FORWARD.score)
  if (ahead.length) {
    const top = Math.max(...ahead.map((c) => c.score))
    const pick = ahead.filter((c) => c.score >= top - 0.5).sort((a, b) => a.end - b.end)[0]!
    return pick.end <= at ? null : pick.end
  }
  // Back: a line read again, with a stronger and denser match.
  const back = local.filter((c) => c.end < at - 2 && c.content >= BACKWARD.content && c.score >= BACKWARD.score && c.content / (c.end - c.start + 1) >= BACKWARD.density)
  if (back.length) return back.sort((a, b) => b.score - a.score || b.end - a.end)[0]!.end
  // Nothing near: a skip. Search everywhere else, and move only when one place clearly wins.
  const far = [...align(index, words, 0, lo), ...align(index, words, hi, total)].filter((c) => c.content >= RECOVER.content && c.score >= RECOVER.score)
  const all = align(index, words, 0, total)
  if (!far.length) return null
  const winner = far.sort((a, b) => b.score - a.score)[0]!
  const rival = all.filter((c) => Math.abs(c.end - winner.end) > RECOVER.apart).reduce((m, c) => Math.max(m, c.score), 0)
  return winner.score - rival >= RECOVER.margin ? winner.end : null
}

/** The follower's place: `confirmed` from final words only, `shown` (what the highlight shows) with the interim too. */
export type FollowPlace = { confirmed: number; shown: number }
export const START: FollowPlace = { confirmed: -1, shown: -1 }

/**
 * The place after hearing: finals confirm, interims only move what is shown. An interim the finals don't bear out
 * falls back to the confirmed place on the next update.
 */
export function follow(index: ScriptIndex, place: FollowPlace, finals: Token[], interim: Token[]): FollowPlace {
  const confirmed = locate(index, finals, place.confirmed) ?? place.confirmed
  if (!interim.length) return { confirmed, shown: confirmed }
  const shown = locate(index, [...finals, ...interim], confirmed) ?? confirmed
  return { confirmed, shown }
}
