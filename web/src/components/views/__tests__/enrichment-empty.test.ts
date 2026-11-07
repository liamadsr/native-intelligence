/**
 * `isEmptyEnrichment` — the predicate behind "the search ran and found nothing".
 *
 * The real case that forced it: a group alias (ga-us-nyconf@…onmicrosoft.com)
 * enriched fine, but the extractor — correctly, since there is no person behind
 * that address — wrote no fields at all. The run ends `status: 'enriched'` with
 * two company-level sources and nothing else, and the UI was showing a green
 * "Enriched" pill over an empty result.
 *
 * Two properties matter here:
 *  - It must say "empty" ONLY for a completed run that contributed nothing.
 *    A single applied field, a stray extra field, or a summary all mean the
 *    panel really is showing web-sourced content, and the pill is honest.
 *  - It reads an untyped jsonb blob, so every key can be missing or the wrong
 *    type. It must never throw — the panels have no boundary around it.
 */
import { describe, it, expect } from 'vitest'
import { isEmptyEnrichment, type EnrichmentMetadata } from '@/components/views/enrichment'

/** The production blob from the group-alias contact, minus the noise. */
const EMPTY_RUN: EnrichmentMetadata = {
  version: 1,
  status: 'enriched',
  fields: {},
  applied_fields: [],
  summary: null,
  sources: [
    { url: 'https://www.lpl.com/' },
    { url: 'https://www.lpl.com/news.html' },
  ],
}

/** Cast helper: these cases are deliberately off-contract. */
const malformed = (blob: unknown) => blob as EnrichmentMetadata

describe('isEmptyEnrichment', () => {
  it('is true for a completed run that wrote nothing', () => {
    expect(isEmptyEnrichment(EMPTY_RUN)).toBe(true)
  })

  it('is false when the run applied a column', () => {
    expect(isEmptyEnrichment({ ...EMPTY_RUN, applied_fields: ['title'] })).toBe(false)
  })

  it('is false when the run returned fields it did not apply', () => {
    // Not written to a column (the column was already filled), but still real
    // findings the Enrichment group renders as extras.
    expect(
      isEmptyEnrichment({ ...EMPTY_RUN, fields: { twitter: { value: '@acme' } } }),
    ).toBe(false)
  })

  it('is false when the run produced a summary', () => {
    expect(isEmptyEnrichment({ ...EMPTY_RUN, summary: 'Acme builds widgets.' })).toBe(false)
  })

  it('is false when a contact run wrote a notes summary', () => {
    expect(isEmptyEnrichment({ ...EMPTY_RUN, notes_summary: 'Jane is a CTO.' })).toBe(false)
  })

  it('treats whitespace-only prose as no contribution', () => {
    expect(isEmptyEnrichment({ ...EMPTY_RUN, summary: '   ', notes_summary: '\n' })).toBe(true)
  })

  it('is false for every non-enriched status', () => {
    // Failed, skipped and pending runs have their own UI branches; reporting
    // them as "empty" would route them through the wrong copy.
    for (const status of ['failed', 'skipped', 'pending'] as const) {
      expect(isEmptyEnrichment({ ...EMPTY_RUN, status })).toBe(false)
    }
  })

  it('is false when there is no enrichment blob at all', () => {
    // A row that was never enriched is not an empty RESULT — it has no result.
    expect(isEmptyEnrichment(null)).toBe(false)
    expect(isEmptyEnrichment(undefined)).toBe(false)
  })

  it('tolerates a legacy blob missing every optional key', () => {
    expect(isEmptyEnrichment(malformed({ status: 'enriched' }))).toBe(true)
  })

  it('tolerates wrong types in the jsonb bag without throwing', () => {
    // `fields` as an array or scalar carries no readable field/value pairs, and
    // a non-array `applied_fields` names no columns — both mean "nothing here".
    expect(isEmptyEnrichment(malformed({ status: 'enriched', fields: [] }))).toBe(true)
    expect(isEmptyEnrichment(malformed({ status: 'enriched', fields: 'none' }))).toBe(true)
    expect(isEmptyEnrichment(malformed({ status: 'enriched', fields: null }))).toBe(true)
    expect(isEmptyEnrichment(malformed({ status: 'enriched', applied_fields: 'title' }))).toBe(
      true,
    )
    expect(isEmptyEnrichment(malformed({ status: 'enriched', summary: 42 }))).toBe(true)
    expect(isEmptyEnrichment(malformed({ status: 'enriched', sources: null }))).toBe(true)
  })
})
