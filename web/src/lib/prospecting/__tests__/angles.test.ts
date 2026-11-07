/**
 * `buildDiscoveryAngles` and `buildDiscoverySystemPrompt` (spec §7, §15).
 *
 * The assertions that matter most, and why:
 *
 *   * FOUR angles, always. A thin ICP that silently produces two angles is a
 *     round that quietly halves its yield and still bills for the calls it did
 *     make.
 *   * Investor angles CITE `comparables`. §12 measured that the naive category
 *     phrasing returns obscure funds; the portfolio-evidence phrasing is the
 *     only mitigation we have, and a regression here is invisible in the UI —
 *     the run still succeeds, it just returns junk.
 *   * Round 2 DIFFERS from round 1. A verbatim re-ask returns the same page of
 *     results and bills full price for it.
 *   * The suppression list is capped at 30. Past that the marginal domain buys
 *     nothing (the prompt is soft — 2 of 30 leaked in the probe) and costs
 *     prompt budget.
 */
import { describe, it, expect } from 'vitest'
import {
  DISCOVERY_ANGLES_PER_ROUND,
  MAX_SUPPRESSED_DOMAINS_IN_PROMPT,
  buildDiscoveryAngles,
  buildDiscoverySystemPrompt,
  capSuppressedDomains,
  discoveryNounFor,
} from '../angles'
import { emptyIcp } from '../icp'
import type { Icp } from '../types'

/** A fully-specified ICP, the shape `buildIcpDraft` produces from an enriched
 *  company plus a few user edits. */
function fullIcp(overrides: Partial<Icp> = {}): Icp {
  const base = emptyIcp()
  return {
    ...base,
    ...overrides,
    source: {
      company_id: 'co-1',
      name: 'Dial8',
      domain: 'dial8.ai',
      what_we_sell: 'an AI meeting-capture and CRM workspace',
      our_customers: ['Globex', 'Initech'],
      ...(overrides.source ?? {}),
    },
    target: {
      description: 'B2B SaaS companies with 20-300 sales reps',
      industries: ['B2B SaaS', 'Developer Tools'],
      employee_bands: ['51-200', '201-1000'],
      geographies: ['United States', 'United Kingdom'],
      buyer_titles: ['VP Sales', 'RevOps Lead'],
      use_cases: ['pipeline hygiene', 'meeting notes'],
      competitors: ['Gong', 'Clari'],
      comparables: ['Gong', 'Clari', 'Attio', 'Granola'],
      ...(overrides.target ?? {}),
    },
    anti: {
      exclude_industries: [],
      exclude_keywords: [],
      notes: '',
      ...(overrides.anti ?? {}),
    },
    search_hint: overrides.search_hint ?? '',
  }
}

