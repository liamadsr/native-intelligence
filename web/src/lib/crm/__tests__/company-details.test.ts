/**
 * `buildCompanyDetails` — the model behind the company Details tab.
 *
 * What matters:
 *  - Every value the enricher can produce lands in a named section, in
 *    reading order, and nothing the blob holds silently vanishes.
 *  - Columns are canonical: a human-editable column value beats the blob's
 *    copy, and only carries web provenance when the run actually wrote it.
 *  - Low-confidence values never enter a section. The enricher refuses to
 *    write them to columns for the same reason — a namesake's facts must not
 *    read as the record — so the tab quarantines them under Unverified.
 *  - The blob is untyped jsonb from several enricher generations; malformed
 *    shapes degrade to "nothing to show", never a throw.
 */
import { describe, it, expect } from 'vitest'
import {
  buildCompanyDetails,
  parseKeyPeople,
  splitList,
  displayUrl,
  sourceHost,
  type CompanyDetailsInput,
} from '@/lib/crm/company-details'

const SRC = 'https://fieldwing.ag/about'
const NEWS = 'https://orchardwire.com/fieldwing-drones'

function field(value: string, confidence: 'high' | 'medium' | 'low' = 'high', source_url = SRC) {
  return { value, source_url, source_title: 'Fieldwing', confidence }
}

/** A row shaped like the Fieldwing run: columns filled, rich blob. */
const FIELDWING: CompanyDetailsInput = {
  domain: 'fieldwing.ag',
  website: 'https://fieldwing.ag/',
  industry: 'Agricultural Technology (AgTech)',
  employee_count_range: '11-50',
  city: 'Pasco',
  state: 'Washington',
  country: 'United States',
  enrichment_status: 'enriched',
  enriched_at: '2026-09-04T01:00:00Z',
  metadata: {
    enrichment: {
      version: 2,
      status: 'enriched',
      enriched_at: '2026-09-04T01:00:00Z',
      model: 'exa/deep-search',
      summary: 'Fieldwing provides autonomous drone services for sustainable agriculture.',
      applied_fields: ['website', 'industry', 'employee_count_range', 'city', 'state', 'country'],
      fields: {
        industry: field('Agricultural Technology (AgTech)'),
        website: field('https://fieldwing.ag/'),
        headquarters_city: field('Pasco'),
        headquarters_state: field('Washington', 'medium'),
        headquarters_country: field('United States'),
        company_stage: field('Early-stage startup', 'medium'),
        founded_year: field('2020'),
        employee_count: field('12', 'medium'),
        ownership: field('Privately Held'),
        funding_stage: field('Seed'),
        latest_funding: field('$612,400 Seed round in May 2021, led by Larkspur Capital.'),
        total_funding_raised: field('$612,400'),
        investors: field('Larkspur Capital, Sequoia Capital'),
        key_people: field('Ansel Varga (Co-Founder), Corbin Hale (Chief Agronomic Officer)'),
        products_and_services: field('Autonomous drone services and AI-enabled maps.'),
        recent_news: field('In July 2026, Fieldwing announced AgTech Expo participation.', 'medium', NEWS),
        linkedin_url: field('https://www.linkedin.com/company/fieldwing'),
      },
      sources: [
        { url: SRC, title: 'Fieldwing' },
        { url: NEWS, title: 'Orchard Wire' },
        { url: 'https://fieldwing.ag/news', title: '' },
      ],
    },
  },
}

