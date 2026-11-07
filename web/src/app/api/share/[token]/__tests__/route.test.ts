/**
 * GET /api/share/[token] and its comments route: a share row opens its item
 * only when the item is in the share's workspace and, for a private item, the
 * share is its creator's. Migration 447 stops a member writing such a row; the
 * routes refuse one that exists anyway (a forged pre-447 row), with the same
 * 404 as a bad token and without reading the item's content.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'

type Row = Record<string, unknown>

const hoisted = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  selects: [] as { table: string; cols: string }[],
}))

/** A service client over fixed tables: eq filters; single, maybeSingle or await. */
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

import { GET } from '../route'
import { GET as GET_COMMENTS } from '../comments/route'

const WS = 'ws-1'

function linkShare(token: string, shareableType: string, shareableId: string, createdBy = 'm-ann'): Row {
  return {
    id: `share-${token}`,
    workspace_id: WS,
    shareable_type: shareableType,
    shareable_id: shareableId,
    share_type: 'link',
    share_token: token,
    is_active: true,
    expires_at: null,
    access_level: 'view',
    show_transcript: false,
    show_ai_summary: true,
    show_decisions: false,
    created_by: createdBy,
    created_at: '2026-10-27T00:00:00Z',
  }
}

beforeEach(() => {
  hoisted.selects.length = 0
  hoisted.tables = {
    member: [
      { id: 'm-ann', user_id: 'u-ann', workspace_id: WS },
      { id: 'm-bob', user_id: 'u-bob', workspace_id: WS },
    ],
    document: [
      { id: 'doc-ws', workspace_id: WS, visibility: 'workspace', created_by: 'm-bob', title: 'Team plan', content: 'shared' },
      { id: 'doc-bob-private', workspace_id: WS, visibility: 'private', created_by: 'm-bob', title: 'Bob only', content: 'secret' },
      { id: 'doc-other-tenant', workspace_id: 'ws-2', visibility: 'workspace', created_by: 'm-zed', title: 'Theirs', content: 'secret' },
    ],
    captures: [
      { id: 'cap-ann-private', workspace_id: WS, visibility: 'private', user_id: 'u-ann', title: 'Ann call', content: 'notes' },
      { id: 'cap-bob-private', workspace_id: WS, visibility: 'private', user_id: 'u-bob', title: 'Bob call', content: 'secret' },
    ],
    share: [
      linkShare('t-ws-doc', 'document', 'doc-ws'),
      linkShare('t-forged-private', 'document', 'doc-bob-private'),
      linkShare('t-forged-tenant', 'document', 'doc-other-tenant'),
      linkShare('t-own-capture', 'capture', 'cap-ann-private'),
      linkShare('t-forged-capture', 'capture', 'cap-bob-private'),
    ],
    capture_participant: [],
    comment: [],
  }
})

const call = (token: string) => GET({} as NextRequest, { params: Promise.resolve({ token }) })
const callComments = (token: string) => GET_COMMENTS({} as NextRequest, { params: Promise.resolve({ token }) })
const readContent = () => hoisted.selects.some((s) => s.table !== 'comment' && s.cols.includes('content'))

describe('GET /api/share/[token]', () => {
  it('opens a workspace document from a teammate’s share', async () => {
    const res = await call('t-ws-doc')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.document.title).toBe('Team plan')
  })

  it('opens a private capture from its creator’s share', async () => {
    const res = await call('t-own-capture')
    expect(res.status).toBe(200)
    expect((await res.json()).capture.title).toBe('Ann call')
  })

  it.each([
    ['another member’s private document', 't-forged-private'],
    ['a document in another workspace', 't-forged-tenant'],
    ['another member’s private capture', 't-forged-capture'],
  ])('refuses a forged share on %s, and never reads it', async (_what, token) => {
    const res = await call(token)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
    expect(readContent()).toBe(false)
  })
})

describe('GET /api/share/[token]/comments', () => {
  it('lists comments on a share that may open its item', async () => {
    const res = await callComments('t-ws-doc')
    expect(res.status).toBe(200)
  })

  it('refuses a forged share before reading any comment', async () => {
    const res = await callComments('t-forged-private')
    expect(res.status).toBe(404)
    expect(hoisted.selects.some((s) => s.table === 'comment')).toBe(false)
  })
})
