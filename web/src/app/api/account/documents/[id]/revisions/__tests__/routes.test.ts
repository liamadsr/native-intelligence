/**
 * The history routes (documents phase 1, item 2): GET the list (no text) and
 * one version with the one before it; POST restore puts a version back as a
 * new revision, with edit access, and a document that moved on since the
 * version the person was looking at is a 409.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { readJson } from '@/test/integration'
import { createFakeSupabase, type FakeQuery, type FakeResult } from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'

const env = vi.hoisted(() => ({
  fake: null as null | { client: unknown; log: FakeQuery[] },
  role: 'owner',
  revision: 5,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ ...(env.fake!.client as object), auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) } }),
}))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => 'ws-1' }))
vi.mock('@/lib/ai/embeddings', () => ({ indexDocument: vi.fn(async () => ({ chunksCreated: 0 })) }))

const DOC = '11111111-1111-4111-8111-111111111111'
const ROW = (n: number, content: string) => ({
  revision_number: n,
  title: 'Plan',
  author_kind: n === 5 ? 'agent' : 'human',
  author_id: 'mem-1',
  change_summary: null,
  created_at: 't',
  updated_at: 't',
  author: { display_name: 'Ana' },
  content,
  frontmatter: {},
})

beforeEach(() => {
  env.role = 'owner'
  env.revision = 5
  env.fake = createFakeSupabase((q: FakeQuery): FakeResult => {
    if (q.table === 'member') return { data: { id: 'mem-1', role: env.role, workspace: { settings: {} } }, error: null }
    if (q.table === 'document_revision') {
      const lte = q.filters.find((f) => f[0] === 'lte')?.[2] as number | undefined
      return { data: [ROW(5, 'Now.'), ROW(4, 'Before.')].filter((r) => lte === undefined || r.revision_number <= lte), error: null }
    }
    if (q.table === 'document' && q.op === 'select') {
      return {
        data: { id: DOC, workspace_id: 'ws-1', created_by: 'mem-9', type: 'note', slug: null, published_status: 'published', frontmatter: {}, project_id: null, status: 'active', title: 'Plan', content: 'Now.', revision: env.revision },
        error: null,
      }
    }
    if (q.table === 'document' && q.op === 'update') return { data: [{ id: DOC, title: 'Plan', content: (q.payload as { content: string }).content, revision: 6 }], error: null }
    return { data: null, error: null }
  }) as never
})

const params = (number?: string) => ({ params: Promise.resolve({ id: DOC, number: number ?? '4' }) })

describe('history routes', () => {
  it('GET the list: newest first, no text, with the current revision', async () => {
    const { GET } = await import('../route')
    const res = await GET(new NextRequest(`https://dial8.ai/api/account/documents/${DOC}/revisions?limit=10`), { params: Promise.resolve({ id: DOC }) })
    const json = await readJson<{ revisions: Array<Record<string, unknown>>; current_revision: number }>(res)
    expect(json.current_revision).toBe(5)
    expect(json.revisions.map((r) => r.revision_number)).toEqual([5, 4])
    const q = env.fake!.log.find((x) => x.table === 'document_revision')!
    expect(q.columns).not.toMatch(/content/)
  })

  it('GET one version with the one before it; a bad number is a 400', async () => {
    const { GET } = await import('../[number]/route')
    const json = await readJson<{ revision: { content: string }; previous: { revision_number: number } }>(
      await GET(new NextRequest(`https://dial8.ai/api/account/documents/${DOC}/revisions/5`), params('5')),
    )
    expect(json.revision.content).toBe('Now.')
    expect(json.previous.revision_number).toBe(4)
    expect((await GET(new NextRequest('https://dial8.ai/x'), params('abc'))).status).toBe(400)
  })

  it('POST restore: a new revision, marked human with its summary', async () => {
    const { POST } = await import('../[number]/restore/route')
    const res = await POST(new NextRequest(`https://dial8.ai/x`, { method: 'POST', body: JSON.stringify({ base_revision: 5 }) }), params('4'))
    expect(res.status).toBe(200)
    expect(await readJson(res)).toMatchObject({ revision: 6, restored_from: 4, document: { content: 'Before.', revision: 6 } })
    const update = env.fake!.log.find((x) => x.table === 'document' && x.op === 'update')!
    expect(update.payload).toMatchObject({ content: 'Before.', edit_source: 'human', edit_summary: 'Restored revision 4' })
    expect(update.filters).toContainEqual(['eq', 'revision', 5])
  })

  it('POST restore: the document moved on is a 409; no edit access is a 403', async () => {
    const { POST } = await import('../[number]/restore/route')
    env.revision = 7
    const moved = await POST(new NextRequest('https://dial8.ai/x', { method: 'POST', body: JSON.stringify({ base_revision: 5 }) }), params('4'))
    expect(moved.status).toBe(409)
    expect(await readJson(moved)).toMatchObject({ code: 'CONFLICT', details: { revision: 7, base_revision: 5 } })

    env.revision = 5
    env.role = 'member'
    expect((await POST(new NextRequest('https://dial8.ai/x', { method: 'POST', body: '{}' }), params('4'))).status).toBe(403)
    expect(env.fake!.log.filter((x) => x.table === 'document' && x.op === 'update')).toHaveLength(0)
  })
})