describe('buildCompanyDetails — sections', () => {
  const model = buildCompanyDetails(FIELDWING)
  const section = (key: string) => model.sections.find((s) => s.key === key)
  const keys = (key: string) => section(key)?.fields.map((f) => f.key) ?? []

  it('orders sections what → size → funding → leadership → products → news', () => {
    expect(model.sections.map((s) => s.key)).toEqual([
      'about', 'size', 'funding', 'leadership', 'products', 'news',
    ])
  })

  it('places every catalog value, with headquarters composed after the links', () => {
    expect(keys('about')).toEqual([
      'industry', 'company_stage', 'founded_year', 'ownership', 'website', 'linkedin_url', 'headquarters',
    ])
    expect(keys('size')).toEqual(['employee_count', 'employee_count_range'])
    expect(keys('funding')).toEqual(['funding_stage', 'latest_funding', 'total_funding_raised', 'investors'])
    expect(keys('leadership')).toEqual(['key_people'])
    expect(keys('products')).toEqual(['products_and_services'])
    expect(keys('news')).toEqual(['recent_news'])
    expect(model.fieldCount).toBe(16)
    expect(model.unverified).toEqual([])
  })

  it('reads an applied column’s provenance from the blob field it was written from', () => {
    // employee_count_range is bucketed from the blob's `employee_count`; the
    // HQ trio from `headquarters_*`. The blob has no entry under the column name.
    const range = section('size')!.fields.find((f) => f.key === 'employee_count_range')!
    expect(range.value).toBe('11-50')
    expect(range.origin).toBe('column')
    expect(range.enriched).toBe(true)
    expect(range.confidence).toBe('medium')
    expect(range.sourceUrl).toBe(SRC)
  })

  it('does not repeat headcount under "Employee range" when that column is empty', () => {
    const model = buildCompanyDetails({
      metadata: { enrichment: { fields: { employee_count: field('12') } } },
    })
    expect(model.sections[0].fields.map((f) => f.key)).toEqual(['employee_count'])
  })

  it('composes headquarters from the columns and carries the weakest confidence', () => {
    const hq = section('about')!.fields.find((f) => f.key === 'headquarters')!
    expect(hq.value).toBe('Pasco, Washington, United States')
    expect(hq.origin).toBe('column')
    expect(hq.enriched).toBe(true)
    expect(hq.sourceUrl).toBe(SRC)
    expect(hq.confidence).toBe('medium')
  })

  it('uses the block layout for the long single-value sections', () => {
    expect(section('about')!.layout).toBe('rows')
    expect(section('leadership')!.layout).toBe('block')
    expect(section('products')!.layout).toBe('block')
    expect(section('news')!.layout).toBe('block')
  })

  it('keeps each field’s own source rather than the run’s first one', () => {
    const news = section('news')!.fields[0]
    expect(news.sourceUrl).toBe(NEWS)
    expect(news.confidence).toBe('medium')
  })

  it('surfaces the run metadata and drops blank source titles', () => {
    expect(model.summary).toMatch(/autonomous drone/)
    expect(model.enrichedAt).toBe('2026-09-04T01:00:00Z')
    expect(model.status).toBe('enriched')
    expect(model.sources).toEqual([
      { url: SRC, title: 'Fieldwing' },
      { url: NEWS, title: 'Orchard Wire' },
      { url: 'https://fieldwing.ag/news', title: null },
    ])
  })
})

describe('buildCompanyDetails — columns vs blob', () => {
  it('lets the column win and lends it provenance only when the run wrote it', () => {
    const model = buildCompanyDetails({
      industry: 'Typed by a human',
      website: 'https://acme.com',
      metadata: {
        enrichment: {
          status: 'enriched',
          applied_fields: ['website'],
          fields: {
            industry: field('Something the web said'),
            website: field('https://acme.com', 'high', 'https://acme.com/about'),
          },
        },
      },
    })
    const about = model.sections.find((s) => s.key === 'about')!
    const industry = about.fields.find((f) => f.key === 'industry')!
    const website = about.fields.find((f) => f.key === 'website')!

    expect(industry.value).toBe('Typed by a human')
    expect(industry.enriched).toBe(false)
    expect(industry.sourceUrl).toBeNull()

    expect(website.enriched).toBe(true)
    expect(website.sourceUrl).toBe('https://acme.com/about')
    expect(website.confidence).toBe('high')
  })

  it('falls through to the blob when the column is empty', () => {
    const model = buildCompanyDetails({
      industry: '   ',
      metadata: { enrichment: { fields: { industry: field('AgTech', 'medium') } } },
    })
    const industry = model.sections[0].fields[0]
    expect(industry.key).toBe('industry')
    expect(industry.value).toBe('AgTech')
    expect(industry.origin).toBe('enrichment')
    expect(industry.enriched).toBe(true)
  })

  it('composes headquarters from the blob when no HQ column is set', () => {
    const model = buildCompanyDetails({
      metadata: {
        enrichment: {
          fields: {
            headquarters_city: field('Boston'),
            headquarters_country: field('United States', 'medium'),
          },
        },
      },
    })
    const hq = model.sections[0].fields[0]
    expect(hq.key).toBe('headquarters')
    expect(hq.value).toBe('Boston, United States')
    expect(hq.origin).toBe('enrichment')
    expect(hq.confidence).toBe('medium')
  })

  it('gives contact email, phone and the contact page their own section, with address provenance from street_address', () => {
    const model = buildCompanyDetails({
      contact_email: 'hello@acme.com',
      phone: '+1 (415) 555-0100',
      address: '1 Market St, San Francisco, CA 94105, US',
      metadata: {
        enrichment: {
          applied_fields: ['contact_email', 'phone', 'address'],
          fields: {
            contact_email: field('Email: Hello@Acme.com', 'high', 'https://acme.com/contact'),
            phone: field('Tel: +1 (415) 555-0100', 'medium', 'https://acme.com/contact'),
            street_address: field('1 Market St, San Francisco, CA 94105, US', 'high', 'https://acme.com/contact'),
            contact_page: field('https://acme.com/contact'),
          },
        },
      },
    })
    expect(model.sections.map((s) => s.key)).toEqual(['about', 'contact'])
    const address = model.sections[0].fields[0]
    expect(address).toMatchObject({ key: 'address', enriched: true, sourceUrl: 'https://acme.com/contact' })
    expect(model.sections[1].fields.map((f) => [f.key, f.value, f.kind])).toEqual([
      ['contact_email', 'hello@acme.com', 'text'],
      ['phone', '+1 (415) 555-0100', 'text'],
      ['contact_page', 'https://acme.com/contact', 'url'],
    ])
    expect(model.sections[1].fields[1].confidence).toBe('medium')
  })

  it('shows the revenue range column when present', () => {
    const model = buildCompanyDetails({ annual_revenue_range: '$1M-$10M' })
    expect(model.sections).toHaveLength(1)
    expect(model.sections[0].key).toBe('size')
    expect(model.sections[0].fields[0]).toMatchObject({
      key: 'annual_revenue_range',
      label: 'Revenue range',
      value: '$1M-$10M',
      origin: 'column',
      enriched: false,
    })
  })
})

