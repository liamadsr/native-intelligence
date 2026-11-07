import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createSupabaseMock } from '@/test/supabase-mock'
import { createDocumentTools } from '../documents'

const USER_ID = 'user-uuid-1'
const WORKSPACE_ID = 'workspace-uuid-1'
const ACTION_ID = 'action-uuid-1'
const DOCUMENT_ID = 'document-uuid-1'
const LINK_ID = 'link-uuid-1'

const OTHER_WORKSPACE_ID = 'workspace-uuid-2'

const EXEC_OPTS = {
  toolCallId: 'test-call-id',
  messages: [],
  context: {},
} satisfies ToolExecutionOptions<Record<string, unknown>>

/**
 * link/unlink resolve BOTH ids through resolveEntityWorkspace before touching
 * action_document, so the flat mocks below have to answer those two probes with
 * rows that live in the active workspace.
 */
const IN_WORKSPACE = {
  actions: { data: { workspace_id: WORKSPACE_ID }, error: null },
  document: { data: { workspace_id: WORKSPACE_ID }, error: null },
}

describe('link_document_to_action', () => {
  it('inserts into action_document and returns link_id on success', async () => {
    const supabase = createSupabaseMock({
      tables: {
        ...IN_WORKSPACE,
        action_document: { data: { id: LINK_ID }, error: null },
      },
    })

    const tools = createDocumentTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.link_document_to_action.execute!(
      { action_id: ACTION_ID, document_id: DOCUMENT_ID },
      EXEC_OPTS,
    ) as any

    expect(result.success).toBe(true)
    expect(result.link_id).toBe(LINK_ID)
    expect(supabase.from).toHaveBeenCalledWith('action_document')
  })

  it('returns a friendly error when the document is already linked (23505)', async () => {
    const supabase = createSupabaseMock({
      tables: {
        ...IN_WORKSPACE,
        action_document: { data: null, error: { message: 'dup', code: '23505' } },
      },
    })

    const tools = createDocumentTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.link_document_to_action.execute!(
      { action_id: ACTION_ID, document_id: DOCUMENT_ID },
      EXEC_OPTS,
    ) as any

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/already linked/)
  })

  it('returns an error on unexpected DB failure', async () => {
    const supabase = createSupabaseMock({
      tables: {
        ...IN_WORKSPACE,
        action_document: { data: null, error: { message: 'db error' } },
      },
    })

    const tools = createDocumentTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.link_document_to_action.execute!(
      { action_id: ACTION_ID, document_id: DOCUMENT_ID },
      EXEC_OPTS,
    ) as any

    expect(result.success).toBe(false)
    expect(result.error).toBe('db error')
  })
})

describe('unlink_document_from_action', () => {
  it('deletes from action_document and returns success', async () => {
    const supabase = createSupabaseMock({
      tables: {
        ...IN_WORKSPACE,
        action_document: { data: null, error: null },
      },
    })

    const tools = createDocumentTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.unlink_document_from_action.execute!(
      { action_id: ACTION_ID, document_id: DOCUMENT_ID },
      EXEC_OPTS,
    ) as any

    expect(result.success).toBe(true)
    expect(supabase.from).toHaveBeenCalledWith('action_document')
  })

  it('returns an error on DB failure', async () => {
    const supabase = createSupabaseMock({
      tables: {
        ...IN_WORKSPACE,
        action_document: { data: null, error: { message: 'delete failed' } },
      },
    })

    const tools = createDocumentTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.unlink_document_from_action.execute!(
      { action_id: ACTION_ID, document_id: DOCUMENT_ID },
      EXEC_OPTS,
    ) as any

    expect(result.success).toBe(false)
    expect(result.error).toBe('delete failed')
  })
})

