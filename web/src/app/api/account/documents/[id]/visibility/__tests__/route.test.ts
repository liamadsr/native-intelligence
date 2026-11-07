/**
 * PATCH /api/account/documents/[id]/visibility — document scope ("Workspace"
 * vs "Only me", migration 369), the capture route's twin.
 *
 * Load-bearing: the EXPLICIT creator check (a non-creator gets a truthful 403,
 * never a silent no-op), someone else's private document is a 404 (to them it
 * does not exist), and a system document (a canon_key, or the product-doc
 * pointer) is never made private.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { SYSTEM_DOCUMENT_PRIVATE_REFUSAL, VISIBILITY_REFUSAL } from '@/lib/documents/access'
import { NOW_PRIVATE_REFUSAL } from '@/lib/now/now-stamp'

const hoisted = vi.hoisted(() => ({ requireWorkspace: vi.fn() }))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: hoisted.requireWorkspace,
  requireWorkspaceMember: hoisted.requireWorkspace,
}))

const WS = 'ws-1'
const DOC = 'doc-1'
const ME = 'user-me'
const MY_MEMBER = 'm-me'
const OTHER_MEMBER = 'm-zoe'

let db: FakeSupabase

function seed(doc: Record<string, unknown>, settings: Record<string, unknown> = {}) {
  db = makeFakeSupabase()
  db.seed('member', [
    { id: MY_MEMBER, user_id: ME, workspace_id: WS, role: 'member', workspace: { settings } },
    { id: OTHER_MEMBER, user_id: 'user-zoe', workspace_id: WS, role: 'member', workspace: { settings } },
  ])
  db.seed('document', [
    {
      id: DOC,
      workspace_id: WS,
      title: 'Plan',
      type: 'note',
      slug: null,
      published_status: 'draft',
      frontmatter: {},
      project_id: null,
      status: 'active',
      canon_key: null,
      visibility: 'workspace',
      created_by: MY_MEMBER,
      ...doc,
    },
  ])
  hoisted.requireWorkspace.mockResolvedValue({
    supabase: db,
    user: { id: ME },
    workspaceId: WS,
    member: { id: MY_MEMBER, role: 'member' },
  })
}

function patch(body: unknown): NextRequest {
  return buildRequest({
    url: `https://dial8.ai/api/account/documents/${DOC}/visibility`,
    method: 'PATCH',
    body,
  }) as unknown as NextRequest
}

const { PATCH } = await import('@/app/api/account/documents/[id]/visibility/route')
const params = { params: Promise.resolve({ id: DOC }) }
const stored = () => db.rows('document')[0]?.visibility

describe('PATCH /api/account/documents/[id]/visibility', () => {
  beforeEach(() => {
    hoisted.requireWorkspace.mockReset()
  })

  it('lets the creator make their document Only me, and back', async () => {
    seed({})
    const res = await PATCH(patch({ visibility: 'private' }), params)
    expect(res.status).toBe(200)
    expect(stored()).toBe('private')

    const back = await PATCH(patch({ visibility: 'workspace' }), params)
    expect(back.status).toBe(200)
    expect(stored()).toBe('workspace')
  })

  it('refuses anything but workspace or private', async () => {
    seed({})
    const res = await PATCH(patch({ visibility: 'team' }), params)
    expect(res.status).toBe(400)
    expect(stored()).toBe('workspace')
  })

  it('refuses a member who is not the creator with a 403, and writes nothing', async () => {
    seed({ created_by: OTHER_MEMBER })
    const res = await PATCH(patch({ visibility: 'private' }), params)
    expect(res.status).toBe(403)
    expect((await readJson<{ error: string }>(res)).error).toBe(VISIBILITY_REFUSAL)
    expect(stored()).toBe('workspace')
  })

  it("answers someone else's private document with a 404: to them it does not exist", async () => {
    seed({ created_by: OTHER_MEMBER, visibility: 'private' })
    const res = await PATCH(patch({ visibility: 'workspace' }), params)
    expect(res.status).toBe(404)
    expect(stored()).toBe('private')
  })

  it('never makes a document with a canon_key private', async () => {
    seed({ canon_key: 'handbook' })
    const res = await PATCH(patch({ visibility: 'private' }), params)
    expect(res.status).toBe(403)
    expect((await readJson<{ error: string }>(res)).error).toBe(SYSTEM_DOCUMENT_PRIVATE_REFUSAL)
    expect(stored()).toBe('workspace')
  })

  it('never shares the person’s own Now file with the workspace (migration 440): a 403, nothing written', async () => {
    seed({ title: 'Now', frontmatter: { now: { tracks: [] } }, visibility: 'private' })
    const res = await PATCH(patch({ visibility: 'workspace' }), params)
    expect(res.status).toBe(403)
    expect((await readJson<{ error: string }>(res)).error).toBe(NOW_PRIVATE_REFUSAL)
    expect(stored()).toBe('private')
  })

  it('never makes the product doc private', async () => {
    seed({}, { product_doc: { document_id: DOC, set_by: OTHER_MEMBER, set_at: '2026-10-01T00:00:00Z' } })
    const res = await PATCH(patch({ visibility: 'private' }), params)
    expect(res.status).toBe(403)
    expect((await readJson<{ error: string }>(res)).error).toBe(SYSTEM_DOCUMENT_PRIVATE_REFUSAL)
    expect(stored()).toBe('workspace')
  })
})
