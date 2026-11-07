/**
 * `buildIcpDraft` against fixture rows (full blob, thin blob, missing row) and
 * the four purpose templates, plus `normalizeIcp` as the PATCH gate.
 *
 * The seeding table in §4 is the contract. Every assertion here names the row
 * it exists to protect: a seeded field that quietly stops being seeded is a
 * pre-filled panel that silently goes blank, which is exactly the kind of
 * regression nobody notices until a list is created against an empty ICP.
 */
import { describe, it, expect } from 'vitest'
import { buildIcpDraft, emptyIcp, icpEquals, normalizeIcp, splitBlobList } from '../icp'
import type { SourceCompanyRow } from '../source-company'

function field(value: string, sourceUrl = 'https://acme.test/about') {
  return { value, source_url: sourceUrl, confidence: 'high' }
}

/** A fully enriched company: CORE + DETAILS + the ICP card all landed. */
const FULL: SourceCompanyRow = {
  id: 'co-1',
  workspace_id: 'ws-1',
  name: 'Acme',
  domain: 'acme.test',
  industry: 'Developer Tools',
  description: 'Acme builds things.',
  metadata: {
    enrichment: {
      fields: {
        products_and_services: field('A meeting-capture and CRM workspace'),
        value_proposition: field('Acme turns every meeting into pipeline'),
        target_customer: field('Series A-C B2B SaaS sales teams'),
        known_customers: field('Globex, Initech, Umbrella'),
        use_cases: field('Meeting notes; pipeline hygiene'),
        buyer_titles: field('VP Sales, RevOps Lead'),
        market_segment: field('Mid-market'),
        competitors: field('Gong, Clari'),
      },
    },
  },
}

/** A brand-new company row: columns only, nothing enriched. */
const THIN: SourceCompanyRow = {
  id: 'co-2',
  workspace_id: 'ws-1',
  name: 'Thin Co',
  domain: 'thin.test',
  industry: 'Logistics',
  description: null,
  metadata: null,
}

describe('splitBlobList', () => {
  it('splits on commas, semicolons and newlines, dropping blanks and dupes', () => {
    expect(splitBlobList('Globex, Initech; Globex\nUmbrella,  ')).toEqual([
      'Globex',
      'Initech',
      'Umbrella',
    ])
  })

  it('returns an empty list for absent values', () => {
    expect(splitBlobList(null)).toEqual([])
    expect(splitBlobList('   ')).toEqual([])
  })
})

