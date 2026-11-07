/**
 * The list-card half of the Exa client (spec §7, §12).
 *
 * Everything here is exercised against the REAL recorded responses in
 * `src/lib/prospecting/__tests__/fixtures/exa/` — `{request, status, response}`
 * captured from live Exa — rather than hand-invented shapes, because the whole
 * point of `groundedArray` is that the wire format has a subscript in it that
 * a hand-written fixture would have gotten right by construction.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_OUTPUT_SCHEMA_PROPERTIES,
  type DeepSearchResult,
  buildDeepSearchBody,
  countSchemaProperties,
  countSchemaPropertiesDeep,
  groundedArray,
  parseDeepSearchResponse,
  resultEntities,
} from '../deep-search'
import buyersFixture from '@/lib/prospecting/__tests__/fixtures/exa/discovery-buyers-n25.json'
import investorsFixture from '@/lib/prospecting/__tests__/fixtures/exa/discovery-investors-n15.json'
import peopleFixture from '@/lib/prospecting/__tests__/fixtures/exa/people-quillfort.json'

const buyers: DeepSearchResult = parseDeepSearchResponse(buyersFixture.response)
const investors: DeepSearchResult = parseDeepSearchResponse(investorsFixture.response)
const people: DeepSearchResult = parseDeepSearchResponse(peopleFixture.response)

// ---------------------------------------------------------------------------
// countSchemaPropertiesDeep
// ---------------------------------------------------------------------------

/** The shape Exa answered with HTTP 400 (§12): one array, 12 leaves. */
const TWELVE_LEAF_ARRAY_CARD = {
  type: 'object',
  properties: {
    companies: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          a: { type: 'string' },
          b: { type: 'string' },
          c: { type: 'string' },
          d: { type: 'string' },
          e: { type: 'string' },
          f: { type: 'string' },
          g: { type: 'string' },
          h: { type: 'string' },
          i: { type: 'string' },
          j: { type: 'string' },
          k: { type: 'string' },
          l: { type: 'string' },
        },
      },
    },
  },
  required: [],
} as const

describe('countSchemaPropertiesDeep', () => {
  it('counts the 12-leaf array card as 13 deep where the shallow counter says 1', () => {
    // This IS the measured bug: the shallow number would have waved through a
    // schema Exa rejects with a 400, minutes into an already-billed run.
    expect(countSchemaProperties(TWELVE_LEAF_ARRAY_CARD)).toBe(1)
    expect(countSchemaPropertiesDeep(TWELVE_LEAF_ARRAY_CARD)).toBe(13)
    expect(countSchemaPropertiesDeep(TWELVE_LEAF_ARRAY_CARD)).toBeGreaterThan(
      MAX_OUTPUT_SCHEMA_PROPERTIES,
    )
  })

  it('counts the recorded discovery card as 7 deep (1 array + 6 leaves)', () => {
    const schema = buyersFixture.request.outputSchema
    expect(countSchemaPropertiesDeep(schema)).toBe(7)
    expect(countSchemaProperties(schema)).toBe(1)
  })

  it('counts the recorded people card as 6 deep (1 array + 5 leaves)', () => {
    expect(countSchemaPropertiesDeep(peopleFixture.request.outputSchema)).toBe(6)
  })

  it('agrees with the shallow counter on a flat card', () => {
    const flat = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
    }
    expect(countSchemaProperties(flat)).toBe(2)
    expect(countSchemaPropertiesDeep(flat)).toBe(2)
  })

  it('is 0 for a non-schema', () => {
    expect(countSchemaPropertiesDeep(null)).toBe(0)
    expect(countSchemaPropertiesDeep('nope')).toBe(0)
    expect(countSchemaPropertiesDeep({ type: 'string' })).toBe(0)
  })

  it('walks a tuple `items`', () => {
    const tuple = {
      type: 'object',
      properties: {
        pair: {
          type: 'array',
          items: [
            { type: 'object', properties: { a: { type: 'string' } } },
            { type: 'object', properties: { b: { type: 'string' }, c: { type: 'string' } } },
          ],
        },
      },
    }
    // 1 for `pair` + 1 (a) + 2 (b, c)
    expect(countSchemaPropertiesDeep(tuple)).toBe(4)
  })
})

