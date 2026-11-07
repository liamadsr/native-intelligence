import { describe, expect, it } from 'vitest'
import { browserTaskSchema, observationSchema, browserObservationState, taskCompleted, type BrowserObservation } from '../task-contract'

const observation: BrowserObservation = {
  protocol: 'dial8-browser-decision-v1', documentId: 'doc', observationId: 1, interactionEpoch: 0,
  observedAt: 1, url: 'https://example.com/article', title: 'Ada Lovelace', text: 'Ada Lovelace Close banner', elements: [],
}
const task = (completion: unknown[]) => browserTaskSchema.parse({ goal: 'Show the Ada Lovelace article without a dialog', completion })
const evidence = { headings: [{ name: 'Ada Lovelace', level: 1 }], dialogs: [], dialogsComplete: true }

describe('grounded browser completion', () => {
  it('keeps fresh form evidence bounded and separate from action refs and literal predicates', () => {
    const fields = { ...evidence, currentFields: [{ role: 'textbox', name: 'Start', nameTruncated: false,
      value: '2026-10-06', valueTruncated: false, disabled: false }], currentFieldsScope: 'rendered_form_state', currentFieldsTruncated: false }
    const parsed = observationSchema.parse({ ...observation, evidence: fields })
    expect(parsed.evidence?.currentFields?.[0].value).toBe('2026-10-06')
    for (const key of ['currentFields', 'currentFieldsScope', 'currentFieldsTruncated'])
      expect(observationSchema.safeParse({ ...observation, evidence: { ...fields, [key]: undefined } }).success).toBe(false)
    expect(observationSchema.safeParse({ ...observation, evidence: { ...fields,
      currentFields: [{ ...fields.currentFields[0], ref: 'e1' }] } }).success).toBe(false)
    expect(observationSchema.safeParse({ ...observation, evidence: { ...fields,
      currentFields: Array.from({ length: 30 }, () => ({ ...fields.currentFields[0], value: '漢'.repeat(500) })) } }).success).toBe(false)
    expect(browserObservationState(parsed)).not.toBe(browserObservationState({ ...parsed,
      evidence: { ...parsed.evidence!, currentFields: [{ ...fields.currentFields[0], value: '2026-10-07' }] } }))
    expect(taskCompleted(task([{ kind: 'field', name: 'Start', value: '2026-10-06' }]), parsed)).toBe(false)
  })
  it('accepts only bounded read-only semantic records with scope and truncation', () => {
    const reading = { ...evidence, documentRecords: [{ kind: 'row', text: 'Item A $10', textTruncated: false, order: 0 }],
      documentRecordsScope: 'rendered_semantic_records', documentRecordsTruncated: false }
    expect(observationSchema.safeParse({ ...observation, evidence: reading }).success).toBe(true)
    for (const key of ['documentRecords', 'documentRecordsScope', 'documentRecordsTruncated']) {
      expect(observationSchema.safeParse({ ...observation, evidence: { ...reading, [key]: undefined } }).success).toBe(false)
    }
    expect(observationSchema.safeParse({ ...observation, evidence: { ...reading,
      documentRecords: [{ ...reading.documentRecords[0], ref: 'e3' }] } }).success).toBe(false)
    expect(observationSchema.safeParse({ ...observation, evidence: { ...reading,
      documentRecords: Array.from({ length: 30 }, (_, order) => ({ ...reading.documentRecords[0], text: '漢'.repeat(480), order })) } }).success).toBe(false)
  })
  it('excludes read timing changes from page identity and rejects unbounded metrics', () => {
    const readMetrics = { controlScan: 1, targetBuild: 2, viewportText: 3, completionEvidence: 4, documentLinks: 5, total: 15 }
    const parsed = observationSchema.parse({ ...observation, readMetrics })
    expect(parsed.readMetrics).toEqual(readMetrics)
    expect(browserObservationState(parsed)).toBe(browserObservationState(observation))
    for (const value of [-1, Infinity, 60001, '10']) {
      expect(observationSchema.safeParse({ ...observation, readMetrics: { ...readMetrics, total: value } }).success).toBe(false)
    }
  })
  it('requires bounded reading records, provenance and truncation together without accepting executable fields', () => {
    const reading = { ...evidence, documentLinksScope: 'rendered_heading_links', documentLinksTruncated: false,
      documentLinks: [{ title: 'Article', destination: 'https://example.com/article', order: 2, section: 'Articles' }] }
    expect(observationSchema.safeParse({ ...observation, evidence: reading }).success).toBe(true)
    for (const key of ['documentLinks', 'documentLinksScope', 'documentLinksTruncated']) {
      expect(observationSchema.safeParse({ ...observation, evidence: { ...reading, [key]: undefined } }).success).toBe(false)
    }
    expect(observationSchema.safeParse({ ...observation, evidence: { ...reading,
      documentLinks: [{ ...reading.documentLinks[0], ref: 'e7' }] } }).success).toBe(false)
    expect(observationSchema.safeParse({ ...observation, evidence: { ...reading,
      documentLinks: Array.from({ length: 30 }, (_, order) => ({ ...reading.documentLinks[0], title: '漢字'.repeat(120), order })) } }).success).toBe(false)
  })
  it('keeps viewport metadata optional and includes observed geometry/scope in the page identity', () => {
    const legacy = observationSchema.parse(observation)
    for (const key of ['viewport', 'textScope', 'textTruncated']) expect(legacy).not.toHaveProperty(key)
    const viewport = { width: 800, height: 600, scrollX: 0, scrollY: 300, scrollWidth: 800, scrollHeight: 1800 }
    const current = observationSchema.parse({ ...observation, viewport, textScope: 'viewport', textTruncated: false })
    expect(current).toMatchObject({ viewport, textScope: 'viewport', textTruncated: false })
    expect(browserObservationState(current)).not.toBe(browserObservationState(legacy))
    for (const changed of [{ ...current, viewport: { ...viewport, scrollY: 301 } },
      { ...current, textScope: 'page' as const }, { ...current, textTruncated: true }]) {
      expect(browserObservationState(changed)).not.toBe(browserObservationState(current))
    }
    expect(browserObservationState({ ...current, observedAt: 20, observationId: 21 })).toBe(browserObservationState(current))
  })

  it('rejects nonfinite, negative and malformed viewport geometry without inventing missing dimensions', () => {
    const viewport = { width: 800, height: 600, scrollX: 0, scrollY: 300, scrollWidth: 800, scrollHeight: 1800 }
    for (const key of Object.keys(viewport)) {
      for (const value of [-1, NaN, Infinity, -Infinity, '600', null, undefined]) {
        expect(observationSchema.safeParse({ ...observation, viewport: { ...viewport, [key]: value } }).success,
          `${key} must reject ${String(value)}`).toBe(false)
      }
    }
    expect(observationSchema.safeParse({ ...observation,
      viewport: Object.fromEntries(Object.keys(viewport).map(key => [key, 0])) }).success).toBe(true)
    expect(observationSchema.safeParse({ ...observation, textScope: 'document' }).success).toBe(false)
    expect(observationSchema.safeParse({ ...observation, textTruncated: 'false' }).success).toBe(false)
  })

  it('never uses viewport or truncated text to prove global absence, while preserving positive evidence', () => {
    const absent = task([{ kind: 'heading', value: 'Ada Lovelace' }, { kind: 'text_absent', value: 'Fundraising' }])
    const page = { ...observation, text: 'Ada Lovelace', evidence }
    expect(taskCompleted(absent, page)).toBe(true) // Older bounded-document contract remains compatible.
    expect(taskCompleted(absent, { ...page, textScope: 'page', textTruncated: false })).toBe(true)
    expect(taskCompleted(absent, { ...page, textScope: 'viewport', textTruncated: false })).toBe(false)
    expect(taskCompleted(absent, { ...page, textScope: 'page', textTruncated: true })).toBe(false)
    expect(taskCompleted(absent, { ...page, textTruncated: true })).toBe(false)
    expect(taskCompleted(task([{ kind: 'text', value: 'Ada Lovelace' }]),
      { ...page, textScope: 'viewport', textTruncated: true })).toBe(true)
    // The explicit native dialog inventory has its own completeness semantics.
    expect(taskCompleted(task([{ kind: 'heading', value: 'Ada Lovelace' }, { kind: 'dialog', state: 'absent' }]),
      { ...page, textScope: 'viewport', textTruncated: true })).toBe(true)
  })

  it('preserves explicit control states and leaves older observations unknown', () => {
    const element = { ref: 'e1', role: 'checkbox', name: 'Free cancellation', value: '', canType: false,
      disabled: false, sensitive: false, forbidden: false, context: '', destination: '' }
    const legacy = observationSchema.parse({ ...observation, elements: [element] })
    expect(legacy.elements[0]).not.toHaveProperty('checked')
    expect(legacy.elements[0]).not.toHaveProperty('selected')
    expect(legacy.elements[0]).not.toHaveProperty('expanded')
    for (const checked of ['true', 'false', 'mixed']) {
      const current = observationSchema.parse({ ...observation, elements: [{ ...element, checked, selected: 'false', expanded: 'true' }] })
      expect(current.elements[0]).toMatchObject({ checked, selected: 'false', expanded: 'true' })
      expect(browserObservationState(current)).not.toBe(browserObservationState(legacy))
      expect(browserObservationState(current)).not.toBe(browserObservationState({ ...current,
        elements: [{ ...current.elements[0], expanded: 'false' }] }))
    }
    expect(observationSchema.safeParse({ ...observation, elements: [{ ...element, checked: 'unknown' }] }).success).toBe(false)
    expect(observationSchema.safeParse({ ...observation, elements: [{ ...element, selected: 'mixed' }] }).success).toBe(false)
  })

  it('requires native heading evidence, not a matching title or incidental body text', () => {
    const article = task([{ kind: 'heading', value: 'Ada Lovelace', level: 1 }])
    expect(taskCompleted(article, observation)).toBe(false)
    expect(taskCompleted(article, { ...observation, evidence })).toBe(true)
    expect(taskCompleted(article, { ...observation, evidence: { ...evidence, headings: [{ name: 'Ada Lovelace', level: 2 }] } })).toBe(false)
    expect(taskCompleted(article, { ...observation, evidence: { ...evidence, headings: [{ name: 'Ada Lovelace biography', level: 1 }] } })).toBe(false)
  })

  it('normalizes only heading/name whitespace, preserving exact words and case', () => {
    const article = task([{ kind: 'heading', value: 'Ada  Lovelace' }])
    expect(taskCompleted(article, { ...observation, evidence: { ...evidence, headings: [{ name: ' Ada\nLovelace ', level: null }] } })).toBe(true)
    expect(taskCompleted(article, { ...observation, evidence: { ...evidence, headings: [{ name: 'ADA LOVELACE', level: 1 }] } })).toBe(false)
  })

  it('does not call a replacement dialog successful dismissal', () => {
    const dismissed = task([{ kind: 'heading', value: 'Ada Lovelace' }, { kind: 'dialog', state: 'absent' }])
    expect(taskCompleted(dismissed, { ...observation, evidence })).toBe(true)
    expect(taskCompleted(dismissed, { ...observation, evidence: { ...evidence, dialogs: [{ name: 'Reminder options', visible: true }] } })).toBe(false)
    expect(taskCompleted(dismissed, { ...observation, evidence: { ...evidence, dialogs: [{ name: 'Reminder options', visible: false }] } })).toBe(false)
  })

  it('fails closed on missing or incomplete dialog inventory, independent of body text length', () => {
    const dismissed = task([{ kind: 'heading', value: 'Ada Lovelace' }, { kind: 'dialog', state: 'absent' }])
    expect(taskCompleted(dismissed, observation)).toBe(false)
    expect(taskCompleted(dismissed, { ...observation, evidence: { ...evidence, dialogsComplete: false } })).toBe(false)
    expect(taskCompleted(dismissed, { ...observation, text: 'x'.repeat(12000), evidence })).toBe(true)
    const textAbsent = task([{ kind: 'heading', value: 'Ada Lovelace' }, { kind: 'text_absent', value: 'Close banner' }])
    expect(taskCompleted(textAbsent, { ...observation, text: 'x'.repeat(12000), evidence })).toBe(false)
  })

  it('checks an exact named dialog and requires visibility for positive checks', () => {
    const prompt = task([{ kind: 'dialog', name: 'Reminder options', state: 'visible' }])
    const named = { ...evidence, dialogs: [{ name: 'Reminder\noptions', visible: true }] }
    expect(taskCompleted(prompt, { ...observation, evidence: named })).toBe(true)
    expect(taskCompleted(prompt, { ...observation, evidence: { ...named, dialogs: [{ name: 'Reminder options', visible: false }] } })).toBe(false)
    expect(taskCompleted(task([{ kind: 'heading', value: 'Ada Lovelace' }, { kind: 'dialog', name: 'Fundraising', state: 'absent' }]),
      { ...observation, evidence: named })).toBe(true)
  })

  it('rejects only-absence goals and remains compatible with older native observations', () => {
    expect(browserTaskSchema.safeParse({ goal: 'Dismiss', completion: [{ kind: 'dialog', state: 'absent' }] }).success).toBe(false)
    expect(browserTaskSchema.safeParse({ goal: 'Dismiss', completion: [{ kind: 'dialog', state: 'absent' }, { kind: 'text_absent', value: 'Banner' }] }).success).toBe(false)
    expect(observationSchema.safeParse(observation).success).toBe(true)
    expect(taskCompleted(task([{ kind: 'url', value: observation.url }]), observation)).toBe(true)
    expect(taskCompleted(task([{ kind: 'url', value: observation.url }]), { ...observation, url: observation.url + '?unverified=1' })).toBe(false)
  })
})
