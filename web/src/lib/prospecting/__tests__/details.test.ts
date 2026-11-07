/**
 * `buildProspectDetails` — the model behind the prospect panel's Details tab
 * and sidebar.
 *
 * What matters:
 *  - Every research key with a home lands in the CRM's OWN section under the
 *    CRM's own label, in the CRM's order — a candidate must read like the
 *    record it becomes.
 *  - The identity and the verdict (`name`, `domain`, `one_liner`, `why_fit`,
 *    `why_match`) are NOT rows: the panel shows them once, elsewhere.
 *  - A key nobody catalogued still lands under Other, labelled from the key.
 *  - Two vintages' names for one fact show once.
 *  - Low-confidence values never enter a section (Unverified quarantine).
 *  - The sidebar's facts are the same fields, minus anything unverified.
 */
import { describe, it, expect } from 'vitest'
import {
  buildProspectDetails,
  employeeRangeOf,
  entrySources,
  personRelevance,
  prospectFacts,
  researchValue,
  tidyListValue,
  type ProspectDetailsInput,
} from '@/lib/prospecting/details'

const SRC = 'https://giftwell.com/about'

function field(value: string, confidence: 'high' | 'medium' | 'low' = 'high', source_url = SRC) {
  return { value, source_url, source_title: 'Giftwell', confidence }
}

/** A company entry after the account card, in the BARE map `applyCard` writes. */
const CARDED: ProspectDetailsInput = {
  kind: 'company',
  candidate: { name: 'Giftwell', domain: 'giftwell.com', account_card_at: '2026-09-05T10:00:00Z' },
  research: {
    name: field('Giftwell'),
    domain: field('giftwell.com'),
    one_liner: field('Gifting and direct mail automation platform for revenue teams.'),
    why_match: field('Mid-market US B2B SaaS company with outbound sales motions.', 'high', 'https://g2.com/giftwell'),
    why_fit: field('Giftwell is a prime candidate because it is a B2B SaaS company with ~244 employees.'),
    signal: field('Ongoing focus on revenue intelligence tools as of June 2026.'),
    founded_year: field('2016'),
    employee_range: field('201-500'),
    employee_count: field('244', 'medium'),
    headquarters: field('San Francisco, California, United States'),
    funding_stage: field('Series C'),
    total_raised: field('$152.7M'),
    growth_signals: field('Maintained 244 employees with steady growth; positions itself as a gifting platform.'),
    tech_stack: field('Salesforce, Marketo, HubSpot, Docker, TypeScript, Apache Kafka, Kubernetes.'),
    products: field('Gifting and direct mail automation platform, AI-powered gifting tools, campaign studio.'),
    key_people: field('Kurt Ravensby — Co-CEO and Co-Founder; Paula Desrosiers — Chief Revenue Officer'),
    // A weak finding — a namesake's page.
    annual_revenue: field('$40M', 'low', 'https://zoominfo.com/giftwell-namesake'),
    // Nobody catalogued this one.
    partner_ecosystem: field('AWS Marketplace, Salesforce AppExchange'),
  },
  sources: [
    { url: 'https://giftwell.com/about', title: 'About Giftwell' },
    { url: 'https://giftwell.com/careers', title: 'Careers' },
  ],
}

function titles(input: ProspectDetailsInput): string[] {
  return buildProspectDetails(input).sections.map((s) => s.title)
}

function section(input: ProspectDetailsInput, title: string) {
  const found = buildProspectDetails(input).sections.find((s) => s.title === title)
  if (!found) throw new Error(`no section ${title}`)
  return found
}