describe('buildDiscoveryAngles — shape', () => {
  it('returns at most four non-empty angles for every purpose, even on an empty ICP', () => {
    for (const purpose of ['buyers', 'investors', 'partners', 'talent', 'custom'] as const) {
      for (const icp of [fullIcp(), emptyIcp()]) {
        const angles = buildDiscoveryAngles(icp, purpose, 1)
        expect(angles.length, `${purpose} angles`).toBeGreaterThan(0)
        expect(angles.length, `${purpose} angles`).toBeLessThanOrEqual(DISCOVERY_ANGLES_PER_ROUND)
        for (const angle of angles) {
          expect(angle.query.trim(), `${purpose}/${angle.key} query`).not.toBe('')
          expect(angle.additionalQueries.length).toBeLessThanOrEqual(3)
        }
      }
    }
  })

  it('a full ICP still phrases all four distinct angles', () => {
    for (const purpose of ['buyers', 'investors', 'partners', 'talent', 'custom'] as const) {
      const angles = buildDiscoveryAngles(fullIcp(), purpose, 1)
      expect(angles, `${purpose} angles`).toHaveLength(DISCOVERY_ANGLES_PER_ROUND)
    }
  })

  it('NEVER fires two paid calls for the same query — for any ICP, purpose or round', () => {
    // Each angle is one billed deep search (§7: ≈$0.027 at numResults 25), and
    // §9's caps are sized on four DISTINCT angles. A duplicate primary is money
    // spent to re-ask a question we already asked in the same round.
    const thin = emptyIcp()
    const noCustomers = fullIcp({ source: { ...fullIcp().source, our_customers: [] } })
    const noIndustries = fullIcp({ target: { ...fullIcp().target, industries: [] } })
    for (const icp of [fullIcp(), thin, noCustomers, noIndustries]) {
      for (const purpose of ['buyers', 'investors', 'partners', 'talent', 'custom'] as const) {
        for (const round of [1, 2, 3]) {
          const angles = buildDiscoveryAngles(icp, purpose, round)
          const queries = angles.map((a) => a.query)
          expect(new Set(queries).size, `${purpose} r${round}`).toBe(queries.length)
        }
      }
    }
  })

  it('collapses the thin-ICP fallbacks down to the distinct questions only', () => {
    // No description, no use cases, no industries, no customers: the lookalike
    // and segment slots both fall back to the direct phrasing, so a round that
    // fired four slots would bill four calls for two questions.
    const angles = buildDiscoveryAngles(emptyIcp(), 'buyers', 1)
    expect(angles.map((a) => a.key)).toEqual(['direct', 'signal'])
  })

  it('uses the direct/lookalike/segment/signal keys for the general purposes', () => {
    const keys = buildDiscoveryAngles(fullIcp(), 'buyers', 1).map((a) => a.key)
    expect(keys).toEqual(['direct', 'lookalike', 'segment', 'signal'])
  })

  it('uses the investors key set for investors', () => {
    const keys = buildDiscoveryAngles(fullIcp(), 'investors', 1).map((a) => a.key)
    expect(keys).toEqual(['portfolio', 'stage', 'thesis', 'activity'])
  })

  it("carries the OTHER angles' phrasings as additionalQueries, never its own", () => {
    const angles = buildDiscoveryAngles(fullIcp(), 'buyers', 1)
    for (const angle of angles) {
      expect(angle.additionalQueries).not.toContain(angle.query)
      for (const extra of angle.additionalQueries) {
        expect(angles.map((a) => a.query)).toContain(extra)
      }
    }
  })

  it('drops the duplicate slot rather than paying to ask twice', () => {
    // No customers → the lookalike angle falls back to the direct phrasing
    // (§7). The two are then identical, and the duplicate slot must not be
    // returned at all — neither as a primary nor as an additionalQuery.
    const icp = fullIcp({ source: { ...fullIcp().source, our_customers: [] } })
    const angles = buildDiscoveryAngles(icp, 'buyers', 1)
    expect(angles.map((a) => a.key)).toEqual(['direct', 'segment', 'signal'])
    for (const angle of angles) {
      expect(new Set(angle.additionalQueries).size).toBe(angle.additionalQueries.length)
      expect(angle.additionalQueries).not.toContain(angle.query)
    }
  })
})

describe('buildDiscoveryAngles — content', () => {
  it("angle 1 names what we sell and the target description", () => {
    const [direct] = buildDiscoveryAngles(fullIcp(), 'buyers', 1)
    expect(direct.query).toContain('an AI meeting-capture and CRM workspace')
    expect(direct.query).toContain('B2B SaaS companies with 20-300 sales reps')
  })

  it('angle 2 names our own customers when we have them', () => {
    const angles = buildDiscoveryAngles(fullIcp(), 'buyers', 1)
    expect(angles[1].query).toContain('Globex')
    expect(angles[1].query).toContain('Initech')
  })

  it('angle 3 narrows on industries, bands and geographies', () => {
    const angles = buildDiscoveryAngles(fullIcp(), 'buyers', 1)
    expect(angles[2].query).toContain('B2B SaaS')
    expect(angles[2].query).toContain('51-200')
    expect(angles[2].query).toContain('United States')
  })

  it('angle 4 names the buyer titles as a hiring signal', () => {
    const angles = buildDiscoveryAngles(fullIcp(), 'buyers', 1)
    expect(angles[3].query).toMatch(/hiring/i)
    expect(angles[3].query).toContain('VP Sales')
  })

  it('never doubles the noun when the signal angle falls back to the direct phrasing', () => {
    // With `industries` empty the signal subject falls back to `directSubject`,
    // which already ends in "…companies with 20-300 sales reps". Appending
    // " companies" again produced "…sales reps companies that are hiring" —
    // broken grammar in a query we pay for, and paid retrieval is only as good
    // as its phrasing.
    const icp = fullIcp({ target: { ...fullIcp().target, industries: [] } })
    const signal = buildDiscoveryAngles(icp, 'buyers', 1).find((a) => a.key === 'signal')!
    expect(signal.query).not.toMatch(/companies\s+companies/i)
    expect(signal.query).toBe(
      'B2B SaaS companies with 20-300 sales reps, hiring VP Sales and RevOps Lead or recently funded',
    )
  })

  it('still appends the noun when the signal subject IS a bare industry list', () => {
    const signal = buildDiscoveryAngles(fullIcp(), 'buyers', 1).find((a) => a.key === 'signal')!
    expect(signal.query).toMatch(/^B2B SaaS and Developer Tools companies hiring /)
  })

  it('changes the direct verb for partners and talent', () => {
    const partners = buildDiscoveryAngles(fullIcp(), 'partners', 1)[0].query
    const talent = buildDiscoveryAngles(fullIcp(), 'talent', 1)[0].query
    expect(partners).toMatch(/complements/i)
    expect(talent).toMatch(/hire/i)
    expect(partners).not.toBe(talent)
  })
})