describe('buildIcpDraft — the §4 seeding table', () => {
  it('seeds source from the columns and the blob', () => {
    const { icp, provenance } = buildIcpDraft(FULL, 'buyers')
    expect(icp.source).toEqual({
      company_id: 'co-1',
      name: 'Acme',
      domain: 'acme.test',
      // The ICP card's own-domain valueProposition leads the chain.
      what_we_sell: 'Acme turns every meeting into pipeline',
      our_customers: ['Globex', 'Initech', 'Umbrella'],
    })
    // Provenance carries the citation so the panel can render the link.
    expect(provenance['source.what_we_sell']).toEqual({
      value: 'Acme turns every meeting into pipeline',
      from: 'company_profile',
      source_url: 'https://acme.test/about',
    })
  })

  it('falls back what_we_sell: value_proposition → description → industry', () => {
    const noValueProp = {
      ...FULL,
      metadata: { enrichment: { fields: { target_customer: field('Sales teams') } } },
    }
    expect(buildIcpDraft(noValueProp, 'buyers').icp.source.what_we_sell).toBe('Acme builds things.')

    const noDescription = { ...noValueProp, description: '   ' }
    expect(buildIcpDraft(noDescription, 'buyers').icp.source.what_we_sell).toBe('Developer Tools')
  })

  it("takes target.description from the card's targetCustomer for a sales list", () => {
    const { icp, provenance } = buildIcpDraft(FULL, 'buyers')
    expect(icp.target.description).toBe('Series A-C B2B SaaS sales teams')
    expect(provenance['target.description'].from).toBe('company_profile')
  })

  it('falls back to the purpose template, interpolated, when the card said nothing', () => {
    const { icp, provenance } = buildIcpDraft(THIN, 'buyers')
    expect(icp.target.description).toBe('Companies that would buy Logistics.')
    expect(provenance['target.description'].from).toBe('template')
  })

  it('seeds industries from company.industry + the card market segment', () => {
    expect(buildIcpDraft(FULL, 'buyers').icp.target.industries).toEqual([
      'Developer Tools',
      'Mid-market',
    ])
  })

  it("seeds buyer_titles from the card, else the purpose defaults", () => {
    expect(buildIcpDraft(FULL, 'buyers').icp.target.buyer_titles).toEqual(['VP Sales', 'RevOps Lead'])
    expect(buildIcpDraft(THIN, 'buyers').icp.target.buyer_titles).toEqual([
      'Head of Sales',
      'VP Sales',
      'Founder',
    ])
  })

  it('seeds comparables from competitors + our_customers, de-duplicated', () => {
    const { icp } = buildIcpDraft(FULL, 'buyers')
    expect(icp.target.competitors).toEqual(['Gong', 'Clari'])
    expect(icp.target.comparables).toEqual(['Gong', 'Clari', 'Globex', 'Initech', 'Umbrella'])
  })

  it('seeds NOTHING into anti — an unrequested exclusion silently costs results', () => {
    const { icp } = buildIcpDraft(FULL, 'buyers')
    expect(icp.anti).toEqual({ exclude_industries: [], exclude_keywords: [], notes: '' })
    expect(icp.search_hint).toBe('')
  })

  it('returns a structurally complete draft when there is no source company (§4 step 4)', () => {
    const { icp, provenance } = buildIcpDraft(null, 'buyers')
    expect(icp.source).toEqual(emptyIcp().source)
    expect(icp.target.buyer_titles).toEqual(['Head of Sales', 'VP Sales', 'Founder'])
    expect(provenance['source.name']).toBeUndefined()
  })

  it('survives a malformed metadata blob without throwing', () => {
    for (const metadata of ['nope', 42, [], { enrichment: 'nope' }, { enrichment: { fields: [] } }]) {
      const { icp } = buildIcpDraft({ ...THIN, metadata }, 'buyers')
      expect(icp.source.what_we_sell).toBe('Logistics')
    }
  })
})

/**
 * THE NAMESAKE FIXTURE, taken verbatim from the shape production produced for
 * dial8.ai: an off-domain `products_and_services` describing a London cocktail
 * bar (the DETAILS card runs on the OPEN WEB) sitting in the same blob as a
 * correct, own-domain `description` from the CORE card. Seeding `what_we_sell`
 * from the first of those pointed every ICP in the workspace at the wrong
 * business, so the seeding order and the own-domain gate below exist to make
 * that impossible.
 */
const NAMESAKE: SourceCompanyRow = {
  id: 'co-3',
  workspace_id: 'ws-1',
  name: 'Dial8',
  domain: 'dial8.ai',
  industry: 'Hospitality',
  description: null,
  metadata: {
    enrichment: {
      fields: {
        products_and_services: field(
          'Cocktail bar and event space',
          'https://hotelvarenne.com/dial8',
        ),
        known_customers: field('Hotel Varenne, Number Nine', 'https://hotelvarenne.com/dial8'),
        description: field(
          'Dial8 is an agentic workspace and sales intelligence platform',
          'https://www.dial8.ai/about',
        ),
      },
    },
  },
}

