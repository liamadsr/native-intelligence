/**
 * Tests for DELETE /api/account/attachments/[id].
 *
 * The load-bearing invariant: storage objects are removed BEFORE the row is
 * deleted — the workspace storage policies (migration 128) authorize through
 * the attachments row, so removing the row first would strand the objects.
 * Also locked in: generated reference docs (spec pages) get archived on the
 * SERVICE client once the attachment delete went through (since migration 359
 * a member's session can't change a spec page), knowledge-graph
 * provenance is torn down via the cleanup_attachment_knowledge RPC (migration
 * 178), and bad ids / missing rows return 400 / 404.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  getCurrentWorkspaceId: vi.fn(),
  storageRemove: vi.fn(),
  documentUpdate: vi.fn(),
  knowledgeCleanupRpc: vi.fn(),
  rowDelete: vi.fn(),
  callOrder: [] as string[],
  // The archive's filters, and the workspace settings it reads the product doc from.
  archiveFilters: [] as Array<[string, string, unknown]>,
  settings: {} as Record<string, unknown>,
}))

vi.mock('@/lib/workspace', () => ({
  getCurrentWorkspaceId: hoisted.getCurrentWorkspaceId,
  WORKSPACE_COOKIE: 'workspace_id',
  WORKSPACE_HEADER: 'x-workspace-id',
}))

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

let attachmentRow: Record<string, unknown> | null = null

const fakeSupabase = {
  auth: {
    getUser: vi.fn(async () => ({ data: { user: { id: 'user-abc' } } })),
  },
  from: (table: string) => {
    if (table === 'attachments') {
      return {
        select: () => makeProxy({ data: attachmentRow, error: null }),
        delete: (opts?: { count?: string }) => {
          hoisted.rowDelete(opts)
          hoisted.callOrder.push('row-delete')
          return makeProxy({ error: null, count: attachmentRow ? 1 : 0 })
        },
      }
    }
    if (table === 'document') throw new Error('the archive must not run on the session client')
    // Workspace resolution (requireWorkspace) now reads the member table
    // directly. Derive the row from the getCurrentWorkspaceId spy so the
    // existing knob still controls whether a workspace resolves.
    if (table === 'member') {
      return makeProxy(
        Promise.resolve(hoisted.getCurrentWorkspaceId()).then((ws: unknown) => ({
          data: ws ? { workspace_id: ws, id: 'member-1' } : null,
          error: null,
        })),
      )
    }
    return makeProxy({ data: null, error: null })
  },
  storage: {
    from: () => ({
      remove: (paths: string[]) => {
        hoisted.storageRemove(paths)
        hoisted.callOrder.push('storage-remove')
        return Promise.resolve({ error: null })
      },
    }),
  },
  rpc: (fn: string, args: unknown) => {
    hoisted.knowledgeCleanupRpc(fn, args)
    hoisted.callOrder.push('knowledge-cleanup')
    return Promise.resolve({ data: null, error: null })
  },
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => fakeSupabase,
}))

// The generated pages are archived on the service client.
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      if (table === 'workspace') return makeProxy({ data: { settings: hoisted.settings }, error: null })
      if (table !== 'document') throw new Error(`unexpected service table ${table}`)
      return {
        update: (payload: unknown) => {
          hoisted.documentUpdate(payload)
          hoisted.callOrder.push('document-archive')
          const chain: Record<string, unknown> = {
            then: (cb: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(cb),
          }
          for (const op of ['eq', 'neq', 'is', 'contains']) {
            chain[op] = (col: string, val: unknown) => (hoisted.archiveFilters.push([op, col, val]), chain)
          }
          return chain
        },
      }
    },
  }),
}))

const { DELETE } = await import('@/app/api/account/attachments/[id]/route')

const ATT_ID = '11111111-2222-3333-4444-555555555555'

function deleteRequest(id: string) {
  return [
    new Request(`https://nativeintelligence.dev/api/account/attachments/${id}`, { method: 'DELETE' }),
    { params: Promise.resolve({ id }) },
  ] as const
}

beforeEach(() => {
  hoisted.getCurrentWorkspaceId.mockResolvedValue('workspace-1')
  hoisted.storageRemove.mockClear()
  hoisted.documentUpdate.mockClear()
  hoisted.knowledgeCleanupRpc.mockClear()
  hoisted.rowDelete.mockClear()
  hoisted.callOrder.length = 0
  hoisted.archiveFilters.length = 0
  hoisted.settings = {}
  attachmentRow = {
    id: ATT_ID,
    storage_path: 'user-abc/project-1/file.pdf',
    thumbnail_path: 'user-abc/project-1/file-thumb.png',
    storage_bucket: 'attachments',
  }
})

describe('DELETE /api/account/attachments/[id]', () => {
  it('rejects a non-UUID id', async () => {
    const [req, ctx] = deleteRequest('not-a-uuid')
    const res = await DELETE(req, ctx)
    expect(res.status).toBe(400)
    expect(hoisted.storageRemove).not.toHaveBeenCalled()
  })

  it('returns 404 when the attachment does not exist in the workspace', async () => {
    attachmentRow = null
    const [req, ctx] = deleteRequest(ATT_ID)
    const res = await DELETE(req, ctx)
    expect(res.status).toBe(404)
    expect(hoisted.storageRemove).not.toHaveBeenCalled()
    expect(hoisted.rowDelete).not.toHaveBeenCalled()
  })

  it('removes storage objects, archives generated docs, cleans knowledge provenance, then the row', async () => {
    const [req, ctx] = deleteRequest(ATT_ID)
    const res = await DELETE(req, ctx)
    expect(res.status).toBe(200)

    // Both the object and its thumbnail go
    expect(hoisted.storageRemove).toHaveBeenCalledWith([
      'user-abc/project-1/file.pdf',
      'user-abc/project-1/file-thumb.png',
    ])
    // Reference pages generated from this file are archived, not orphaned
    expect(hoisted.documentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'archived' }),
    )
    // Knowledge-graph teardown goes through the migration-178 RPC (claims
    // sole-sourced by this file + evidence rows + edges), not a bare
    // entity_link delete.
    expect(hoisted.knowledgeCleanupRpc).toHaveBeenCalledExactlyOnceWith(
      'cleanup_attachment_knowledge',
      // p_user_id required: on device-token auth the route's client has no
      // session, so the RPC cannot read auth.uid().
      { p_attachment_id: ATT_ID, p_workspace_id: 'workspace-1', p_user_id: 'user-abc' },
    )

    // Ordering invariants: storage removal and provenance cleanup both happen
    // before the row delete — storage RLS authorizes via the row, and the RPC
    // partitions claims by evidence that must still exist.
    expect(hoisted.callOrder.indexOf('storage-remove')).toBeLessThan(
      hoisted.callOrder.indexOf('row-delete'),
    )
    expect(hoisted.callOrder.indexOf('knowledge-cleanup')).toBeLessThan(
      hoisted.callOrder.indexOf('row-delete'),
    )
    // The spec pages are archived only once the delete went through.
    expect(hoisted.callOrder.indexOf('row-delete')).toBeLessThan(
      hoisted.callOrder.indexOf('document-archive'),
    )
  })

  it('leaves system documents out of the archive: a canon_key, and the product doc (one refused row fails the batch)', async () => {
    const PRODUCT_DOC = '99999999-2222-3333-4444-555555555555'
    hoisted.settings = { product_doc: { document_id: PRODUCT_DOC, set_by: null, set_at: null } }
    const [req, ctx] = deleteRequest(ATT_ID)
    expect((await DELETE(req, ctx)).status).toBe(200)
    expect(hoisted.archiveFilters).toContainEqual(['is', 'canon_key', null])
    expect(hoisted.archiveFilters).toContainEqual(['neq', 'id', PRODUCT_DOC])
  })

  it('archives nothing when the attachment delete is refused', async () => {
    const [req, ctx] = deleteRequest(ATT_ID)
    const original = fakeSupabase.from
    fakeSupabase.from = (table: string) => {
      if (table === 'attachments') {
        return {
          select: () => makeProxy({ data: attachmentRow, error: null }),
          delete: () => {
            hoisted.callOrder.push('row-delete')
            return makeProxy({ error: null, count: 0 })
          },
        }
      }
      return original(table)
    }
    try {
      const res = await DELETE(req, ctx)
      expect(res.status).toBe(404)
      expect(hoisted.documentUpdate).not.toHaveBeenCalled()
    } finally {
      fakeSupabase.from = original
    }
  })

  it('skips storage removal when there are no storage paths', async () => {
    attachmentRow = { id: ATT_ID, storage_path: null, thumbnail_path: null, storage_bucket: null }
    const [req, ctx] = deleteRequest(ATT_ID)
    const res = await DELETE(req, ctx)
    expect(res.status).toBe(200)
    expect(hoisted.storageRemove).not.toHaveBeenCalled()
    expect(hoisted.rowDelete).toHaveBeenCalledOnce()
  })
})
