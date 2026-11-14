import { describe, expect, it } from 'vitest'
import { COMPETITORS, NI_STRENGTHS, VS_COMPETITOR_SLUGS, getCompetitor } from '@/data/vs-competitors'
import { SEAT_PRICE_USD, TRIAL_DAYS } from '@/lib/billing/access'

const all = VS_COMPETITOR_SLUGS.map((slug) => COMPETITORS[slug])

describe('the /vs comparison data', () => {
  it('has one entry per slug, filed under its own slug', () => {
    expect(Object.keys(COMPETITORS).sort()).toEqual([...VS_COMPETITOR_SLUGS].sort())
    for (const slug of VS_COMPETITOR_SLUGS) expect(COMPETITORS[slug].slug).toBe(slug)
  })

  it('keeps each title and description to what Google shows, and names the searched phrase', () => {
    for (const c of all) {
      expect(c.metaTitle.length, c.metaTitle).toBeLessThanOrEqual(60)
      expect(c.metaTitle, c.slug).toMatch(/ Alternative for .* \| Native Intelligence$/)
      expect(c.metaDescription.length, c.metaDescription).toBeGreaterThanOrEqual(70)
      expect(c.metaDescription.length, c.metaDescription).toBeLessThanOrEqual(160)
    }
  })

  it('shows the same rows, in the same order, on every page', () => {
    const rows = (slug: (typeof VS_COMPETITOR_SLUGS)[number]) => COMPETITORS[slug].matrix.map((r) => r.feature)
    const first = rows(VS_COMPETITOR_SLUGS[0])
    expect(first.length).toBeGreaterThan(5)
    for (const slug of VS_COMPETITOR_SLUGS) expect(rows(slug), slug).toEqual(first)
  })

  it('quotes our trial and seat price from billing, never an old trial length', () => {
    for (const c of all) {
      const price = c.matrix.find((r) => r.feature === 'Starting price')
      expect(price?.ni, c.slug).toBe(`${TRIAL_DAYS}-day trial, then $${SEAT_PRICE_USD}/user/mo`)
    }
    const text = JSON.stringify({ COMPETITORS, NI_STRENGTHS })
    expect(text).not.toMatch(/14-day|no credit card/i)
  })

  it('credits every vendor, dates its facts and answers its questions', () => {
    for (const c of all) {
      expect(c.theirStrengths.length, c.slug).toBeGreaterThanOrEqual(2)
      expect(c.faqs.length, c.slug).toBeGreaterThanOrEqual(3)
      expect(c.verifiedAt, c.slug).toMatch(/^[A-Z][a-z]+ 20\d\d$/)
      expect(c.audience, c.slug).toMatch(/sales teams$/)
    }
  })

  it('finds only the listed vendors, not inherited names', () => {
    expect(getCompetitor('granola')?.name).toBe('Granola')
    // Retired with the sales positioning: next.config.mjs redirects it.
    expect(getCompetitor('gong')).toBeUndefined()
    expect(getCompetitor('constructor')).toBeUndefined()
    expect(getCompetitor('toString')).toBeUndefined()
  })
})