describe('buildDiscoveryAngles — investors cite comparables (§12)', () => {
  const icp = fullIcp()

  it('every investor angle names at least one comparable', () => {
    const angles = buildDiscoveryAngles(icp, 'investors', 1)
    for (const angle of angles) {
      const named = icp.target.comparables.some((c) => angle.query.includes(c))
      expect(named, `${angle.key} must cite portfolio evidence: ${angle.query}`).toBe(true)
    }
  })

  it('the portfolio angle uses the measured "led seed or Series A rounds in" phrasing', () => {
    const [portfolio] = buildDiscoveryAngles(icp, 'investors', 1)
    expect(portfolio.key).toBe('portfolio')
    expect(portfolio.query).toMatch(/led seed or Series A rounds in/i)
    expect(portfolio.query).toContain('Gong')
  })

  it('never emits the naive category-only phrasing when comparables exist', () => {
    for (const angle of buildDiscoveryAngles(icp, 'investors', 1)) {
      expect(angle.query).not.toMatch(/^VC funds that invest in [^,]+$/i)
    }
  })

  it('falls back to competitors, then our_customers, before a bare category', () => {
    const noComparables = fullIcp({
      target: { ...fullIcp().target, comparables: [] },
    })
    expect(buildDiscoveryAngles(noComparables, 'investors', 1)[0].query).toContain('Gong')

    const onlyCustomers = fullIcp({
      target: { ...fullIcp().target, comparables: [], competitors: [] },
    })
    expect(buildDiscoveryAngles(onlyCustomers, 'investors', 1)[0].query).toContain('Globex')
  })

  it('still produces four non-empty angles with no evidence at all', () => {
    const bare = fullIcp({
      source: { ...fullIcp().source, our_customers: [] },
      target: { ...fullIcp().target, comparables: [], competitors: [] },
    })
    const angles = buildDiscoveryAngles(bare, 'investors', 1)
    expect(angles).toHaveLength(4)
    for (const angle of angles) expect(angle.query.trim()).not.toBe('')
  })
})

describe('buildDiscoveryAngles — rounds', () => {
  const icp = fullIcp()

  it('round 2 differs from round 1', () => {
    const one = buildDiscoveryAngles(icp, 'buyers', 1)
    const two = buildDiscoveryAngles(icp, 'buyers', 2)
    expect(two.map((a) => a.query)).not.toEqual(one.map((a) => a.query))
  })

  it('broadens exactly the two narrowest slots, leaving 1 and 2 verbatim', () => {
    const one = buildDiscoveryAngles(icp, 'buyers', 1)
    const two = buildDiscoveryAngles(icp, 'buyers', 2)
    expect(two[0].query).toBe(one[0].query)
    expect(two[1].query).toBe(one[1].query)
    expect(two[2].query).not.toBe(one[2].query)
    expect(two[3].query).not.toBe(one[3].query)
    expect(two[2].query.startsWith(one[2].query)).toBe(true)
  })

  it('broadens the investors set too', () => {
    const one = buildDiscoveryAngles(icp, 'investors', 1)
    const two = buildDiscoveryAngles(icp, 'investors', 2)
    expect(two[2].query).not.toBe(one[2].query)
    expect(two[3].query).not.toBe(one[3].query)
  })

  it('round 3 differs from round 2 as well — successive rounds must not collide', () => {
    const two = buildDiscoveryAngles(icp, 'buyers', 2)
    const three = buildDiscoveryAngles(icp, 'buyers', 3)
    expect(three[2].query).not.toBe(two[2].query)
  })

  it('defaults to round 1', () => {
    expect(buildDiscoveryAngles(icp, 'buyers')).toEqual(buildDiscoveryAngles(icp, 'buyers', 1))
  })
})