describe('the cap assertion checks both counters', () => {
  it('rejects an array card the shallow counter would have passed', () => {
    expect(() =>
      buildDeepSearchBody({ query: 'q', outputSchema: TWELVE_LEAF_ARRAY_CARD }),
    ).toThrow(/13 properties/)
  })

  it('still accepts the recorded discovery card', () => {
    expect(() =>
      buildDeepSearchBody({ query: 'q', outputSchema: buyersFixture.request.outputSchema }),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// groundedArray
// ---------------------------------------------------------------------------

describe('groundedArray', () => {
  it('resolves companies[i].<key> to item i, not item 0', () => {
    const items = groundedArray(buyers, 'companies')
    expect(items).toHaveLength(5)
    items.forEach((item, index) => expect(item.index).toBe(index))

    // The regression this function exists for: `fieldKeyFromPath` strips the
    // subscript, so `groundedFields` would give every company item 0's
    // citation. Each item must carry its OWN.
    const urls = items.map((i) => i.fields.one_liner?.source_url)
    expect(new Set(urls).size).toBe(items.length)
    expect(items[0].fields.one_liner?.source_url).toBe('https://tallyhire.com')
    expect(items[4].fields.domain?.value).toBe('rivalscope.co')
    expect(items[4].fields.one_liner?.source_url).not.toBe(
      items[0].fields.one_liner?.source_url,
    )
  })

  it('snake-cases the schema keys, exactly as groundedFields does', () => {
    const [first] = groundedArray(buyers, 'companies')
    expect(Object.keys(first.fields).sort()).toEqual([
      'domain',
      'employee_range',
      'name',
      'one_liner',
      'signal',
      'why_match',
    ])
  })

  it('carries the per-field confidence off the wire, per item', () => {
    // The recorded INVESTOR response is genuinely mixed — 34 high and 8 medium
    // — which is why `fit_confidence` is a column and the rationale gets the
    // muted treatment (§12). A per-item parse must preserve that mix rather
    // than flattening every item to company zero's confidence.
    const items = groundedArray(investors, 'companies')
    const confidences = items.flatMap((i) =>
      Object.values(i.fields).map((f) => f.confidence),
    )
    expect(new Set(confidences)).toEqual(new Set(['high', 'medium']))
    expect(confidences.filter((c) => c === 'medium')).toHaveLength(8)
    // ...and the mix is spread across items, not concentrated in one.
    const mediumItems = items.filter((i) =>
      Object.values(i.fields).some((f) => f.confidence === 'medium'),
    )
    expect(mediumItems.length).toBeGreaterThan(1)
  })

  it('applies isNonAnswer per field, so a placeholder never becomes a value', () => {
    const res: DeepSearchResult = {
      requestId: null,
      content: {
        companies: [
          { name: 'Real Co', signal: 'Not publicly disclosed', domain: 'real.co' },
          { name: 'Other Co', signal: '  ', domain: 'other.co' },
        ],
      },
      grounding: [
        { field: 'companies[0].signal', citations: [{ url: 'https://x', title: null }], confidence: 'high' },
      ],
      results: [],
      costDollars: null,
    }
    const items = groundedArray(res, 'companies')
    expect(items[0].fields.signal).toBeUndefined()
    expect(items[0].fields.name?.value).toBe('Real Co')
    expect(items[1].fields.signal).toBeUndefined()
  })

  it('joins string arrays and drops placeholder members, like groundedFields', () => {
    const res: DeepSearchResult = {
      requestId: null,
      content: { companies: [{ tags: ['saas', 'N/A', ' crm '] }] },
      grounding: [],
      results: [],
      costDollars: null,
    }
    expect(groundedArray(res, 'companies')[0].fields.tags?.value).toBe('saas, crm')
  })

  it('marks an ungrounded field low rather than dropping it', () => {
    const res: DeepSearchResult = {
      requestId: null,
      content: { companies: [{ name: 'Ungrounded Co' }] },
      grounding: [],
      results: [],
      costDollars: null,
    }
    expect(groundedArray(res, 'companies')[0].fields.name).toEqual({
      value: 'Ungrounded Co',
      source_url: null,
      source_title: null,
      confidence: 'low',
    })
  })

  it('returns every item positionally, including one whose fields all dropped', () => {
    const res: DeepSearchResult = {
      requestId: null,
      content: { companies: [{ name: 'A' }, { name: 'n/a' }, { name: 'C' }] },
      grounding: [],
      results: [],
      costDollars: null,
    }
    const items = groundedArray(res, 'companies')
    expect(items.map((i) => i.index)).toEqual([0, 1, 2])
    expect(items[1].fields).toEqual({})
    expect(items[2].fields.name?.value).toBe('C')
  })

  it('ignores grounding for a different array key', () => {
    const res: DeepSearchResult = {
      requestId: null,
      content: { companies: [{ name: 'A' }] },
      grounding: [
        { field: 'people[0].name', citations: [{ url: 'https://x', title: null }], confidence: 'high' },
      ],
      results: [],
      costDollars: null,
    }
    expect(groundedArray(res, 'companies')[0].fields.name?.confidence).toBe('low')
  })

  it('tolerates a leading content. on the grounding path', () => {
    const res: DeepSearchResult = {
      requestId: null,
      content: { companies: [{ name: 'A' }] },
      grounding: [
        {
          field: 'content.companies[0].name',
          citations: [{ url: 'https://x', title: 'X' }],
          confidence: 'high',
        },
      ],
      results: [],
      costDollars: null,
    }
    expect(groundedArray(res, 'companies')[0].fields.name?.confidence).toBe('high')
  })

  it('is empty when there is no such array', () => {
    expect(groundedArray(buyers, 'people')).toEqual([])
    expect(
      groundedArray({ ...buyers, content: null }, 'companies'),
    ).toEqual([])
  })

  it('works on the people fixture too', () => {
    const items = groundedArray(people, 'people')
    expect(items).toHaveLength(7)
    expect(items[6].fields.full_name?.value).toBe('Person Seven')
    expect(items[6].fields.linkedin_url?.source_url).toContain('person-seven')
    expect(items[0].fields.linkedin_url?.source_url).toContain('person-one')
  })
})

// ---------------------------------------------------------------------------
// resultEntities
// ---------------------------------------------------------------------------

describe('resultEntities', () => {
  it('lifts every company entity off the recorded discovery results', () => {
    const entities = resultEntities(buyers)
    expect(entities).toHaveLength(25)
    const first = entities[0]
    expect(first.id).toBe('https://exa.ai/library/organization/gwv39dnyd5q')
    expect(first.name).toBe('Tallyhire')
    expect(first.domain).toBe('tallyhire.com')
    expect(first.foundedYear).toBe(2018)
    expect(first.description).toContain('Tallyhire helps scaling companies')
    expect(first.url).toBe('https://tallyhire.com/')
  })

  it('takes the domain from the result URL host with www stripped', () => {
    const domains = resultEntities(buyers).map((e) => e.domain)
    expect(domains).toContain('linkedin.com')
    expect(domains.every((d) => d === null || !d.startsWith('www.'))).toBe(true)
    // Noise is returned, NOT filtered — the exclusion set is what filters.
    expect(domains.filter((d) => d === 'linkedin.com').length).toBeGreaterThan(1)
  })

  it('returns nothing for people results (type is not company)', () => {
    expect(resultEntities(people)).toEqual([])
  })

  it('is empty when results carry no entities', () => {
    expect(resultEntities({ ...buyers, results: [{ url: 'https://x', title: null, publishedDate: null }] })).toEqual([])
  })
})

describe('parseDeepSearchResponse carries entities additively', () => {
  it('sets entities only where Exa sent them', () => {
    expect(buyers.results[0].entities?.[0]?.type).toBe('company')
    const plain = parseDeepSearchResponse({
      results: [{ url: 'https://x', title: 'X' }],
    })
    expect(plain.results[0]).toEqual({ url: 'https://x', title: 'X', publishedDate: null })
    expect('entities' in plain.results[0]).toBe(false)
  })
})
