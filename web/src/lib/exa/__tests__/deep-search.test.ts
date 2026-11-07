import { describe, it, expect, vi } from 'vitest'
import {
  EXA_SEARCH_URL,
  DEEP_SEARCH_MAX_AGE_HOURS,
  DEEP_SEARCH_NUM_RESULTS,
  DEEP_SEARCH_TIMEOUT_MS,
  COMPANY_CARD_CONTACT,
  COMPANY_CARD_CORE,
  COMPANY_CARD_DETAILS,
  COMPANY_CARD_SCHEMAS,
  companyContactQuery,
  demoteUnrelatedPersonSources,
  normalizeLinkedInProfileUrl,
  MAX_OUTPUT_SCHEMA_PROPERTIES,
  PERSON_CARD_BACKGROUND,
  PERSON_CARD_CORE,
  PERSON_CARD_SCHEMAS,
  countSchemaProperties,
  demoteLookAlikeSources,
  demoteUnrelatedSources,
  isLookAlikeDomain,
  isNonAnswer,
  mergeDeepSearchResults,
  ExaNotConfiguredError,
  ExaRequestError,
  buildDeepSearchBody,
  camelToSnake,
  companyProfileQuery,
  deepSearch,
  fieldKeyFromPath,
  groundedFields,
  parseDeepSearchResponse,
  personAdditionalQueries,
  personProfileQuery,
  sourcesOf,
  type DeepSearchResult,
} from '../deep-search'

/**
 * The request must be Exa's documented deep-search recipe. Drift here silently
 * changes what every enrichment run learns, and the banned filters
 * (startPublishedDate / endPublishedDate / excludeDomains) 400 the whole call
 * on the company and people categories.
 */

/** A JSON-ish Response double: only what `deepSearch` reads off it. */
function fakeResponse(opts: { ok?: boolean; status?: number; json?: unknown; text?: string }) {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => opts.json,
    text: async () => opts.text ?? '',
  } as unknown as Response
}

/** A DeepSearchResult with only the parts a test cares about filled in. */
function result(partial: Partial<DeepSearchResult>): DeepSearchResult {
  return {
    requestId: null,
    content: null,
    grounding: [],
    results: [],
    costDollars: null,
    ...partial,
  }
}

describe('buildDeepSearchBody — Exa recipe', () => {
  it('matches the documented company request shape', () => {
    expect(
      buildDeepSearchBody({
        query: companyProfileQuery('exa.ai'),
        category: 'company',
        outputSchema: COMPANY_CARD_CORE,
      }),
    ).toEqual({
      query: 'Company profile and information for exa.ai',
      type: 'deep',
      numResults: 5,
      category: 'company',
      outputSchema: COMPANY_CARD_CORE,
      contents: { maxAgeHours: 24 },
    })
  })

  it('uses the exported defaults so the constants stay the single source', () => {
    const body = buildDeepSearchBody({ query: 'q', outputSchema: {} })
    expect(body.numResults).toBe(DEEP_SEARCH_NUM_RESULTS)
    expect(body.contents).toEqual({ maxAgeHours: DEEP_SEARCH_MAX_AGE_HOURS })
    expect(DEEP_SEARCH_TIMEOUT_MS).toBe(60_000)
  })

  it('does not send filters the company/people categories reject', () => {
    const body = buildDeepSearchBody({
      query: 'q',
      category: 'people',
      outputSchema: PERSON_CARD_CORE,
      additionalQueries: ['a'],
    })
    for (const banned of ['startPublishedDate', 'endPublishedDate', 'excludeDomains']) {
      expect(body).not.toHaveProperty(banned)
    }
  })

  it('sends includeDomains when given, and omits it otherwise', () => {
    // Exa DOES accept includeDomains on the company category — unlike
    // excludeDomains and the date filters, which 400.
    expect(
      buildDeepSearchBody({
        query: 'q',
        category: 'company',
        outputSchema: {},
        includeDomains: ['dial8.ai'],
      }).includeDomains,
    ).toEqual(['dial8.ai'])
    expect(buildDeepSearchBody({ query: 'q', outputSchema: {} })).not.toHaveProperty(
      'includeDomains',
    )
    expect(
      buildDeepSearchBody({ query: 'q', outputSchema: {}, includeDomains: [] }),
    ).not.toHaveProperty('includeDomains')
  })

  it('includes additionalQueries only when there are some', () => {
    expect(buildDeepSearchBody({ query: 'q', outputSchema: {} })).not.toHaveProperty(
      'additionalQueries',
    )
    expect(buildDeepSearchBody({ query: 'q', outputSchema: {}, additionalQueries: [] })).not.toHaveProperty(
      'additionalQueries',
    )
    expect(
      buildDeepSearchBody({ query: 'q', outputSchema: {}, additionalQueries: ['x', 'y'] })
        .additionalQueries,
    ).toEqual(['x', 'y'])
  })

  it('honours per-call overrides', () => {
    const body = buildDeepSearchBody({
      query: 'q',
      outputSchema: {},
      numResults: 2,
      maxAgeHours: 168,
    })
    expect(body.numResults).toBe(2)
    expect(body.contents).toEqual({ maxAgeHours: 168 })
  })
})

