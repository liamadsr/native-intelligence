import { describe, it, expect, vi } from 'vitest'

// The module registers an Inngest function at import time; stub the client so
// importing the pure helpers doesn't construct real infrastructure.
vi.mock('@/lib/inngest/client', () => ({
  inngest: { createFunction: vi.fn(() => ({})) },
}))

import {
  buildSlug,
  assignSlugs,
  buildIndexContent,
  planSegments,
  mergeSegmentPages,
  extractPdfSegment,
  SEGMENT_PDF_PAGES,
} from '../reference-ingest'
import { PDFDocument } from 'pdf-lib'

/**
 * The reference pipeline's correctness hinges on app-side slug assignment
 * (the model never invents slugs, so wikilinks always resolve) and on the
 * deterministic index builder.
 */

describe('buildSlug', () => {
  it('kebab-cases endpoint titles, folding path syntax', () => {
    expect(buildSlug('GET /boutiques/{id}')).toBe('get-boutiques-id')
    expect(buildSlug('Boutique Service API')).toBe('boutique-service-api')
  })

  it('never returns empty', () => {
    expect(buildSlug('???')).toBe('page')
    expect(buildSlug('')).toBe('page')
  })
})

describe('assignSlugs', () => {
  it('prefixes pages with the index slug', () => {
    const { indexSlug, pageSlugs } = assignSlugs(
      'Boutique Service API',
      ['GET /boutiques/{id}', 'Boutique object'],
      new Set(),
    )
    expect(indexSlug).toBe('boutique-service-api')
    expect(pageSlugs).toEqual([
      'boutique-service-api--get-boutiques-id',
      'boutique-service-api--boutique-object',
    ])
  })

  it('suffixes collisions within the batch', () => {
    const { pageSlugs } = assignSlugs(
      'API',
      ['GET /a', 'GET /a'], // identical titles → identical base slugs
      new Set(),
    )
    expect(pageSlugs[0]).not.toBe(pageSlugs[1])
    expect(pageSlugs[1]).toBe(`${pageSlugs[0]}-2`)
  })

  it('avoids slugs already taken in the workspace', () => {
    const { indexSlug } = assignSlugs('Boutique Service API', [], new Set(['boutique-service-api']))
    expect(indexSlug).toBe('boutique-service-api-2')
  })
})

describe('buildIndexContent', () => {
  const pages = [
    { slug: 'api--get-boutiques-id', title: 'GET /boutiques/{id}', kind: 'endpoint' },
    { slug: 'api--boutique-object', title: 'Boutique object', kind: 'object' },
  ]

  it('contains the overview, grouped wikilinks, and provenance note', () => {
    const out = buildIndexContent('REST API for boutiques.', pages, 'boutique-spec.pdf')
    expect(out).toContain('REST API for boutiques.')
    expect(out).toContain('### Endpoints')
    expect(out).toContain('[[api--get-boutiques-id]] — GET /boutiques/{id}')
    expect(out).toContain('### Objects & schemas')
    expect(out).toContain('boutique-spec.pdf')
  })

  it('omits empty groups', () => {
    const out = buildIndexContent('x', pages, 'f.pdf')
    expect(out).not.toContain('### Concepts')
  })
})

/**
 * Segmentation exists because a whole dense PDF in one model call exceeds the
 * 200k context window (a real 4.4MB tech-arch PDF measured 201k tokens).
 * These lock in the page math and the no-silent-truncation merge.
 */
describe('planSegments', () => {
  it('returns a single full-range segment for small documents', () => {
    expect(planSegments(10, 25)).toEqual([{ from: 1, to: 10 }])
  })

  it('splits into inclusive ranges of at most maxPages', () => {
    expect(planSegments(60, 25)).toEqual([
      { from: 1, to: 25 },
      { from: 26, to: 50 },
      { from: 51, to: 60 },
    ])
  })

  it('uses the default segment size', () => {
    const segments = planSegments(SEGMENT_PDF_PAGES + 1)
    expect(segments).toHaveLength(2)
    expect(segments[1]).toEqual({ from: SEGMENT_PDF_PAGES + 1, to: SEGMENT_PDF_PAGES + 1 })
  })

  it('returns no segments for an empty document', () => {
    expect(planSegments(0, 25)).toEqual([])
  })
})

describe('mergeSegmentPages', () => {
  const page = (title: string, markdown: string) => ({
    title,
    kind: 'endpoint' as const,
    markdown,
  })

  it('keeps the longest body when the same title spans two segments', () => {
    const { pages, dropped } = mergeSegmentPages([
      [page('GET /orders', 'short')],
      [page('get /orders ', 'a much longer and more complete body')],
    ])
    expect(pages).toHaveLength(1)
    expect(pages[0].markdown).toContain('more complete')
    expect(dropped).toBe(0)
  })

  it('caps the merged set and reports the number dropped', () => {
    const many = Array.from({ length: 45 }, (_, i) => page(`GET /thing/${i}`, 'body'))
    const { pages, dropped } = mergeSegmentPages([many])
    expect(pages).toHaveLength(40)
    expect(dropped).toBe(5)
  })
})

describe('extractPdfSegment', () => {
  async function makePdf(pages: number): Promise<Buffer> {
    const doc = await PDFDocument.create()
    for (let i = 0; i < pages; i++) doc.addPage()
    return Buffer.from(await doc.save())
  }

  it('copies the requested 1-based inclusive range', async () => {
    const pdf = await makePdf(5)
    const segment = await extractPdfSegment(pdf, 2, 3)
    const loaded = await PDFDocument.load(new Uint8Array(segment))
    expect(loaded.getPageCount()).toBe(2)
  })

  it('returns the original buffer when the range covers the whole document', async () => {
    const pdf = await makePdf(3)
    const segment = await extractPdfSegment(pdf, 1, 3)
    expect(segment).toBe(pdf)
  })

  it('clamps a range that overruns the document end', async () => {
    const pdf = await makePdf(4)
    const segment = await extractPdfSegment(pdf, 3, 9)
    const loaded = await PDFDocument.load(new Uint8Array(segment))
    expect(loaded.getPageCount()).toBe(2)
  })
})
