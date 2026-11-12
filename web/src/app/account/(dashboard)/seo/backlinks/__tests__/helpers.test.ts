import { describe, expect, it } from 'vitest'
import type { BacklinksOverview, BacklinksTrendPoint } from '@/lib/seo/backlinks/view'
import {
  bareHost,
  changeNote,
  hasPagePath,
  historyChange,
  historySpan,
  monthNewLost,
  overviewTiles,
  ownSiteLookup,
  percent,
  sameSite,
  siteHref,
  siteOfLabel,
  splitUrl,
  trendSummary,
} from '../helpers'
import { defaultControls, profileFilters } from '../use-profile'

const p = (date: string, rd: number | null, bl: number | null, extra: Partial<BacklinksTrendPoint> = {}): BacklinksTrendPoint => ({
  date,
  referring_domains: rd,
  backlinks: bl,
  rank: null,
  new_backlinks: null,
  lost_backlinks: null,
  new_referring_domains: null,
  lost_referring_domains: null,
  ...extra,
})

const summary: BacklinksOverview['summary'] = {
  rank: null,
  backlinks: 12480,
  referring_pages: null,
  referring_domains: 420,
  broken_backlinks: null,
  broken_pages: null,
  dofollow_share: null,
  backlinks_spam_score: null,
  target_spam_score: null,
  new_backlinks: null,
  lost_backlinks: null,
  new_referring_domains: null,
  lost_referring_domains: null,
}
const ov = (extra: Partial<BacklinksOverview> = {}): BacklinksOverview => ({
  lookup_id: 'l1',
  target: 'fernhillstudio.example',
  display_target: 'fernhillstudio.example',
  scope: 'subdomains',
  summary,
  history: [],
  scope_note: null,
  fetched_at: '2026-11-12T09:00:00Z',
  from_cache: true,
  ...extra,
})

describe('sites and labels', () => {
  it('reads a typed site as a bare host, and compares sites', () => {
    expect(bareHost('https://www.Fernhillstudio.example/shop')).toBe('fernhillstudio.example')
    expect(bareHost('  ')).toBe('')
    expect(sameSite('www.fernhillstudio.example', 'https://fernhillstudio.example/')).toBe(true)
    expect(sameSite('', '')).toBe(false)
    expect(siteOfLabel('fernhillstudio.example · backlinks overview')).toBe('fernhillstudio.example')
  })

  it('finds the own site’s whole-site lookup, never a page of it', () => {
    const lookups = [
      { id: 'a', label: 'fernhillstudio.example/journal · backlinks overview' },
      { id: 'b', label: 'oakandloom.example · backlinks overview' },
      { id: 'c', label: 'fernhillstudio.example · backlinks overview' },
    ]
    expect(ownSiteLookup(lookups, 'fernhillstudio.example')?.id).toBe('c')
    expect(ownSiteLookup(lookups, null)).toBeUndefined()
  })

  it('knows when an address names a page', () => {
    expect(hasPagePath('fernhillstudio.example')).toBe(false)
    expect(hasPagePath('https://fernhillstudio.example/')).toBe(false)
    expect(hasPagePath('fernhillstudio.example/journal/')).toBe(true)
    expect(hasPagePath('')).toBe(false)
  })

  it('splits a linking address into its site and path', () => {
    expect(splitUrl('https://www.oakandloom.example/blog/x?y=1')).toEqual({ site: 'www.oakandloom.example', path: '/blog/x?y=1' })
    expect(splitUrl('https://oakandloom.example/')).toEqual({ site: 'oakandloom.example', path: '' })
    expect(splitUrl(null)).toEqual({ site: '', path: '' })
    expect(siteHref('oakandloom.example')).toBe('https://oakandloom.example')
  })
})

