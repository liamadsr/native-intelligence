import { describe, expect, it } from 'vitest'
import { browserInputSchema } from '../tasks/browser-next'
import { browserCompletion } from '../tasks/browser-completion'
import type { Evaluation } from '../contracts'

const input = () => browserInputSchema.parse({ task: { goal: 'Collect the three requested titles and links.', goalDriven: true }, history: [],
  observation: { protocol: 'dial8-browser-decision-v1', documentId: 'doc', observationId: 1, interactionEpoch: 0,
    observedAt: 1, url: 'https://example.com/', title: 'Results', text: 'Observed results', readyState: 'complete', loading: false, elements: [],
    evidence: { headings: [], dialogs: [], dialogsComplete: true, documentLinksScope: 'rendered_heading_links', documentLinksTruncated: true,
      documentLinks: [{ title: 'Observed title', destination: 'https://example.com/article', order: 4, section: 'Web results', context: 'Observed source preview' }] } } })
const answer = (probability = .99, confidence = .99) => ({ answers: Object.fromEntries(['context', 'findings'].map(key => [key, { type: 'choice', choice: 'complete',
  probabilities: { complete: probability, incomplete: 1 - probability } }])), providerMetadata: { typesafe: { confidence: { context: confidence, findings: confidence } } } } as unknown as Evaluation)

describe('focused browser reading completion', () => {
  it('keeps source context and ordering, without exposing executable refs or treating a link as visited', () => {
    const prepared = browserCompletion.prepare(input())!
    const state = JSON.parse(prepared.state)
    expect(state.currentPage.headingLinks).toEqual([{ title: 'Observed title', order: 0, section: 'Web results', context: 'Observed source preview', linkId: 'l0', hasExactDestination: true }])
    expect(state.currentPage.headingLinksTruncated).toBe(true)
    expect(state.provenance).toContain('never unvisited contents')
    expect(prepared.questions).not.toHaveProperty('action')
  })
  it('keeps a fresh record inventory independent of earlier form recommendations', () => {
    const fixture = input()
    fixture.observation.evidence!.documentLinks = []
    fixture.observation.evidence!.documentRecords = [{ kind: 'row', text: 'Requested item: $20 available', textTruncated: false, order: 12 }]
    fixture.observation.evidence!.documentRecordsScope = 'rendered_semantic_records'
    fixture.observation.evidence!.documentRecordsTruncated = false
    fixture.evidenceLedger = { version: 1, source: 'accepted_native_observations', scope: 'historical_read_evidence', destinationsVisited: false,
      pages: [{ documentId: 'old', url: 'https://example.com/form', title: 'Recommendations', firstSeenStep: 0, lastSeenStep: 0,
        latestObservationId: 1, latestObservedAt: 1, snippets: [{ text: 'Unrelated old recommendation', firstSeenStep: 0, position: 0 }], links: [], truncated: false }], truncated: false }
    const state = JSON.parse(browserCompletion.prepare(fixture)!.state)
    expect(state.currentPage.records).toEqual(fixture.observation.evidence!.documentRecords)
    expect(state.currentPage).not.toHaveProperty('historicalReadings')
    expect(fixture.evidenceLedger.pages[0].snippets[0].text).toBe('Unrelated old recommendation')
    fixture.observation.evidence!.documentRecords = []
    expect(JSON.parse(browserCompletion.prepare(fixture)!.state).currentPage.historicalReadings.pages[0].snippets[0].text).toBe('Unrelated old recommendation')
  })
  it('carries human requirements independently of planner elaboration', () => {
    const fixture = input()
    fixture.task.sourceRequest = JSON.stringify(['Collect three titles and links.'])
    const prepared = browserCompletion.prepare(fixture)!
    expect(JSON.parse(prepared.state).goal).toBe('Collect three titles and links.')
    expect(prepared.state).not.toContain(fixture.task.goal)
    expect(prepared.state).not.toContain('plannerNavigationHint')
    expect(prepared.questions.context.instructions).toContain('elaboration cannot add requirements')
  })
  it('preserves the strict terminal gates and literal checks in the alternate view', () => {
    const fixture = input()
    for (const values of [[.84, .99], [.99, .79]]) expect(browserCompletion.accept(answer(values[0], values[1]), fixture)).toBeNull()
    expect(browserCompletion.accept(answer(), fixture)).toBe('complete')
    fixture.task.completion = [{ kind: 'heading', value: 'Required current heading' }]
    expect(browserCompletion.accept(answer(), fixture)).toBeNull()
    const malformed = answer(); malformed.answers.findings = { type: 'choice', choice: 'complete', probabilities: { complete: 1 } }
    expect(browserCompletion.accept(malformed, input())).toBeNull()
  })
  it('requires both independent heads to meet the unchanged terminal threshold', () => {
    const fixture = input()
    for (const key of ['context', 'findings']) {
      const evaluation = answer()
      evaluation.answers[key] = { type: 'choice', choice: 'complete', probabilities: { complete: .89, incomplete: .11 } }
      evaluation.providerMetadata!.typesafe = { confidence: { context: key === 'context' ? .78 : .99, findings: key === 'findings' ? .78 : .99 } }
      expect(browserCompletion.accept(evaluation, fixture)).toBeNull()
    }
  })
  it('does not review loading, empty or legacy observations as completed reading goals', () => {
    const fixture = input()
    fixture.observation.loading = true
    expect(browserCompletion.prepare(fixture)).toBeNull()
    fixture.observation.loading = false; delete fixture.task.goalDriven
    expect(browserCompletion.prepare(fixture)).toBeNull()
  })
})