describe('buildDiscoveryAngles — search_hint', () => {
  const hint = 'only companies that publish an engineering blog'

  it('appends the hint to all four queries', () => {
    const angles = buildDiscoveryAngles(fullIcp({ search_hint: hint }), 'buyers', 1)
    for (const angle of angles) {
      expect(angle.query, angle.key).toContain(hint)
    }
  })

  it('appends it to every additionalQuery too — Exa retrieves on each of them', () => {
    const angles = buildDiscoveryAngles(fullIcp({ search_hint: hint }), 'buyers', 1)
    for (const angle of angles) {
      for (const extra of angle.additionalQueries) expect(extra).toContain(hint)
    }
  })

  it('keeps the hint LAST, after any round-2 broadening clause', () => {
    const angles = buildDiscoveryAngles(fullIcp({ search_hint: hint }), 'buyers', 2)
    expect(angles[2].query.endsWith(hint)).toBe(true)
  })

  it('appends it to the investor angles as well', () => {
    const angles = buildDiscoveryAngles(fullIcp({ search_hint: hint }), 'investors', 1)
    for (const angle of angles) expect(angle.query).toContain(hint)
  })
})

describe('buildDiscoverySystemPrompt', () => {
  const icp = fullIcp()

  it('contains the source-company description', () => {
    const prompt = buildDiscoverySystemPrompt(icp)
    expect(prompt).toContain('Dial8')
    expect(prompt).toContain('dial8.ai')
    expect(prompt).toContain('an AI meeting-capture and CRM workspace')
  })

  it('states the UP TO N DISTINCT contract with the domain requirement', () => {
    const prompt = buildDiscoverySystemPrompt(icp, { targetCount: 20 })
    expect(prompt).toContain('Return UP TO 20 DISTINCT companies')
    expect(prompt).toMatch(/one entry per company/i)
    expect(prompt).toMatch(/primary website domain/i)
  })

  it('says "venture funds" for an investor run so the model returns funds, not portfolios', () => {
    const prompt = buildDiscoverySystemPrompt(icp, {
      noun: discoveryNounFor('investors'),
      targetCount: 15,
    })
    expect(prompt).toContain('Return UP TO 15 DISTINCT venture funds')
    expect(prompt).toContain('one entry per venture fund')
  })

  it('injects the anti terms', () => {
    const prompt = buildDiscoverySystemPrompt(
      fullIcp({
        anti: {
          exclude_industries: ['staffing agencies', 'crypto'],
          exclude_keywords: ['recruiting', 'outsourcing'],
          notes: 'No government contractors.',
        },
      }),
    )
    expect(prompt).toContain('staffing agencies')
    expect(prompt).toContain('crypto')
    expect(prompt).toContain('recruiting')
    expect(prompt).toContain('outsourcing')
    expect(prompt).toContain('No government contractors.')
  })

  it('names the suppressed domains under a NEVER include clause', () => {
    const prompt = buildDiscoverySystemPrompt(icp, {
      suppressedDomains: ['chimewell.io', 'forecastly.com'],
    })
    expect(prompt).toMatch(/NEVER include any of these already-known domains: /)
    expect(prompt).toContain('chimewell.io')
    expect(prompt).toContain('forecastly.com')
  })

  it('caps the suppressed domains at 30', () => {
    const many = Array.from({ length: 120 }, (_, i) => `example${i}.com`)
    const prompt = buildDiscoverySystemPrompt(icp, { suppressedDomains: many })
    const named = many.filter((d) => prompt.includes(d))
    expect(named).toHaveLength(MAX_SUPPRESSED_DOMAINS_IN_PROMPT)
    // The cap keeps the CALLER'S order — it prefers CRM + this-list keys.
    expect(named[0]).toBe('example0.com')
    expect(prompt).not.toContain('example30.com')
  })

  it('omits the NEVER-include clause entirely when nothing is suppressed', () => {
    expect(buildDiscoverySystemPrompt(icp)).not.toMatch(/NEVER include/)
  })

  it('renders from an empty ICP without emitting an empty clause', () => {
    const prompt = buildDiscoverySystemPrompt(emptyIcp())
    expect(prompt).toContain('Return UP TO 20 DISTINCT companies')
    expect(prompt).not.toMatch(/Source: \./)
    expect(prompt).not.toMatch(/mentions: \./)
  })
})

describe('capSuppressedDomains', () => {
  it('lowercases, trims, dedupes and caps at 30', () => {
    expect(capSuppressedDomains([' Chimewell.IO ', 'chimewell.io', 'forecastly.com'])).toEqual([
      'chimewell.io',
      'forecastly.com',
    ])
    expect(
      capSuppressedDomains(Array.from({ length: 50 }, (_, i) => `d${i}.com`)),
    ).toHaveLength(MAX_SUPPRESSED_DOMAINS_IN_PROMPT)
  })
})