describe('buildIcpDraft — the own-domain gate on who-we-are fields', () => {
  it('IGNORES an off-domain products_and_services and takes the own-domain description', () => {
    const { icp, provenance } = buildIcpDraft(NAMESAKE, 'buyers')
    expect(icp.source.what_we_sell).toBe(
      'Dial8 is an agentic workspace and sales intelligence platform',
    )
    expect(provenance['source.what_we_sell'].source_url).toBe('https://www.dial8.ai/about')
    // …and the namesake's prose reaches nothing downstream either.
    expect(icp.target.description).toBe(
      'Companies that would buy Dial8 is an agentic workspace and sales intelligence platform.',
    )
  })

  it('IGNORES off-domain known_customers — those are somebody else\'s logos', () => {
    const { icp, provenance } = buildIcpDraft(NAMESAKE, 'buyers')
    expect(icp.source.our_customers).toEqual([])
    expect(icp.target.comparables).toEqual([])
    expect(provenance['source.our_customers']).toBeUndefined()
  })

  it('ACCEPTS products_and_services when its citation IS the own domain', () => {
    const own = {
      ...NAMESAKE,
      metadata: {
        enrichment: {
          fields: {
            products_and_services: field('Agentic sales workspace', 'https://dial8.ai/product'),
            known_customers: field('Globex, Initech', 'https://dial8.ai/customers'),
          },
        },
      },
    }
    const { icp } = buildIcpDraft(own, 'buyers')
    expect(icp.source.what_we_sell).toBe('Agentic sales workspace')
    expect(icp.source.our_customers).toEqual(['Globex', 'Initech'])
  })

  it('treats a SUBDOMAIN citation as own-domain, and ignores a look-alike host', () => {
    const make = (url: string) => ({
      ...NAMESAKE,
      description: null,
      industry: null,
      metadata: {
        enrichment: { fields: { products_and_services: field('Agentic sales workspace', url) } },
      },
    })
    expect(buildIcpDraft(make('https://blog.dial8.ai/launch'), 'buyers').icp.source.what_we_sell)
      .toBe('Agentic sales workspace')
    // notdial8.ai must NOT endsWith-match dial8.ai — the dot is load-bearing.
    expect(buildIcpDraft(make('https://notdial8.ai/x'), 'buyers').icp.source.what_we_sell).toBe('')
  })

  it('an UNATTRIBUTED products field is not own-domain — unattributable is not trusted', () => {
    const noUrl = {
      ...NAMESAKE,
      description: null,
      industry: 'Hospitality',
      metadata: {
        enrichment: {
          fields: { products_and_services: { value: 'Cocktail bar', confidence: 'high' } },
        },
      },
    }
    expect(buildIcpDraft(noUrl, 'buyers').icp.source.what_we_sell).toBe('Hospitality')
  })

  it('the company.description COLUMN outranks the blob description field', () => {
    const withColumn = { ...NAMESAKE, description: 'Typed by a human' }
    expect(buildIcpDraft(withColumn, 'buyers').icp.source.what_we_sell).toBe('Typed by a human')
  })

  it('a company with no domain cannot own-domain-trust ANY blob field', () => {
    // `description` and `known_customers` both sit in the blob; with no domain
    // to compare against, the gated ones (products, known customers) are
    // unusable, so the chain falls through to the ungated blob description and
    // the customer list stays empty rather than importing a stranger's logos.
    const noDomain = { ...NAMESAKE, domain: null }
    const { icp } = buildIcpDraft(noDomain, 'buyers')
    expect(icp.source.what_we_sell).toBe(
      'Dial8 is an agentic workspace and sales intelligence platform',
    )
    expect(icp.source.our_customers).toEqual([])

    // Strip the ungated description too and only the industry column is left —
    // never the cocktail bar.
    const bare = {
      ...noDomain,
      metadata: {
        enrichment: {
          fields: {
            products_and_services: field('Cocktail bar', 'https://hotelvarenne.com/dial8'),
          },
        },
      },
    }
    expect(buildIcpDraft(bare, 'buyers').icp.source.what_we_sell).toBe('Hospitality')
  })
})

