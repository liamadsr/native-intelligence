/**
 * Tests for PATCH /api/account/documents/[id] — the document re-index hook.
 *
 * A content-changing PATCH must refresh the document's embeddings
 * (document_chunks, migration 185) via indexDocument, or hybrid_search's
 * document_vec branch (migration 186) returns the stale pre-edit text forever.
 * Mirrors the captures/[id] PATCH re-index tests. Locks in that the handler:
 *   - TRIGGERS indexDocument when body.content changed (indexes off the returned
 *     row's full current values: id, user, project_id, content, workspace)
 *   - does NOT re-index a title-only / metadata-only PATCH (body untouched)
 *   - is best-effort: an embedding failure never fails the PATCH
 *   - rejects unauthenticated requests
 *
 * And who may change it (migration 359, src/lib/documents/access.ts): PATCH
 * and DELETE (archive and permanent) refuse with a 403 before writing, GET
 * says can_edit / can_delete.
 *
 * And safe writes (migration 364): a body change names the revision it was
 * made against (an old client that sends none is written blind, for now),
 * the update is conditional on it, and a
 * document that moved on is a 409 with its revision now; nothing is written.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  getUser: vi.fn(),
  getCurrentWorkspaceId: vi.fn(),
  indexDocumentSpy: vi.fn(),
  updateSpy: vi.fn(),
  serviceUpdateSpy: vi.fn(),
  rpcSpy: vi.fn(),
  loadAccess: vi.fn(),
}))

// Who may change the document: the real rules, a controllable loader.
vi.mock('@/lib/documents/access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/access')>()),
  loadDocumentAccess: (...args: unknown[]) => hoisted.loadAccess(...args),
}))

// The archive runs on the service client after the delete check.
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => {
    const chain: Record<string, unknown> = {
      from: () => chain,
      update: (fields: unknown) => {
        hoisted.serviceUpdateSpy(fields)
        return chain
      },
      eq: () => chain,
      select: async () => ({ data: [{ id: 'doc-abc-123' }], error: null }),
    }
    return chain
  },
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => makeFakeSupabase(),
}))

vi.mock('@/lib/workspace', () => ({
  getCurrentWorkspaceId: hoisted.getCurrentWorkspaceId,
}))

// Stub indexDocument as a spy so we can assert it fires (or not) without hitting
// the embedding gateway.
vi.mock('@/lib/ai/embeddings', () => ({
  indexDocument: (...args: unknown[]) => hoisted.indexDocumentSpy(...args),
}))

// wikilinks sync is exercised on published docs; stub to a no-op.
vi.mock('@/lib/wiki/wikilinks', () => ({
  syncDocumentLinks: vi.fn(async () => {}),
}))

const DOC_ID = 'doc-abc-123'
const WORKSPACE_ID = 'ws-test-1'
const USER_ID = 'user-1'

// The document row the post-update select returns.
const FAKE_DOC_ROW = {
  id: DOC_ID,
  title: 'Architecture Notes',
  content: 'The system uses a hexagonal architecture with clear ports and adapters.',
  content_json: null,
  slug: 'architecture-notes',
  type: 'doc',
  tags: [],
  project_id: 'proj-9',
  team_id: null,
  status: 'active',
  published_status: 'published',
  is_pinned: false,
  sort_order: 0,
  revision: 4,
  created_at: '2026-06-06T09:00:00Z',
  updated_at: '2026-06-06T09:15:00Z',
}

let storedFrontmatter: Record<string, unknown> = {}
/** The revision the stored document is at (a conditional update on any other matches nothing). */
let storedRevision = 3

/** The access the loader hands back: an owner on a plain note by default. */
function accessFor(overrides: { role?: string | null; memberId?: string | null; isProductDoc?: boolean; row?: Record<string, unknown> } = {}) {
  return {
    access: {
      role: overrides.role === undefined ? 'owner' : overrides.role,
      memberId: overrides.memberId === undefined ? 'member-1' : overrides.memberId,
      isProductDoc: overrides.isProductDoc ?? false,
      row: {
        id: DOC_ID,
        workspace_id: WORKSPACE_ID,
        created_by: 'member-creator',
        type: 'note',
        slug: null,
        published_status: 'published',
        frontmatter: storedFrontmatter,
        project_id: null,
        status: 'active',
        ...(overrides.row ?? {}),
      },
    },
    error: null,
  }
}