describe('list_action_documents', () => {
  it('returns a shaped document list for the action', async () => {
    const supabase = createSupabaseMock({
      tables: {
        // The action is resolved through resolveEntityWorkspace before the join
        // is read (see routing.documents.test.ts), and each linked document must
        // land in the workspace that resolve returned.
        actions: { data: { workspace_id: WORKSPACE_ID }, error: null },
        action_document: {
          data: [
            {
              id: LINK_ID,
              document: {
                id: DOCUMENT_ID,
                workspace_id: WORKSPACE_ID,
                title: 'Project Spec',
                updated_at: '2026-01-01T00:00:00Z',
                created_by: { id: 'member-1', display_name: 'Alice' },
              },
            },
          ],
          error: null,
        },
      },
    })

    const tools = createDocumentTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.list_action_documents.execute!(
      { action_id: ACTION_ID },
      EXEC_OPTS,
    ) as any

    expect(result.success).toBe(true)
    expect(result.count).toBe(1)
    expect(result.documents[0]).toMatchObject({
      link_id: LINK_ID,
      id: DOCUMENT_ID,
      title: 'Project Spec',
      created_by_name: 'Alice',
    })
    expect(supabase.from).toHaveBeenCalledWith('action_document')
  })

  it('returns an error on DB failure', async () => {
    const supabase = createSupabaseMock({
      tables: {
        actions: { data: { workspace_id: WORKSPACE_ID }, error: null },
        action_document: { data: null, error: { message: 'query failed' } },
      },
    })

    const tools = createDocumentTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.list_action_documents.execute!(
      { action_id: ACTION_ID },
      EXEC_OPTS,
    ) as any

    expect(result.success).toBe(false)
    expect(result.error).toBe('query failed')
  })
})

/**
 * action_document is a bare join table with no workspace_id of its own, and
 * both ids arrive from the model. The MCP server runs these tools on a
 * SERVICE-ROLE client (RLS bypassed), so resolveEntityWorkspace on BOTH sides
 * is the only thing standing between a caller-supplied uuid and another
 * tenant's rows.
 */

/**
 * Filter-aware double for the resolution probes plus the join write.
 *   `rows`     — table -> id -> the workspace the row REALLY lives in.
 *   `memberOf` — workspaces the caller belongs to (the slow-path check).
 * Writes are recorded rather than performed so a test can assert none happened.
 */
function makeScopedSupabase(opts: { rows: Record<string, Record<string, string>>; memberOf: string[] }) {
  const writes = vi.fn()
  const from = vi.fn((table: string) => {
    const filters: Record<string, unknown> = {}
    let op: 'select' | 'insert' | 'delete' = 'select'
    const result = () => {
      if (op !== 'select') {
        writes({ table, op })
        return { data: { id: LINK_ID }, error: null }
      }
      if (table === 'member') {
        const ws = filters['workspace_id'] as string
        return { data: opts.memberOf.includes(ws) ? { id: 'm-1' } : null, error: null }
      }
      const homeWorkspace = opts.rows[table]?.[filters['id'] as string]
      if (!homeWorkspace) return { data: null, error: null }
      // The fast path pins workspace_id; a row elsewhere must miss it.
      if ('workspace_id' in filters && filters['workspace_id'] !== homeWorkspace) {
        return { data: null, error: null }
      }
      return { data: { workspace_id: homeWorkspace }, error: null }
    }
    const chain: Record<string, unknown> = {
      single: async () => result(),
      maybeSingle: async () => result(),
      then: (resolve: (r: unknown) => unknown) => Promise.resolve(result()).then(resolve),
    }
    const proxy: Record<string, unknown> = new Proxy(chain, {
      get(target, prop: string) {
        if (prop in target) return target[prop]
        if (prop === 'eq') return (col: string, val: unknown) => ((filters[col] = val), proxy)
        if (prop === 'insert') return () => ((op = 'insert'), proxy)
        if (prop === 'delete') return () => ((op = 'delete'), proxy)
        return () => proxy
      },
    })
    return proxy
  })
  return { supabase: { from } as never, writes }
}

const SAME_WORKSPACE = {
  rows: {
    actions: { [ACTION_ID]: WORKSPACE_ID },
    document: { [DOCUMENT_ID]: WORKSPACE_ID },
  },
  memberOf: [WORKSPACE_ID],
}

