/**
 * The prompt explorer's purchase (../explore.ts): the parts are bought one
 * after the other, and a later part failing never loses the parts already
 * bought. They are stored, returned marked partial, and a repeat answers from
 * storage without buying again.
 */
import type { DataforseoClient } from '@/lib/seo/dataforseo'
import { setupDataforseoTestEnv } from '@/lib/seo/dataforseo/__tests__/test-support'
import { SeoError } from '@/lib/seo/errors'
import { allowAccess, testDb } from '@/lib/seo/keywords/__tests__/support'
import { describe, expect, it, vi } from 'vitest'
import {
  exploreAiMentions,
  explorePartial,
  fetchExplore,
  resolveExplore,
  type ResolvedExplore,
} from '../explore'

setupDataforseoTestEnv()

const WS = '11111111-1111-4111-8111-111111111111'
const who = { workspaceId: WS, userId: 'user-1' }

function fakeClient(fail: { pages?: boolean; totals?: boolean } = {}) {
  const down = () =>
    Promise.reject(new SeoError('UPSTREAM_UNAVAILABLE', 'Internal Error.'))
  return {
    aiSearch: {
      aggregatedMetrics: vi.fn(async () =>
        fail.totals
          ? down()
          : { platform: [{ mentions: 12, ai_search_volume: 300 }] },
      ),
      topPages: vi.fn(async () =>
        fail.pages
          ? down()
          : [{ key: 'https://shop.example.com/a', platform: [{ mentions: 3 }] }],
      ),
      mentionsSearch: vi.fn(async () => [
        { question: 'Best shop for tea?', ai_search_volume: 40 },
      ]),
    },
  }
}

function resolved(parts: ResolvedExplore['parts']): ResolvedExplore {
  const r = resolveExplore({ target: 'shop.example.com', parts })
  if ('ok' in r) throw new Error(r.message)
  return r
}

describe('fetchExplore', () => {
  it('keeps the parts bought before one failed, buys nothing after it, and says what is missing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client = fakeClient({ pages: true })
    const out = await fetchExplore(
      client as unknown as Pick<DataforseoClient, 'aiSearch'>,
      resolved(['totals', 'pages', 'questions']),
    )
    expect(out.totals).toEqual({ mentions: 12, ai_search_volume: 300 })
    expect(out.top_pages).toBeNull()
    expect(out.questions).toBeNull()
    expect(client.aiSearch.mentionsSearch).not.toHaveBeenCalled()
    expect(out.partial).toEqual({
      missing: ['pages', 'questions'],
      note: 'The most cited pages and the questions could not be looked up this time. What came back is shown; a refresh looks the whole lookup up again.',
    })
  })

  it('fails when the first part fails (nothing came back)', async () => {
    const client = fakeClient({ totals: true })
    await expect(
      fetchExplore(
        client as unknown as Pick<DataforseoClient, 'aiSearch'>,
        resolved(['totals', 'questions']),
      ),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' })
    expect(client.aiSearch.mentionsSearch).not.toHaveBeenCalled()
  })

  it('a whole answer carries no partial marker', async () => {
    const out = await fetchExplore(
      fakeClient() as unknown as Pick<DataforseoClient, 'aiSearch'>,
      resolved(['totals', 'pages', 'questions']),
    )
    expect(out.partial).toBeUndefined()
    expect(explorePartial([])).toBeNull()
  })
})

describe('exploreAiMentions', () => {
  it('stores a partial lookup and answers a repeat from it without buying again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { svc, tables } = testDb()
    const client = fakeClient({ pages: true })
    const deps = {
      client: client as unknown as DataforseoClient,
      checkAccess: allowAccess,
    }
    const input = {
      target: 'shop.example.com',
      parts: ['totals' as const, 'pages' as const],
      confirmed: true,
    }

    const first = await exploreAiMentions(svc, who, input, deps)
    if (!first.ok) throw new Error(first.message)
    expect(first.result).toMatchObject({
      totals: { mentions: 12 },
      top_pages: null,
      partial: { missing: ['pages'] },
      from_cache: false,
      lookup_id: expect.any(String),
    })
    expect(tables.seo_lookup).toHaveLength(1)

    const again = await exploreAiMentions(svc, who, input, deps)
    expect(again.ok && again.result).toMatchObject({
      from_cache: true,
      partial: { missing: ['pages'] },
    })
    expect(client.aiSearch.aggregatedMetrics).toHaveBeenCalledTimes(1)
    expect(client.aiSearch.topPages).toHaveBeenCalledTimes(1)
  })
})