describe('buildProspectDetails — the CRM sections over the research blob', () => {
  it('places every catalogued key in the CRM section, in the CRM order', () => {
    expect(titles(CARDED)).toEqual([
      'About',
      'Size & revenue',
      'Funding',
      'Leadership',
      'Products & services',
      'Technology',
      'Signals',
      'Other',
    ])
    expect(section(CARDED, 'About').fields.map((f) => [f.label, f.value])).toEqual([
      ['Founded', '2016'],
      ['Headquarters', 'San Francisco, California, United States'],
    ])
    expect(section(CARDED, 'Size & revenue').fields.map((f) => [f.label, f.value])).toEqual([
      ['Headcount', '244'],
      ['Employee range', '201-500'],
    ])
    expect(section(CARDED, 'Funding').fields.map((f) => [f.label, f.value])).toEqual([
      ['Funding stage', 'Series C'],
      ['Total raised', '$152.7M'],
    ])
    // Layouts follow the CRM's: rows for facts, a block for the long ones.
    expect(section(CARDED, 'About').layout).toBe('rows')
    expect(section(CARDED, 'Leadership').layout).toBe('block')
    expect(section(CARDED, 'Leadership').fields[0].kind).toBe('people')
    expect(section(CARDED, 'Technology').fields[0].kind).toBe('list')
  })

  it('keeps the identity and the verdict OUT of the sections', () => {
    const keys = buildProspectDetails(CARDED).sections.flatMap((s) => s.fields.map((f) => f.key))
    for (const key of ['name', 'domain', 'one_liner', 'why_fit', 'why_match']) {
      expect(keys, `${key} is shown once, elsewhere`).not.toContain(key)
    }
  })

  it('puts the two signal fields together under Signals', () => {
    expect(section(CARDED, 'Signals').fields.map((f) => f.key)).toEqual(['growth_signals', 'signal'])
  })

  it('lands a key nobody catalogued under Other, labelled from the key', () => {
    const other = section(CARDED, 'Other')
    expect(other.fields.map((f) => [f.label, f.value])).toEqual([
      ['Partner ecosystem', 'AWS Marketplace, Salesforce AppExchange'],
    ])
  })

  it('quarantines a low-confidence value under Unverified, never in a section', () => {
    const model = buildProspectDetails(CARDED)
    expect(model.unverified.map((f) => f.key)).toEqual(['annual_revenue'])
    expect(section(CARDED, 'Size & revenue').fields.map((f) => f.key)).not.toContain('annual_revenue')
  })

  it('shows one fact once when two vintages named it differently', () => {
    const both: ProspectDetailsInput = {
      ...CARDED,
      research: {
        employee_range: field('201-500'),
        employee_count_range: field('201-500'),
        total_raised: field('$152.7M'),
        total_funding_raised: field('$152.7M'),
      },
    }
    expect(section(both, 'Size & revenue').fields.map((f) => f.label)).toEqual(['Employee range'])
    expect(section(both, 'Funding').fields.map((f) => f.label)).toEqual(['Total raised'])
  })

  it('composes Headquarters from the CRM trio when the card wrote none', () => {
    const trio: ProspectDetailsInput = {
      ...CARDED,
      research: {
        fields: {
          headquarters_city: field('Pasco'),
          headquarters_state: field('Washington', 'medium'),
          headquarters_country: field('United States'),
        },
      },
    }
    const hq = section(trio, 'About').fields[0]
    expect(hq.label).toBe('Headquarters')
    expect(hq.value).toBe('Pasco, Washington, United States')
    expect(hq.confidence).toBe('medium')
    // The trio does not ALSO fall through to Other.
    expect(titles(trio)).toEqual(['About'])
  })

  it('reads the `{ fields }` wrapper and the bare map alike', () => {
    const wrapped: ProspectDetailsInput = {
      ...CARDED,
      research: { fields: { founded_year: field('2016') } },
    }
    const bare: ProspectDetailsInput = { ...CARDED, research: { founded_year: '2016' } }
    expect(section(wrapped, 'About').fields[0].value).toBe('2016')
    expect(section(bare, 'About').fields[0].value).toBe('2016')
    expect(section(bare, 'About').fields[0].sourceUrl).toBeNull()
  })

  it('takes the status and the date from the account-card stamp', () => {
    const model = buildProspectDetails(CARDED)
    expect(model.status).toBe('enriched')
    expect(model.enrichedAt).toBe('2026-09-05T10:00:00Z')
    expect(model.summary).toBeNull()
    expect(model.fieldCount).toBe(12)

    const discovered: ProspectDetailsInput = {
      kind: 'company',
      candidate: { name: 'Acme', domain: 'acme.com' },
      research: { founded_year: field('2015') },
      sources: null,
    }
    expect(buildProspectDetails(discovered).status).toBeNull()
    expect(buildProspectDetails(discovered).enrichedAt).toBeNull()
  })

  it('degrades a malformed blob to nothing rather than throwing', () => {
    for (const research of [null, undefined, 'text', 42, [1, 2], { fields: 'nope' }]) {
      const model = buildProspectDetails({ ...CARDED, research })
      expect(model.sections).toEqual([])
      expect(model.unverified).toEqual([])
    }
  })
})

