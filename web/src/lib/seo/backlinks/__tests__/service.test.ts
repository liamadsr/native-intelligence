/**
 * Backlinks lookups (../service.ts): shaped from the provider's rows, stored
 * as snapshots and answered from them, bought again only on `refresh`, and
 * refused before anything is bought when search data may not be used or the
 * request is ours to refuse.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  readLookup: vi.fn(),
  writeLookup: vi.fn(),
  workspaceSiteUrl: vi.fn(),
}))
vi.mock('@/lib/seo/lookup-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/seo/lookup-cache')>()),
  readLookup: h.readLookup,
  writeLookup: h.writeLookup,
}))
vi.mock('@/lib/seo/site', () => ({ workspaceSiteUrl: h.workspaceSiteUrl }))

import { normalizeBacklinksTarget } from '@/lib/seo/dataforseo/backlinks-target'
import { SeoInputError } from '@/lib/seo/input-error'
import {
  BACKLINKS_OVERVIEW_KIND,
  backlinksHistoryRange,
  dofollowShare,
  getBacklinksOverview,
  getBacklinksProfile,
  profileRequestKey,
} from '../service'

const WS = '00000000-0000-4000-8000-000000000001'
const PERSON = '00000000-0000-4000-8000-0000000000aa'
const svc = {} as SupabaseClient
const who = { workspaceId: WS, userId: PERSON }
const now = () => new Date('2026-11-12T10:00:00Z')

function client() {
  return {
    backlinks: {
      summary: vi.fn(async () => ({
        target: 'example.com',
        rank: 41,
        backlinks: 1200,
        referring_domains: 140,
        referring_pages: 900,
        new_reffering_domains: 6,
        lost_reffering_domains: 2,
        info: { target_spam_score: 3 },
        referring_links_attributes: { nofollow: 300 },
      })),
      history: vi.fn(async () => [
        {
          date: '2026-11-10 00:00:00 +00:00',
          backlinks: 1200,
          referring_domains: 140,
          rank: 41,
          new_backlinks: 10,
          lost_backlinks: 4,
        },
        {
          date: '2026-11-09 00:00:00 +00:00',
          backlinks: 1190,
          referring_domains: 139,
          rank: 41,
        },
      ]),
      rows: vi.fn(async () => ({
        items: [
          {
            domain_from: 'blog.example.org',
            url_from: 'https://blog.example.org/post',
            url_to: 'https://example.com/',
            anchor: 'a fine studio',
            dofollow: true,
            rank: 30,
            backlink_spam_score: 2,
            first_seen: '2025-01-02 03:04:05 +00:00',
          },
        ],
        totalCount: 2,
      })),
      referringDomains: vi.fn(async () => ({
        items: [{ domain: 'example.org', backlinks: 3 }],
        totalCount: 1,
      })),
      domainPages: vi.fn(async () => ({
        items: [
          {
            page: 'https://example.com/work',
            backlinks: 50,
            referring_domains: 9,
          },
        ],
        totalCount: 1,
      })),
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.readLookup.mockResolvedValue(null)
  h.writeLookup.mockImplementation(async (_svc, _who, entry) => ({
    id: 'lookup-1',
    kind: entry.kind,
    label: entry.label,
    request: entry.request,
    result: entry.result,
    fetched_at: '2026-11-12T10:00:00.000Z',
    fetched_by: PERSON,
  }))
  h.workspaceSiteUrl.mockResolvedValue('https://www.example.com/home')
})

const allow = { checkAccess: vi.fn(async () => ({ ok: true as const })) }

describe('getBacklinksOverview', () => {
  it('buys the summary and a year of history for the workspace’s own site, shaped and stored', async () => {
    const c = client()
    const out = await getBacklinksOverview(
      svc,
      who,
      {},
      { client: c as never, ...allow, now },
    )
    if (!out.ok) throw new Error('expected ok')
    expect(c.backlinks.summary).toHaveBeenCalledWith({
      target: 'example.com',
      includeSubdomains: true,
    })
    expect(c.backlinks.history).toHaveBeenCalledWith({
      target: 'example.com',
      dateFrom: '2025-11-11',
      dateTo: '2026-11-11',
    })
    expect(out.overview).toMatchObject({
      target: 'example.com',
      scope: 'subdomains',
      from_cache: false,
      lookup_id: 'lookup-1',
      summary: {
        rank: 41,
        backlinks: 1200,
        referring_domains: 140,
        dofollow_share: 0.75,
        new_referring_domains: 6,
        lost_referring_domains: 2,
        target_spam_score: 3,
      },
    })
    expect(out.overview.history.map((p) => p.date)).toEqual([
      '2026-11-09',
      '2026-11-10',
    ])
    expect(h.writeLookup).toHaveBeenCalledWith(
      svc,
      { workspaceId: WS, userId: PERSON },
      expect.objectContaining({ kind: BACKLINKS_OVERVIEW_KIND }),
      expect.anything(),
    )
  })

  it('answers from a fresh stored overview without buying or checking access', async () => {
    h.readLookup.mockResolvedValue({
      id: 'old',
      result: { target: 'example.com', summary: { rank: 1 }, history: [] },
      fetched_at: '2026-11-12T01:00:00.000Z',
    })
    const c = client()
    const checkAccess = vi.fn()
    const out = await getBacklinksOverview(
      svc,
      who,
      { target: 'example.com' },
      { client: c as never, checkAccess, now },
    )
    expect(out).toMatchObject({
      ok: true,
      overview: {
        from_cache: true,
        lookup_id: 'old',
        fetched_at: '2026-11-12T01:00:00.000Z',
      },
    })
    expect(c.backlinks.summary).not.toHaveBeenCalled()
    expect(checkAccess).not.toHaveBeenCalled()
  })

  it('buys again on refresh', async () => {
    h.readLookup.mockResolvedValue({
      id: 'old',
      result: { summary: {}, history: [] },
      fetched_at: 'x',
    })
    const c = client()
    await getBacklinksOverview(
      svc,
      who,
      { target: 'example.com', refresh: true },
      { client: c as never, ...allow, now },
    )
    expect(h.readLookup).not.toHaveBeenCalled()
    expect(c.backlinks.summary).toHaveBeenCalledTimes(1)
  })

  it('returns the access refusal and buys nothing', async () => {
    const c = client()
    const out = await getBacklinksOverview(
      svc,
      who,
      { target: 'example.com' },
      {
        client: c as never,
        checkAccess: async () => ({
          ok: false,
          code: 'FREE_PLAN',
          message: 'paid plan',
        }),
      },
    )
    expect(out).toMatchObject({ ok: false, code: 'FREE_PLAN' })
    expect(c.backlinks.summary).not.toHaveBeenCalled()
  })

  it('asks which website when none is named and the workspace has none', async () => {
    h.workspaceSiteUrl.mockResolvedValue(null)
    expect(
      await getBacklinksOverview(
        svc,
        who,
        {},
        { client: client() as never, ...allow },
      ),
    ).toMatchObject({ ok: false, code: 'NO_SITE' })
  })

  it('a page has no history; a subfolder is counted from two filtered lists', async () => {
    const c = client()
    const page = await getBacklinksOverview(
      svc,
      who,
      { target: 'https://example.com/work/brand', scope: 'exact_url' },
      { client: c as never, ...allow, now },
    )
    expect(c.backlinks.history).not.toHaveBeenCalled()
    expect(page.ok && page.overview.scope_note).toMatch(/single page/)

    const c2 = client()
    const sub = await getBacklinksOverview(
      svc,
      who,
      { target: 'example.com/blog', scope: 'subfolder' },
      { client: c2 as never, ...allow, now },
    )
    expect(c2.backlinks.summary).not.toHaveBeenCalled()
    expect(
      (
        c2.backlinks.rows.mock.calls as unknown as Array<[{ mode: string }]>
      ).map(([i]) => i.mode),
    ).toEqual(['as_is', 'one_per_domain'])
    expect(sub.ok && sub.overview.summary).toMatchObject({
      backlinks: 2,
      referring_domains: 2,
      rank: null,
    })
  })

  it('shows a subdomain’s summary without history when history fails, but a domain’s failure is a failure', async () => {
    const c = client()
    c.backlinks.history.mockRejectedValue(new Error('history down'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await getBacklinksOverview(
      svc,
      who,
      { target: 'blog.example.com' },
      { client: c as never, ...allow, now },
    )
    expect(out.ok && out.overview.history).toEqual([])
    await expect(
      getBacklinksOverview(
        svc,
        who,
        { target: 'example.com' },
        { client: c as never, ...allow, now },
      ),
    ).rejects.toThrow('history down')
  })
})

describe('getBacklinksProfile', () => {
  const base = { page: 2, page_size: 50, sort_order: 'desc' as const }

  it('reads one page of backlinks with the scope, spam and sort applied', async () => {
    const c = client()
    const out = await getBacklinksProfile(
      svc,
      who,
      {
        tab: 'backlinks',
        target: 'example.com',
        ...base,
        sort_field: 'rank',
        filters: { linkType: 'dofollow' },
        mode: 'as_is',
        hide_spam: true,
      },
      { client: c as never, ...allow, now },
    )
    expect(c.backlinks.rows).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'example.com',
        limit: 50,
        offset: 50,
        orderBy: ['rank,desc'],
        mode: 'as_is',
        hideSpam: true,
        filters: [['dofollow', '=', true]],
      }),
    )
    if (!out.ok) throw new Error('expected ok')
    expect(out.profile).toMatchObject({
      tab: 'backlinks',
      page: 2,
      total_count: 2,
      has_more: false,
    })
    expect(out.profile.rows[0]).toMatchObject({
      anchor: 'a fine studio',
      first_seen: '2025-01-02',
      dofollow: true,
      is_lost: false,
    })
  })

  it('refuses too many filter conditions in its own words, before buying', async () => {
    const c = client()
    const run = getBacklinksProfile(
      svc,
      who,
      {
        tab: 'backlinks',
        target: 'example.com',
        ...base,
        sort_field: 'rank',
        filters: { include: 'a,b,c,d', exclude: 'e,f,g' },
        mode: 'as_is',
        hide_spam: true,
      },
      { client: c as never, ...allow, now },
    )
    await expect(run).rejects.toBeInstanceOf(SeoInputError)
    expect(c.backlinks.rows).not.toHaveBeenCalled()
  })

  it('refuses the referring-domains list for a subfolder', async () => {
    const c = client()
    await expect(
      getBacklinksProfile(
        svc,
        who,
        {
          tab: 'domains',
          target: 'example.com/blog',
          scope: 'subfolder',
          ...base,
          sort_field: 'backlinks',
          filters: {},
          hide_spam: true,
        },
        { client: c as never, ...allow, now },
      ),
    ).rejects.toThrow(/subfolder/)
    expect(c.backlinks.referringDomains).not.toHaveBeenCalled()
  })

  it('keys a stored page on exactly what changes the answer', () => {
    const t = normalizeBacklinksTarget('example.com')
    const a = profileRequestKey(t, {
      tab: 'pages',
      target: 'example.com',
      ...base,
      sort_field: 'backlinks',
      filters: {},
    })
    const b = profileRequestKey(t, {
      tab: 'pages',
      target: 'example.com',
      ...base,
      sort_field: 'backlinks',
      filters: {},
      refresh: true,
    })
    expect(a).toEqual(b)
    expect(
      profileRequestKey(t, {
        tab: 'pages',
        target: 'example.com',
        ...base,
        page: 3,
        sort_field: 'backlinks',
        filters: {},
      }),
    ).not.toEqual(a)
  })
})

describe('helpers', () => {
  it('reads the history window as the year before yesterday (UTC)', () => {
    expect(backlinksHistoryRange(new Date('2026-03-01T00:30:00Z'))).toEqual({
      dateFrom: '2025-02-28',
      dateTo: '2026-02-28',
    })
  })
  it('works out the dofollow share only when the provider gave both numbers', () => {
    expect(
      dofollowShare({
        backlinks: 200,
        referring_links_attributes: { nofollow: 50 },
      } as never),
    ).toBe(0.75)
    expect(dofollowShare({ backlinks: 200 } as never)).toBeNull()
    expect(
      dofollowShare({
        backlinks: 0,
        referring_links_attributes: { nofollow: 0 },
      } as never),
    ).toBeNull()
  })
})
