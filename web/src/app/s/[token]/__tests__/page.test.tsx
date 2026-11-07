/**
 * /s/[token]: the public share page makes the same check as the API route
 * (src/lib/share-target.ts). A share opens its item only when the item is in
 * the share's workspace and, for a private item, the share is its creator's;
 * anything else is the "not available" page, and the item is never read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'

type Row = Record<string, unknown>

const hoisted = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  selects: [] as { table: string; cols: string }[],
}))

function from(table: string) {
  const filters: [string, unknown][] = []
  const rows = () => (hoisted.tables[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v))
  const chain: Record<string, unknown> = {
    select: (cols: string) => {
      hoisted.selects.push({ table, cols })
      return chain
    },
    eq: (col: string, value: unknown) => {
      filters.push([col, value])
      return chain
    },
    neq: () => chain,
    order: () => chain,
    single: async () => ({ data: rows()[0] ?? null, error: null }),
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve),
  }
  return chain
}

vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ from }) }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('../shared-view-client', () => ({ SharedViewClient: function SharedViewClient() { return null } }))

import SharedViewPage from '../page'

const WS = 'ws-1'

function linkShare(token: string, shareableId: string): Row {
  return {
    id: `share-${token}`,
    workspace_id: WS,
    shareable_type: 'document',
    shareable_id: shareableId,
    share_type: 'link',
    share_token: token,
    is_active: true,
    expires_at: null,
    access_level: 'view',
    created_by: 'm-ann',
    created_at: '2026-10-27T00:00:00Z',
  }
}

beforeEach(() => {
  hoisted.selects.length = 0
  hoisted.tables = {
    member: [{ id: 'm-ann', user_id: 'u-ann', workspace_id: WS }],
    document: [
      { id: 'doc-ws', workspace_id: WS, visibility: 'workspace', created_by: 'm-bob', title: 'Team plan', content: 'shared' },
      { id: 'doc-bob-private', workspace_id: WS, visibility: 'private', created_by: 'm-bob', title: 'Bob only', content: 'secret' },
      { id: 'doc-other-tenant', workspace_id: 'ws-2', visibility: 'workspace', created_by: 'm-zed', title: 'Theirs', content: 'secret' },
    ],
    share: [
      linkShare('t-ws-doc', 'doc-ws'),
      linkShare('t-forged-private', 'doc-bob-private'),
      linkShare('t-forged-tenant', 'doc-other-tenant'),
    ],
    comment: [],
  }
})

const render = async (token: string) =>
  (await SharedViewPage({ params: Promise.resolve({ token }) })) as ReactElement<Record<string, unknown>>

describe('/s/[token]', () => {
  it('shows a workspace document from a teammate’s link', async () => {
    const el = await render('t-ws-doc')
    expect((el.type as { name: string }).name).toBe('SharedViewClient')
    expect((el.props.data as { document: { title: string } }).document.title).toBe('Team plan')
  })

  it.each([
    ['another member’s private document', 't-forged-private'],
    ['a document in another workspace', 't-forged-tenant'],
  ])('shows "not available" for a forged link on %s, and never reads it', async (_what, token) => {
    const el = await render(token)
    expect((el.type as { name: string }).name).toBe('SharedViewError')
    expect(el.props.status).toBe(404)
    expect(hoisted.selects.some((s) => s.cols.includes('content'))).toBe(false)
  })
})