describe('schemas — the 10-property cap', () => {
  /*
   * The live 400 this split exists to prevent:
   *   Validation error: Output_schema exceeds maximum of 10 properties
   * A single 24-property company schema died on DEV, and nesting does not
   * help — the count is recursive. Every card must fit on its own.
   */
  it.each([
    ['COMPANY_CARD_CORE', COMPANY_CARD_CORE],
    ['COMPANY_CARD_DETAILS', COMPANY_CARD_DETAILS],
    ['COMPANY_CARD_CONTACT', COMPANY_CARD_CONTACT],
    ['PERSON_CARD_CORE', PERSON_CARD_CORE],
    ['PERSON_CARD_BACKGROUND', PERSON_CARD_BACKGROUND],
  ])('%s fits inside the cap', (_name, schema) => {
    expect(countSchemaProperties(schema)).toBeLessThanOrEqual(MAX_OUTPUT_SCHEMA_PROPERTIES)
  })

  it('keeps Exa’s seven recipe fields first, in order, on the company CORE card', () => {
    expect(Object.keys(COMPANY_CARD_CORE.properties)).toEqual([
      'industry',
      'annualRevenue',
      'employeeCount',
      'ownership',
      'latestFunding',
      'description',
      'recentNews',
      'companyName',
      'website',
      'linkedinUrl',
    ])
    expect(COMPANY_CARD_CORE.required).toEqual(['industry', 'description'])
  })

  it('carries the column-less firmographics on the company DETAILS card', () => {
    expect(Object.keys(COMPANY_CARD_DETAILS.properties)).toEqual([
      'fundingStage',
      'totalFundingRaised',
      'investors',
      'foundedYear',
      'companyStage',
      'keyPeople',
      'productsAndServices',
      'headquartersCity',
      'headquartersState',
      'headquartersCountry',
    ])
    // A thin answer here is normal and must not fail the card.
    expect(COMPANY_CARD_DETAILS.required).toEqual([])
  })

  it('carries how-to-reach-them on the company CONTACT card, nothing required', () => {
    expect(Object.keys(COMPANY_CARD_CONTACT.properties)).toEqual([
      'contactEmail',
      'phone',
      'streetAddress',
      'contactPage',
    ])
    // Most small companies publish an email and nothing else.
    expect(COMPANY_CARD_CONTACT.required).toEqual([])
    expect(companyContactQuery(' Acme ', 'acme.com')).toBe(
      'Contact information for Acme (acme.com): contact email address, phone number, street address, contact page',
    )
  })

  it('splits the person card into columns-and-bio, then history', () => {
    expect(Object.keys(PERSON_CARD_CORE.properties)).toEqual([
      'fullName',
      'jobTitle',
      'department',
      'seniority',
      'companyName',
      'companyDomain',
      'location',
      'linkedinUrl',
      'summary',
      'notableWork',
    ])
    expect(PERSON_CARD_CORE.required).toEqual(['fullName'])
    expect(Object.keys(PERSON_CARD_BACKGROUND.properties)).toEqual([
      'previousRoles',
      'education',
      'expertise',
      'twitterUrl',
      'githubUrl',
    ])
    expect(PERSON_CARD_BACKGROUND.required).toEqual([])
  })

  it('drops the fields the company cards no longer ask for', () => {
    const keys = [
      ...Object.keys(COMPANY_CARD_CORE.properties),
      ...Object.keys(COMPANY_CARD_DETAILS.properties),
    ]
    // summary → the blob falls back to description; the other two were cut to
    // make room under the cap.
    for (const dropped of ['summary', 'targetCustomers', 'twitterUrl']) {
      expect(keys).not.toContain(dropped)
    }
  })

  it('names no field twice across an entity’s cards, so a merge can never fight itself', () => {
    for (const cards of [COMPANY_CARD_SCHEMAS, PERSON_CARD_SCHEMAS]) {
      const keys = cards.flatMap((c) => Object.keys(c.properties))
      expect(new Set(keys).size).toBe(keys.length)
    }
  })

  it('exposes three company cards (core, details, contact) and two person cards', () => {
    expect(COMPANY_CARD_SCHEMAS).toHaveLength(3)
    expect(COMPANY_CARD_SCHEMAS[2]).toBe(COMPANY_CARD_CONTACT)
    expect(PERSON_CARD_SCHEMAS).toHaveLength(2)
  })

  it('describes every property so Exa’s synthesizer knows what to fill', () => {
    for (const schema of [...COMPANY_CARD_SCHEMAS, ...PERSON_CARD_SCHEMAS]) {
      for (const [key, prop] of Object.entries(schema.properties)) {
        expect((prop as { type: string }).type, key).toBe('string')
        expect((prop as { description?: string }).description, key).toBeTruthy()
      }
    }
  })
})

describe('countSchemaProperties', () => {
  it('counts a flat schema', () => {
    expect(countSchemaProperties({ type: 'object', properties: { a: {}, b: {} } })).toBe(2)
  })

  // The trap this guard exists for: nesting does NOT buy headroom. Exa counts
  // an object property as itself PLUS everything inside it.
  it('counts nested object properties too', () => {
    expect(
      countSchemaProperties({
        type: 'object',
        properties: {
          a: {},
          details: { type: 'object', properties: { x: {}, y: {}, z: {} } },
        },
      }),
    ).toBe(5)
  })

  it('is 0 for a schema with no properties at all', () => {
    expect(countSchemaProperties({ type: 'object' })).toBe(0)
    expect(countSchemaProperties(null)).toBe(0)
    expect(countSchemaProperties('nope')).toBe(0)
  })
})

