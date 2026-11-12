/**
 * PATCH /api/account/views/:id keeps POST's layout rules: a table's view
 * takes only the grid, board, calendar and gallery; any other kind can't
 * take the three table-only ones. A change that names no layout reads
 * nothing extra.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest } from '@/test/integration'

const hoisted = vi.hoisted(() => ({ kind: 'data_row' as string | null, updates: [] as unknown[], reads: 0 }))

function chain(result: unknown) {
  const target: Record<string, unknown> = { then: (cb: (v: unknown) => unknown) => Promise.resolve(result).then(cb) }
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(t, prop: string) {
      if (prop in t) return t[prop]
      if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(result)
      return () => new Proxy(target, handler)
    },
  }
  return new Proxy(target, handler)
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    from: () => ({
      select: () => {
        hoisted.reads++
        return chain({ data: hoisted.kind ? { entity_type: hoisted.kind } : null, error: null })
      },
      update: (u: unknown) => {
        hoisted.updates.push(u)
        return chain({ data: { id: 'v-1', ...(u as object) }, error: null })
      },
    }),
  }),
}))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => 'ws-1' }))

const { PATCH } = await import('@/app/api/account/views/[id]/route')
const patch = (body: unknown) =>
  PATCH(buildRequest({ url: 'https://nativeintelligence.dev/api/account/views/v-1', method: 'PATCH', body }) as unknown as NextRequest, { params: Promise.resolve({ id: 'v-1' }) })

beforeEach(() => {
  hoisted.kind = 'data_row'
  hoisted.updates = []
  hoisted.reads = 0
})

describe('PATCH a view’s layout', () => {
  it('a table’s view takes its four layouts, and not a list', async () => {
    for (const layout of ['grid', 'board', 'calendar', 'gallery']) expect((await patch({ layout })).status, layout).toBe(200)
    expect((await patch({ layout: 'list' })).status).toBe(400)
  })

  it('any other kind can’t take a table-only layout', async () => {
    hoisted.kind = 'contact'
    expect((await patch({ layout: 'calendar' })).status).toBe(400)
    expect((await patch({ layout: 'board' })).status).toBe(200)
    expect(hoisted.updates).toEqual([{ layout: 'board' }])
  })

  it('a view it can’t find is not found; a change without a layout reads nothing extra', async () => {
    hoisted.kind = null
    expect((await patch({ layout: 'grid' })).status).toBe(404)
    hoisted.reads = 0
    expect((await patch({ name: 'Pipeline' })).status).toBe(200)
    expect(hoisted.reads).toBe(0)
  })
})
