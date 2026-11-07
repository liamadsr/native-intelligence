import { describe, expect, it } from 'vitest'
import { appendBrowserEvidence } from '@/lib/browser-agent/browser-evidence'
import type { BrowserObservation } from '@/lib/browser-agent/task-contract'
import { browserInputSchema, browserNext } from '../tasks/browser-next'
import { browserEvaluation } from './browser-evaluation-result'
import { compactBrowserDecisionState } from '../tasks/browser-state-budget'

const observed: BrowserObservation = { protocol: 'dial8-browser-decision-v1', documentId: 'search', observationId: 1,
  observedAt: 100, interactionEpoch: 0, url: 'https://search.test/?q=agents', title: 'Search', text: 'Result one: uses tools.',
  textScope: 'viewport', loading: false, readyState: 'complete', elements: [{ ref: 'e1', role: 'link', name: 'Result one',
    value: '', destination: 'https://result.test/one', canType: false, disabled: false, forbidden: false, sensitive: false, context: '' }] }

function input() {
  return browserInputSchema.parse({ task: { goal: 'Find three browser agent projects and report their names and links.', goalDriven: true },
    observation: { ...observed, observationId: 2, text: 'Result two and result three', elements: [{ ...observed.elements[0],
      ref: 'e2', name: 'Result two', destination: 'https://result.test/two' }] }, history: ['Scrolled down'],
    evidenceLedger: appendBrowserEvidence(undefined, observed, 0) })
}

