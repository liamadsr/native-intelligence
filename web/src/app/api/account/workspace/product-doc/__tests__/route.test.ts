/**
 * GET/PUT/DELETE /api/account/workspace/product-doc. Invariants:
 *  - any member reads it; only owner/admin set or clear it (member/guest 403,
 *    nothing written);
 *  - a document outside this workspace is refused (404), and so are archived,
 *    draft, spec and personal (meeting prep) documents (400);
 *  - writes go through the SERVICE client and touch only `product_doc`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const auth = vi.hoisted(() => ({ result: null as unknown }))
vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: async () => auth.result,
}))
const service = vi.hoisted(() => ({ client: null as unknown }))
vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => service.client,
}))

import { GET, PUT, DELETE } from '../route'

type Doc = Record<string, unknown> & { id: string; workspace_id: string }
let docs: Doc[]
let storedSettings: Record<string, unknown>
let written: Array<{ via: string; settings: Record<string, unknown> }>

const SHARED: Doc = {
  id: 'doc-1',
  workspace_id: 'ws-1',
  title: 'Product facts',
  content: 'Pro is $20.',
  updated_at: '2026-10-02T00:00:00Z',
  status: 'active',
  published_status: 'published',
  type: 'note',
  frontmatter: {},
}

function makeClient(kind: 'session' | 'service') {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {}
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = (c: string, v: unknown) => {
        filters[c] = v
        return chain
      }
      chain.maybeSingle = async () => {
        if (table === 'workspace') return { data: { settings: storedSettings }, error: null }
        const row = docs.find((d) => d.id === filters.id && d.workspace_id === filters.workspace_id) ?? null
        return { data: row, error: null }
      }
      chain.update = (vals: { settings: Record<string, unknown> }) => {
        written.push({ via: kind, settings: vals.settings })
        storedSettings = vals.settings
        return { eq: () => ({ select: async () => ({ data: [{ id: 'ws-1' }], error: null }) }) }
      }
      return chain
    },
  }
}

function setAuth(role: string) {
  auth.result = { supabase: makeClient('session'), workspaceId: 'ws-1', member: { id: 'm-1', role } }
  service.client = makeClient('service')
}

const put = (body: unknown) => PUT({ json: async () => body } as unknown as Parameters<typeof PUT>[0])

beforeEach(() => {
  docs = [SHARED]
  storedSettings = { edition: 'sales' }
  written = []
})

describe('GET /product-doc', () => {
  it('null when none is set', async () => {
    setAuth('member')
    expect(await (await GET()).json()).toEqual({ product_doc: null })
  })

  it('any member reads the pointer + the doc title and updated_at', async () => {
    storedSettings = { product_doc: { document_id: 'doc-1', set_by: 'm-9', set_at: '2026-10-01T00:00:00Z' } }
    for (const role of ['owner', 'admin', 'member', 'guest']) {
      setAuth(role)
      const res = await GET()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        product_doc: {
          document_id: 'doc-1',
          set_by: 'm-9',
          set_at: '2026-10-01T00:00:00Z',
          title: 'Product facts',
          updated_at: '2026-10-02T00:00:00Z',
          available: true,
        },
      })
    }
  })

  it('a pointer to a document that is gone or no longer qualifies reads as unavailable', async () => {
    storedSettings = { product_doc: { document_id: 'doc-1' } }
    docs = [{ ...SHARED, status: 'archived' }]
    setAuth('member')
    expect((await (await GET()).json()).product_doc).toMatchObject({ document_id: 'doc-1', available: false })
    docs = []
    expect((await (await GET()).json()).product_doc).toMatchObject({ title: null, available: false })
  })
})

describe('PUT /product-doc', () => {
  it('a member gets 403 and nothing is written', async () => {
    for (const role of ['member', 'guest']) {
      setAuth(role)
      expect((await put({ document_id: 'doc-1' })).status).toBe(403)
    }
    expect(written).toHaveLength(0)
  })

  it('an admin sets it, through the service client, touching only product_doc', async () => {
    setAuth('admin')
    const res = await put({ document_id: 'doc-1' })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.product_doc).toMatchObject({ document_id: 'doc-1', set_by: 'm-1', title: 'Product facts', available: true })
    expect(written).toHaveLength(1)
    expect(written[0].via).toBe('service')
    expect(written[0].settings).toEqual({
      edition: 'sales',
      product_doc: { document_id: 'doc-1', set_by: 'm-1', set_at: expect.any(String) },
    })
  })

  it('stores the document id lowercase (the 359 protection compares it as text)', async () => {
    const id = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
    docs = [{ ...SHARED, id }]
    setAuth('admin')
    const res = await put({ document_id: id.toUpperCase() })
    expect(res.status).toBe(200)
    expect((await res.json()).product_doc.document_id).toBe(id)
    expect((written[0].settings.product_doc as { document_id: string }).document_id).toBe(id)
  })

  it('an owner sets it too', async () => {
    setAuth('owner')
    expect((await put({ document_id: 'doc-1' })).status).toBe(200)
  })

  it('a document in another workspace is refused (404), nothing written', async () => {
    docs = [{ ...SHARED, id: 'doc-x', workspace_id: 'ws-2' }]
    setAuth('admin')
    expect((await put({ document_id: 'doc-x' })).status).toBe(404)
    expect(written).toHaveLength(0)
  })

  it.each([
    ['personal (someone’s meeting prep)', { frontmatter: { meeting_prep: { userId: 'u-2' } } }, 'personal'],
    ['archived', { status: 'archived' }, 'archived'],
    ['draft', { published_status: 'draft' }, 'draft'],
    ['generated spec', { type: 'spec' }, 'spec'],
  ])('a %s document is refused (400), nothing written', async (_name, patch, reason) => {
    docs = [{ ...SHARED, ...patch }]
    setAuth('admin')
    const res = await put({ document_id: 'doc-1' })
    expect(res.status).toBe(400)
    expect((await res.json()).details).toEqual({ reason })
    expect(written).toHaveLength(0)
  })

  it('a bad body is a 400', async () => {
    setAuth('admin')
    expect((await put({})).status).toBe(400)
    expect((await put({ document_id: 7 })).status).toBe(400)
    expect((await put({ document_id: 'a,workspace_id.eq.ws-2' })).status).toBe(400)
    expect(written).toHaveLength(0)
  })
})

describe('DELETE /product-doc', () => {
  it('an admin clears it, keeping every other key', async () => {
    storedSettings = { edition: 'sales', product_doc: { document_id: 'doc-1' } }
    setAuth('admin')
    const res = await DELETE()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ product_doc: null })
    expect(written).toEqual([{ via: 'service', settings: { edition: 'sales' } }])
  })

  it('a member gets 403', async () => {
    storedSettings = { product_doc: { document_id: 'doc-1' } }
    setAuth('member')
    expect((await DELETE()).status).toBe(403)
    expect(written).toHaveLength(0)
  })
})
