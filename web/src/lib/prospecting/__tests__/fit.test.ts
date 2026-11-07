/**
 * fit.ts — ONE score, from the profile.
 *
 * What is pinned here:
 *   * the bands the number is read in, at their exact floors;
 *   * how the card's `fitScore` is read (strings, decorations, fractions,
 *     junk → null, never a guess);
 *   * the anti rule — the USER'S rule — firing whole-word over everything we
 *     know about a company, and zeroing the score with the rule named;
 *   * `scoreFromProfile` reading the score from THE CARD and the rationale
 *     from the merged blob, in the documented order;
 *   * that the recorded Exa fixtures still flow through without throwing —
 *     and that the account-card fixture, recorded before `fitScore` existed,
 *     yields NO score rather than an invented one.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { groundedFields, parseDeepSearchResponse } from '@/lib/exa/deep-search'
import {
  FIT_LABEL_FLOOR,
  FIT_LABEL_TEXT,
  antiRuleHit,
  antiRuleRationale,
  fitLabel,
  parseFitScore,
  scoreFromProfile,
  type FitInputField,
} from '../fit'
import { emptyIcp } from '../icp'
import { parseDiscoveryResponse } from '../parse'
import type { Icp } from '../types'

function gf(value: string, over: Partial<FitInputField> = {}): FitInputField {
  return { value, confidence: 'high', source_url: 'https://example.com/x', ...over }
}

function icpWith(over: {
  exclude_industries?: string[]
  exclude_keywords?: string[]
}): Icp {
  const icp = emptyIcp()
  icp.anti.exclude_industries = over.exclude_industries ?? []
  icp.anti.exclude_keywords = over.exclude_keywords ?? []
  return icp
}

function fixture(name: string) {
  return JSON.parse(
    readFileSync(
      join(process.cwd(), 'src/lib/prospecting/__tests__/fixtures/exa', `${name}.json`),
      'utf8',
    ),
  ) as { response: unknown }
}

// ---------------------------------------------------------------------------
// The bands
// ---------------------------------------------------------------------------

describe('fitLabel', () => {
  it('reads the four bands at their floors', () => {
    expect(fitLabel(100)).toBe('strong')
    expect(fitLabel(FIT_LABEL_FLOOR.strong)).toBe('strong')
    expect(fitLabel(FIT_LABEL_FLOOR.strong - 1)).toBe('good')
    expect(fitLabel(FIT_LABEL_FLOOR.good)).toBe('good')
    expect(fitLabel(FIT_LABEL_FLOOR.good - 1)).toBe('partial')
    expect(fitLabel(FIT_LABEL_FLOOR.partial)).toBe('partial')
    expect(fitLabel(FIT_LABEL_FLOOR.partial - 1)).toBe('weak')
    expect(fitLabel(0)).toBe('weak')
  })

  it('is null — not cold — for an unscored entry', () => {
    expect(fitLabel(null)).toBeNull()
    expect(fitLabel(undefined)).toBeNull()
    expect(fitLabel(Number.NaN)).toBeNull()
  })

  it('has a short and a long word for every band, in the register Exa uses', () => {
    for (const label of ['strong', 'good', 'partial', 'weak'] as const) {
      expect(FIT_LABEL_TEXT[label].short).toBeTruthy()
      expect(FIT_LABEL_TEXT[label].long.startsWith(FIT_LABEL_TEXT[label].short)).toBe(true)
    }
    // Never a temperature: the CRM's relationship strength owns hot/warm/cold.
    expect(FIT_LABEL_TEXT.strong.long).toBe('Strong match')
    for (const label of ['strong', 'good', 'partial', 'weak'] as const) {
      expect(FIT_LABEL_TEXT[label].long).not.toMatch(/hot|warm|cold/i)
    }
  })
})

// ---------------------------------------------------------------------------
// Reading the card's number
// ---------------------------------------------------------------------------

describe('parseFitScore', () => {
  it('reads the stringified integer groundedFields produces', () => {
    expect(parseFitScore('85')).toBe(85)
    expect(parseFitScore(' 42 ')).toBe(42)
    expect(parseFitScore(0)).toBe(0)
    expect(parseFitScore(100)).toBe(100)
  })

  it('takes the first integer out of a decorated answer', () => {
    expect(parseFitScore('85/100')).toBe(85)
    expect(parseFitScore('85 — strong fit')).toBe(85)
    expect(parseFitScore('Score: 72.')).toBe(72)
  })

  it('reads a lone fraction as a percentage', () => {
    expect(parseFitScore('0.85')).toBe(85)
    expect(parseFitScore(0.4)).toBe(40)
    expect(parseFitScore('.9')).toBe(90)
  })

  it('rounds a decimal score', () => {
    expect(parseFitScore('72.6')).toBe(73)
    expect(parseFitScore(66.4)).toBe(66)
  })

  it('is null for junk, blanks, and out-of-range numbers — never a guess', () => {
    expect(parseFitScore('')).toBeNull()
    expect(parseFitScore('   ')).toBeNull()
    expect(parseFitScore('strong')).toBeNull()
    expect(parseFitScore('N/A')).toBeNull()
    expect(parseFitScore(null)).toBeNull()
    expect(parseFitScore(undefined)).toBeNull()
    expect(parseFitScore(150)).toBeNull()
    expect(parseFitScore('-5')).toBeNull()
    expect(parseFitScore(Number.POSITIVE_INFINITY)).toBeNull()
    expect(parseFitScore({ value: 85 })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The user's own rule
// ---------------------------------------------------------------------------

describe('antiRuleHit', () => {
  const fields = {
    name: gf('Acme Crypto Exchange'),
    one_liner: gf('A retail brokerage for digital assets.'),
    why_match: gf('They run a large inside sales team.'),
  }

  it('fires on an excluded industry and names it as the user wrote it', () => {
    const hit = antiRuleHit({ fields }, icpWith({ exclude_industries: ['crypto'] }))
    expect(hit).toEqual({ term: 'crypto', rule: 'excluded industry' })
    expect(antiRuleRationale(hit!)).toBe('Matches excluded industry "crypto".')
  })

  it('fires on an excluded keyword and names the keyword rule', () => {
    const hit = antiRuleHit({ fields }, icpWith({ exclude_keywords: ['brokerage'] }))
    expect(hit).toEqual({ term: 'brokerage', rule: 'excluded keyword' })
  })

  it('prefers the industry rule when both would fire', () => {
    const hit = antiRuleHit(
      { fields },
      icpWith({ exclude_industries: ['crypto'], exclude_keywords: ['crypto'] }),
    )
    expect(hit?.rule).toBe('excluded industry')
  })

  it('is case-insensitive and matches a multi-word term as a phrase', () => {
    expect(
      antiRuleHit({ fields }, icpWith({ exclude_industries: ['DIGITAL ASSETS'] }))?.term,
    ).toBe('DIGITAL ASSETS')
  })

  it('matches WHOLE WORDS only — "AI" must not fire on "retail"', () => {
    expect(antiRuleHit({ fields }, icpWith({ exclude_keywords: ['AI'] }))).toBeNull()
    expect(antiRuleHit({ fields }, icpWith({ exclude_keywords: ['tail'] }))).toBeNull()
    expect(
      antiRuleHit(
        { fields: { one_liner: gf('An AI copilot for underwriters.') } },
        icpWith({ exclude_keywords: ['AI'] }),
      )?.term,
    ).toBe('AI')
  })

  it('reads the company NAME, not only its prose', () => {
    expect(
      antiRuleHit(
        { fields: { name: gf('Tobacco Holdings'), one_liner: gf('A holding company.') } },
        icpWith({ exclude_industries: ['tobacco'] }),
      )?.term,
    ).toBe('tobacco')
  })

  it('reads the free entity description and its nested strings', () => {
    expect(
      antiRuleHit(
        {
          fields: { name: gf('Northwind') },
          entity: { description: 'A gambling operator', headquarters: { city: 'Macau' } },
        },
        icpWith({ exclude_industries: ['gambling'] }),
      )?.term,
    ).toBe('gambling')
    expect(
      antiRuleHit(
        { fields: { name: gf('Northwind') }, entity: { headquarters: { city: 'Macau' } } },
        icpWith({ exclude_keywords: ['Macau'] }),
      )?.term,
    ).toBe('Macau')
  })

  it('ignores blank terms and never throws on regex characters', () => {
    expect(antiRuleHit({ fields }, icpWith({ exclude_keywords: ['', '   '] }))).toBeNull()
    expect(
      antiRuleHit(
        { fields: { one_liner: gf('Pricing from $10 (per seat) [beta]') } },
        icpWith({ exclude_keywords: ['$10 (per seat) [beta]'] }),
      )?.term,
    ).toBe('$10 (per seat) [beta]')
  })

  it('is null on an empty company', () => {
    expect(antiRuleHit({}, icpWith({ exclude_industries: ['crypto'] }))).toBeNull()
    expect(antiRuleHit({ fields: null }, icpWith({ exclude_industries: ['crypto'] }))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The one scoring call
// ---------------------------------------------------------------------------

describe('scoreFromProfile', () => {
  const icp = icpWith({ exclude_industries: ['gambling'] })

  it('takes the score from THE CARD and the rationale from the merged why_fit', () => {
    const card = { fit_score: gf('87', { confidence: 'low' }), why_fit: gf('They would buy.') }
    const merged = { why_match: gf('Discovery said so.'), why_fit: gf('They would buy.') }
    expect(scoreFromProfile({ card, merged, icp })).toEqual({
      fit_score: 87,
      fit_rationale: 'They would buy.',
    })
  })

  it('never reads a score out of the merged blob — a stale one cannot leak through the merge', () => {
    const merged = { fit_score: gf('99'), why_fit: gf('Old reasoning.') }
    expect(scoreFromProfile({ card: {}, merged, icp }).fit_score).toBeNull()
  })

  it('falls back to why_match, then the previous rationale, then null', () => {
    expect(
      scoreFromProfile({ card: {}, merged: { why_match: gf('From discovery.') }, icp })
        .fit_rationale,
    ).toBe('From discovery.')
    expect(
      scoreFromProfile({ card: {}, merged: {}, icp, previousRationale: 'Kept.' }).fit_rationale,
    ).toBe('Kept.')
    expect(scoreFromProfile({ card: {}, merged: {}, icp }).fit_rationale).toBeNull()
  })

  it('leaves the score NULL when the card returned no usable number', () => {
    expect(
      scoreFromProfile({ card: { fit_score: gf('unknown') }, merged: {}, icp }).fit_score,
    ).toBeNull()
    expect(scoreFromProfile({ card: {}, merged: {}, icp }).fit_score).toBeNull()
  })

  it('zeroes the score and names the rule when the merged blob hits an anti term', () => {
    const result = scoreFromProfile({
      card: { fit_score: gf('95'), why_fit: gf('Perfect fit.') },
      merged: { products: gf('An online gambling platform'), why_fit: gf('Perfect fit.') },
      icp,
    })
    expect(result).toEqual({
      fit_score: 0,
      fit_rationale: 'Matches excluded industry "gambling".',
    })
  })
})

// ---------------------------------------------------------------------------
// Over the recorded Exa responses
// ---------------------------------------------------------------------------

describe('over the recorded responses', () => {
  it('runs the anti check over every recorded discovery candidate without a hit on an empty ICP', () => {
    const parsed = parseDeepSearchResponse(fixture('discovery-buyers-n25').response)
    const candidates = parseDiscoveryResponse(parsed)
    expect(candidates.length).toBeGreaterThan(0)
    for (const c of candidates) {
      expect(antiRuleHit({ fields: c.fields, entity: c.entity }, emptyIcp())).toBeNull()
    }
  })

  it('fires the anti rule against a recorded candidate by its industry language', () => {
    const parsed = parseDeepSearchResponse(fixture('discovery-buyers-n25').response)
    const tallyhire = parseDiscoveryResponse(parsed).find((c) => c.fields.name?.value === 'Tallyhire')
    expect(tallyhire).toBeDefined()
    expect(
      antiRuleHit(
        { fields: tallyhire!.fields, entity: tallyhire!.entity },
        icpWith({ exclude_industries: ['B2B SaaS'] }),
      )?.term,
    ).toBe('B2B SaaS')
  })

  it('yields NO score from the recorded account card, which predates fitScore — never an invented one', () => {
    const card = groundedFields(parseDeepSearchResponse(fixture('account-card-quoteleaf').response))
    expect(card.fit_score).toBeUndefined()
    const result = scoreFromProfile({ card, merged: card, icp: emptyIcp() })
    expect(result.fit_score).toBeNull()
    // The card's own why-fit is still the rationale.
    expect(result.fit_rationale).toBe(card.why_fit?.value ?? null)
    expect(result.fit_rationale).toBeTruthy()
  })
})