describe('buildCompanyDetails — confidence gate', () => {
  it('quarantines low-confidence blob values under unverified, never in a section', () => {
    // The dial8.ai run: own-site facts high, a London cocktail bar's facts low.
    const model = buildCompanyDetails({
      domain: 'dial8.ai',
      metadata: {
        enrichment: {
          status: 'enriched',
          fields: {
            industry: field('Software', 'high', 'https://dial8.ai'),
            founded_year: field('1885', 'low', 'https://hotelvarenne.com'),
            key_people: field('Some Barman (Owner)', 'low', 'https://hotelvarenne.com'),
          },
        },
      },
    })
    expect(model.sections.map((s) => s.key)).toEqual(['about'])
    expect(model.sections[0].fields.map((f) => f.key)).toEqual(['industry'])
    expect(model.unverified.map((f) => f.key)).toEqual(['founded_year', 'key_people'])
    expect(model.unverified[0].confidence).toBe('low')
    expect(model.fieldCount).toBe(1)
  })

  it('never quarantines a column value, even with a low blob twin', () => {
    const model = buildCompanyDetails({
      industry: 'Hospitality',
      metadata: { enrichment: { fields: { industry: field('Bars', 'low') } } },
    })
    expect(model.unverified).toEqual([])
    expect(model.sections[0].fields[0].value).toBe('Hospitality')
  })

  it('composed headquarters from low-confidence blob parts is unverified too', () => {
    const model = buildCompanyDetails({
      metadata: {
        enrichment: {
          fields: {
            headquarters_city: field('London', 'high'),
            headquarters_country: field('United Kingdom', 'low'),
          },
        },
      },
    })
    expect(model.sections).toEqual([])
    expect(model.unverified.map((f) => f.key)).toEqual(['headquarters'])
  })

  it('treats a missing confidence (older blobs) as trustworthy', () => {
    const model = buildCompanyDetails({
      metadata: { enrichment: { fields: { funding_summary: { value: 'Raised a seed round.' } } } },
    })
    expect(model.sections[0].fields[0]).toMatchObject({ key: 'funding_summary', confidence: null })
    expect(model.unverified).toEqual([])
  })
})

