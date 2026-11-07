/**
 * Graded claims and open questions in the product doc, the brand context
 * (marketing M0; docs/plans/marketing-skill-set.md §4.1, eve-alignment.md §6
 * decision 10; eve-templates-lessons.md §3b P12, P13). Deterministic: no
 * model call.
 *
 * Grades come from evidence, not the model's mood (plan §4.1):
 *   proven      backed by calls with two or more outside companies, or a
 *               document a person wrote (human-authored.ts: never one an agent
 *               created or one drawn from outside text), or a metric;
 *   plausible   follows from how the product works (the product doc says so);
 *   assumption  nothing backs it yet.
 * gradeClaim is the ceiling an edit's evidence allows: a line may be graded
 * lower than its evidence, never higher.
 *
 * The format: a claim line in Who it's for, Positioning or Messaging is a
 * bullet that carries its grade in square brackets, `[proven]`, `[plausible]`
 * or `[assumption]`, so a writer reading it knows when to hedge. An agent's
 * edit there that leaves a bullet ungraded, or marks one proven past what its
 * sources show, is refused with the fix (gradeRefusal).
 *
 * Open questions are kept, never deleted: a question leaves the list only by
 * moving, its answer landing somewhere else in the document (openQuestionsRefusal).
 *
 * Pure and client-safe.
 */
import { contentWords } from '@/lib/content/public-safe'
import { findSection, parseOutline, splitLines } from '@/lib/documents/markdown-structure'

export const CLAIM_GRADES = ['proven', 'plausible', 'assumption'] as const
export type ClaimGrade = (typeof CLAIM_GRADES)[number]

/** What backs one claim, counted from its sources. */
export interface ClaimEvidence {
  /** Distinct outside companies whose calls back it (one per person, P9 review S8). */
  companies: number
  /** Distinct outside people behind those companies. Absent: not counted (companies alone decide). */
  people?: number
  /** Published workspace documents that back it. */
  documents: number
  /** Metrics that back it. */
  metrics: number
  /** It follows from how the product works (the product doc says so). */
  fromProduct?: boolean
}

/** The grade the evidence allows (see the module doc). Pure. */
export function gradeClaim(evidence: ClaimEvidence): ClaimGrade {
  // Two companies, said by two different people (S8); or a published document or a metric.
  if ((evidence.companies >= 2 && (evidence.people === undefined || evidence.people >= 2)) || evidence.documents >= 1 || evidence.metrics >= 1) return 'proven'
  if (evidence.fromProduct) return 'plausible'
  return 'assumption'
}

/** The sections of the product doc whose bullets are graded claims. */
export const GRADED_PRODUCT_SECTIONS = ["Who it's for", 'Positioning', 'Messaging'] as const

/** The section a question list lives in. */
export const OPEN_QUESTIONS_HEADING = 'Open questions'

const GRADE_RE = /\[(proven|plausible|assumption)\]/i
/** A top-level bullet or numbered item: a claim line (an indented one is a detail of the claim above it). */
const BULLET_RE = /^ {0,1}(?:[-*+]|\d{1,3}[.)])\s+\S/

/** The grade a line carries, or null. Pure. */
export function lineGrade(line: string): ClaimGrade | null {
  const m = GRADE_RE.exec(line)
  return m ? (m[1].toLowerCase() as ClaimGrade) : null
}

/** The claim lines (top-level bullets) of a section's text. Pure. */
export function claimLines(text: string): string[] {
  return splitLines(text).filter((l) => BULLET_RE.test(l))
}

/** How the claim lines of a text are graded. Pure. */
export function gradeSummary(text: string): Record<ClaimGrade | 'ungraded', number> {
  const out = { proven: 0, plausible: 0, assumption: 0, ungraded: 0 }
  for (const line of claimLines(text)) out[lineGrade(line) ?? 'ungraded']++
  return out
}

/** "2 proven, 1 plausible", or '' when nothing is graded. Pure. */
export function describeGrades(summary: Record<ClaimGrade | 'ungraded', number>): string {
  return [...CLAIM_GRADES, 'ungraded' as const]
    .filter((g) => summary[g] > 0)
    .map((g) => `${summary[g]} ${g}`)
    .join(', ')
}

