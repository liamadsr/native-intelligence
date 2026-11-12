/**
 * Saved keywords: one row per (keyword, location, language) held in code, a
 * race's duplicates collapsed to the oldest, the per-workspace cap, tags,
 * the list's filters, and every read and write fenced to the workspace.
 */
import { describe, expect, it } from 'vitest'
import {
  addSavedKeywords,
  collapseDuplicates,
  duplicateIds,
  listSavedKeywords,
  normalizeSavedKeywords,
  planSavedKeywordAdd,
  removeSavedKeywords,
  retag,
  updateSavedKeywords,
} from '../saved'
import { SAVED_KEYWORDS_MAX } from '../view'
import { testDb } from './support'

const WS = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const who = { workspaceId: WS, userId: 'user-1' }

function savedRow(keyword: string, extra: Record<string, unknown> = {}) {
  return {
    id: `id-${keyword.replace(/\s+/g, '-')}`,
    workspace_id: WS,
    keyword,
    location_code: 2840,
    language_code: 'en',
    search_volume: null,
    cpc: null,
    competition: null,
    keyword_difficulty: null,
    intent: null,
    monthly_searches: [],
    metrics_fetched_at: null,
    tags: [],
    note: null,
    created_by: null,
    created_at: '2026-10-01T00:00:00.000Z',
    ...extra,
  }
}

describe('pure rules', () => {
  it('normalizes and dedupes keywords, dropping empty and over-long ones', () => {
    expect(
      normalizeSavedKeywords([
        ' Running  Shoes ',
        'running shoes',
        '',
        'x'.repeat(201),
        'Trail',
      ]),
    ).toEqual(['running shoes', 'trail'])
  })

  it('splits an add into new and already-saved keywords', () => {
    expect(planSavedKeywordAdd(['a', 'c'], ['a', 'b', 'c', 'd'])).toEqual({
      insert: ['b', 'd'],
      existing: ['a', 'c'],
    })
  })

  it('retags: set replaces, then remove and add apply, normalized and capped', () => {
    expect(
      retag(['blog', 'pricing'], {
        add: ['How To', 'blog'],
        remove: ['PRICING'],
      }),
    ).toEqual(['blog', 'how to'])
    expect(retag(['blog'], { set: ['Landing'], add: ['faq'] })).toEqual([
      'landing',
      'faq',
    ])
    expect(retag(['blog'], { set: [] })).toEqual([])
  })

  it('keeps the oldest of each duplicated keyword and market', () => {
    const rows = [
      {
        id: 'b',
        keyword: 'k',
        location_code: 2840,
        language_code: 'en',
        created_at: '2026-10-02',
      },
      {
        id: 'a',
        keyword: 'k',
        location_code: 2840,
        language_code: 'en',
        created_at: '2026-10-01',
      },
      {
        id: 'c',
        keyword: 'k',
        location_code: 2826,
        language_code: 'en',
        created_at: '2026-10-03',
      },
      {
        id: 'd',
        keyword: 'k',
        location_code: 2840,
        language_code: 'en',
        created_at: '2026-10-01',
      },
    ]
    expect(duplicateIds(rows).sort()).toEqual(['b', 'd'])
  })
})

describe('addSavedKeywords', () => {
  it('inserts only the new keywords, with their metrics, and gives the already-saved ones the tags', async () => {
    const { svc, tables } = testDb({
      seo_saved_keyword: [
        savedRow('running shoes', { tags: ['shoes'] }),
        savedRow('running shoes', { workspace_id: OTHER, id: 'other' }),
      ],
    })
    const out = await addSavedKeywords(svc, who, {
      keywords: ['Running Shoes', 'trail shoes'],
      tags: ['Buyer Guide'],
      metrics: [
        {
          keyword: 'TRAIL SHOES',
          search_volume: 2900,
          keyword_difficulty: 35,
          cpc: 1.2,
          competition: 0.4,
          intent: 'commercial',
          trend: [],
        },
      ],
    })
    if (!out.ok) throw new Error(out.message)
    expect(out).toMatchObject({ added: 1, already_saved: 1 })
    const mine = (tables.seo_saved_keyword ?? []).filter(
      (row) => row.workspace_id === WS,
    )
    expect(mine.map((row) => [row.keyword, row.tags])).toEqual([
      ['running shoes', ['shoes', 'buyer guide']],
      ['trail shoes', ['buyer guide']],
    ])
    expect(mine[1]).toMatchObject({
      search_volume: 2900,
      keyword_difficulty: 35,
      intent: 'commercial',
      created_by: 'user-1',
      location_code: 2840,
      language_code: 'en',
    })
    expect(mine[1]?.metrics_fetched_at).toEqual(expect.any(String))
    expect(
      (tables.seo_saved_keyword ?? []).find((row) => row.id === 'other'),
    ).toMatchObject({ tags: [] })
  })

  it('keeps one row per keyword in each market: the same keyword in another country is its own', async () => {
    const { svc, tables } = testDb()
    await addSavedKeywords(svc, who, { keywords: ['plumber'] })
    await addSavedKeywords(svc, who, { keywords: ['plumber'] })
    await addSavedKeywords(svc, who, {
      keywords: ['plumber'],
      location_code: 2826,
    })
    expect(
      (tables.seo_saved_keyword ?? []).map((row) => row.location_code),
    ).toEqual([2840, 2826])
  })

  it('collapses the duplicates a race left to the oldest row', async () => {
    const { svc, tables } = testDb({
      seo_saved_keyword: [
        savedRow('plumber', {
          id: 'late',
          created_at: '2026-10-02T00:00:00.000Z',
        }),
        savedRow('plumber', { id: 'early' }),
      ],
    })
    expect(
      await collapseDuplicates(
        svc,
        WS,
        { locationCode: 2840, languageCode: 'en' },
        ['plumber'],
      ),
    ).toBe(1)
    expect((tables.seo_saved_keyword ?? []).map((row) => row.id)).toEqual([
      'early',
    ])
  })

  it('saves nothing past the workspace cap and says so', async () => {
    const rows = Array.from({ length: SAVED_KEYWORDS_MAX }, (_, i) =>
      savedRow(`kw ${i}`, { id: `id-${i}` }),
    )
    const { svc, tables } = testDb({ seo_saved_keyword: rows })
    const out = await addSavedKeywords(svc, who, { keywords: ['one more'] })
    expect(out).toMatchObject({ ok: false, code: 'SAVED_KEYWORDS_FULL' })
    expect(tables.seo_saved_keyword).toHaveLength(SAVED_KEYWORDS_MAX)
    // Re-saving one it already has is still fine at the cap.
    expect(
      await addSavedKeywords(svc, who, { keywords: ['kw 1'], tags: ['x'] }),
    ).toMatchObject({ ok: true, added: 0, already_saved: 1 })
  })

  it('refuses an empty add and a language the country is not served in', async () => {
    const { svc } = testDb()
    expect(await addSavedKeywords(svc, who, { keywords: [' '] })).toMatchObject(
      { ok: false, code: 'VALIDATION_ERROR' },
    )
    expect(
      await addSavedKeywords(svc, who, {
        keywords: ['x'],
        language_code: 'ru',
      }),
    ).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
  })
})