describe('buildProspectDetails — a person', () => {
  const PERSON: ProspectDetailsInput = {
    kind: 'person',
    candidate: { name: 'Dana Reyes', title: 'VP Revenue Operations', domain: 'quillfort.ai' },
    research: {
      full_name: field('Dana Reyes'),
      job_title: field('VP Revenue Operations'),
      linkedin_url: field('linkedin.com/in/dana-reyes'),
      seniority: field('VP'),
      why_relevant: field('Owns the RevOps tooling budget.', 'high', 'https://quillfort.ai/team'),
      previous_roles: field('Director of Sales Ops at Okta (2019–2022)'),
    },
    sources: null,
  }

  it('keeps the identity fields and the relevance out of the sections', () => {
    const model = buildProspectDetails(PERSON)
    expect(model.sections.map((s) => s.title)).toEqual(['Other'])
    expect(model.sections[0].fields.map((f) => f.label)).toEqual(['Previous roles'])
    // A person is never "enriched" — there is no card to have run.
    expect(model.status).toBeNull()
  })

  it('hands the relevance sentence over with its source', () => {
    const relevance = personRelevance(PERSON)
    expect(relevance?.value).toBe('Owns the RevOps tooling budget.')
    expect(relevance?.sourceUrl).toBe('https://quillfort.ai/team')
    expect(personRelevance({ ...PERSON, research: null })).toBeNull()
  })
})

describe('prospectFacts — the sidebar', () => {
  it('picks the short facts with their provenance', () => {
    const facts = prospectFacts(CARDED)
    expect(facts.domain).toBe('giftwell.com')
    expect(facts.employees?.value).toBe('201-500')
    expect(facts.employees?.sourceUrl).toBe(SRC)
    expect(facts.headquarters?.value).toBe('San Francisco, California, United States')
    expect(facts.founded?.value).toBe('2016')
    expect(facts.fundingStage?.value).toBe('Series C')
    expect(facts.totalRaised?.value).toBe('$152.7M')
    expect(facts.industry).toBeNull()
  })

  it('never states a low-confidence value as a fact', () => {
    const weak: ProspectDetailsInput = {
      ...CARDED,
      research: { headquarters: field('Austin, Texas', 'low') },
    }
    expect(prospectFacts(weak).headquarters).toBeNull()
  })

  it('drops a website row that only repeats the domain', () => {
    const same: ProspectDetailsInput = {
      ...CARDED,
      research: { website: field('https://www.giftwell.com/') },
    }
    expect(prospectFacts(same).website).toBeNull()
    const other: ProspectDetailsInput = {
      ...CARDED,
      research: { website: field('https://giftwell.co.uk') },
    }
    expect(prospectFacts(other).website?.value).toBe('https://giftwell.co.uk')
  })

  it('reads the headcount under any of the keys the passes have used', () => {
    expect(employeeRangeOf({ employee_range: '51-200' })).toBe('51-200')
    expect(employeeRangeOf({ employee_count_range: '1000+' })).toBe('1000+')
    expect(employeeRangeOf({ fields: { employee_count: { value: '109' } } })).toBe('109')
    expect(employeeRangeOf(null)).toBeNull()
    expect(researchValue({ founded_year: '  ' }, 'founded_year')).toBeNull()
  })
})

describe('entrySources', () => {
  it("prefers the entry's own sources column, then the blob's list", () => {
    expect(entrySources(CARDED).map((s) => s.url)).toEqual([
      'https://giftwell.com/about',
      'https://giftwell.com/careers',
    ])
    const blobOnly: ProspectDetailsInput = {
      ...CARDED,
      sources: [],
      research: { fields: {}, sources: [{ url: 'https://example.com/x', title: 'X' }] },
    }
    expect(entrySources(blobOnly)).toEqual([{ url: 'https://example.com/x', title: 'X' }])
    expect(entrySources({ ...CARDED, sources: [{ title: 'no url' }], research: null })).toEqual([])
  })
})

describe('tidyListValue', () => {
  it('drops the full stop from a list of short names so it chips', () => {
    expect(tidyListValue('Salesforce, Marketo, HubSpot, Apache Kafka, Kubernetes.')).toBe(
      'Salesforce, Marketo, HubSpot, Apache Kafka, Kubernetes',
    )
    // The card's stop-free answer is untouched.
    expect(tidyListValue('Salesforce, Marketo')).toBe('Salesforce, Marketo')
  })

  it('leaves a sentence that merely contains commas alone', () => {
    const sentence = 'Uses Salesforce and HubSpot, as evidenced by the roles it is hiring for.'
    expect(tidyListValue(sentence)).toBe(sentence)
    const one = 'Salesforce.'
    expect(tidyListValue(one)).toBe(one)
  })

  it('chips the technology list end to end through the model', () => {
    expect(section(CARDED, 'Technology').fields[0].value).toBe(
      'Salesforce, Marketo, HubSpot, Docker, TypeScript, Apache Kafka, Kubernetes',
    )
  })
})
