/**
 * The brand context's grades and open questions (marketing M0, decision 10;
 * P12, P13). Pinned:
 *   - gradeClaim: proven from two companies, a document a person wrote or a
 *     metric; plausible from how the product works; else an assumption;
 *   - an agent's edit to a graded section of the product doc grades every
 *     claim bullet, and never above what its sources show;
 *   - an open question leaves its list only by moving; rewording in place is
 *     fine; any template with the section is held to it;
 *   - read_canon reports the grades.
 */
import { describe, expect, it } from 'vitest'
import { claimLines, describeGrades, gradeClaim, gradeRefusal, gradeSummary, isGradedProductSection, lineGrade, newProvenLine, openQuestionsRefusal } from '../grade'
import { canonEditCheck, lintCanonDocument } from '@/lib/documents/canon-lint'
import { CANON_TEMPLATES } from '@/lib/documents/canon'

const NONE = { companies: 0, documents: 0, metrics: 0 }

describe('gradeClaim', () => {
  it('grades from evidence, never from the claim', () => {
    expect(gradeClaim({ ...NONE, companies: 2 })).toBe('proven')
    expect(gradeClaim({ ...NONE, documents: 1 })).toBe('proven')
    expect(gradeClaim({ ...NONE, metrics: 1 })).toBe('proven')
    expect(gradeClaim({ ...NONE, companies: 1 })).toBe('assumption')
    expect(gradeClaim({ ...NONE, companies: 1, fromProduct: true })).toBe('plausible')
    expect(gradeClaim(NONE)).toBe('assumption')
  })
})

describe('the format', () => {
  it('reads a grade in square brackets, on top-level bullets only', () => {
    expect(lineGrade('- Files actions while the call is on [proven]')).toBe('proven')
    expect(lineGrade('- Cuts follow-up time [Plausible] (from how it works)')).toBe('plausible')
    expect(lineGrade('- No grade here')).toBeNull()
    expect(claimLines('Intro sentence.\n- One [proven]\n  - a detail\n2. Two\n* Three [assumption]')).toEqual(['- One [proven]', '2. Two', '* Three [assumption]'])
    expect(describeGrades(gradeSummary('- a [proven]\n- b [proven]\n- c [assumption]\n- d'))).toBe('2 proven, 1 assumption, 1 ungraded')
    expect(describeGrades(gradeSummary('no bullets'))).toBe('')
  })

  it("the graded sections are Who it's for, Positioning and Messaging, whatever the apostrophe", () => {
    for (const s of ["Who it's for", 'Who it’s for', 'Positioning', 'messaging']) expect(isGradedProductSection([s]), s).toBe(true)
    for (const s of ['What the product is', 'Voice', 'Open questions']) expect(isGradedProductSection([s]), s).toBe(false)
    // The template these name is the product doc's (P4's skeleton).
    const headings = CANON_TEMPLATES.product.sections.map((s) => s.heading)
    expect(headings).toEqual(["What the product is", "Who it's for", 'Positioning', 'Messaging', 'Voice', 'Open questions'])
  })
})

describe('gradeRefusal', () => {
  const at = (section: string, text: string, evidence: typeof NONE | null = NONE) => gradeRefusal({ key: 'product', sectionPath: [section], text, evidence })

  it('refuses an ungraded claim bullet, with the fix and the rule', () => {
    const r = at('Messaging', '- Saves an hour a week [plausible]\n- Works with any calendar')
    expect(r).toMatch(/end each bullet with \[proven\], \[plausible\] or \[assumption\]/)
    expect(r).toMatch(/"- Works with any calendar"/)
  })

  it('refuses [proven] past the evidence, and says what was counted', () => {
    const r = at('Positioning', '- The real alternative is a spreadsheet [proven]', { ...NONE, companies: 1 })
    expect(r).toMatch(/needs calls with two or more companies, a document a person wrote, or a metric/)
    expect(r).toMatch(/1 outside company and 0 documents a person wrote/)
    expect(at('Positioning', '- The real alternative is a spreadsheet [proven]', null)).toMatch(/could not be counted/)
  })

  it('lets proven stand on its evidence, and plausible or assumption on none', () => {
    expect(at('Positioning', '- The real alternative is a spreadsheet [proven]', { ...NONE, companies: 2 })).toBeNull()
    expect(at('Messaging', '- Saves an hour a week [plausible]\n- Teams of 5 to 50 [assumption]')).toBeNull()
    // Prose and details are not claims.
    expect(at('Messaging', 'Our core message, in one line.\n- Pillar [plausible]\n  - mechanism: files actions on the call')).toBeNull()
  })

  it('only the product doc, only its graded sections', () => {
    expect(gradeRefusal({ key: 'team-playbook', sectionPath: ['Positioning'], text: '- ungraded', evidence: NONE })).toBeNull()
    expect(at('Voice', '- Plain and dry')).toBeNull()
    expect(at('What the product is', '- Records calls')).toBeNull()
  })
})

