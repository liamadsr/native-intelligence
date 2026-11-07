/**
 * A document's meeting-prep stamp (`frontmatter.meeting_prep`) is the
 * server's alone (prep-doc.ts markPrepDocuments). The document routes that
 * take frontmatter from the client (create, draft, publish; the PATCH has its
 * own tests in [id]/__tests__/route.test.ts) drop an incoming stamp and keep
 * the stored one (prep-ref.ts withServerFrontmatter), so a teammate can't
 * make a document read as someone's prep.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest } from '@/test/integration'
import { createFakeSupabase, type FakeQuery, type FakeResult } from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'

const env = vi.hoisted(() => ({ fake: null as null | { client: unknown; log: Array<{ table: string; op: string; payload?: unknown }> }, stored: {} as Record<string, unknown>, draft: null as unknown }))

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
vi.mock('@/lib/posthog', () => ({ trackServerEvent: vi.fn() }))

const DOC = 'doc-1'
const REAL = { startIso: '2026-10-18T15:00:00.000Z', calendarEventId: 'evt-1', meetingKey: 'a'.repeat(40), userId: 'user-1' }
const FORGED = { ...REAL, userId: 'victim-9' }

beforeEach(() => {
  env.stored = {}
  env.draft = null
  env.fake = createFakeSupabase((q: FakeQuery): FakeResult => {
    if (q.table === 'member') return { data: { id: 'mem-1', role: 'owner' }, error: null }
    if (q.op !== 'select') return { data: { id: DOC, document_id: DOC, title: 'T', content: 'c', project_id: null, published_status: 'published' }, error: null }
    // A list read (GET /documents) gets rows; every other read, the one document.
    if (q.table === 'document' && q.terminal === 'many') return { data: [], error: null }
    if (q.table === 'document') return { data: { id: DOC, title: 'T', content: 'c', content_json: null, frontmatter: env.stored, tags: [], published_status: 'draft', revision: 1 }, error: null }
    if (q.table === 'document_draft') return { data: env.draft, error: null }
    return { data: null, error: null }
  }) as never
})

const write = (table: string, op: string) => env.fake!.log.find((q) => q.table === table && q.op === op)?.payload as Record<string, unknown>
const req = (url: string, method: string, body: unknown) => buildRequest({ url, method, body }) as unknown as NextRequest

describe('document routes never write a meeting-prep stamp from the client', () => {
  it('POST /documents: an incoming stamp is dropped', async () => {
    const { POST } = await import('../route')
    await POST(req('https://dial8.ai/api/account/documents', 'POST', { title: 'Prep — Acme', frontmatter: { area: 'x', meeting_prep: FORGED } }))
    expect(write('document', 'insert').frontmatter).toEqual({ area: 'x' })
  })

  it('POST /documents: nor a Now file’s stamp (migration 440)', async () => {
    const { POST } = await import('../route')
    await POST(req('https://dial8.ai/api/account/documents', 'POST', { title: 'Now', frontmatter: { area: 'x', now: { tracks: [] } } }))
    expect(write('document', 'insert').frontmatter).toEqual({ area: 'x' })
  })

  it('GET /documents: the person’s Now file is in no list unless a kind is asked for (and none admits it)', async () => {
    const { GET } = await import('../route')
    const { NextRequest } = await import('next/server')
    await GET(new NextRequest('https://dial8.ai/api/account/documents'))
    const list = env.fake!.log.filter((q) => q.table === 'document' && q.op === 'select').at(-1) as unknown as { filters: unknown[][] }
    expect(list.filters).toContainEqual(['neq', 'kind', 'now'])
    await GET(new NextRequest('https://dial8.ai/api/account/documents?kind=doc,now'))
    const asked = env.fake!.log.filter((q) => q.table === 'document' && q.op === 'select').at(-1) as unknown as { filters: unknown[][] }
    expect(asked.filters).toContainEqual(['in', 'kind', ['doc']])
  })

  it('PUT /documents/[id]/draft: a draft never carries one', async () => {
    const { PUT } = await import('../[id]/draft/route')
    await PUT(req(`https://dial8.ai/api/account/documents/${DOC}/draft`, 'PUT', { frontmatter: { area: 'x', meeting_prep: FORGED } }), { params: Promise.resolve({ id: DOC }) })
    expect(write('document_draft', 'upsert').frontmatter).toEqual({ area: 'x' })
  })

  it('POST /documents/[id]/publish: the document keeps its stored stamp, whatever the draft holds', async () => {
    env.stored = { meeting_prep: REAL }
    env.draft = { title: 'T2', content: 'c2', content_json: null, frontmatter: { area: 'y', meeting_prep: FORGED }, tags: null, base_revision: 1 }
    const { POST } = await import('../[id]/publish/route')
    await POST(req(`https://dial8.ai/api/account/documents/${DOC}/publish`, 'POST', {}), { params: Promise.resolve({ id: DOC }) })
    expect(write('document', 'update').frontmatter).toEqual({ area: 'y', meeting_prep: REAL })
  })
})