describe('the schema cap is enforced before any fetch', () => {
  const oversized = {
    type: 'object',
    properties: Object.fromEntries(
      Array.from({ length: 11 }, (_, i) => [`f${i}`, { type: 'string' }]),
    ),
  }

  it('buildDeepSearchBody refuses an oversized schema', () => {
    expect(() => buildDeepSearchBody({ query: 'q', outputSchema: oversized })).toThrow(
      /11 properties, exceeding the maximum of 10/,
    )
  })

  it('refuses a schema that hides its bulk in a nested object', () => {
    const nested = {
      type: 'object',
      properties: {
        details: {
          type: 'object',
          properties: Object.fromEntries(
            Array.from({ length: 10 }, (_, i) => [`f${i}`, { type: 'string' }]),
          ),
        },
      },
    }
    expect(() => buildDeepSearchBody({ query: 'q', outputSchema: nested })).toThrow(/11 properties/)
  })

  it('deepSearch throws WITHOUT fetching — a bad schema is our bug, not a retryable upstream one', async () => {
    const fetchImpl = vi.fn()
    await expect(
      deepSearch({
        query: 'q',
        outputSchema: oversized,
        apiKey: 'k',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/exceeding the maximum/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('lets a schema sitting exactly on the cap through', () => {
    const exact = {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [`f${i}`, { type: 'string' }]),
      ),
    }
    expect(() => buildDeepSearchBody({ query: 'q', outputSchema: exact })).not.toThrow()
  })
})

describe('mergeDeepSearchResults', () => {
  it('shallow-merges content, first non-empty winning', () => {
    const merged = mergeDeepSearchResults([
      result({ content: { industry: 'Search', description: '' } }),
      result({ content: { industry: 'Something else', description: 'Builds things.', investors: 'a16z' } }),
    ])
    // The CORE card's industry stands…
    expect(merged.content?.industry).toBe('Search')
    // …but a field the first card left blank is still fillable.
    expect(merged.content?.description).toBe('Builds things.')
    expect(merged.content?.investors).toBe('a16z')
  })

  it('concatenates grounding in card order', () => {
    const merged = mergeDeepSearchResults([
      result({ grounding: [{ field: 'industry', citations: [], confidence: 'high' }] }),
      result({ grounding: [{ field: 'investors', citations: [], confidence: 'low' }] }),
    ])
    expect(merged.grounding.map((g) => g.field)).toEqual(['industry', 'investors'])
  })

  it('de-duplicates results by url, keeping first position', () => {
    const merged = mergeDeepSearchResults([
      result({ results: [{ url: 'https://a', title: 'A', publishedDate: null }] }),
      result({
        results: [
          { url: 'https://a', title: 'A dup', publishedDate: null },
          { url: 'https://b', title: 'B', publishedDate: null },
        ],
      }),
    ])
    expect(merged.results).toEqual([
      { url: 'https://a', title: 'A', publishedDate: null },
      { url: 'https://b', title: 'B', publishedDate: null },
    ])
  })

  it('sums cost across the cards, so the blob records the real entity spend', () => {
    expect(
      mergeDeepSearchResults([result({ costDollars: 0.01 }), result({ costDollars: 0.02 })])
        .costDollars,
    ).toBeCloseTo(0.03)
  })

  it('sums the cards that reported a cost and ignores the ones that did not', () => {
    expect(
      mergeDeepSearchResults([result({ costDollars: null }), result({ costDollars: 0.02 })])
        .costDollars,
    ).toBeCloseTo(0.02)
  })

  it('is null only when NO card reported a cost', () => {
    expect(
      mergeDeepSearchResults([result({ costDollars: null }), result({ costDollars: null })])
        .costDollars,
    ).toBeNull()
  })

  it('takes the first non-null requestId', () => {
    expect(
      mergeDeepSearchResults([result({ requestId: null }), result({ requestId: 'req_2' })]).requestId,
    ).toBe('req_2')
  })

  it('keeps content null when no card returned one — a total miss stays a miss', () => {
    expect(mergeDeepSearchResults([result({}), result({})]).content).toBeNull()
  })

  it('returns an empty content object when a card answered with one', () => {
    expect(mergeDeepSearchResults([result({ content: {} }), result({})]).content).toEqual({})
  })

  it('handles an empty list', () => {
    expect(mergeDeepSearchResults([])).toEqual({
      requestId: null,
      content: null,
      grounding: [],
      results: [],
      costDollars: null,
    })
  })

  it('feeds groundedFields exactly as a single-card result would', () => {
    const merged = mergeDeepSearchResults([
      result({
        content: { industry: 'Search' },
        grounding: [{ field: 'industry', citations: [{ url: 'https://a', title: 'A' }], confidence: 'high' }],
      }),
      result({
        content: { investors: 'a16z' },
        grounding: [{ field: 'investors', citations: [{ url: 'https://b', title: 'B' }], confidence: 'medium' }],
      }),
    ])
    expect(groundedFields(merged)).toEqual({
      industry: { value: 'Search', source_url: 'https://a', source_title: 'A', confidence: 'high' },
      investors: { value: 'a16z', source_url: 'https://b', source_title: 'B', confidence: 'medium' },
    })
  })
})

describe('deepSearch — transport', () => {
  it('throws ExaNotConfiguredError WITHOUT fetching when the key is missing', async () => {
    const fetchImpl = vi.fn()
    vi.stubEnv('EXA_API_KEY', '')
    await expect(
      deepSearch({ query: 'q', outputSchema: {}, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(ExaNotConfiguredError)
    expect(fetchImpl).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })

  it('sends the key as x-api-key and posts JSON to the search URL', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ json: { output: { content: {} } } }))
    await deepSearch({
      query: 'Company profile and information for exa.ai',
      category: 'company',
      outputSchema: COMPANY_CARD_CORE,
      apiKey: 'test-key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(EXA_SEARCH_URL)
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'content-type': 'application/json', 'x-api-key': 'test-key' })
    expect(JSON.parse(init.body as string)).toEqual(
      buildDeepSearchBody({
        query: 'Company profile and information for exa.ai',
        category: 'company',
        outputSchema: COMPANY_CARD_CORE,
      }),
    )
  })

  it('passes the abort signal straight through', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn(async () => fakeResponse({ json: {} }))
    await deepSearch({
      query: 'q',
      outputSchema: {},
      apiKey: 'k',
      signal: controller.signal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })

  it('raises ExaRequestError carrying the status and a bounded body excerpt', async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({ ok: false, status: 400, text: 'x'.repeat(600) }),
    )
    const err = await deepSearch({
      query: 'q',
      outputSchema: {},
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e) => e)

    expect(err).toBeInstanceOf(ExaRequestError)
    expect((err as ExaRequestError).status).toBe(400)
    expect((err as Error).message).toContain('400')
    // 300-char excerpt + the prefix, never the whole 600-char body.
    expect((err as Error).message.length).toBeLessThan(360)
  })

  it('falls back to process.env.EXA_API_KEY', async () => {
    vi.stubEnv('EXA_API_KEY', 'env-key')
    const fetchImpl = vi.fn(async () => fakeResponse({ json: {} }))
    await deepSearch({ query: 'q', outputSchema: {}, fetchImpl: fetchImpl as unknown as typeof fetch })
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('env-key')
    vi.unstubAllEnvs()
  })
})

describe('parseDeepSearchResponse', () => {
  it('maps content, grounding, results and cost', () => {
    const res = parseDeepSearchResponse({
      requestId: 'req_1',
      output: {
        content: { industry: 'Search' },
        grounding: [
          {
            field: 'content.industry',
            citations: [{ url: 'https://a', title: 'A' }],
            confidence: 'high',
          },
        ],
      },
      results: [{ url: 'https://b', title: 'B', publishedDate: '2026-01-01' }],
      costDollars: { total: 0.05 },
    })

    expect(res.requestId).toBe('req_1')
    expect(res.content).toEqual({ industry: 'Search' })
    expect(res.grounding).toEqual([
      { field: 'content.industry', citations: [{ url: 'https://a', title: 'A' }], confidence: 'high' },
    ])
    expect(res.results).toEqual([{ url: 'https://b', title: 'B', publishedDate: '2026-01-01' }])
    expect(res.costDollars).toBe(0.05)
  })

  it('reads an empty answer as empty rather than throwing', () => {
    const res = parseDeepSearchResponse({})
    expect(res).toEqual({
      requestId: null,
      content: null,
      grounding: [],
      results: [],
      costDollars: null,
    })
  })

  it('defaults an unrecognized grounding confidence to low', () => {
    const res = parseDeepSearchResponse({
      output: { content: {}, grounding: [{ field: 'industry', citations: [], confidence: 'sure' }] },
    })
    expect(res.grounding[0].confidence).toBe('low')
  })

  it('throws on a non-object body', () => {
    expect(() => parseDeepSearchResponse('nope')).toThrow(ExaRequestError)
  })
})

describe('fieldKeyFromPath / camelToSnake', () => {
  it('resolves bare, dotted and indexed grounding paths on the last segment', () => {
    expect(fieldKeyFromPath('industry')).toBe('industry')
    expect(fieldKeyFromPath('content.industry')).toBe('industry')
    expect(fieldKeyFromPath('companies[0].employeeCount')).toBe('employeeCount')
    expect(fieldKeyFromPath('content.items[12]')).toBe('items')
  })

  it('snake-cases camelCase keys', () => {
    expect(camelToSnake('employeeCount')).toBe('employee_count')
    expect(camelToSnake('headquartersCity')).toBe('headquarters_city')
    expect(camelToSnake('linkedinUrl')).toBe('linkedin_url')
    expect(camelToSnake('industry')).toBe('industry')
  })
})

describe('groundedFields', () => {
  it('flattens content to snake_case triples with the first citation URL', () => {
    const fields = groundedFields(
      result({
        content: { industry: 'Search', employeeCount: '51-200' },
        grounding: [
          {
            field: 'industry',
            citations: [{ url: 'https://a', title: 'A' }, { url: 'https://b', title: null }],
            confidence: 'high',
          },
          { field: 'content.employeeCount', citations: [{ url: 'https://c', title: null }], confidence: 'medium' },
        ],
      }),
    )
    expect(fields).toEqual({
      industry: { value: 'Search', source_url: 'https://a', source_title: 'A', confidence: 'high' },
      employee_count: { value: '51-200', source_url: 'https://c', source_title: null, confidence: 'medium' },
    })
  })

  it('omits absent and blank values entirely', () => {
    const fields = groundedFields(
      result({ content: { industry: 'Search', description: '   ', ownership: null, recentNews: '' } }),
    )
    expect(Object.keys(fields)).toEqual(['industry'])
  })

  it('joins an array of strings and drops an empty one', () => {
    const fields = groundedFields(
      result({ content: { investors: ['Sequoia', ' a16z '], keyPeople: [], targetCustomers: [''] } }),
    )
    expect(fields.investors.value).toBe('Sequoia, a16z')
    expect(fields).not.toHaveProperty('key_people')
    expect(fields).not.toHaveProperty('target_customers')
  })

  it('stringifies a finite number', () => {
    expect(groundedFields(result({ content: { foundedYear: 2019 } })).founded_year.value).toBe('2019')
  })

  it('marks an ungrounded field low with a null source URL', () => {
    const fields = groundedFields(result({ content: { industry: 'Search' } }))
    expect(fields.industry).toEqual({
      value: 'Search',
      source_url: null,
      source_title: null,
      confidence: 'low',
    })
  })

  it('applies an explicit key map over camelToSnake', () => {
    const fields = groundedFields(result({ content: { annualRevenue: '$10M' } }), {
      annualRevenue: 'annual_revenue_range',
    })
    expect(Object.keys(fields)).toEqual(['annual_revenue_range'])
  })

  it('returns nothing when Exa synthesized no content', () => {
    expect(groundedFields(result({ content: null }))).toEqual({})
  })
})

describe('isNonAnswer', () => {
  /*
   * The live DEV bug: Exa answers an optional field it could not find with a
   * PLACEHOLDER at medium confidence, and `annual_revenue_range` was written
   * with the literal string "Not publicly disclosed".
   */
  it.each([
    'Not publicly disclosed',
    'None found',
    'Nothing found',
    'No profile found',
    'No public LinkedIn profile',
    'No website available',
    'Not applicable (venue/space).',
    'Not explicitly disclosed',
    'Not currently disclosed',
    'Not available',
    'Not known',
    'Not found',
    'Not listed',
    'Not provided',
    'Not specified',
    'Not stated',
    'Not applicable',
    'N/A',
    'n/a',
    'NA',
    'None',
    'null',
    'Unknown',
    'Undisclosed',
    'Unavailable',
    'No information',
    'No public information available',
    'No data available',
    'No details',
    'Information not available',
    '—',
    '-',
  ])('drops the placeholder %j', (value) => {
    expect(isNonAnswer(value)).toBe(true)
  })

  it('tolerates trailing punctuation and a parenthetical', () => {
    expect(isNonAnswer('Not publicly disclosed.')).toBe(true)
    expect(isNonAnswer('Not publicly disclosed (as of 2026)')).toBe(true)
    expect(isNonAnswer('  NOT AVAILABLE  ')).toBe(true)
  })

  it('treats blank and whitespace as an absence', () => {
    expect(isNonAnswer('')).toBe(true)
    expect(isNonAnswer('   ')).toBe(true)
  })

  /*
   * The anchoring that matters: a placeholder is the WHOLE value. These are
   * real answers that merely START with a placeholder-ish word, and dropping
   * any of them would silently lose a fact.
   */
  it.each([
    'Not-for-profit organization',
    'Nonprofit',
    'Unknown Worlds Entertainment',
    'None Of The Above Records',
    'No Man’s Sky studio',
    'not disclosed publicly in filings but estimated at $4M',
    'Series B',
    '$10M-$50M',
    '51-200',
    'Nashville, TN',
  ])('keeps the real value %j', (value) => {
    expect(isNonAnswer(value)).toBe(false)
  })

  it('keeps placeholders out of columns AND out of the blob', () => {
    const fields = groundedFields(
      result({
        content: { annualRevenue: 'Not publicly disclosed', industry: 'Fintech' },
        grounding: [
          { field: 'annualRevenue', citations: [], confidence: 'medium' },
          { field: 'industry', citations: [], confidence: 'high' },
        ],
      }),
    )
    // Medium confidence would otherwise have filled the column.
    expect(fields).not.toHaveProperty('annual_revenue')
    expect(Object.keys(fields)).toEqual(['industry'])
  })

  it('strips placeholder members out of an array before joining', () => {
    const fields = groundedFields(result({ content: { investors: ['Sequoia', 'N/A', 'a16z'] } }))
    expect(fields.investors.value).toBe('Sequoia, a16z')
  })

  it('drops an array that is nothing but placeholders', () => {
    expect(groundedFields(result({ content: { investors: ['N/A', 'Unknown'] } }))).toEqual({})
  })
})

describe('isLookAlikeDomain', () => {
  /*
   * Observed on the live dial8.ai run: Exa's neural search cited five
   * similarly-named companies, and reported products_and_services as "AI DIAL
   * platform, DIALZY XL…" at HIGH confidence citing dialzy.ai — a different
   * company entirely.
   */
  it.each([
    'https://dialzy.ai/products',
    'https://dialova.ca',
    'https://dialbyte.ai/about',
    'https://dialuno.ai',
    'https://www.dialwisp.ai/pricing',
  ])('flags the look-alike %s against dial8.ai', (url) => {
    expect(isLookAlikeDomain(url, 'dial8.ai')).toBe(true)
  })

  it('never flags the company’s OWN site', () => {
    expect(isLookAlikeDomain('https://dial8.ai/about', 'dial8.ai')).toBe(false)
    expect(isLookAlikeDomain('https://www.dial8.ai', 'dial8.ai')).toBe(false)
    // A different TLD on the same label is still the same company name.
    expect(isLookAlikeDomain('https://dial8.com', 'dial8.ai')).toBe(false)
  })

  it('leaves unrelated aggregators and press alone', () => {
    for (const url of [
      'https://www.crunchbase.com/organization/dial8',
      'https://linkedin.com/company/dial8',
      'https://techcrunch.com/2026/01/01/dial8',
      'https://github.com/dial8',
    ]) {
      expect(isLookAlikeDomain(url, 'dial8.ai'), url).toBe(false)
    }
  })

  it('needs a real shared prefix, not a coincidental letter or two', () => {
    // 'data' vs 'dial8' share only 'd'+'a'... — 2 chars, under the bar.
    expect(isLookAlikeDomain('https://databricks.com', 'dial8.ai')).toBe(false)
    // A prefix relationship counts however short: 'dial' is inside 'dial8'.
    expect(isLookAlikeDomain('https://dial.com', 'dial8.ai')).toBe(true)
  })

  it('is false when either side is unusable', () => {
    expect(isLookAlikeDomain('', 'dial8.ai')).toBe(false)
    expect(isLookAlikeDomain('https://dialzy.ai', '')).toBe(false)
  })
})

describe('demoteUnrelatedSources', () => {
  const f = (
    value: string,
    source_url: string | null,
    source_title: string | null = null,
  ) => ({ value, source_url, source_title, confidence: 'high' as const })

  const identity = { domain: 'dial8.ai', name: 'Dial8' }

  it('keeps a field cited to the company’s own domain', () => {
    const out = demoteUnrelatedSources({ industry: f('AI', 'https://dial8.ai/about') }, identity)
    expect(out.industry.confidence).toBe('high')
  })

  it('keeps a field cited to a SUBdomain of the company', () => {
    const out = demoteUnrelatedSources({ industry: f('AI', 'https://blog.dial8.ai/p/1') }, identity)
    expect(out.industry.confidence).toBe('high')
  })

  it('keeps an aggregator whose TITLE carries the company name', () => {
    const out = demoteUnrelatedSources(
      {
        industry: f(
          'AI',
          'https://www.crunchbase.com/organization/dial8',
          'Dial8 - Crunchbase Company Profile',
        ),
      },
      identity,
    )
    expect(out.industry.confidence).toBe('high')
  })

  /*
   * The cocktail bar: a confident, well-cited field about an entirely
   * different business. Neither the host nor the title mentions Dial8.
   */
  it('demotes the cocktail bar', () => {
    const out = demoteUnrelatedSources(
      {
        industry: f('Hospitality', 'https://hotelvarenne.com/dial8', 'Hotel Varenne'),
        description: f(
          'dial8 is a cocktail bar at Number Nine, Hotel Varenne.',
          'https://hotelvarenne.com/dial8',
          'Hotel Varenne',
        ),
      },
      identity,
    )
    expect(out.industry.confidence).toBe('low')
    expect(out.description.confidence).toBe('low')
  })

  it('demotes a look-alike company’s page', () => {
    const out = demoteUnrelatedSources(
      { products_and_services: f('Dialzy Studio', 'https://dialzy.ai', 'DIALZY') },
      identity,
    )
    expect(out.products_and_services.confidence).toBe('low')
  })

  it('demotes an ungrounded field — nothing proves it is about this company', () => {
    expect(demoteUnrelatedSources({ industry: f('AI', null) }, identity).industry.confidence).toBe(
      'low',
    )
  })

  it('matches the name ignoring case and punctuation', () => {
    const out = demoteUnrelatedSources(
      { industry: f('AI', 'https://news.example.com/x', 'DIAL8, INC. raises a round') },
      { domain: 'dial8.ai', name: 'Dial8 Inc' },
    )
    expect(out.industry.confidence).toBe('high')
  })

  it('ignores a name too short to match safely', () => {
    // A 2-char name would match inside half the titles on the web, so the
    // title route is disabled and only the domain anchors.
    const out = demoteUnrelatedSources(
      { industry: f('AI', 'https://example.com', 'Hi there') },
      { domain: 'dial8.ai', name: 'Hi' },
    )
    expect(out.industry.confidence).toBe('low')
  })

  it('is a no-op when there is no identity to anchor against', () => {
    const fields = { industry: f('AI', 'https://anywhere.com') }
    expect(demoteUnrelatedSources(fields, { domain: null, name: null })).toBe(fields)
  })

  it('does not mutate the input', () => {
    const fields = { a: f('x', 'https://hotelvarenne.com') }
    demoteUnrelatedSources(fields, identity)
    expect(fields.a.confidence).toBe('high')
  })
})

describe('demoteLookAlikeSources', () => {
  const hi = (value: string, source_url: string | null, source_title: string | null = null) =>
    ({ value, source_url, source_title, confidence: 'high' as const })

  it('forces a look-alike-cited field down to low', () => {
    const out = demoteLookAlikeSources(
      {
        products_and_services: hi('Dialzy Studio, DIALZY XL', 'https://dialzy.ai/products'),
        industry: hi('AI meeting capture', 'https://dial8.ai'),
      },
      'dial8.ai',
    )
    // Demoted, NOT dropped — a human can still see it and where it came from.
    expect(out.products_and_services).toEqual({
      value: 'Dialzy Studio, DIALZY XL',
      source_url: 'https://dialzy.ai/products',
      source_title: null,
      confidence: 'low',
    })
    // The company's own site is untouched.
    expect(out.industry.confidence).toBe('high')
  })

  it('leaves a Crunchbase citation untouched', () => {
    const out = demoteLookAlikeSources(
      { industry: hi('Fintech', 'https://www.crunchbase.com/organization/dial8') },
      'dial8.ai',
    )
    expect(out.industry.confidence).toBe('high')
  })

  it('leaves an ungrounded field alone — there is no domain to judge', () => {
    const out = demoteLookAlikeSources({ industry: hi('Fintech', null) }, 'dial8.ai')
    expect(out.industry.confidence).toBe('high')
  })

  it('is a no-op without a company domain', () => {
    const fields = { industry: hi('Fintech', 'https://dialzy.ai') }
    expect(demoteLookAlikeSources(fields, null)).toBe(fields)
    expect(demoteLookAlikeSources(fields, '  ')).toBe(fields)
  })

  it('does not mutate the input', () => {
    const fields = { a: hi('x', 'https://dialzy.ai') }
    demoteLookAlikeSources(fields, 'dial8.ai')
    expect(fields.a.confidence).toBe('high')
  })
})

describe('sourcesOf', () => {
  it('lists grounding citations first, then uncited results, de-duplicated', () => {
    expect(
      sourcesOf(
        result({
          grounding: [
            { field: 'industry', citations: [{ url: 'https://a', title: 'A' }], confidence: 'high' },
            { field: 'description', citations: [{ url: 'https://a', title: 'A again' }], confidence: 'low' },
          ],
          results: [
            { url: 'https://a', title: 'A result', publishedDate: '2026-01-01' },
            { url: 'https://z', title: 'Z', publishedDate: null },
          ],
        }),
      ),
    ).toEqual([
      { url: 'https://a', title: 'A', published_date: '2026-01-01' },
      { url: 'https://z', title: 'Z', published_date: null },
    ])
  })

  it('backfills a title a citation was missing from the bare result', () => {
    expect(
      sourcesOf(
        result({
          grounding: [{ field: 'industry', citations: [{ url: 'https://a', title: null }], confidence: 'high' }],
          results: [{ url: 'https://a', title: 'Real title', publishedDate: null }],
        }),
      ),
    ).toEqual([{ url: 'https://a', title: 'Real title', published_date: null }])
  })
})

describe('query templates', () => {
  it('uses Exa’s company template', () => {
    expect(companyProfileQuery('  Acme Inc ')).toBe('Company profile and information for Acme Inc')
  })

  it('folds every known person fact into the query', () => {
    expect(
      personProfileQuery({ name: 'Jane Doe', jobTitle: 'CTO', company: 'Acme', domain: 'acme.com' }),
    ).toBe('Professional profile for Jane Doe, CTO at Acme (acme.com) — current role, employer, background')
  })

  it('omits the parts it does not know', () => {
    expect(personProfileQuery({ name: 'Jane Doe' })).toBe(
      'Professional profile for Jane Doe — current role, employer, background',
    )
    expect(personProfileQuery({ name: 'Jane Doe', company: 'Acme' })).toBe(
      'Professional profile for Jane Doe, at Acme — current role, employer, background',
    )
  })

  it('builds up to three quoted variations, only from real disambiguators', () => {
    expect(
      personAdditionalQueries({ name: 'Jane Doe', domain: 'acme.com', company: 'Acme', jobTitle: 'CTO' }),
    ).toEqual(['"Jane Doe" acme.com', '"Jane Doe" linkedin Acme', '"Jane Doe" CTO'])
  })

  it('produces no variations for a bare name — that would widen the namesake problem', () => {
    expect(personAdditionalQueries({ name: 'Jane Doe' })).toEqual([])
    expect(personAdditionalQueries({ name: '' })).toEqual([])
  })
})


describe('normalizeLinkedInProfileUrl', () => {
  it('canonicalises a personal profile URL', () => {
    expect(normalizeLinkedInProfileUrl('https://www.linkedin.com/in/JustDevin/?trk=x')).toBe('linkedin.com/in/justdevin')
    expect(normalizeLinkedInProfileUrl('linkedin.com/in/devin-marsh-4c7e2d10')).toBe('linkedin.com/in/devin-marsh-4c7e2d10')
    expect(normalizeLinkedInProfileUrl('https://uk.linkedin.com/in/someone')).toBe('linkedin.com/in/someone')
  })

  it('does not throw on a malformed percent-escape in the slug', () => {
    expect(normalizeLinkedInProfileUrl('https://www.linkedin.com/in/John-Doe%')).toBe('linkedin.com/in/john-doe%')
  })

  it('is null for anything that is not a personal profile', () => {
    expect(normalizeLinkedInProfileUrl('https://www.linkedin.com/company/fieldwingag')).toBeNull()
    expect(normalizeLinkedInProfileUrl('https://lnkd.in/xQ7kV2pL')).toBeNull()
    expect(normalizeLinkedInProfileUrl('https://fieldwing.ag/company/')).toBeNull()
    expect(normalizeLinkedInProfileUrl('not a url')).toBeNull()
    expect(normalizeLinkedInProfileUrl(null)).toBeNull()
  })
})

describe('personProfileQuery with a known LinkedIn URL', () => {
  it('quotes the profile path so the synthesizer knows which namesake', () => {
    expect(
      personProfileQuery({ name: 'Devin Marsh', jobTitle: 'CEO', company: 'Fieldwing', domain: 'fieldwing.ag', linkedinUrl: 'https://www.linkedin.com/in/justdevin/' }),
    ).toBe('Professional profile for Devin Marsh, CEO at Fieldwing (fieldwing.ag) — LinkedIn: linkedin.com/in/justdevin — current role, employer, background')
  })

  it('ignores a short link it cannot canonicalise', () => {
    expect(personProfileQuery({ name: 'Devin Marsh', linkedinUrl: 'https://lnkd.in/xQ7kV2pL' })).toBe(
      'Professional profile for Devin Marsh — current role, employer, background',
    )
  })

  // A contact can legitimately be a profile link and nothing else — the URL
  // names one human, which is the whole point of it.
  it('becomes the subject when there is no name', () => {
    expect(
      personProfileQuery({ name: '', linkedinUrl: 'https://www.linkedin.com/in/grantellery/' }),
    ).toBe(
      'Professional profile for linkedin.com/in/grantellery — current role, employer, background',
    )
    expect(personProfileQuery({ name: '' })).toBe(
      'Professional profile — current role, employer, background',
    )
  })
})

/*
 * THE DEVIN MARSH INCIDENT. Exa's people index had no page for the Fieldwing
 * CEO's own profile but did have a namesake lawyer's, and cited it at HIGH for
 * his roles and education; his title and company were cited to two colleagues'
 * profiles. None of those pages was about him. The gate makes a person's field
 * earn its confidence the way a company's does.
 */
describe('demoteUnrelatedPersonSources', () => {
  const identity = {
    name: 'Devin Marsh',
    companyName: 'Fieldwing',
    companyDomain: 'fieldwing.ag',
    linkedinUrl: 'https://www.linkedin.com/in/justdevin/',
  }
  const f = (source_url: string | null, source_title: string | null, confidence: 'high' | 'medium' | 'low' = 'high') => ({
    value: 'v', source_url, source_title, confidence,
  })

  it('keeps fields cited to the employer’s own domain', () => {
    const out = demoteUnrelatedPersonSources(
      { job_title: f('https://fieldwing.ag/company/', 'Our Team - Fieldwing'), location: f('https://www.fieldwing.ag/about', null) },
      identity,
    )
    expect(out.job_title.confidence).toBe('high')
    expect(out.location.confidence).toBe('high')
  })

  it('keeps fields cited to the person’s OWN LinkedIn profile, however spelled', () => {
    const out = demoteUnrelatedPersonSources(
      { previous_roles: f('https://linkedin.com/in/JustDevin?trk=public', 'Devin Marsh') },
      identity,
    )
    expect(out.previous_roles.confidence).toBe('high')
  })

  it('demotes a namesake’s LinkedIn profile even though its title is the name', () => {
    const out = demoteUnrelatedPersonSources(
      {
        previous_roles: f('https://www.linkedin.com/in/devin-marsh-4c7e2d10', 'Devin Marsh'),
        education: f('https://www.linkedin.com/in/devin-marsh-4c7e2d10', 'Devin Marsh - Senior Counsel - Halvern | LinkedIn'),
      },
      identity,
    )
    expect(out.previous_roles.confidence).toBe('low')
    expect(out.education.confidence).toBe('low')
  })

  it('demotes a colleague’s profile: company in the title, but not the name', () => {
    const out = demoteUnrelatedPersonSources(
      { job_title: f('https://www.linkedin.com/in/nolan-ray-ito-5e8b31f07', 'Nolan Ray Ito - Engineer - Fieldwing | LinkedIn') },
      identity,
    )
    expect(out.job_title.confidence).toBe('low')
  })

  it('keeps an unknown LinkedIn profile whose title carries name AND company', () => {
    const out = demoteUnrelatedPersonSources(
      { job_title: f('https://www.linkedin.com/in/devin-marsh-abc', 'Devin Marsh - CEO - Fieldwing | LinkedIn') },
      { ...identity, linkedinUrl: null },
    )
    expect(out.job_title.confidence).toBe('high')
  })

  it('keeps third-party pages that carry the company, demotes ones that only carry the name', () => {
    const out = demoteUnrelatedPersonSources(
      {
        summary: f('https://growerdaily.com/spotlight', 'Fieldwing on THE GROWER Innovator Spotlight'),
        notable_work: f('https://www.youtube.com/watch?v=x', 'Devin Marsh: Measuring hemp with drones (fieldwing.ag)'),
        expertise: f('https://hemp.example.edu/webinar', 'State Hemp Webinar: Drones & AI with Devin Marsh'),
        seniority: f('https://law360.com/halvern-hires', 'Halvern hires Devin Marsh as Senior Counsel'),
      },
      identity,
    )
    expect(out.summary.confidence).toBe('high')
    expect(out.notable_work.confidence).toBe('high')
    expect(out.expertise.confidence).toBe('low')
    expect(out.seniority.confidence).toBe('low')
  })

  it('matches the company by domain label when the row has no company name', () => {
    const out = demoteUnrelatedPersonSources(
      { summary: f('https://news.example.com/a', 'fieldwing names new CEO') },
      { name: 'Devin Marsh', companyDomain: 'fieldwing.ag' },
    )
    expect(out.summary.confidence).toBe('high')
  })

  it('treats an email standing in for the name as no name at all', () => {
    const out = demoteUnrelatedPersonSources(
      { job_title: f('https://www.linkedin.com/in/someone', 'someone - Fieldwing | LinkedIn') },
      { name: 'devin@fieldwing.ag', companyName: 'Fieldwing', companyDomain: 'fieldwing.ag' },
    )
    // A profile can only anchor by name+company or by being the known one.
    expect(out.job_title.confidence).toBe('low')
  })

  it('leaves everything alone when there is no identity to anchor against', () => {
    const fields = { job_title: f('https://anywhere.com', 'anything') }
    expect(demoteUnrelatedPersonSources(fields, { name: 'Devin Marsh' })).toEqual(fields)
  })

  it('demotes fields with no citation at all', () => {
    const out = demoteUnrelatedPersonSources({ job_title: f(null, null, 'medium') }, identity)
    expect(out.job_title.confidence).toBe('low')
  })
})
