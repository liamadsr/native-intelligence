/**
 * Tests for GET and POST /api/account/attachments.
 *
 * POST is now the JSON registration endpoint: the browser uploads the file
 * directly to storage, then posts metadata here. The route validates the
 * client-supplied storage_path, verifies the object, derives project_id from
 * the parent action/capture, and inserts the row.
 *
 * GET:
 *   - 401 when unauthenticated
 *   - 400 when no workspace cookie/header
 *   - 200 with action_id filter → workspace-shared (no user_id filter)
 *   - 200 with note_id filter
 *
 * POST:
 *   - 401 when unauthenticated
 *   - 400 when no workspace
 *   - 400 when required fields missing
 *   - 400 when no parent id
 *   - 400 for an unsupported file extension
 *   - 400 for a storage_path outside the caller's own folder
 *   - 400 when the object is already registered
 *   - 200 happy path for a capture (note_id) — derives project_id from capture
 *   - 200 happy path for an action (action_id) — derives project_id from action
 *   - 200 happy path for a project-only upload
 *   - 404 when the parent action / project is not in the workspace
 *   - 500 + storage cleanup when the DB insert fails
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => ({
  getCurrentWorkspaceId: vi.fn(),
  storageInfo: vi.fn(),
  storageRemove: vi.fn(),
  attachmentsSelect: vi.fn(),
  attachmentsInsert: vi.fn(),
  attachmentsCount: vi.fn(),
  attachmentsExisting: vi.fn(),
  inngestSend: vi.fn(),
}))

vi.mock('@/lib/workspace', () => ({
  getCurrentWorkspaceId: hoisted.getCurrentWorkspaceId,
  WORKSPACE_COOKIE: 'workspace_id',
  WORKSPACE_HEADER: 'x-workspace-id',
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: hoisted.inngestSend },
}))

// ---------------------------------------------------------------------------
// Supabase client factory
// ---------------------------------------------------------------------------

function makeProxy(result: unknown) {
  const chain: Record<string, unknown> = {}
  const proxy: unknown = new Proxy(chain, {
    get(_, prop: string) {
      if (prop === 'then') {
        return (cb: (v: unknown) => unknown) => Promise.resolve(result).then(cb)
      }
      if (prop === 'single' || prop === 'maybeSingle') {
        return () => Promise.resolve(result)
      }
      return () => proxy
    },
  })
  return proxy
}

function makeFakeSupabase(opts: {
  user?: { id: string } | null
  selectResult?: unknown
  insertResult?: unknown
  countResult?: unknown
  existingResult?: unknown
  projectResult?: unknown
  actionResult?: unknown
  captureResult?: unknown
} = {}) {
  const {
    user = { id: 'user-abc' },
    selectResult = { data: [], error: null },
    insertResult = { data: { id: 'att-1', file_name: 'test.pdf', file_category: 'document', action_id: 'action-1', note_id: null, project_id: null, created_at: new Date().toISOString(), file_size_bytes: 100, mime_type: 'application/pdf', file_extension: 'pdf', storage_path: 'user-abc/action-1/file.pdf', thumbnail_path: null }, error: null },
    countResult = { data: null, count: 0, error: null },
    existingResult = { data: null, error: null },
    projectResult = { data: { id: 'project-1' }, error: null },
    actionResult = { data: { id: 'action-1', project_id: null }, error: null },
    captureResult = { data: { id: 'capture-1', project_id: null }, error: null },
  } = opts

  return {
    auth: {
      getUser: vi.fn(async () => ({ data: { user } })),
    },
    from: (table: string) => {
      if (table === 'projects') return makeProxy(projectResult)
      if (table === 'actions') return makeProxy(actionResult)
      if (table === 'captures') return makeProxy(captureResult)
      if (table === 'member') {
        return makeProxy(
          Promise.resolve(hoisted.getCurrentWorkspaceId()).then((ws: unknown) => ({
            data: ws ? { workspace_id: ws, id: 'member-1' } : null,
            error: null,
          })),
        )
      }
      if (table !== 'attachments') return makeProxy({ data: null, error: null })

      return {
        select: (fields: string, selectOpts?: { count?: string; head?: boolean }) => {
          if (selectOpts?.head) {
            hoisted.attachmentsCount(fields, selectOpts)
            return makeProxy(countResult)
          }
          // The existing-row double-register guard selects 'id' + maybeSingle;
          // the GET select requests the full field list.
          if (fields === 'id') {
            hoisted.attachmentsExisting(fields)
            return makeProxy(existingResult)
          }
          hoisted.attachmentsSelect(fields)
          return makeProxy(selectResult)
        },
        insert: (payload: unknown) => {
          hoisted.attachmentsInsert(payload)
          return makeProxy(insertResult)
        },
      }
    },
    storage: {
      from: () => ({
        info: hoisted.storageInfo,
        remove: hoisted.storageRemove,
      }),
    },
  }
}

let fakeSupabase = makeFakeSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => fakeSupabase,
}))

// ---------------------------------------------------------------------------
// Dynamic import (after all mocks are set up)
// ---------------------------------------------------------------------------

const { GET, POST } = await import('@/app/api/account/attachments/route')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('https://dial8.ai/api/account/attachments')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new NextRequest(url.toString(), { method: 'GET' })
}

function postRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('https://dial8.ai/api/account/attachments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function makeBody(opts: {
  storagePath?: string
  fileName?: string
  size?: number
  mimeType?: string
  noteId?: string
  actionId?: string
  projectId?: string
} = {}) {
  const {
    storagePath = 'user-abc/action-1/11111111-1111-1111-1111-111111111111.pdf',
    fileName = 'test.pdf',
    size = 100,
    mimeType = 'application/pdf',
    noteId,
    actionId,
    projectId,
  } = opts

  const body: Record<string, unknown> = {
    storage_path: storagePath,
    file_name: fileName,
    file_size_bytes: size,
    mime_type: mimeType,
  }
  if (noteId) body.note_id = noteId
  if (actionId) body.action_id = actionId
  if (projectId) body.project_id = projectId
  return body
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  hoisted.attachmentsSelect.mockReset()
  hoisted.attachmentsInsert.mockReset()
  hoisted.attachmentsCount.mockReset()
  hoisted.attachmentsExisting.mockReset()
  hoisted.storageInfo.mockReset()
  hoisted.storageRemove.mockReset()
  hoisted.inngestSend.mockReset()
  hoisted.getCurrentWorkspaceId.mockResolvedValue('workspace-1')
  hoisted.storageInfo.mockResolvedValue({ data: { size: 100 }, error: null })
  hoisted.storageRemove.mockResolvedValue({ error: null })
  hoisted.inngestSend.mockResolvedValue(undefined)
  fakeSupabase = makeFakeSupabase()
})

// ── GET ──────────────────────────────────────────────────────────────────────

describe('GET /api/account/attachments', () => {
  it('returns 401 when unauthenticated', async () => {
    fakeSupabase = makeFakeSupabase({ user: null })
    const res = await GET(getRequest({ action_id: 'action-1' }))
    expect(res.status).toBe(401)
  })

  it('returns 400 when workspace cannot be resolved', async () => {
    hoisted.getCurrentWorkspaceId.mockResolvedValue(null)
    const res = await GET(getRequest({ note_id: 'note-1' }))
    expect(res.status).toBe(400)
  })

  it('filters by action_id when action_id param is provided (workspace-shared)', async () => {
    fakeSupabase = makeFakeSupabase({
      selectResult: { data: [{ id: 'att-1', file_name: 'doc.pdf', file_category: 'document', action_id: 'action-99', note_id: null, project_id: null, created_at: '2025-01-01', file_size_bytes: 0, mime_type: null, file_extension: null, storage_path: null, thumbnail_path: null }], error: null },
    })
    const res = await GET(getRequest({ action_id: 'action-99' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.attachments).toHaveLength(1)
    expect(body.attachments[0].action_id).toBe('action-99')
  })

  it('filters by note_id when note_id param is provided', async () => {
    fakeSupabase = makeFakeSupabase({
      selectResult: { data: [{ id: 'att-2', file_name: 'img.png', file_category: 'image', action_id: null, note_id: 'note-55', project_id: null, created_at: '2025-01-01', file_size_bytes: 0, mime_type: null, file_extension: null, storage_path: null, thumbnail_path: null }], error: null },
    })
    const res = await GET(getRequest({ note_id: 'note-55' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.attachments).toHaveLength(1)
    expect(body.attachments[0].note_id).toBe('note-55')
  })
})

// ── POST ─────────────────────────────────────────────────────────────────────

describe('POST /api/account/attachments', () => {
  it('returns 401 when unauthenticated', async () => {
    fakeSupabase = makeFakeSupabase({ user: null })
    const res = await POST(postRequest(makeBody({ actionId: 'action-1' })))
    expect(res.status).toBe(401)
  })

  it('returns 400 when workspace cannot be resolved', async () => {
    hoisted.getCurrentWorkspaceId.mockResolvedValue(null)
    const res = await POST(postRequest(makeBody({ actionId: 'action-1' })))
    expect(res.status).toBe(400)
  })

  it('returns 400 when required fields are missing', async () => {
    const res = await POST(postRequest({ action_id: 'action-1' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when no parent id is present', async () => {
    const res = await POST(postRequest(makeBody()))
    expect(res.status).toBe(400)
  })

  it('returns 400 for an unsupported file extension', async () => {
    const res = await POST(
      postRequest(
        makeBody({
          storagePath: 'user-abc/action-1/11111111-1111-1111-1111-111111111111.exe',
          fileName: 'evil.exe',
          mimeType: 'application/octet-stream',
          actionId: 'action-1',
        }),
      ),
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 for a storage_path outside the caller own folder', async () => {
    const res = await POST(
      postRequest(
        makeBody({
          storagePath: 'someone-else/action-1/11111111-1111-1111-1111-111111111111.pdf',
          actionId: 'action-1',
        }),
      ),
    )
    expect(res.status).toBe(400)
    expect(hoisted.attachmentsInsert).not.toHaveBeenCalled()
  })

  it('returns 400 when the storage path extension does not match the file name', async () => {
    const res = await POST(
      postRequest(
        makeBody({
          storagePath: 'user-abc/action-1/11111111-1111-1111-1111-111111111111.png',
          fileName: 'report.pdf',
          actionId: 'action-1',
        }),
      ),
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 when the object is already registered', async () => {
    fakeSupabase = makeFakeSupabase({ existingResult: { data: { id: 'att-dup' }, error: null } })
    const res = await POST(postRequest(makeBody({ actionId: 'action-1' })))
    expect(res.status).toBe(400)
    expect(hoisted.attachmentsInsert).not.toHaveBeenCalled()
  })

  it('returns 400 when the object does not exist in storage', async () => {
    hoisted.storageInfo.mockResolvedValue({ data: null, error: { message: 'not found' } })
    const res = await POST(postRequest(makeBody({ actionId: 'action-1' })))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/not found in storage/i)
    expect(hoisted.attachmentsInsert).not.toHaveBeenCalled()
  })

  it('rejects when the stored object is larger than the cap regardless of client-declared size', async () => {
    hoisted.storageInfo.mockResolvedValue({ data: { size: 51 * 1024 * 1024 }, error: null })
    const res = await POST(postRequest(makeBody({ actionId: 'action-1' })))
    expect(res.status).toBe(400)
    expect(hoisted.storageRemove).toHaveBeenCalled()
    expect(hoisted.attachmentsInsert).not.toHaveBeenCalled()
  })

  // ── Happy path: capture (note_id) ─────────────────────────────────────────

  it('inserts with note_id and derives project_id from the capture', async () => {
    fakeSupabase = makeFakeSupabase({
      captureResult: { data: { id: 'capture-42', project_id: 'project-derived' }, error: null },
      insertResult: {
        data: { id: 'att-cap', file_name: 'report.pdf', file_category: 'document', action_id: null, note_id: 'capture-42', project_id: 'project-derived', created_at: new Date().toISOString(), file_size_bytes: 100, mime_type: 'application/pdf', file_extension: 'pdf', storage_path: 'user-abc/capture-42/x.pdf', thumbnail_path: null },
        error: null,
      },
    })
    const res = await POST(
      postRequest(
        makeBody({
          storagePath: 'user-abc/capture-42/11111111-1111-1111-1111-111111111111.pdf',
          fileName: 'report.pdf',
          noteId: 'capture-42',
        }),
      ),
    )
    expect(res.status).toBe(200)

    expect(hoisted.attachmentsInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        note_id: 'capture-42',
        action_id: null,
        project_id: 'project-derived',
        user_id: 'user-abc',
        workspace_id: 'workspace-1',
        file_name: 'report.pdf',
        file_category: 'document',
      }),
    )
  })

  // ── Happy path: action (action_id) ────────────────────────────────────────

  it('inserts with action_id and derives project_id from the action', async () => {
    fakeSupabase = makeFakeSupabase({
      actionResult: { data: { id: 'action-77', project_id: 'project-77' }, error: null },
      insertResult: {
        data: { id: 'att-new', file_name: 'design.pdf', file_category: 'document', action_id: 'action-77', note_id: null, project_id: 'project-77', created_at: new Date().toISOString(), file_size_bytes: 200, mime_type: 'application/pdf', file_extension: 'pdf', storage_path: 'user-abc/action-77/file.pdf', thumbnail_path: null },
        error: null,
      },
    })

    const res = await POST(
      postRequest(
        makeBody({
          storagePath: 'user-abc/action-77/11111111-1111-1111-1111-111111111111.pdf',
          fileName: 'design.pdf',
          actionId: 'action-77',
        }),
      ),
    )
    expect(res.status).toBe(200)

    expect(hoisted.attachmentsInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        action_id: 'action-77',
        note_id: null,
        project_id: 'project-77',
        user_id: 'user-abc',
        workspace_id: 'workspace-1',
        file_name: 'design.pdf',
        file_category: 'document',
      }),
    )

    const body = await res.json()
    expect(body.attachment).toMatchObject({ id: 'att-new', action_id: 'action-77', note_id: null })
  })

  // ── Happy path: project-only upload ───────────────────────────────────────

  it('inserts with project_id as the sole parent and fires the index event', async () => {
    fakeSupabase = makeFakeSupabase({
      insertResult: {
        data: { id: 'att-proj', file_name: 'api-spec.pdf', file_category: 'document', action_id: null, note_id: null, project_id: 'project-9', created_at: new Date().toISOString(), file_size_bytes: 300, mime_type: 'application/pdf', file_extension: 'pdf', storage_path: 'user-abc/project-9/file.pdf', thumbnail_path: null },
        error: null,
      },
    })

    const res = await POST(
      postRequest(
        makeBody({
          storagePath: 'user-abc/project-9/11111111-1111-1111-1111-111111111111.pdf',
          fileName: 'api-spec.pdf',
          projectId: 'project-9',
        }),
      ),
    )
    expect(res.status).toBe(200)

    expect(hoisted.attachmentsInsert).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: 'project-9', note_id: null, action_id: null, file_name: 'api-spec.pdf' }),
    )
    expect(hoisted.inngestSend).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'attachment/index',
        data: expect.objectContaining({ projectId: 'project-9' }),
      }),
    )
  })

  it('returns 404 when the project is not in the workspace', async () => {
    fakeSupabase = makeFakeSupabase({ projectResult: { data: null, error: null } })
    const res = await POST(
      postRequest(
        makeBody({
          storagePath: 'user-abc/project-elsewhere/11111111-1111-1111-1111-111111111111.pdf',
          fileName: 'api-spec.pdf',
          projectId: 'project-elsewhere',
        }),
      ),
    )
    expect(res.status).toBe(404)
    expect(hoisted.attachmentsInsert).not.toHaveBeenCalled()
  })

  it('returns 404 when the action is not in the workspace', async () => {
    fakeSupabase = makeFakeSupabase({ actionResult: { data: null, error: null } })
    const res = await POST(postRequest(makeBody({ actionId: 'action-elsewhere' })))
    expect(res.status).toBe(404)
    expect(hoisted.attachmentsInsert).not.toHaveBeenCalled()
  })

  it('returns 500 and removes uploaded file when DB insert fails', async () => {
    fakeSupabase = makeFakeSupabase({
      insertResult: { data: null, error: { message: 'constraint violation' } },
    })
    const res = await POST(postRequest(makeBody({ actionId: 'action-1' })))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toHaveProperty('error')
    expect(hoisted.storageRemove).toHaveBeenCalled()
  })
})