/** The session read finds no row (RLS hides someone else's private document, 369). */
let documentHidden = false

function makeFakeSupabase(rowOverrides: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = { ...FAKE_DOC_ROW, frontmatter: storedFrontmatter, ...rowOverrides }

  // .from('document').update(...).eq().eq().select().single() → row; a
  // conditional update (.eq('revision', n)) matches only the stored revision.
  let revisionFilter: number | null = null
  const updateChain: Record<string, unknown> = {
    eq: (column: string, value: unknown) => {
      if (column === 'revision') revisionFilter = value as number
      return updateChain
    },
    select: () => updateChain,
    single: async () => (documentHidden ? { data: null, error: { code: 'PGRST116', message: 'no rows' } } : { data: row, error: null }),
    // The stored frontmatter (and revision) read before a write.
    maybeSingle: async () => ({ data: { frontmatter: row.frontmatter ?? {}, revision: storedRevision }, error: null }),
    update: (fields: Record<string, unknown>) => {
      hoisted.updateSpy(fields)
      revisionFilter = null
      return updateChain
    },
    then: (cb: (v: unknown) => unknown) =>
      Promise.resolve(
        revisionFilter !== null && revisionFilter !== storedRevision ? { data: [], error: null } : { data: [row], error: null },
      ).then(cb),
  }

  // .from('member').select().eq().eq().maybeSingle() → editor member
  const memberChain = {
    select: () => memberChain,
    eq: () => memberChain,
    maybeSingle: async () => ({ data: { id: 'member-1' }, error: null }),
  }

  // GET's side reads: the comment count and the caller's draft.
  const sideChain: Record<string, unknown> = {
    select: () => sideChain,
    eq: () => sideChain,
    maybeSingle: async () => ({ data: null, error: null }),
    then: (cb: (v: unknown) => unknown) => Promise.resolve({ count: 0, data: null, error: null }).then(cb),
  }

  return {
    from: (table: string) => {
      if (table === 'document') return updateChain
      if (table === 'member') return memberChain
      if (table === 'comment' || table === 'document_draft') return sideChain
      throw new Error(`unexpected table ${table}`)
    },
    rpc: async (name: string, args: unknown) => {
      hoisted.rpcSpy(name, args)
      return { data: null, error: null }
    },
    auth: { getUser: hoisted.getUser },
  }
}

function patchReq(body: unknown): NextRequest {
  return buildRequest({
    url: `https://nativeintelligence.dev/api/account/documents/${DOC_ID}`,
    method: 'PATCH',
    body,
  }) as unknown as NextRequest
}

const { GET, PATCH, DELETE } = await import('@/app/api/account/documents/[id]/route')

function deleteReq(permanent: boolean): NextRequest {
  return new NextRequest(`https://nativeintelligence.dev/api/account/documents/${DOC_ID}${permanent ? '?permanent=true' : ''}`, { method: 'DELETE' })
}