describe('only new or changed lines are held to the grades (review S1)', () => {
  const previous = '- The real alternative is a spreadsheet [proven]\n- Works with any calendar'
  const at = (text: string, evidence: { companies: number; documents: number; metrics: number } | null) =>
    gradeRefusal({ key: 'product', sectionPath: ['Positioning'], text, evidence, previousText: previous })

  it('a rewrite that keeps an approved [proven] line word for word needs no new evidence', () => {
    expect(at('- The real alternative is a spreadsheet [proven]\n- Teams switch in a week [assumption]', null)).toBeNull()
  })

  it('a line kept from before the grades stays as it is; a new ungraded one is refused', () => {
    expect(at('- Works with any calendar\n- Teams switch in a week [assumption]', null)).toBeNull()
    expect(at('- Works with any calendar\n- Teams switch in a week', null)).toMatch(/Ungraded: "- Teams switch in a week"/)
  })

  it('a changed [proven] line needs this edit’s evidence', () => {
    expect(at('- The real alternative is a shared spreadsheet [proven]', { companies: 1, documents: 0, metrics: 0 })).toMatch(/needs calls with two or more companies/)
    expect(at('- The real alternative is a shared spreadsheet [proven]', { companies: 2, documents: 0, metrics: 0 })).toBeNull()
  })

  it('the tool counts sources only when a new [proven] line needs them', () => {
    const doc = `## Positioning\n${previous}\n\n## Messaging\n`
    expect(newProvenLine('- The real alternative is a spreadsheet [proven]', doc, 'Positioning')).toBe(false)
    expect(newProvenLine('- Teams switch in a week [proven]', doc, 'Positioning')).toBe(true)
    expect(newProvenLine('- Teams switch in a week [plausible]', doc, 'Positioning')).toBe(false)
  })

  it('canonEditCheck hands the section’s previous text to the rule', () => {
    const doc = `## Who it's for\n\n## Positioning\n${previous}\n\n## Messaging\n\n## Open questions\n`
    const check = canonEditCheck('product', { section: 'Positioning', text: '- The real alternative is a spreadsheet [proven]\n- Teams switch in a week [plausible]' })
    expect(check({ previous: doc, content: doc })).toBeNull()
  })
})

describe('openQuestionsRefusal', () => {
  const doc = (positioning: string, questions: string) => `## Positioning\n${positioning}\n\n## Open questions\n${questions}\n`
  const before = doc('- The real alternative is a spreadsheet [plausible]', '- Do agencies buy it, or only in-house teams?\n- Is per-seat pricing a blocker for small teams?')

  it('refuses a question deleted without landing anywhere', () => {
    const after = doc('- The real alternative is a spreadsheet [plausible]', '- Do agencies buy it, or only in-house teams?')
    expect(openQuestionsRefusal({ previous: before, content: after })).toMatch(/resolved by moving it, never by deleting it[\s\S]*per-seat pricing/)
  })

  it('lets a question move: its answer lands in another section', () => {
    const after = doc(
      '- The real alternative is a spreadsheet [plausible]\n- Settled: per-seat pricing is not a blocker for small teams; three of them signed this month [proven]',
      '- Do agencies buy it, or only in-house teams?',
    )
    expect(openQuestionsRefusal({ previous: before, content: after })).toBeNull()
  })

  it('rewording one in place, or adding one, is fine; a document without the section is never checked', () => {
    const reworded = doc('- The real alternative is a spreadsheet [plausible]', '- Do agencies buy it, or only in-house product teams?\n- Is per-seat pricing a blocker for very small teams?\n- New: does it work for sales?')
    expect(openQuestionsRefusal({ previous: before, content: reworded })).toBeNull()
    expect(openQuestionsRefusal({ previous: '## Voice\n- dry\n', content: '' })).toBeNull()
  })
})

describe('canonEditCheck: the brand context rules ride every canon edit', () => {
  const product = '## What the product is\n\n## Who it\'s for\n\n## Positioning\n\n## Messaging\n\n## Voice\n\n## Open questions\n- Who else buys it?\n'

  it('refuses an ungraded product claim and a deleted question, with the budget and headings still checked', () => {
    const check = canonEditCheck('product', { section: 'Messaging', text: '- Saves an hour' })
    expect(check({ previous: product, content: product.replace('## Messaging\n', '## Messaging\n- Saves an hour\n') })).toMatch(/carries its grade/)
    const drop = canonEditCheck('product', { section: 'Open questions', text: '' })
    expect(drop({ previous: product, content: product.replace('- Who else buys it?\n', '') })).toMatch(/never by deleting it/)
    const ok = canonEditCheck('product', { section: 'Messaging', text: '- Saves an hour [assumption]' })
    expect(ok({ previous: product, content: product.replace('## Messaging\n', '## Messaging\n- Saves an hour [assumption]\n') })).toBeNull()
  })

  it('the team playbook keeps its open questions too; the voice notes have none to keep', () => {
    const playbook = '## How we work\n\n## Open questions\n- Who owns releases?\n'
    expect(canonEditCheck('team-playbook', { section: 'Open questions', text: '' })({ previous: playbook, content: '## How we work\n\n## Open questions\n' })).toMatch(/never by deleting it/)
    expect(canonEditCheck('person:voice', { section: 'How I write', text: 'Short.' })({ previous: '## How I write\nLong.\n', content: '## How I write\nShort.\n' })).toBeNull()
  })

  it('read_canon reports how the product doc is graded', () => {
    const graded = product.replace('## Positioning\n', '## Positioning\n- Spreadsheets today [proven]\n- Per-seat is fine [assumption]\n- Ungraded line\n')
    expect(lintCanonDocument('product', graded)).toMatchObject({ claim_grades: '1 proven, 1 assumption, 1 ungraded', ungraded_claims: 1 })
    expect(lintCanonDocument('product', product)).not.toHaveProperty('claim_grades')
    expect(lintCanonDocument('team-playbook', graded)).not.toHaveProperty('claim_grades')
  })
})
