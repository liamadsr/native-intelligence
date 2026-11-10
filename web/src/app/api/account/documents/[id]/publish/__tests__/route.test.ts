/**
 * POST /api/account/documents/[id]/publish — who may publish over a document
 * (migration 359, src/lib/documents/access.ts). Anyone may keep a draft, but
 * draining it into the document needs edit access, checked BEFORE anything is
 * written: a refused publish leaves no revision, no document update, and the
 * draft in place.
 *
 * And safe writes (migration 364): a draft the document has moved past is a
 * 409 STALE_DRAFT unless the body says overwrite; the write is conditional on
 * the revision read, and history is the change trigger's (the route writes no
 * revision row itself).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { createFakeSupabase, type FakeQuery, type FakeResult } from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'

const env = vi.hoisted(() => ({
  fake: null as null | { client: unknown; log: FakeQuery[] },
  member: null as unknown,
  settings: {} as Record<string, unknown>,
  doc: {} as Record<string, unknown>,
  draftBase: 3 as number | null,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    const client = env.fake!.client as Record<string, unknown>
    return { ...client, auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) } }
  },
}))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => 'ws-1' }))
vi.mock('@/lib/ai/embeddings', () => ({ indexDocument: vi.fn(async () => ({ chunksCreated: 0 })) }))
vi.mock('@/lib/wiki/wikilinks', () => ({ syncDocumentLinks: vi.fn(async () => {}) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => {}) } }))

const DOC = '11111111-1111-4111-8111-111111111111'
const CREATOR = 'mem-creator'

beforeEach(() => {
  env.settings = {}
  env.member = { id: 'mem-other', role: 'member' }
  env.doc = {
    id: DOC,
    workspace_id: 'ws-1',
    created_by: CREATOR,
    type: 'note',
    slug: null,
    published_status: 'published',
    frontmatter: {},
    project_id: null,
    status: 'active',
    title: 'T',
    content: 'c',
    content_json: null,
    tags: [],
    revision: 3,
  }
  env.draftBase = 3
  env.fake = createFakeSupabase((q: FakeQuery): FakeResult => {
    if (q.table === 'member') return { data: env.member ? { ...(env.member as object), workspace: { settings: env.settings } } : null, error: null }
    if (q.op === 'update' && q.table === 'document') return { data: [{ ...env.doc, ...(q.payload as object), revision: 4 }], error: null }
    if (q.op !== 'select') return { data: null, error: null }
    if (q.table === 'document') return { data: env.doc, error: null }
    if (q.table === 'document_draft') return { data: { title: 'T2', content: 'c2', content_json: null, frontmatter: null, tags: null, base_revision: env.draftBase }, error: null }
    if (q.table === 'document_revision') return { data: { revision_number: 3 }, error: null }
    return { data: null, error: null }
  }) as never
})

const ops = (table: string, op: string) => env.fake!.log.filter((q) => q.table === table && q.op === op)
const publish = async (body: Record<string, unknown> = {}) => {
  const { POST } = await import('../route')
  return POST(buildRequest({ url: `https://nativeintelligence.dev/api/account/documents/${DOC}/publish`, method: 'POST', body }) as unknown as NextRequest, {
    params: Promise.resolve({ id: DOC }),
  })
}

describe('POST /documents/[id]/publish — edit access', () => {
  it('another member publishing over a plain note: 403, nothing written, the draft kept', async () => {
    const res = await publish()
    expect(res.status).toBe(403)
    expect((await readJson<{ error: string }>(res)).error).toMatch(/Your draft is saved/)
    expect(ops('document_revision', 'insert')).toHaveLength(0)
    expect(ops('document', 'update')).toHaveLength(0)
    expect(ops('document_draft', 'delete')).toHaveLength(0)
  })

  it('the creator publishes: a conditional update marked human, then the draft drained', async () => {
    env.member = { id: CREATOR, role: 'member' }
    const res = await publish()
    expect(res.status).toBe(200)
    expect(await readJson<{ revision_number: number }>(res)).toMatchObject({ revision_number: 4 })
    // History is the change trigger's (migration 364).
    expect(ops('document_revision', 'insert')).toHaveLength(0)
    expect(ops('document', 'update')[0].payload).toMatchObject({
      content: 'c2',
      published_status: 'published',
      last_edited_by: CREATOR,
      edit_source: 'human',
      edit_summary: 'Published a draft',
    })
    expect(ops('document', 'update')[0].filters).toContainEqual(['eq', 'revision', 3])
    expect(ops('document_draft', 'delete')).toHaveLength(1)
  })

  it("publishing extracts claims, but never from the person's Now file (migration 440)", async () => {
    const { inngest } = await import('@/lib/inngest/client')
    const send = vi.mocked(inngest.send)
    send.mockClear()
    env.member = { id: CREATOR, role: 'member' }
    expect((await publish()).status).toBe(200)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toMatchObject({ name: 'claim/extract-from-source', data: { sourceType: 'document', sourceId: DOC } })

    send.mockClear()
    env.doc = { ...env.doc, visibility: 'private', frontmatter: { now: { v: 1 } } }
    expect((await publish()).status).toBe(200)
    expect(send).not.toHaveBeenCalled()
  })

  it('the creator cannot publish over the product doc; an admin can', async () => {
    env.settings = { product_doc: { document_id: DOC } }
    env.member = { id: CREATOR, role: 'member' }
    expect((await publish()).status).toBe(403)
    expect(ops('document_revision', 'insert')).toHaveLength(0)

    env.member = { id: 'mem-admin', role: 'admin' }
    expect((await publish()).status).toBe(200)
  })

  it('a member may publish over a shared wiki page', async () => {
    env.doc = { ...env.doc, slug: 'onboarding' }
    expect((await publish()).status).toBe(200)
  })

  it('a non-member is refused', async () => {
    env.member = null
    expect((await publish()).status).toBe(403)
    expect(ops('document_revision', 'insert')).toHaveLength(0)
  })
})

describe('POST /documents/[id]/publish — a stale draft asks first (migration 364)', () => {
  beforeEach(() => {
    env.member = { id: CREATOR, role: 'member' }
  })

  it('a draft the document has moved past: 409 STALE_DRAFT, nothing written, the draft kept', async () => {
    env.doc = { ...env.doc, revision: 6 }
    const res = await publish()
    expect(res.status).toBe(409)
    const json = await readJson<{ code: string; error: string; details: unknown }>(res)
    expect(json.code).toBe('STALE_DRAFT')
    expect(json.error).toMatch(/revision 3.*revision 6.*Your draft is saved/)
    expect(json.details).toEqual({ draft_base_revision: 3, revision: 6 })
    expect(ops('document', 'update')).toHaveLength(0)
    expect(ops('document_draft', 'delete')).toHaveLength(0)
  })

  it('overwrite: true publishes it over the newer revision', async () => {
    env.doc = { ...env.doc, revision: 6 }
    const res = await publish({ overwrite: true })
    expect(res.status).toBe(200)
    expect(ops('document', 'update')[0].filters).toContainEqual(['eq', 'revision', 6])
  })

  it('a draft with no base (made before 364) asks too', async () => {
    env.draftBase = null
    expect((await publish()).status).toBe(409)
  })
})