describe('PATCH /api/account/documents/[id] — re-index on edit', () => {
  beforeEach(() => {
    hoisted.getUser.mockResolvedValue({ data: { user: { id: USER_ID } } })
    hoisted.getCurrentWorkspaceId.mockResolvedValue(WORKSPACE_ID)
    hoisted.loadAccess.mockImplementation(async () => accessFor())
    hoisted.indexDocumentSpy.mockReset()
    hoisted.indexDocumentSpy.mockResolvedValue({ chunksCreated: 1 })
    hoisted.updateSpy.mockClear()
    storedRevision = 3
  })

  it('returns 401 when unauthenticated', async () => {
    hoisted.getUser.mockResolvedValue({ data: { user: null } })
    const res = await PATCH(patchReq({ content: 'x', base_revision: 3 }), { params: Promise.resolve({ id: DOC_ID }) })
    expect(res.status).toBe(401)
  })

  it('TRIGGERS re-index when content changes, off the returned row values', async () => {
    const res = await PATCH(
      patchReq({ content: 'Rewritten body about ports and adapters.', base_revision: 3 }),
      { params: Promise.resolve({ id: DOC_ID }) },
    )
    expect(res.status).toBe(200)
    expect(hoisted.indexDocumentSpy).toHaveBeenCalledTimes(1)
    // indexDocument(supabase, id, userId, projectId, content, workspaceId)
    const call = hoisted.indexDocumentSpy.mock.calls[0]
    expect(call[1]).toBe(DOC_ID)                  // documentId
    expect(call[2]).toBe(USER_ID)                 // userId
    expect(call[3]).toBe('proj-9')                // project_id from returned row
    expect(call[4]).toBe(FAKE_DOC_ROW.content)    // full current body (returned row)
    expect(call[5]).toBe(WORKSPACE_ID)            // workspaceId
  })

  it('does NOT re-index a title-only PATCH (body untouched)', async () => {
    await PATCH(patchReq({ title: 'Renamed' }), { params: Promise.resolve({ id: DOC_ID }) })
    expect(hoisted.updateSpy).toHaveBeenCalled()
    expect(hoisted.indexDocumentSpy).not.toHaveBeenCalled()
  })

  it('does NOT re-index a metadata-only PATCH (pin/tags/project)', async () => {
    await PATCH(
      patchReq({ is_pinned: true, tags: ['x'], project_id: 'proj-2' }),
      { params: Promise.resolve({ id: DOC_ID }) },
    )
    expect(hoisted.indexDocumentSpy).not.toHaveBeenCalled()
  })

  it('an embedding failure does NOT fail the PATCH (best-effort)', async () => {
    hoisted.indexDocumentSpy.mockRejectedValueOnce(new Error('embedding API down'))
    const res = await PATCH(
      patchReq({ content: 'New body that triggers a doomed re-index.', base_revision: 3 }),
      { params: Promise.resolve({ id: DOC_ID }) },
    )
    expect(res.status).toBe(200)
    const json = await readJson<{ document: { id: string } }>(res)
    expect(json.document.id).toBe(DOC_ID)
    expect(hoisted.indexDocumentSpy).toHaveBeenCalledTimes(1)
  })

  it('does NOT re-index the person’s Now file (migration 440): the access row already says so', async () => {
    storedFrontmatter = { now: { tracks: [] } }
    try {
      const res = await PATCH(patchReq({ content: '## Focus\n- Ship guest access (Oct 26)', base_revision: 3 }), { params: Promise.resolve({ id: DOC_ID }) })
      expect(res.status).toBe(200)
      expect(hoisted.updateSpy).toHaveBeenCalled()
      expect(hoisted.indexDocumentSpy).not.toHaveBeenCalled()
    } finally {
      storedFrontmatter = {}
    }
  })
})

describe('PATCH /api/account/documents/[id] — the meeting-prep stamp is the server’s', () => {
  const REAL = { startIso: '2026-10-18T15:00:00.000Z', calendarEventId: 'evt-1', meetingKey: 'a'.repeat(40), userId: 'user-1' }
  const FORGED = { ...REAL, userId: 'victim-9' }
  beforeEach(() => {
    hoisted.getUser.mockResolvedValue({ data: { user: { id: USER_ID } } })
    hoisted.getCurrentWorkspaceId.mockResolvedValue(WORKSPACE_ID)
    hoisted.indexDocumentSpy.mockResolvedValue({ chunksCreated: 1 })
    hoisted.updateSpy.mockClear()
    hoisted.loadAccess.mockImplementation(async () => accessFor())
    storedFrontmatter = {}
  })

  it('an incoming meeting_prep is dropped (a forged stamp never lands)', async () => {
    await PATCH(patchReq({ frontmatter: { area: 'sales', meeting_prep: FORGED } }), { params: Promise.resolve({ id: DOC_ID }) })
    expect(hoisted.updateSpy.mock.calls[0][0].frontmatter).toEqual({ area: 'sales' })
  })

  it('the stored stamp is kept, whatever the body says', async () => {
    storedFrontmatter = { meeting_prep: REAL, area: 'old' }
    await PATCH(patchReq({ frontmatter: { area: 'new', meeting_prep: FORGED } }), { params: Promise.resolve({ id: DOC_ID }) })
    expect(hoisted.updateSpy.mock.calls[0][0].frontmatter).toEqual({ area: 'new', meeting_prep: REAL })
    hoisted.updateSpy.mockClear()
    await PATCH(patchReq({ frontmatter: {} }), { params: Promise.resolve({ id: DOC_ID }) })
    expect(hoisted.updateSpy.mock.calls[0][0].frontmatter).toEqual({ meeting_prep: REAL })
  })

  it('the Now file’s stamp (migration 440) is kept the same way, and a forged one never lands', async () => {
    const stamp = { tracks: [{ kind: 'work', id: 'job-1', hash: 'a'.repeat(16), added_at: 't' }] }
    storedFrontmatter = { now: stamp }
    await PATCH(patchReq({ frontmatter: { area: 'x', now: { tracks: [] } } }), { params: Promise.resolve({ id: DOC_ID }) })
    expect(hoisted.updateSpy.mock.calls[0][0].frontmatter).toEqual({ area: 'x', now: stamp })
    hoisted.updateSpy.mockClear()
    storedFrontmatter = {}
    await PATCH(patchReq({ frontmatter: { now: { tracks: [] } } }), { params: Promise.resolve({ id: DOC_ID }) })
    expect(hoisted.updateSpy.mock.calls[0][0].frontmatter).toEqual({})
  })
})