describe('buildCompanyDetails — empty and malformed input', () => {
  it('is empty for a bare row', () => {
    const model = buildCompanyDetails({})
    expect(model.sections).toEqual([])
    expect(model.unverified).toEqual([])
    expect(model.sources).toEqual([])
    expect(model.summary).toBeNull()
    expect(model.status).toBeNull()
    expect(model.fieldCount).toBe(0)
  })

  it('reports a run that found nothing: status enriched, sources, no fields', () => {
    const model = buildCompanyDetails({
      enrichment_status: 'enriched',
      metadata: {
        enrichment: {
          status: 'enriched',
          fields: {},
          applied_fields: [],
          sources: [{ url: 'https://example.com' }],
        },
      },
    })
    expect(model.status).toBe('enriched')
    expect(model.fieldCount).toBe(0)
    expect(model.sources).toEqual([{ url: 'https://example.com', title: null }])
  })

  it('carries a failed run’s error', () => {
    const model = buildCompanyDetails({
      enrichment_status: 'failed',
      metadata: { enrichment: { status: 'failed', error: 'no_search_results' } },
    })
    expect(model.status).toBe('failed')
    expect(model.error).toBe('no_search_results')
  })

  it('prefers the row’s status over the blob’s', () => {
    const model = buildCompanyDetails({
      enrichment_status: 'pending',
      metadata: { enrichment: { status: 'enriched' } },
    })
    expect(model.status).toBe('pending')
  })

  it.each([
    ['fields as an array', { fields: ['industry'] }],
    ['fields as a string', { fields: 'nope' }],
    ['a null entry', { fields: { industry: null } }],
    ['an object entry with no value', { fields: { industry: { source_url: SRC } } }],
    ['an object value', { fields: { industry: { value: { nested: true } } } }],
    ['blank strings', { fields: { industry: { value: '   ' } } }],
    ['applied_fields as a scalar', { applied_fields: 'industry' }],
    ['sources with junk', { sources: [null, 'x', { url: '' }, { title: 'no url' }] }],
    ['a blob that is an array', ['nope']],
    ['a blob that is a string', 'nope'],
  ])('tolerates %s', (_label, enrichment) => {
    const model = buildCompanyDetails({ metadata: { enrichment } })
    expect(model.sections).toEqual([])
    expect(model.unverified).toEqual([])
    expect(model.sources).toEqual([])
  })

  it('accepts a bare scalar where a { value } triple was expected', () => {
    const model = buildCompanyDetails({
      metadata: { enrichment: { fields: { founded_year: 2019, ownership: 'Private' } } },
    })
    expect(model.sections[0].fields.map((f) => [f.key, f.value])).toEqual([
      ['founded_year', '2019'],
      ['ownership', 'Private'],
    ])
  })
})

describe('parseKeyPeople', () => {
  it('splits "Name (Title)" lists', () => {
    expect(
      parseKeyPeople('Ansel Varga (Co-Founder), Corbin Hale (Chief Agronomic Officer)'),
    ).toEqual([
      { name: 'Ansel Varga', title: 'Co-Founder' },
      { name: 'Corbin Hale', title: 'Chief Agronomic Officer' },
    ])
  })

  it('keeps a comma inside a title with its person', () => {
    expect(parseKeyPeople('Jane Doe (Co-Founder, CEO); John Roe (CTO)')).toEqual([
      { name: 'Jane Doe', title: 'Co-Founder, CEO' },
      { name: 'John Roe', title: 'CTO' },
    ])
  })

  it('reads dash-separated titles and bare names', () => {
    expect(parseKeyPeople('Jane Doe - CEO, John Roe – CTO, Alex Poe')).toEqual([
      { name: 'Jane Doe', title: 'CEO' },
      { name: 'John Roe', title: 'CTO' },
      { name: 'Alex Poe', title: null },
    ])
  })

  it('does not treat a hyphenated name as a title', () => {
    expect(parseKeyPeople('Anna-Lise Moreau (Founder)')).toEqual([
      { name: 'Anna-Lise Moreau', title: 'Founder' },
    ])
  })

  it('is empty for an empty string', () => {
    expect(parseKeyPeople('   ')).toEqual([])
  })
})

describe('splitList', () => {
  it('splits on top-level commas and semicolons only', () => {
    expect(splitList('Larkspur Capital, Sequoia (Growth, Series B); a16z')).toEqual([
      'Larkspur Capital',
      'Sequoia (Growth, Series B)',
      'a16z',
    ])
  })

  it('drops empty items', () => {
    expect(splitList(', a,, b ,')).toEqual(['a', 'b'])
  })
})

describe('url helpers', () => {
  it('displayUrl strips scheme, www and the trailing slash', () => {
    expect(displayUrl('https://www.linkedin.com/company/fieldwing/')).toBe('linkedin.com/company/fieldwing')
    expect(displayUrl('fieldwing.ag')).toBe('fieldwing.ag')
  })

  it('sourceHost returns the bare host or null', () => {
    expect(sourceHost('https://www.fieldwing.ag/about')).toBe('fieldwing.ag')
    expect(sourceHost('not a url')).toBeNull()
    expect(sourceHost(null)).toBeNull()
  })
})