describe('listSavedKeywords', () => {
  const seeded = () =>
    testDb({
      seo_saved_keyword: [
        savedRow('running shoes', {
          search_volume: 50000,
          tags: ['shoes'],
          created_at: '2026-10-01T00:00:00.000Z',
        }),
        savedRow('trail shoes', {
          search_volume: 2900,
          tags: ['shoes', 'trail'],
          created_at: '2026-10-02T00:00:00.000Z',
        }),
        savedRow('marathon plan', {
          search_volume: 8000,
          tags: ['training'],
          created_at: '2026-10-03T00:00:00.000Z',
        }),
        savedRow('5k plan', {
          search_volume: null,
          tags: [],
          created_at: '2026-10-04T00:00:00.000Z',
        }),
        savedRow('secret', { workspace_id: OTHER, id: 'other' }),
      ],
    })

  it('lists newest first, a page at a time, never another workspace’s', async () => {
    const { svc } = seeded()
    const first = await listSavedKeywords(svc, WS, { limit: 3 })
    expect(first.total).toBe(4)
    expect(first.rows.map((row) => row.keyword)).toEqual([
      '5k plan',
      'marathon plan',
      'trail shoes',
    ])
    expect(first.next_offset).toBe(3)
    const second = await listSavedKeywords(svc, WS, { limit: 3, offset: 3 })
    expect(second.rows.map((row) => row.keyword)).toEqual(['running shoes'])
    expect(second.next_offset).toBeNull()
  })

  it('filters by text, by any of several tags, and by volume; sorts on request', async () => {
    const { svc } = seeded()
    expect(
      (await listSavedKeywords(svc, WS, { search: 'PLAN' })).rows.map(
        (row) => row.keyword,
      ),
    ).toEqual(['5k plan', 'marathon plan'])
    expect(
      (
        await listSavedKeywords(svc, WS, { tags: ['trail', 'Training'] })
      ).rows.map((row) => row.keyword),
    ).toEqual(['marathon plan', 'trail shoes'])
    expect((await listSavedKeywords(svc, WS, { tags: ['shoes'] })).total).toBe(
      2,
    )
    expect(
      (
        await listSavedKeywords(svc, WS, {
          min_volume: 5000,
          sort: 'search_volume',
          dir: 'desc',
        })
      ).rows.map((row) => row.keyword),
    ).toEqual(['running shoes', 'marathon plan'])
  })
})

describe('updates and removal', () => {
  it('retags and annotates only this workspace’s rows', async () => {
    const { svc, tables } = testDb({
      seo_saved_keyword: [
        savedRow('a', { tags: ['old'] }),
        savedRow('b', { workspace_id: OTHER, tags: ['old'] }),
      ],
    })
    const out = await updateSavedKeywords(svc, WS, {
      ids: ['id-a', 'id-b'],
      add_tags: ['new'],
      remove_tags: ['old'],
      note: ' for the pricing page ',
    })
    if (!out.ok) throw new Error(out.message)
    expect(out.updated).toBe(1)
    expect(tables.seo_saved_keyword?.[0]).toMatchObject({
      tags: ['new'],
      note: 'for the pricing page',
    })
    expect(tables.seo_saved_keyword?.[1]).toMatchObject({
      tags: ['old'],
      note: null,
    })
    expect(
      await updateSavedKeywords(svc, WS, { ids: ['id-b'], add_tags: ['x'] }),
    ).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(await updateSavedKeywords(svc, WS, { ids: ['id-a'] })).toMatchObject(
      { ok: false, code: 'VALIDATION_ERROR' },
    )
  })

  it('removes only this workspace’s rows', async () => {
    const { svc, tables } = testDb({
      seo_saved_keyword: [
        savedRow('a'),
        savedRow('b', { workspace_id: OTHER }),
      ],
    })
    expect(
      await removeSavedKeywords(svc, WS, ['id-a', 'id-b', 'id-a']),
    ).toEqual({ ok: true, removed: 1 })
    expect((tables.seo_saved_keyword ?? []).map((row) => row.id)).toEqual([
      'id-b',
    ])
  })
})