describe('who may change it (migration 359)', () => {
  beforeEach(() => {
    hoisted.getUser.mockResolvedValue({ data: { user: { id: USER_ID } } })
    hoisted.getCurrentWorkspaceId.mockResolvedValue(WORKSPACE_ID)
    hoisted.indexDocumentSpy.mockResolvedValue({ chunksCreated: 1 })
    hoisted.updateSpy.mockClear()
    hoisted.serviceUpdateSpy.mockClear()
    hoisted.rpcSpy.mockClear()
    storedFrontmatter = {}
  })

  const params = { params: Promise.resolve({ id: DOC_ID }) }

  it('PATCH: another member on a plain note gets a 403 and nothing is written', async () => {
    hoisted.loadAccess.mockResolvedValue(accessFor({ role: 'member', memberId: 'member-other' }))
    const res = await PATCH(patchReq({ content: 'hijacked', base_revision: 3 }), params)
    expect(res.status).toBe(403)
    expect(await readJson<{ code: string }>(res)).toMatchObject({ code: 'FORBIDDEN' })
    expect(hoisted.updateSpy).not.toHaveBeenCalled()
  })

  it('PATCH: the creator edits, but not the product doc', async () => {
    hoisted.loadAccess.mockResolvedValue(accessFor({ role: 'member', memberId: 'member-creator' }))
    expect((await PATCH(patchReq({ content: 'mine', base_revision: 3 }), params)).status).toBe(200)
    hoisted.updateSpy.mockClear()
    hoisted.loadAccess.mockResolvedValue(accessFor({ role: 'member', memberId: 'member-creator', isProductDoc: true }))
    const res = await PATCH(patchReq({ content: 'mine', base_revision: 3 }), params)
    expect(res.status).toBe(403)
    expect((await readJson<{ error: string }>(res)).error).toMatch(/product doc/)
    expect(hoisted.updateSpy).not.toHaveBeenCalled()
  })

  it('PATCH: a member edits a shared wiki page but cannot archive it', async () => {
    hoisted.loadAccess.mockResolvedValue(accessFor({ role: 'member', memberId: 'member-other', row: { slug: 'onboarding' } }))
    expect((await PATCH(patchReq({ content: 'better', base_revision: 3 }), params)).status).toBe(200)
    hoisted.updateSpy.mockClear()
    expect((await PATCH(patchReq({ status: 'archived' }), params)).status).toBe(403)
    expect(hoisted.updateSpy).not.toHaveBeenCalled()
  })

  it('PATCH: a member on a shared page cannot move it into a project', async () => {
    hoisted.loadAccess.mockResolvedValue(accessFor({ role: 'member', memberId: 'member-other', row: { slug: 'onboarding' } }))
    expect((await PATCH(patchReq({ project_id: 'proj-2' }), params)).status).toBe(403)
    expect(hoisted.updateSpy).not.toHaveBeenCalled()
  })

  it('PATCH: a guest never edits', async () => {
    hoisted.loadAccess.mockResolvedValue(accessFor({ role: 'guest', memberId: 'member-creator' }))
    expect((await PATCH(patchReq({ content: 'x', base_revision: 3 }), params)).status).toBe(403)
  })

  it('PATCH: a document outside the workspace is a 404', async () => {
    hoisted.loadAccess.mockResolvedValue({ access: null, error: null })
    expect((await PATCH(patchReq({ content: 'x', base_revision: 3 }), params)).status).toBe(404)
  })

  it('DELETE (archive): refused for a non-creator member, through the service client for the creator', async () => {
    hoisted.loadAccess.mockResolvedValue(accessFor({ role: 'member', memberId: 'member-other', row: { slug: 'onboarding' } }))
    expect((await DELETE(deleteReq(false), params)).status).toBe(403)
    expect(hoisted.serviceUpdateSpy).not.toHaveBeenCalled()

    // The creator of a spec page may archive it, though they can't edit it.
    hoisted.loadAccess.mockResolvedValue(accessFor({ role: 'member', memberId: 'member-creator', row: { type: 'spec' } }))
    const res = await DELETE(deleteReq(false), params)
    expect(res.status).toBe(200)
    expect(hoisted.serviceUpdateSpy).toHaveBeenCalledWith({ status: 'archived' })
  })

  it('DELETE (permanent): refused before the RPC for a non-creator, the product doc too; an admin goes through', async () => {
    hoisted.loadAccess.mockResolvedValue(accessFor({ role: 'member', memberId: 'member-other' }))
    expect((await DELETE(deleteReq(true), params)).status).toBe(403)
    hoisted.loadAccess.mockResolvedValue(accessFor({ role: 'member', memberId: 'member-creator', isProductDoc: true }))
    expect((await DELETE(deleteReq(true), params)).status).toBe(403)
    expect(hoisted.rpcSpy).not.toHaveBeenCalled()

    // The product doc is a system document (migration 366): an admin can't delete it either.
    hoisted.loadAccess.mockResolvedValue(accessFor({ role: 'admin', memberId: 'member-admin', isProductDoc: true }))
    const sys = await DELETE(deleteReq(true), params)
    expect(sys.status).toBe(403)
    expect((await readJson<{ error: string }>(sys)).error).toBe('This is a system document. It can be edited, not deleted.')
    expect(hoisted.rpcSpy).not.toHaveBeenCalled()

    hoisted.loadAccess.mockResolvedValue(accessFor({ role: 'admin', memberId: 'member-admin' }))
    expect((await DELETE(deleteReq(true), params)).status).toBe(200)
    expect(hoisted.rpcSpy).toHaveBeenCalledWith('delete_document_with_knowledge', {
      p_document_id: DOC_ID,
      p_workspace_id: WORKSPACE_ID,
      p_user_id: USER_ID,
    })
  })

  it('a canon doc is a system document: no delete, no archive (DELETE or PATCH), still edited; GET says so', async () => {
    hoisted.loadAccess.mockResolvedValue(accessFor({ role: 'owner', row: { canon_key: 'brand' } }))
    for (const permanent of [true, false]) {
      const res = await DELETE(deleteReq(permanent), params)
      expect(res.status).toBe(403)
      expect((await readJson<{ error: string }>(res)).error).toBe('This is a system document. It can be edited, not deleted.')
    }
    expect(hoisted.rpcSpy).not.toHaveBeenCalled()
    expect(hoisted.serviceUpdateSpy).not.toHaveBeenCalled()
    expect((await PATCH(patchReq({ status: 'archived' }), params)).status).toBe(403)
    expect((await PATCH(patchReq({ content: 'Edited.', base_revision: 3 }), params)).status).toBe(200)
    const json = await readJson<{ document: { can_delete: boolean; is_system: boolean; can_edit: boolean } }>(await GET(patchReq({}), params))
    expect(json.document).toMatchObject({ is_system: true, can_delete: false, can_edit: true })
  })

  it("GET: someone else's private document is a 404, not a 500 (RLS hides it, migration 369)", async () => {
    documentHidden = true
    try {
      hoisted.loadAccess.mockResolvedValue({ access: null, error: null })
      const res = await GET(patchReq({}), params)
      expect(res.status).toBe(404)
    } finally {
      documentHidden = false
    }
  })

  it('GET: says can_edit, can_delete and can_set_project', async () => {
    hoisted.loadAccess.mockResolvedValue(accessFor({ role: 'member', memberId: 'member-other', row: { slug: 'onboarding' } }))
    let json = await readJson<{ document: { can_edit: boolean; can_delete: boolean; can_set_project: boolean } }>(await GET(patchReq({}), params))
    // A member on a shared page edits it, but can't move it into a project.
    expect(json.document).toMatchObject({ can_edit: true, can_delete: false, can_set_project: false })

    hoisted.loadAccess.mockResolvedValue(accessFor({ role: 'member', memberId: 'member-other' }))
    json = await readJson(await GET(patchReq({}), params))
    expect(json.document).toMatchObject({ can_edit: false, can_delete: false, can_set_project: false })

    hoisted.loadAccess.mockResolvedValue(accessFor({ role: 'member', memberId: 'member-creator' }))
    json = await readJson(await GET(patchReq({}), params))
    expect(json.document).toMatchObject({ can_edit: true, can_delete: true, can_set_project: true })
  })
})

