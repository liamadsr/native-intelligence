/**
 * Grades that move with the evidence (marketing M1, P9;
 * marketing-skill-set.md §4.1 "Grades come from evidence, not the model's
 * mood"). The marketing lens lands each line in the product doc as an
 * [assumption]: one call is one company (lenses.ts marketingLine). When more
 * customers say the same thing, the line should say so. This is how, with no
 * model call:
 *
 *   - a new finding that says what a line ALREADY in the doc says (the same
 *     kind, most of the same words: similarLine) adds no second line; its
 *     call counts as more evidence for that line;
 *   - findings in one batch that say the same thing become ONE line, with all
 *     their calls behind it;
 *   - the line's grade is gradeClaim of the evidence its calls show (distinct
 *     outside companies, counted by claim-evidence.ts): two or more companies
 *     make it [proven]. A grade only ever rises here, and never past what the
 *     evidence allows (canon-lint.ts re-checks every [proven] against the
 *     edit's sources).
 *
 * Open questions are untouched: a contradiction stays an open question until
 * someone answers it by moving it (grade.ts openQuestionsRefusal).
 *
 * Pure.
 */
import { contentWords } from '@/lib/content/public-safe'
import { findSection, parseOutline, splitLines } from '@/lib/documents/markdown-structure'
import { CLAIM_GRADES, lineGrade, type ClaimGrade } from './grade'

/** The share of content words two lines must share to say the same thing. */
export const SIMILAR_SHARE = 0.6

/** The prefixes the marketing lens writes, per kind (lenses.ts marketingLine). */
const PREFIX_RE = /^\s*[-*+]\s+(Objection heard|How customers put it|Compared with):\s*/i

/** A line's claim, without its bullet, its lens prefix and its grade. Pure. */
export function claimBody(line: string): string {
  return line.replace(PREFIX_RE, '').replace(/^\s*[-*+]\s+/, '').replace(/\s*\[(?:proven|plausible|assumption)\]\s*$/i, '').trim()
}

/** The lens prefix a line carries ("Objection heard"), lower-cased, or null. Pure. */
export function linePrefix(line: string): string | null {
  const m = PREFIX_RE.exec(line)
  return m ? m[1].toLowerCase() : null
}

/**
 * Two lens lines say the same thing: the same prefix (kind), and at least
 * SIMILAR_SHARE of the shorter one's content words are in the other (each
 * with 3 or more). Pure.
 */
export function similarLine(a: string, b: string): boolean {
  if (linePrefix(a) !== linePrefix(b)) return false
  const wa = new Set(contentWords(claimBody(a)))
  const wb = new Set(contentWords(claimBody(b)))
  if (wa.size < 3 || wb.size < 3) return false
  const [small, large] = wa.size <= wb.size ? [wa, wb] : [wb, wa]
  let shared = 0
  for (const w of small) if (large.has(w)) shared++
  return shared / small.size >= SIMILAR_SHARE
}

/** A section's body lines (without the heading), or null when the document has no such section. Pure. */
export function sectionLines(content: string, heading: string): string[] | null {
  const found = findSection(parseOutline(content), heading)
  if (!found.ok) return null
  return splitLines(content).slice(found.entry.line, found.entry.endLine)
}

/** The doc line in `lines` that says what `line` says, or null. Pure. */
export function matchingLine(lines: readonly string[], line: string): string | null {
  return lines.find((l) => linePrefix(l) !== null && similarLine(l, line)) ?? null
}

/** A grade's rank, weakest first. */
function rank(g: ClaimGrade | null): number {
  return g ? CLAIM_GRADES.length - CLAIM_GRADES.indexOf(g) : 0
}

/** The line with its grade set to `grade` (only ever raised). Pure. */
export function withGrade(line: string, grade: ClaimGrade): string {
  const current = lineGrade(line)
  if (current && rank(current) >= rank(grade)) return line
  const bare = line.replace(/\s*\[(?:proven|plausible|assumption)\]\s*$/i, '')
  return `${bare} [${grade}]`
}

/**
 * The section's body with these lines regraded (each `from` line replaced by
 * its regraded self), every other line word for word. Null when no line
 * changed. Pure.
 */
export function regradedSection(lines: readonly string[], regrades: ReadonlyMap<string, ClaimGrade>): string | null {
  let changed = false
  const out = lines.map((l) => {
    const g = regrades.get(l)
    if (!g) return l
    const next = withGrade(l, g)
    if (next !== l) changed = true
    return next
  })
  return changed ? out.join('\n').replace(/^\n+|\n+$/g, '') : null
}