/** Whether a section path (its top heading) is one of the product doc's graded sections. Pure. */
export function isGradedProductSection(sectionPath: readonly string[] | string): boolean {
  const top = (Array.isArray(sectionPath) ? sectionPath[0] : String(sectionPath).split('>')[0]) ?? ''
  const norm = (s: string) => s.trim().toLowerCase().replace(/[’']/g, "'")
  return GRADED_PRODUCT_SECTIONS.some((s) => norm(s) === norm(top))
}

function clip(text: string, max = 90): string {
  const t = text.trim()
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

/**
 * Why an edit to a graded section of the product doc is refused, or null:
 * a claim line without its grade, or a line marked proven past what the
 * edit's sources show. `evidence` is only read when a line says proven
 * (null: not counted, so a proven line is refused).
 *
 * Only new or changed lines are held to it (P8 review S1): a bullet that
 * stands word for word in the section's `previousText` was already approved
 * (or predates the grades), so rewriting the section around it never demotes
 * it or asks for its proof again. Pure.
 */
export function gradeRefusal(args: { key: string | null; sectionPath: readonly string[]; text: string; evidence: ClaimEvidence | null; previousText?: string }): string | null {
  if (args.key !== 'product' || !isGradedProductSection(args.sectionPath)) return null
  const kept = new Set(splitLines(args.previousText ?? '').map((l) => l.trim()).filter(Boolean))
  const lines = claimLines(args.text).filter((l) => !kept.has(l.trim()))
  const ungraded = lines.filter((l) => !lineGrade(l))
  if (ungraded.length) {
    return (
      `Every claim in ${args.sectionPath[0]} carries its grade, so writers know when to hedge: end each bullet with [proven], [plausible] or [assumption]. ` +
      `proven: calls with two or more companies, or a document a person wrote; plausible: it follows from how the product works; assumption: nothing backs it yet. ` +
      `Ungraded: ${ungraded.slice(0, 3).map((l) => `"${clip(l)}"`).join(', ')}.`
    )
  }
  const proven = lines.filter((l) => lineGrade(l) === 'proven')
  if (!proven.length) return null
  const allowed = args.evidence ? gradeClaim(args.evidence) : 'assumption'
  if (allowed === 'proven') return null
  const counted = args.evidence
    ? `This edit's sources show calls with ${args.evidence.companies} outside ${args.evidence.companies === 1 ? 'company' : 'companies'} and ${args.evidence.documents} ${args.evidence.documents === 1 ? 'document' : 'documents'} a person wrote.`
    : "This edit's sources could not be counted."
  return (
    `A line marked [proven] needs calls with two or more companies, a document a person wrote, or a metric. ${counted} ` +
    `Mark ${proven.length === 1 ? 'it' : 'them'} [plausible] (it follows from how the product works) or [assumption], or cite the proof in sources: ${proven.slice(0, 2).map((l) => `"${clip(l)}"`).join(', ')}.`
  )
}

/** The text under one section's heading (its subsections included), or '' when the document has none. Pure. */
export function sectionTextOf(content: string, query: string): string {
  return sectionBody(content, query).body
}

/** The text of one top-level section, or '' when the document has none. Pure. */
function sectionBody(content: string, heading: string): { body: string; rest: string } {
  const outline = parseOutline(content)
  const found = findSection(outline, heading)
  const lines = splitLines(content)
  if (!found.ok) return { body: '', rest: content }
  const body = lines.slice(found.entry.line, found.entry.endLine).join('\n')
  const rest = [...lines.slice(0, found.entry.line - 1), ...lines.slice(found.entry.endLine)].join('\n')
  return { body, rest }
}

/** Share of a question's content words that must appear elsewhere for it to count as moved. */
export const MOVED_WORD_SHARE = 0.5

/**
 * Why an edit that drops an open question is refused, or null (P13: an open
 * question is resolved by moving it, never by deleting it). A question that
 * leaves the Open questions section must land elsewhere: at least half of its
 * content words appear in the rest of the new document (its answer, written
 * where it belongs). Rewording one in place is fine. Only for a document that
 * has the section. Pure.
 */
export function openQuestionsRefusal(args: { previous: string; content: string }): string | null {
  const before = sectionBody(args.previous, OPEN_QUESTIONS_HEADING).body
  if (!before.trim()) return null
  const questionsBefore = claimLines(before)
  if (!questionsBefore.length) return null
  const nextAll = new Set(contentWords(args.content))
  const dropped = questionsBefore.filter((q) => {
    const words = contentWords(q.replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/, ''))
    if (words.length < 2) return false
    const kept = words.filter((w) => nextAll.has(w)).length
    return kept / words.length < MOVED_WORD_SHARE
  })
  if (!dropped.length) return null
  return (
    `An open question is resolved by moving it, never by deleting it: write its answer where it belongs (for example in Positioning, with its grade), then take it off the list. ` +
    `Dropped without landing anywhere: ${dropped.slice(0, 3).map((q) => `"${clip(q)}"`).join(', ')}.`
  )
}

/**
 * Whether an edit's text has a [proven] claim line the section doesn't
 * already carry word for word: only then are its sources counted. Pure.
 */
export function newProvenLine(text: string, previousContent: string, section: string): boolean {
  if (!/\[proven\]/i.test(text)) return false
  const kept = new Set(splitLines(sectionTextOf(previousContent, section)).map((l) => l.trim()).filter(Boolean))
  return claimLines(text).some((l) => lineGrade(l) === 'proven' && !kept.has(l.trim()))
}
