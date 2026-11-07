/**
 * POST /api/account/documents/[id]/section-check: the "Mark checked" on a
 * canon document's "not checked since" marker (it replaces the "still true?"
 * card, decision 16). Pins: only someone who may edit the document marks a
 * section, as themselves; only a canon document, and never an archived one;
 * a missing section or document is a 404; bad input names the fix; the
 * caller and workspace come from requireWorkspace.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({
  auth: null as unknown,
  access: null as Record<string, unknown> | null,
  marked: [] as Array<Record<string, unknown>>,
  markResult: true,
}))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: async () => h.auth }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/documents/access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/access')>()),
  loadDocumentAccess: async () => ({ access: h.access, error: null }),
}))
vi.mock('@/lib/documents/canon-freshness', () => ({
  markSectionChecked: async (_s: unknown, args: Record<string, unknown>) => (h.marked.push(args), h.markResult),
}))

import { POST } from '../route'

const access = (role: string, row: Record<string, unknown> = {}) => ({
  role,
  memberId: 'm-1',
  isProductDoc: true,
  row: { id: 'd1', workspace_id: 'ws-1', created_by: 'm-9', type: 'note', slug: null, published_status: 'published', frontmatter: {}, project_id: null, canon_key: 'product', visibility: 'workspace', status: 'active', ...row },
})
const post = (body: unknown) =>
  POST(new Request('http://localhost/api/account/documents/d1/section-check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) as unknown as NextRequest, { params: Promise.resolve({ id: 'd1' }) })

beforeEach(() => {
  h.auth = { supabase: {}, user: { id: 'user-1' }, workspaceId: 'ws-1' }
  h.access = access('admin')
  h.marked = []
  h.markResult = true
})

describe('POST section-check', () => {
  it('an admin marks a section checked, as themselves, a "Parent > Child" path included', async () => {
    expect((await post({ section: 'Positioning' })).status).toBe(200)
    expect((await post({ section: 'Positioning > Differentiators' })).status).toBe(200)
    expect(h.marked).toEqual([
      { workspaceId: 'ws-1', documentId: 'd1', section: 'Positioning', memberId: 'm-1' },
      { workspaceId: 'ws-1', documentId: 'd1', section: 'Positioning > Differentiators', memberId: 'm-1' },
    ])
  })

  it('a member who may not edit the product doc is refused, and nothing is stamped', async () => {
    h.access = access('member')
    expect((await post({ section: 'Positioning' })).status).toBe(403)
    expect(h.marked).toHaveLength(0)
  })

  it('only a canon document, and never an archived one', async () => {
    h.access = { ...access('admin', { canon_key: null }), isProductDoc: false }
    expect((await post({ section: 'Positioning' })).status).toBe(400)
    h.access = access('admin', { status: 'archived' })
    expect((await post({ section: 'Positioning' })).status).toBe(409)
    expect(h.marked).toHaveLength(0)
  })

  it('no section named, no document, or a section that is gone', async () => {
    expect((await post({})).status).toBe(400)
    h.access = null
    expect((await post({ section: 'Positioning' })).status).toBe(404)
    h.access = access('owner')
    h.markResult = false
    expect((await post({ section: 'Nope' })).status).toBe(404)
  })

  it('signed out (requireWorkspace answers): that answer is returned', async () => {
    h.auth = new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
    expect((await post({ section: 'Positioning' })).status).toBe(401)
  })
})
