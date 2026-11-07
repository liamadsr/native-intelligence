/**
 * Canon budgets and lint (canon documents D2; documents-as-ground-truth.md
 * §3.5): each canon document stays a page or two, and keeps its template's
 * fixed sections. Deterministic: no model call.
 *
 *   budgets    product ≤ 8K characters, brand ≤ 6K (decision 10 folds the
 *              brand context into the product doc; the key keeps its budget
 *              should one ever be set), content brief ≤ 3K, team playbook
 *              about 8K, voice notes ≤ 1K.
 *   the rule   an edit that leaves the document over its budget must name
 *              what it cuts (`removes`) and must not make it longer; anything
 *              else that would put it over is refused, with the numbers, so the
 *              agent cuts against the second question every time it revises
 *              ("a document that has only grown has stopped being maintained").
 *              An edit that shrinks a document already over its budget is
 *              always fine.
 *   headings   an edit to a template document addresses one of its fixed `##`
 *              sections (or a subsection under one), and its text adds no `#`
 *              or `##` heading of its own. read_canon reports the template
 *              sections a document lacks and the `##` sections it has that the
 *              template doesn't.
 *
 * Pure and client-safe.
 */
import { contentBriefChannel, templateForKey } from './canon'
import { findSection, levelTwoSectionOf, parseOutline } from './markdown-structure'
import { describeGrades, gradeRefusal, gradeSummary, GRADED_PRODUCT_SECTIONS, openQuestionsRefusal, OPEN_QUESTIONS_HEADING, sectionTextOf, type ClaimEvidence } from '@/lib/marketing/grade'

/** Characters per canon key (by template; null: no budget). */
export function canonBudget(key: string | null | undefined): number | null {
  if (!key) return null
  if (key === 'product') return 8_000
  if (key === 'brand') return 6_000
  if (key === 'team-playbook') return 8_000
  if (key === 'person:voice') return 1_000
  if (contentBriefChannel(key)) return 3_000
  return null
}

/** A number as people read it (8,412). Pure. */
const n = (x: number) => x.toLocaleString('en-US')

/** Why the edit is refused for its budget, or null. Pure. */
export function budgetRefusal(args: { key: string | null; previous: string; content: string; removes?: string | null }): string | null {
  const budget = canonBudget(args.key)
  if (budget === null || args.content.length <= budget) return null
  // Shrinking toward the budget is always allowed; a named cut that keeps it no longer is too.
  if (args.content.length < args.previous.length) return null
  if (args.removes?.trim() && args.content.length <= args.previous.length) return null
  const over = `This edit would leave \`${args.key}\` at ${n(args.content.length)} of its ${n(budget)} characters.`
  if (!args.removes?.trim()) {
    return `${over} Cut something to make room: replace a section with a shorter version (or remove one) and name what you cut in \`removes\`. Keep what is proven and current; drop what is stale or repeated.`
  }
  return `${over} Naming what you cut isn't enough: the edit itself must not make the document longer. Replace the section with a shorter version that still holds the new point.`
}

/** Why the edit is refused for its headings, or null. Pure. */
export function headingRefusal(args: { key: string | null; content: string; section: string; text: string }): string | null {
  const template = templateForKey(args.key)
  if (!template) return null
  if (/^\s{0,3}#{1,2}[ \t]/m.test(args.text)) {
    return `The text adds a heading of its own: \`${args.key}\` keeps its fixed sections (${template.sections.map((s) => s.heading).join(', ')}). Use ### for a subsection, or edit the section it belongs in.`
  }
  const outline = parseOutline(args.content)
  const found = findSection(outline, args.section)
  if (!found.ok) return null
  // The `##` the edit lands in (a `#` title, when the document has one, is not a section).
  const top = (levelTwoSectionOf(outline, found.entry)?.heading ?? found.entry.path[0])?.toLowerCase()
  const fixed = template.sections.some((s) => s.heading.toLowerCase() === top)
  return fixed ? null : `"${found.entry.path.join(' > ')}" isn't one of \`${args.key}\`'s sections: ${template.sections.map((s) => s.heading).join(', ')}. Move what it says into the section it belongs in.`
}

/** The document's shape against its template and budget, for read_canon. Pure. */
export function lintCanonDocument(key: string, content: string) {
  const budget = canonBudget(key)
  const template = templateForKey(key)
  const outline = parseOutline(content)
  const top = outline.filter((e) => e.level === 2)
  const missing = template ? template.sections.filter((s) => !findSection(outline, s.heading).ok).map((s) => s.heading) : []
  const extra = template ? top.filter((e) => !template.sections.some((s) => s.heading.toLowerCase() === e.heading.toLowerCase())).map((e) => e.heading) : []
  return {
    chars: content.length,
    ...(budget !== null ? { budget } : {}),
    ...(budget !== null && content.length > budget ? { over_budget: true } : {}),
    ...(missing.length ? { missing_sections: missing } : {}),
    ...(extra.length ? { extra_sections: extra } : {}),
    ...(key === 'product' ? productClaimGrades(content) : {}),
  }
}

/** How the product doc's claim lines are graded (read_canon), when it has any. Pure. */
function productClaimGrades(content: string): { claim_grades?: string; ungraded_claims?: number } {
  const outline = parseOutline(content)
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  const total = { proven: 0, plausible: 0, assumption: 0, ungraded: 0 }
  for (const heading of GRADED_PRODUCT_SECTIONS) {
    const found = findSection(outline, heading)
    if (!found.ok) continue
    const s = gradeSummary(lines.slice(found.entry.line, found.entry.endLine).join('\n'))
    for (const k of Object.keys(total) as Array<keyof typeof total>) total[k] += s[k]
  }
  const said = describeGrades(total)
  return said ? { claim_grades: said, ...(total.ungraded ? { ungraded_claims: total.ungraded } : {}) } : {}
}

/**
 * The check a canon edit runs before it writes (canon-edit.ts `check`): the
 * fixed sections, the budget, and two rules of the brand context (marketing
 * M0, src/lib/marketing/grade.ts): an open question leaves its list only by
 * moving (any template with an Open questions section), and a claim line in
 * the product doc's graded sections carries its grade, never above what
 * `evidence` (the edit's sources, counted) allows. Pure.
 */
export function canonEditCheck(
  key: string | null,
  edit: { section: string; text: string; removes?: string | null },
  opts: { evidence?: ClaimEvidence | null } = {},
) {
  const hasQuestions = !!templateForKey(key)?.sections.some((s) => s.heading === OPEN_QUESTIONS_HEADING)
  return (next: { content: string; previous: string }): string | null =>
    headingRefusal({ key, content: next.previous, section: edit.section, text: edit.text }) ??
    gradeRefusal({ key, sectionPath: sectionPathOf(next.previous, edit.section), text: edit.text, evidence: opts.evidence ?? null, previousText: sectionTextOf(next.previous, edit.section) }) ??
    (hasQuestions ? openQuestionsRefusal({ previous: next.previous, content: next.content }) : null) ??
    budgetRefusal({ key, previous: next.previous, content: next.content, removes: edit.removes })
}

/** The heading path of the section an edit addresses ("Positioning > Real alternative" → both), or the query split. Pure. */
function sectionPathOf(content: string, section: string): string[] {
  const found = findSection(parseOutline(content), section)
  return found.ok ? found.entry.path : section.split(/\s*>\s*/)
}