describe('buildIcpDraft — the four purpose templates', () => {
  it('investors CLEARS the card description and keeps source + comparables intact', () => {
    const { icp, provenance } = buildIcpDraft(FULL, 'investors')
    // The card answers "who does our website say we sell to" — right for a
    // sales list, wrong for a fund search.
    expect(icp.target.description).toBe('')
    expect(icp.target.buyer_titles).toEqual(['Partner', 'Principal'])
    expect(provenance['target.description']).toBeUndefined()
    // …but the angles still need portfolio evidence to cite.
    expect(icp.source.name).toBe('Acme')
    expect(icp.source.our_customers).toEqual(['Globex', 'Initech', 'Umbrella'])
    expect(icp.target.comparables).toEqual(['Gong', 'Clari', 'Globex', 'Initech', 'Umbrella'])
  })

  it("investors ignores the card's buyer titles rather than pitching to a VP Sales", () => {
    expect(buildIcpDraft(FULL, 'investors').icp.target.buyer_titles).toEqual(['Partner', 'Principal'])
  })

  it('partners uses BD/Partnerships titles and an interpolated description', () => {
    const { icp } = buildIcpDraft(THIN, 'partners')
    expect(icp.target.buyer_titles).toEqual(['BD', 'Partnerships'])
    expect(icp.target.description).toContain('Logistics')
  })

  it('custom leaves the target blank but keeps the seeded source', () => {
    const { icp } = buildIcpDraft(FULL, 'custom')
    expect(icp.target.description).toBe('')
    expect(icp.target.buyer_titles).toEqual([])
    expect(icp.source.domain).toBe('acme.test')
  })

  it('interpolates a placeholder subject when the company sells nothing we know of', () => {
    const bare: SourceCompanyRow = { ...THIN, industry: null, description: null }
    expect(buildIcpDraft(bare, 'buyers').icp.target.description).toBe(
      'Companies that would buy what we sell.',
    )
  })
})

describe('normalizeIcp', () => {
  it('produces a structurally complete ICP from nothing at all', () => {
    for (const raw of [undefined, null, 'nope', 42, []]) {
      expect(normalizeIcp(raw)).toEqual(emptyIcp())
    }
  })

  it('drops unknown keys rather than letting them accrete in the blob', () => {
    const out = normalizeIcp({ target: { description: 'x', bogus: 1 }, stray: true }) as unknown as Record<
      string,
      unknown
    >
    expect(Object.keys(out).sort()).toEqual(['anti', 'search_hint', 'source', 'target'])
    expect(Object.keys(out.target as object).sort()).toEqual(
      Object.keys(emptyIcp().target).sort(),
    )
  })

  it('accepts a comma-separated paste where an array was expected', () => {
    expect(normalizeIcp({ target: { industries: 'SaaS, Fintech, SaaS' } }).target.industries).toEqual([
      'SaaS',
      'Fintech',
    ])
  })

  it('drops non-string array members and blanks', () => {
    expect(
      normalizeIcp({ target: { geographies: ['US', 3, null, '  ', 'EU'] } }).target.geographies,
    ).toEqual(['US', 'EU'])
  })

  it('caps free text — the ICP ends up inside an Exa systemPrompt', () => {
    const long = 'x'.repeat(5_000)
    expect(normalizeIcp({ target: { description: long } }).target.description).toHaveLength(2_000)
  })

  it('caps list length', () => {
    const many = Array.from({ length: 120 }, (_, i) => `item-${i}`)
    expect(normalizeIcp({ target: { use_cases: many } }).target.use_cases).toHaveLength(50)
  })

  it('round-trips a built draft unchanged — the panel PATCHes what it rendered', () => {
    const { icp } = buildIcpDraft(FULL, 'buyers')
    expect(normalizeIcp(icp)).toEqual(icp)
  })
})

describe('icpEquals', () => {
  it('is true for a no-op save and false for a real edit — this is what gates the version bump', () => {
    const { icp } = buildIcpDraft(FULL, 'buyers')
    expect(icpEquals(icp, normalizeIcp(icp))).toBe(true)
    const edited = { ...icp, target: { ...icp.target, description: 'something else' } }
    expect(icpEquals(icp, edited)).toBe(false)
  })
})
