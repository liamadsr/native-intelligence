/**
 * PUT /api/account/documents/[id]/draft — a draft records the revision it
 * started from (migration 364): the base_revision the client read on the
 * first save, else the document's revision now; later saves keep it, so a
 * publish can tell the draft is older than the document.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest } from '@/test/integration'
import { createFakeSupabase, type FakeQuery, type FakeResult } from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'

const env = vi.hoisted(() => ({
  fake: null as null | { client: unknown; log: FakeQuery[] },
  existing: null as null | { base_revision: number | null },
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ ...(env.fake!.client as object), auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) } }),
}))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => 'ws-1' }))

const DOC = '11111111-1111-4111-8111-111111111111'

beforeEach(() => {
  env.existing = null
  env.fake = createFakeSupabase((q: FakeQuery): FakeResult => {
    if (q.table === 'member') return { data: { id: 'mem-1' }, error: null }
    if (q.table === 'document') return { data: { id: DOC, revision: 7 }, error: null }
    if (q.table === 'document_draft' && q.op === 'select') return { data: env.existing, error: null }
    if (q.table === 'document_draft' && q.op === 'upsert') return { data: { document_id: DOC, ...(q.payload as object) }, error: null }
    return { data: null, error: null }
  }) as never
})

const put = async (body: Record<string, unknown>) => {
  const { PUT } = await import('../route')
  return PUT(buildRequest({ url: `https://nativeintelligence.dev/api/account/documents/${DOC}/draft`, method: 'PUT', body }) as unknown as NextRequest, {
    params: Promise.resolve({ id: DOC }),
  })
}
const upsert = () => env.fake!.log.findLast((q) => q.table === 'document_draft' && q.op === 'upsert')?.payload as Record<string, unknown>

describe('PUT /documents/[id]/draft — the draft base', () => {
  it('a first save takes the revision the client read', async () => {
    expect((await put({ content: 'x', base_revision: 5 }))?.status).toBe(200)
    expect(upsert()).toMatchObject({ base_revision: 5, content: 'x' })
  })

  it('a first save without one (an old client) keeps no base: never "the revision now", so publishing asks first', async () => {
    await put({ content: 'x' })
    expect(upsert()).not.toHaveProperty('base_revision')
  })

  it('a first save with one records it', async () => {
    await put({ content: 'x', base_revision: 5 })
    expect(upsert()).toMatchObject({ base_revision: 5 })
  })

  it('a later save keeps the base it started from', async () => {
    env.existing = { base_revision: 4 }
    await put({ content: 'y', base_revision: 7 })
    expect(upsert()).not.toHaveProperty('base_revision')
  })

  it('an existing draft from before 364 gets a base only when the client sends one', async () => {
    env.existing = { base_revision: null }
    await put({ content: 'y' })
    expect(upsert()).not.toHaveProperty('base_revision')
    await put({ content: 'y', base_revision: 6 })
    expect(upsert()).toMatchObject({ base_revision: 6 })
  })
})