describe('the overview’s numbers', () => {
  it('words the followed share and the year’s change', () => {
    expect(percent(0.823)).toBe('82%')
    expect(percent(null)).toBeNull()
    const history = [p('2025-11-01', 300, null), p('2026-06-01', null, 11000), p('2026-11-01', 420, 12000)]
    expect(historyChange(history, 'referring_domains')).toBe(120)
    expect(historyChange([p('2026-11-01', 1, 1)], 'backlinks')).toBeNull()
    expect(changeNote(120, 'in a year')).toEqual({ note: 'up 120 in a year', tone: 'up' })
    expect(changeNote(-4, 'in a year')).toEqual({ note: 'down 4 in a year', tone: 'down' })
    expect(changeNote(0, 'in a year')).toEqual({ note: 'no change in a year', tone: 'flat' })
    expect(historySpan(history, new Date('2026-11-12T00:00:00Z'))).toBe('in a year')
    expect(historySpan([p('2026-09-04', 1, 1)], new Date('2026-11-12T00:00:00Z'))).toMatch(/^since /)
  })

  it('sums the newest month’s new and lost, daily or monthly', () => {
    const daily = [
      p('2026-10-31', 1, 1, { new_referring_domains: 9 }),
      p('2026-11-01', 1, 1, { new_referring_domains: 2, lost_referring_domains: 1, new_backlinks: 5 }),
      p('2026-11-02', 1, 1, { new_referring_domains: 3, lost_referring_domains: 0, new_backlinks: 7, lost_backlinks: 2 }),
    ]
    expect(monthNewLost(daily)).toEqual({ newSites: 5, lostSites: 1, newLinks: 12, lostLinks: 2 })
    expect(monthNewLost([])).toBeNull()
    expect(monthNewLost([p('2026-11-01', 1, 1)])).toBeNull()
  })

  it('draws only the tiles the overview carries a number for', () => {
    expect(overviewTiles(ov(), true).map((t) => t.key)).toEqual(['sites', 'links'])
    expect(overviewTiles(ov(), true)[0].label).toBe('Sites linking to you')
    expect(overviewTiles(ov(), false)[0].label).toBe('Sites linking to it')
    const full = overviewTiles(
      ov({
        summary: { ...summary, dofollow_share: 0.5, rank: 200, target_spam_score: 3 },
        history: [p('2025-11-01', 300, 9000), p('2026-11-01', 420, 12480, { new_referring_domains: 4, lost_referring_domains: 0, lost_backlinks: 0 })],
      }),
      true,
      new Date('2026-11-12T00:00:00Z'),
    )
    expect(full.map((t) => t.key)).toEqual(['sites', 'links', 'followed', 'new', 'lost', 'rank', 'spam'])
    expect(full.find((t) => t.key === 'followed')!.value).toBe('50%')
    expect(full.find((t) => t.key === 'sites')!.note).toBe('up 120 in a year')
    // A zero count is not a note.
    expect(full.find((t) => t.key === 'lost')!.note).toBeUndefined()
  })

  it('says what each trend shows in a sentence', () => {
    const history = [p('2025-11-01', 300, 9000), p('2026-11-01', 420, 12480)]
    expect(trendSummary(history, 'referring_domains', 'Sites linking')).toMatch(/^Sites linking: 300 on .+, 420 on .+\.$/)
    expect(trendSummary([], 'backlinks', 'Links')).toBe('Links: not enough history yet.')
  })
})

describe('the lists’ requests', () => {
  it('sends the Links tab’s filters, and only "contains" for the others', () => {
    expect(defaultControls('backlinks')).toEqual({ sort: 'firstSeen', hideLost: false, hideSpam: true, include: '', domainFrom: null })
    expect(defaultControls('domains').sort).toBe('backlinks')
    const c = { ...defaultControls('backlinks'), include: ' blog ', hideLost: true, domainFrom: 'oakandloom.example' }
    expect(profileFilters('backlinks', c)).toEqual({ include: 'blog', hideLost: true, domainFrom: 'oakandloom.example' })
    expect(profileFilters('domains', c)).toEqual({ include: 'blog' })
    expect(profileFilters('pages', defaultControls('pages'))).toEqual({})
  })
})