describe('link_document_to_action — workspace fencing', () => {
  it('links when both sides resolve to the same workspace', async () => {
    const { supabase, writes } = makeScopedSupabase(SAME_WORKSPACE)

    const tools = createDocumentTools(USER_ID, supabase, WORKSPACE_ID)
    const result = (await tools.link_document_to_action.execute!(
      { action_id: ACTION_ID, document_id: DOCUMENT_ID },
      EXEC_OPTS,
    )) as any

    expect(result.success).toBe(true)
    expect(writes).toHaveBeenCalledWith({ table: 'action_document', op: 'insert' })
  })

  it('refuses an action in a workspace the caller is not a member of, without inserting', async () => {
    const { supabase, writes } = makeScopedSupabase({
      rows: {
        actions: { [ACTION_ID]: OTHER_WORKSPACE_ID },
        document: { [DOCUMENT_ID]: WORKSPACE_ID },
      },
      memberOf: [WORKSPACE_ID],
    })

    const tools = createDocumentTools(USER_ID, supabase, WORKSPACE_ID)
    const result = (await tools.link_document_to_action.execute!(
      { action_id: ACTION_ID, document_id: DOCUMENT_ID },
      EXEC_OPTS,
    )) as any

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/i)
    // The message must not say which of the two ids was rejected — a foreign
    // id has to look exactly like a nonexistent one.
    expect(result.error).not.toMatch(/different workspaces/i)
    expect(writes).not.toHaveBeenCalled()
  })

  it('refuses a cross-tenant link even when the caller is a member of BOTH workspaces', async () => {
    const { supabase, writes } = makeScopedSupabase({
      rows: {
        actions: { [ACTION_ID]: WORKSPACE_ID },
        document: { [DOCUMENT_ID]: OTHER_WORKSPACE_ID },
      },
      memberOf: [WORKSPACE_ID, OTHER_WORKSPACE_ID],
    })

    const tools = createDocumentTools(USER_ID, supabase, WORKSPACE_ID)
    const result = (await tools.link_document_to_action.execute!(
      { action_id: ACTION_ID, document_id: DOCUMENT_ID },
      EXEC_OPTS,
    )) as any

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/different workspaces/i)
    expect(writes).not.toHaveBeenCalled()
  })

  it('under strictWorkspace, refuses an action outside the bound workspace the caller can otherwise reach', async () => {
    const { supabase, writes } = makeScopedSupabase({
      rows: {
        actions: { [ACTION_ID]: OTHER_WORKSPACE_ID },
        document: { [DOCUMENT_ID]: OTHER_WORKSPACE_ID },
      },
      memberOf: [WORKSPACE_ID, OTHER_WORKSPACE_ID],
    })

    // strictWorkspace = true: an unattended run is fenced to ONE workspace, so
    // the cross-workspace slow path must not run at all.
    const tools = createDocumentTools(USER_ID, supabase, WORKSPACE_ID, true)
    const result = (await tools.link_document_to_action.execute!(
      { action_id: ACTION_ID, document_id: DOCUMENT_ID },
      EXEC_OPTS,
    )) as any

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/i)
    expect(writes).not.toHaveBeenCalled()
  })
})

describe('unlink_document_from_action — workspace fencing', () => {
  it('unlinks when both sides resolve to the same workspace', async () => {
    const { supabase, writes } = makeScopedSupabase(SAME_WORKSPACE)

    const tools = createDocumentTools(USER_ID, supabase, WORKSPACE_ID)
    const result = (await tools.unlink_document_from_action.execute!(
      { action_id: ACTION_ID, document_id: DOCUMENT_ID },
      EXEC_OPTS,
    )) as any

    expect(result.success).toBe(true)
    expect(writes).toHaveBeenCalledWith({ table: 'action_document', op: 'delete' })
  })

  it('refuses a foreign action id without deleting', async () => {
    const { supabase, writes } = makeScopedSupabase({
      rows: {
        actions: { [ACTION_ID]: OTHER_WORKSPACE_ID },
        document: { [DOCUMENT_ID]: WORKSPACE_ID },
      },
      memberOf: [WORKSPACE_ID],
    })

    const tools = createDocumentTools(USER_ID, supabase, WORKSPACE_ID)
    const result = (await tools.unlink_document_from_action.execute!(
      { action_id: ACTION_ID, document_id: DOCUMENT_ID },
      EXEC_OPTS,
    )) as any

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/i)
    expect(writes).not.toHaveBeenCalled()
  })
})