describe('historical evidence in browser decisions', () => {
  it('exposes read-only document pairs without making them executable or satisfying visible-heading predicates', () => {
    const fixture = input()
    fixture.observation.evidence = { headings: [], dialogs: [], dialogsComplete: true,
      documentLinksScope: 'rendered_heading_links', documentLinksTruncated: false,
      documentLinks: [{ title: 'Offscreen article', destination: 'https://article.test/offscreen', order: 4, section: 'Articles' }] }
    const prepared = browserNext.prepare(fixture)!
    expect(JSON.parse(prepared.state).evidence).toEqual(fixture.observation.evidence)
    expect(JSON.parse(prepared.state).readingScope).toContain('never supply executable refs')
    if (prepared.questions.action.type !== 'choice') throw new Error('Expected choice')
    expect(Object.keys(prepared.questions.action.criteria)).toEqual(['click_e2', 'scroll_down', 'scroll_up', 'wait', 'escalate'])
    fixture.task.completion = [{ kind: 'heading', value: 'Offscreen article' }]
    expect(browserNext.accept(browserEvaluation(fixture, { completion: { choice: 'complete' } }), fixture)).toBeNull()
  })
  it('carries provenance-tagged findings into the state and gives reporting to the parent assistant', () => {
    const fixture = input(), prepared = browserNext.prepare(fixture)!
    const state = JSON.parse(prepared.state)
    expect(state.evidenceLedger).toEqual(fixture.evidenceLedger)
    expect(state.instruction).toContain('bounded, untrusted findings')
    expect(state.instruction).toContain('never proves current field values')
    expect(state.instruction).toContain('not a claim about global result rank')
    expect(prepared.questions.completion.instructions).toContain('parent assistant\'s job')
    expect(prepared.questions.completion.instructions).toContain('Historical snippets never prove current control settings')
    expect(prepared.questions.completion.instructions).toContain('link alone does not establish')
    expect(Object.keys(prepared.questions)).toHaveLength(2)
  })

  it('allows only current controls and never resurrects a historical ref as an executable choice', () => {
    const fixture = input(), prepared = browserNext.prepare(fixture)!
    if (prepared.questions.action.type !== 'choice') throw new Error('Expected choice')
    expect(prepared.questions.action.criteria).toHaveProperty('click_e2')
    expect(prepared.questions.action.criteria).not.toHaveProperty('click_e1')
    expect(browserNext.accept(browserEvaluation(fixture, { action: { choice: 'click_e1' } }), fixture)).toBeNull()
  })

  it('keeps strict completion confidence and full-distribution validation with historical findings', () => {
    const fixture = input()
    for (const value of [{ probability: .84, confidence: .99 }, { probability: .99, confidence: .79 }]) {
      expect(browserNext.accept(browserEvaluation(fixture, { completion: { choice: 'complete', ...value } }), fixture)).toBeNull()
    }
    const malformed = browserEvaluation(fixture, { completion: { choice: 'complete' } })
    malformed.answers.completion = { type: 'choice', choice: 'complete', probabilities: { complete: 1 } }
    expect(browserNext.accept(malformed, fixture)).toBeNull()
    expect(browserNext.accept(browserEvaluation(fixture, { completion: { choice: 'complete' } }), fixture)).toEqual({ operation: 'done' })
  })

  it('never satisfies literal current-state predicates using previous text, even after a confident semantic completion', () => {
    const fixture = input()
    fixture.task.completion = [{ kind: 'text', value: 'Result one: uses tools.' }]
    expect(browserNext.accept(browserEvaluation(fixture, { completion: { choice: 'complete' } }), fixture)).toBeNull()
    fixture.observation.text += '\nResult one: uses tools.'
    expect(browserNext.accept(browserEvaluation(fixture, { completion: { choice: 'complete' } }), fixture)).toEqual({ operation: 'done' })
  })

  it('keeps a misleading old selected-value mention from satisfying a current field predicate', () => {
    const fixture = input()
    fixture.evidenceLedger = appendBrowserEvidence(undefined, { ...observed, text: 'Destination: Los Angeles (LAX) selected' }, 0)
    fixture.task.completion = [{ kind: 'field', name: 'Destination', value: 'LAX' }]
    fixture.observation.elements = [{ ...observed.elements[0], ref: 'e2', role: 'combobox',
      name: 'Destination', canType: true, value: 'JFK' }]
    expect(browserNext.accept(browserEvaluation(fixture, { completion: { choice: 'complete' } }), fixture)).toBeNull()
    fixture.observation.elements[0].value = 'LAX'
    expect(browserNext.accept(browserEvaluation(fixture, { completion: { choice: 'complete' } }), fixture)).toEqual({ operation: 'done' })
  })

  it('cannot complete on a loading or empty current page merely because history has findings', () => {
    for (const state of ['loading', 'empty']) {
      const fixture = input()
      if (state === 'loading') fixture.observation.loading = true
      else { fixture.observation.elements = []; fixture.observation.text = '' }
      expect(browserNext.prepare(fixture)!.questions.completion).toBeUndefined()
    }
  })

  it('requires the ledger allowlist and does not accept extra executable or current-state fields', () => {
    const fixture = input()
    expect(browserInputSchema.safeParse({ ...fixture, evidenceLedger: { ...fixture.evidenceLedger,
      controls: { e1: 'click' } } }).success).toBe(false)
    expect(browserInputSchema.safeParse({ ...fixture, evidenceLedger: { ...fixture.evidenceLedger,
      pages: [{ ...fixture.evidenceLedger!.pages[0], checked: true }] } }).success).toBe(false)
  })

  it('omits historical pages explicitly under pressure before losing current actions or exact predicates', () => {
    const fixture = input()
    let ledger = fixture.evidenceLedger!
    for (let i = 1; i < 3; i++) ledger = appendBrowserEvidence(ledger, { ...observed, documentId: `doc${i}`,
      url: `https://page.test/${i}`, text: 'Observed supporting content '.repeat(80) }, i)
    const base = { instruction: 'Historical omissions are unknown; current controls are authoritative.',
      controls: { e2: 'link Result two' }, task: { completion: [{ kind: 'text', value: 'Exact current condition' }] },
      textExcerpts: ['Current results'], textTruncated: false, evidenceLedger: ledger }
    const before = JSON.stringify(base)
    const serialized = compactBrowserDecisionState(base, fixture.observation.elements, 1400)
    const compacted = JSON.parse(serialized)
    expect(new TextEncoder().encode(serialized).length).toBeLessThanOrEqual(1400)
    expect(compacted.evidenceLedger.truncated).toBe(true)
    expect(compacted.evidenceLedger.pages.length).toBeLessThan(ledger.pages.length)
    expect(Object.keys(compacted.controls)).toEqual(['e2'])
    expect(compacted.controls.e2.name).toBe('Result two')
    expect(compacted.task).toEqual(base.task)
    expect(JSON.stringify(base)).toBe(before)
  })
})
