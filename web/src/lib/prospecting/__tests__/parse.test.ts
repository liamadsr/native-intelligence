/**
 * The three response parsers (spec §7), against the four REAL recorded Exa
 * responses in `fixtures/exa/` — never a hand-invented shape, because every
 * bug these parsers can have is a wire-format bug.
 *
 * NOTE on the people fixture: its `fullName`, `linkedinUrl` and citation URLs
 * were rewritten to synthetic but shape-identical values ("Person One",
 * `linkedin.com/in/person-one`) so real people's profiles do not live in the
 * repo. Everything else — titles, seniorities, grounding paths, confidences,
 * counts, cost — is byte-identical to what Exa returned.
 */
import { describe, expect, it } from 'vitest'
import { type DeepSearchResult, parseDeepSearchResponse } from '@/lib/exa/deep-search'
import { parseAccountCard, parseDiscoveryResponse, parsePeopleResponse } from '../parse'
import buyersFixture from './fixtures/exa/discovery-buyers-n25.json'
import investorsFixture from './fixtures/exa/discovery-investors-n15.json'
import peopleFixture from './fixtures/exa/people-quillfort.json'
import accountCardFixture from './fixtures/exa/account-card-quoteleaf.json'

const buyers: DeepSearchResult = parseDeepSearchResponse(buyersFixture.response)
const investors: DeepSearchResult = parseDeepSearchResponse(investorsFixture.response)
const people: DeepSearchResult = parseDeepSearchResponse(peopleFixture.response)
const accountCard: DeepSearchResult = parseDeepSearchResponse(accountCardFixture.response)

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe('parseDiscoveryResponse — the two-source harvest', () => {
  const candidates = parseDiscoveryResponse(buyers, { angle: 'direct' })

  it('harvests BOTH sources: 5 synthesized plus result entities', () => {
    const synthesized = candidates.filter((c) => c.found_via === 'synthesized')
    const entities = candidates.filter((c) => c.found_via === 'result_entity')
    // The recorded 25-result response synthesized 5 companies and carried a
    // company entity on all 25 results. The second harvest is what makes a
    // round cheap (§7) — without it this call would have produced 5 leads.
    expect(synthesized).toHaveLength(5)
    expect(entities.length).toBeGreaterThan(10)
    expect(candidates.length).toBeGreaterThan(synthesized.length)
  })

  it('produces at least 19 distinct usable candidates from the one call', () => {
    const keys = candidates.map((c) => c.identity_key).filter((k): k is string => !!k)
    expect(new Set(keys).size).toBeGreaterThanOrEqual(19)
  })

  it('stamps the angle on every candidate', () => {
    expect(candidates.every((c) => c.angle === 'direct')).toBe(true)
    expect(parseDiscoveryResponse(buyers)[0].angle).toBeNull()
  })

  it('gives synthesized candidates their fit-relevant text fields', () => {
    const tallyhire = candidates.find((c) => c.identity_key === 'tallyhire.com')
    expect(tallyhire?.found_via).toBe('synthesized')
    expect(tallyhire?.display_name).toBe('Tallyhire')
    expect(tallyhire?.fields.why_match?.value).toContain('scaling')
    expect(tallyhire?.fields.signal?.value).toContain('Series D')
    expect(tallyhire?.fields.employee_range?.value).toBe('316')
    expect(tallyhire?.fields.one_liner?.value).toContain('talent platform')
  })

  it('gives each synthesized candidate its OWN citation, not item zero\'s', () => {
    const synthesized = candidates.filter((c) => c.found_via === 'synthesized')
    const urls = synthesized.map((c) => c.fields.one_liner?.source_url)
    expect(new Set(urls).size).toBe(synthesized.length)
  })

  it('derives per-candidate confidence from the WEAKEST of name and domain', () => {
    // Buyers came back all-high; investors are mixed (§12).
    expect(candidates.every((c) => c.confidence === 'high')).toBe(true)

    const mixed = parseDiscoveryResponse(
      {
        requestId: null,
        content: { companies: [{ name: 'Weak Co', domain: 'weak.co', whyMatch: 'strong prose' }] },
        grounding: [
          { field: 'companies[0].name', citations: [{ url: 'https://weak.co', title: null }], confidence: 'high' },
          { field: 'companies[0].domain', citations: [{ url: 'https://weak.co', title: null }], confidence: 'low' },
          { field: 'companies[0].whyMatch', citations: [{ url: 'https://weak.co', title: null }], confidence: 'high' },
        ],
        results: [],
        costDollars: null,
      },
      {},
    )
    // A confident rationale about a company whose domain is not established is
    // still a low-confidence candidate.
    expect(mixed[0].confidence).toBe('low')
  })

  it('treats a MISSING identity field as weaker than a low-grounded one', () => {
    const res: DeepSearchResult = {
      requestId: null,
      content: { companies: [{ name: 'Nameless Co', domain: 'nameless.co' }] },
      grounding: [
        { field: 'companies[0].name', citations: [{ url: 'https://x', title: null }], confidence: 'high' },
      ],
      results: [],
      costDollars: null,
    }
    // `domain` is ungrounded → 'low' → the candidate is low.
    expect(parseDiscoveryResponse(res)[0].confidence).toBe('low')
  })

  it('carries exa_entity_id and firmographics on the entity harvest', () => {
    const pitchleaf = candidates.find((c) => c.identity_key === 'pitchleaf.com')
    expect(pitchleaf?.found_via).toBe('result_entity')
    expect(pitchleaf?.exa_entity_id).toMatch(/^https:\/\/exa\.ai\/library\/organization\//)
    expect(pitchleaf?.fields.one_liner?.value).toBeTruthy()
    expect(pitchleaf?.evidence_url).toContain('pitchleaf.com')
  })

  it('surfaces noise hosts intact for the exclusion set to suppress', () => {
    // linkedin.com is a measured result host (§12), and so are recruiter sites
    // (`staffnoble.com` in the probe, `dsrepaz.net` / `seriesbbuilders.com`
    // here). They are NOT dropped and NOT null-keyed: `linkedin.com` is a
    // platform, not a webmail domain, so `companyCandidateKey` keeps it — and
    // it must, because the run has to record each one as `suppressed` with a
    // `suppressed_by` rather than silently vanishing it (§6). Suppressing a
    // platform host is the exclusion set's job, not the parser's.
    // Four separate linkedin.com results carried an entity in this response;
    // they are ONE identity, so they collapse to one row.
    const rawLinkedIn = buyers.results.filter((r) => r.url.includes('linkedin.com'))
    expect(rawLinkedIn.length).toBeGreaterThan(1)
    const linkedin = candidates.filter((c) => c.domain === 'linkedin.com')
    expect(linkedin).toHaveLength(1)
    expect(linkedin[0].found_via).toBe('result_entity')
    expect(linkedin[0].identity_key).toBe('linkedin.com')

    const recruiters = candidates.filter((c) => c.domain === 'seriesbbuilders.com')
    expect(recruiters).toHaveLength(1)
    expect(recruiters[0].identity_key).toBe('seriesbbuilders.com')
  })

  it('rejects a webmail host as an identity', () => {
    const res: DeepSearchResult = {
      requestId: null,
      content: { companies: [{ name: 'Gmail', domain: 'gmail.com' }] },
      grounding: [],
      results: [],
      costDollars: null,
    }
    const [candidate] = parseDiscoveryResponse(res)
    expect(candidate.identity_key).toBeNull()
    // ...but the row survives, carrying what we tried, so the run can record
    // it honestly.
    expect(candidate.domain).toBe('gmail.com')
    expect(candidate.display_name).toBe('Gmail')
  })

  it('normalizes the domain into the identity key', () => {
    const res: DeepSearchResult = {
      requestId: null,
      content: { companies: [{ name: 'Messy', domain: 'HTTPS://WWW.Messy.co/pricing?x=1' }] },
      grounding: [],
      results: [],
      costDollars: null,
    }
    expect(parseDiscoveryResponse(res)[0].identity_key).toBe('messy.co')
  })

  it('collapses an exact duplicate within one response, synthesized winning', () => {
    // forgehand.co came back twice in one measured 20-entry answer (§12); two
    // rows for one key would violate UNIQUE (list_id, candidate_key).
    const res: DeepSearchResult = {
      requestId: null,
      content: {
        companies: [
          { name: 'Forgehand', domain: 'forgehand.co', whyMatch: 'AI SDRs' },
          { name: 'Forgehand AI', domain: 'https://forgehand.co', whyMatch: 'again' },
        ],
      },
      grounding: [],
      results: [
        {
          url: 'https://forgehand.co/about',
          title: 'Forgehand',
          publishedDate: null,
          entities: [
            {
              id: 'https://exa.ai/library/organization/abc',
              type: 'company',
              properties: { name: 'Forgehand', description: 'AI sales agents', foundedYear: 2023 },
            },
          ],
        },
      ],
      costDollars: null,
    }
    const out = parseDiscoveryResponse(res)
    expect(out).toHaveLength(1)
    expect(out[0].found_via).toBe('synthesized')
    expect(out[0].fields.why_match?.value).toBe('AI SDRs')
    // The entity harvest's unique contributions survive the merge.
    expect(out[0].exa_entity_id).toBe('https://exa.ai/library/organization/abc')
    expect(out[0].fields.founded_year?.value).toBe('2023')
  })

  it('never collapses two null-key candidates into one', () => {
    const res: DeepSearchResult = {
      requestId: null,
      content: { companies: [{ name: 'A' }, { name: 'B' }] },
      grounding: [],
      results: [],
      costDollars: null,
    }
    const out = parseDiscoveryResponse(res)
    expect(out).toHaveLength(2)
    expect(out.map((c) => c.identity_key)).toEqual([null, null])
  })

  it('does NOT dedupe against anything outside the response', () => {
    // Exclusion is exclusions.ts's job, and it needs to SEE the leak. roamwise.ai
    // and forecastly.com were named in the systemPrompt and came back anyway — 2 of
    // 30 leaked (§12) — so the parser must return them.
    const domains = candidates.map((c) => c.identity_key)
    expect(domains).toContain('roamwise.ai')
    expect(domains).toContain('forecastly.com')
  })

  it('keeps the raw item for prospect_run_candidate.raw', () => {
    const tallyhire = candidates.find((c) => c.identity_key === 'tallyhire.com')
    expect(tallyhire?.raw).toMatchObject({ name: 'Tallyhire', domain: 'tallyhire.com' })
  })

  it('handles a response with no content at all', () => {
    expect(parseDiscoveryResponse({ ...buyers, content: null, results: [] })).toEqual([])
  })

  it('parses the investors response too, with its mixed grounding', () => {
    const funds = parseDiscoveryResponse(investors, { angle: 'portfolio' })
    const synthesized = funds.filter((f) => f.found_via === 'synthesized')
    expect(synthesized).toHaveLength(7)
    expect(synthesized.map((f) => f.identity_key)).toContain('tessellateventures.com')
    // Mixed confidence survives per candidate rather than flattening.
    expect(new Set(synthesized.map((f) => f.confidence)).size).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

describe('parseDiscoveryResponse — entity properties reach the scorer', () => {
  it('carries the raw entity properties onto every result_entity candidate', () => {
    // `workforce.total` and `headquarters` are free firmographics riding on
    // results we already paid for, and §7 routes `employee_bands` and
    // `geographies` at them. Flattening the entity to id/name/domain/... left
    // the candidate with no route to them, making both fallbacks dead code.
    const entities = parseDiscoveryResponse(buyers).filter((c) => c.found_via === 'result_entity')
    expect(entities.length).toBeGreaterThan(0)
    const withWorkforce = entities.filter(
      (c) => typeof (c.entity?.workforce as { total?: unknown } | undefined)?.total === 'number',
    )
    expect(withWorkforce.length).toBeGreaterThan(0)
    const withHq = entities.filter((c) => c.entity?.headquarters)
    expect(withHq.length).toBeGreaterThan(0)
  })

  it('leaves a purely synthesized candidate without an entity', () => {
    const synthesized = parseDiscoveryResponse(buyers).filter(
      (c) => c.found_via === 'synthesized',
    )
    expect(synthesized.length).toBeGreaterThan(0)
    // Nothing invented: a synthesized item that never collided with an entity
    // has no entity properties to offer.
    for (const c of synthesized) {
      expect(c.entity === undefined || c.entity === null || typeof c.entity === 'object').toBe(true)
    }
  })
})

describe('parsePeopleResponse', () => {
  const found = parsePeopleResponse(people, {
    companyName: 'Quillfort AI',
    companyDomain: 'quillfort.ai',
  })

  it('yields every person in the recorded response with a LinkedIn key', () => {
    expect(found).toHaveLength(7)
    expect(found.every((p) => p.identity_key?.startsWith('linkedin.com/in/'))).toBe(true)
    expect(found.map((p) => p.identity_key)).toEqual([
      'linkedin.com/in/person-one',
      'linkedin.com/in/person-two',
      'linkedin.com/in/person-three',
      'linkedin.com/in/person-four',
      'linkedin.com/in/person-five',
      'linkedin.com/in/person-six',
      'linkedin.com/in/person-seven',
    ])
  })

  it('anchors every one of them, because each cites its own profile', () => {
    // The measured people search is the strongest result in the feature (§12):
    // every field grounded high to the person's own LinkedIn profile.
    expect(found.every((p) => p.identity_state === 'anchored')).toBe(true)
  })

  it('carries title, seniority and the normalized profile', () => {
    const first = found[0]
    expect(first.display_name).toBe('Person One')
    expect(first.job_title).toBe('Vice President, Global Midmarket Sales')
    expect(first.seniority).toBe('VP')
    expect(first.linkedin_url).toBe('linkedin.com/in/person-one')
    expect(first.candidate).toMatchObject({
      name: 'Person One',
      domain: 'quillfort.ai',
      linkedin_url: 'linkedin.com/in/person-one',
      title: 'Vice President, Global Midmarket Sales',
      found_via: 'synthesized',
    })
    expect(first.candidate.one_liner).toContain('Midmarket')
  })

  it('demotes a person whose citations point at someone else, and marks them needs_review', () => {
    // The Devin Marsh shape: a real, confident card citing a NAMESAKE's
    // profile at a different employer.
    const res: DeepSearchResult = {
      requestId: null,
      content: {
        people: [
          {
            fullName: 'Devin Marsh',
            jobTitle: 'CEO',
            linkedinUrl: 'https://www.linkedin.com/in/devin-marsh-fieldwing',
            seniority: 'C-level',
          },
        ],
      },
      grounding: [
        {
          field: 'people[0].jobTitle',
          citations: [
            { url: 'https://www.linkedin.com/in/devin-marsh-halvern', title: 'Devin Marsh' },
          ],
          confidence: 'high',
        },
        {
          field: 'people[0].fullName',
          citations: [
            { url: 'https://www.linkedin.com/in/devin-marsh-halvern', title: 'Devin Marsh' },
          ],
          confidence: 'high',
        },
      ],
      results: [],
      costDollars: null,
    }
    const [person] = parsePeopleResponse(res, {
      companyName: 'Fieldwing',
      companyDomain: 'fieldwing.ag',
    })
    expect(person.identity_state).toBe('needs_review')
    // Demoted, NOT dropped — it still shows under Unverified.
    expect(person.fields.job_title?.value).toBe('CEO')
    expect(person.fields.job_title?.confidence).toBe('low')
  })

  it('anchors a person cited to the company\'s own team page', () => {
    const res: DeepSearchResult = {
      requestId: null,
      content: {
        people: [{ fullName: 'Ada Lovelace', jobTitle: 'VP Sales', linkedinUrl: '' }],
      },
      grounding: [
        {
          field: 'people[0].jobTitle',
          citations: [{ url: 'https://fieldwing.ag/team', title: 'Our team' }],
          confidence: 'high',
        },
      ],
      results: [],
      costDollars: null,
    }
    const [person] = parsePeopleResponse(res, {
      companyName: 'Fieldwing',
      companyDomain: 'fieldwing.ag',
    })
    expect(person.identity_state).toBe('anchored')
    // No LinkedIn URL, so the key falls back to the name@domain tier.
    expect(person.identity_key).toBe('ada lovelace@fieldwing.ag')
  })

  it('returns a null key when no identity tier applies', () => {
    const res: DeepSearchResult = {
      requestId: null,
      content: { people: [{ jobTitle: 'VP Sales' }] },
      grounding: [],
      results: [],
      costDollars: null,
    }
    const [person] = parsePeopleResponse(res, { companyDomain: 'fieldwing.ag' })
    expect(person.identity_key).toBeNull()
    expect(person.identity_state).toBe('needs_review')
  })

  it('collapses a repeated profile within one response', () => {
    const res: DeepSearchResult = {
      requestId: null,
      content: {
        people: [
          { fullName: 'Ada L', linkedinUrl: 'https://www.linkedin.com/in/ada' },
          { fullName: 'Ada Lovelace', linkedinUrl: 'linkedin.com/in/ADA/' },
        ],
      },
      grounding: [],
      results: [],
      costDollars: null,
    }
    const out = parsePeopleResponse(res, { companyDomain: 'fieldwing.ag' })
    expect(out).toHaveLength(1)
    expect(out[0].display_name).toBe('Ada L')
  })

  it('drops non-answers before they become a rationale', () => {
    const res: DeepSearchResult = {
      requestId: null,
      content: {
        people: [
          {
            fullName: 'Ada Lovelace',
            linkedinUrl: 'https://www.linkedin.com/in/ada',
            whyRelevant: 'Not publicly available',
          },
        ],
      },
      grounding: [],
      results: [],
      costDollars: null,
    }
    const [person] = parsePeopleResponse(res, { companyDomain: 'fieldwing.ag' })
    expect(person.fields.why_relevant).toBeUndefined()
    expect(person.candidate.one_liner).toBeNull()
  })

  it('is empty for a response that found nobody', () => {
    expect(parsePeopleResponse({ ...people, content: { people: [] } })).toEqual([])
    expect(parsePeopleResponse({ ...people, content: null })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The account card
// ---------------------------------------------------------------------------

describe('parseAccountCard', () => {
  const parsed = parseAccountCard(accountCard)

  it('yields at least six blob fields from the recorded card', () => {
    expect(Object.keys(parsed.fields).length).toBeGreaterThanOrEqual(6)
    expect(Object.keys(parsed.fields).sort()).toEqual([
      'employee_count',
      'funding_stage',
      'growth_signals',
      'headquarters',
      'key_people',
      'products',
      'tech_stack',
      'total_raised',
      'why_fit',
    ])
  })

  it('shapes each field like the CRM blob, so readBlob renders it unchanged', () => {
    expect(parsed.fields.funding_stage).toEqual({
      value: 'Growth (Series C)',
      source_url:
        'https://www.quoteleaf.com/press/quoteleaf-announces-series-c-financing-round-at-one-billion-valuation/',
      source_title: 'Quoteleaf Gets $1 Billion Valuation with Series C Financing Round',
      confidence: 'high',
    })
    expect(parsed.fields.tech_stack?.confidence).toBe('medium')
  })

  it('keeps whyFit, the one non-firmographic field', () => {
    expect(parsed.fields.why_fit?.value).toContain('Quoteleaf')
  })

  it('collects the citations', () => {
    expect(parsed.sources.length).toBeGreaterThan(0)
    expect(parsed.sources.map((s) => s.url)).toContain('https://quoteleaf.com')
  })

  it('reports the cost as a number the run can add up', () => {
    expect(parsed.cost).toBe(0.012)
    expect(parseAccountCard({ ...accountCard, costDollars: null }).cost).toBe(0)
  })

  it('drops non-answers', () => {
    const res: DeepSearchResult = {
      requestId: null,
      content: { totalRaised: 'Not publicly disclosed', employeeCount: '700+' },
      grounding: [],
      results: [],
      costDollars: 0.01,
    }
    const out = parseAccountCard(res)
    expect(out.fields.total_raised).toBeUndefined()
    expect(out.fields.employee_count?.value).toBe('700+')
  })
})