describe('safe writes (migration 364)', () => {
  beforeEach(() => {
    hoisted.getUser.mockResolvedValue({ data: { user: { id: USER_ID } } })
    hoisted.getCurrentWorkspaceId.mockResolvedValue(WORKSPACE_ID)
    hoisted.loadAccess.mockImplementation(async () => accessFor())
    hoisted.indexDocumentSpy.mockReset()
    hoisted.indexDocumentSpy.mockResolvedValue({ chunksCreated: 1 })
    hoisted.updateSpy.mockClear()
    storedFrontmatter = {}
    storedRevision = 3
  })
  const params = { params: Promise.resolve({ id: DOC_ID }) }

  it('a body change without base_revision (an old client bundle) is written blind against the revision now, with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const res = await PATCH(patchReq({ content: 'blind' }), params)
      expect(res.status).toBe(200)
      // Written, as a human edit, so it still lands in the history.
      expect(hoisted.updateSpy).toHaveBeenCalledWith(expect.objectContaining({ content: 'blind', edit_source: 'human' }))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('without base_revision'))
    } finally {
      warn.mockRestore()
    }
  })

  it('writes as a human edit, conditional on the revision read, and returns the new revision', async () => {
    const res = await PATCH(patchReq({ content: 'Edited.', base_revision: 3 }), params)
    expect(res.status).toBe(200)
    expect(hoisted.updateSpy.mock.calls[0][0]).toMatchObject({ content: 'Edited.', edit_source: 'human', last_edited_by: 'member-1' })
    expect(hoisted.updateSpy.mock.calls[0][0]).not.toHaveProperty('base_revision')
    expect((await readJson<{ document: { revision: number } }>(res)).document.revision).toBe(4)
  })

  it('a document that moved on is a 409 with the revision it is at, and nothing is re-indexed', async () => {
    storedRevision = 5
    const res = await PATCH(patchReq({ content: 'Stale copy.', base_revision: 3 }), params)
    expect(res.status).toBe(409)
    const json = await readJson<{ code: string; error: string; details: { revision: number; base_revision: number } }>(res)
    expect(json.code).toBe('CONFLICT')
    expect(json.error).toMatch(/changed since you read it/)
    expect(json.details).toEqual({ revision: 5, base_revision: 3 })
    expect(hoisted.indexDocumentSpy).not.toHaveBeenCalled()
  })

  it('a rename alone needs no base: it is checked against the revision read just now', async () => {
    const res = await PATCH(patchReq({ title: 'Renamed' }), params)
    expect(res.status).toBe(200)
    expect(hoisted.updateSpy.mock.calls[0][0]).toMatchObject({ title: 'Renamed', edit_source: 'human' })
  })

  it('a change summary rides along to the history row', async () => {
    await PATCH(patchReq({ content: 'Kept mine.', base_revision: 3, change_summary: 'Kept my version over a newer change' }), params)
    expect(hoisted.updateSpy.mock.calls[0][0]).toMatchObject({ edit_summary: 'Kept my version over a newer change' })
  })
})
