/**
 * Canon budgets and lint (D2): the per-template budgets; an edit that leaves a
 * document over its budget must name what it cuts and not make it longer;
 * shrinking is always fine; an edit keeps to the fixed sections and adds no
 * `#`/`##` heading; read_canon's report names missing and extra sections.
 */
import { describe, expect, it } from 'vitest'
import { budgetRefusal, canonBudget, canonEditCheck, headingRefusal, lintCanonDocument } from '../canon-lint'

describe('canonBudget', () => {
  it('product 8K, brand 6K, content brief 3K, playbook 8K, voice 1K, others none', () => {
    expect([canonBudget('product'), canonBudget('brand'), canonBudget('content-brief:x'), canonBudget('team-playbook'), canonBudget('person:voice'), canonBudget('roadmap')]).toEqual([8000, 6000, 3000, 8000, 1000, null])
  })
})

describe('budgetRefusal', () => {
  const big = 'x'.repeat(990)
  it('under the budget: fine', () => {
    expect(budgetRefusal({ key: 'person:voice', previous: 'a', content: big })).toBeNull()
  })
  it('over the budget without naming a cut: refused, with the numbers', () => {
    const r = budgetRefusal({ key: 'person:voice', previous: big, content: `${big}${'y'.repeat(30)}` })
    expect(r).toContain('1,020 of its 1,000 characters')
    expect(r).toContain('removes')
  })
  it('naming a cut is not enough when the document still grows', () => {
    expect(budgetRefusal({ key: 'person:voice', previous: big, content: `${big}${'y'.repeat(20)}`, removes: 'the old tagline' })).toContain('must not make the document longer')
  })
  it('a cut that keeps it no longer passes; shrinking always passes', () => {
    expect(budgetRefusal({ key: 'person:voice', previous: `${big}${'z'.repeat(20)}`, content: `${big}${'y'.repeat(20)}`, removes: 'the old tagline' })).toBeNull()
    expect(budgetRefusal({ key: 'person:voice', previous: `${big}${'z'.repeat(50)}`, content: `${big}${'y'.repeat(20)}` })).toBeNull()
  })
})

describe('headingRefusal', () => {
  const doc = "## What the product is\nx\n\n## Positioning\ny\n\n## Pricing notes\nz\n"
  it('refuses text that adds its own # or ## heading; ### is fine', () => {
    expect(headingRefusal({ key: 'product', content: doc, section: 'Positioning', text: '## New\nstuff' })).toContain('fixed sections')
    expect(headingRefusal({ key: 'product', content: doc, section: 'Positioning', text: '### Real alternative\nSpreadsheets.' })).toBeNull()
  })
  it('refuses an edit to a ## section the template does not have', () => {
    expect(headingRefusal({ key: 'product', content: doc, section: 'Pricing notes', text: 'x' })).toContain("isn't one of")
  })
  it('reads the ## section, not a # title the document opens with', () => {
    const titled = `# Product doc\n\n${doc}`
    expect(headingRefusal({ key: 'product', content: titled, section: 'Positioning', text: 'y2' })).toBeNull()
    expect(headingRefusal({ key: 'product', content: titled, section: 'Product doc > Positioning', text: 'y2' })).toBeNull()
    expect(headingRefusal({ key: 'product', content: titled, section: 'Pricing notes', text: 'x' })).toContain("isn't one of")
  })
  it('a document with no template is not linted', () => {
    expect(headingRefusal({ key: 'roadmap', content: doc, section: 'Pricing notes', text: '## x' })).toBeNull()
  })
})

describe('lintCanonDocument', () => {
  it('names missing and extra sections, and the budget', () => {
    expect(lintCanonDocument('person:voice', '## How I write\nShort.\n\n## Sign-offs\nCheers')).toEqual({
      chars: 42,
      budget: 1000,
      missing_sections: ['Words I use', 'Words I avoid'],
      extra_sections: ['Sign-offs'],
    })
  })
})

describe('canonEditCheck', () => {
  it('checks the headings first, then the budget', () => {
    const check = canonEditCheck('person:voice', { section: 'How I write', text: '## Oops' })
    expect(check({ previous: '## How I write\n', content: '## How I write\n## Oops' })).toContain('heading of its own')
  })
})
