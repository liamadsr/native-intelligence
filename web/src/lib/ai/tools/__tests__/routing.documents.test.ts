/**
 * Create-time workspace routing for the DOCUMENT family (documents.ts).
 *
 * Two distinct gaps are pinned here.
 *
 * 1. `create_document` is a ROOT create with a DEPENDENT LOOKUP: it resolves
 *    the caller's `member` row for `created_by`, and `member` is per (user,
 *    workspace). Routing the insert without re-pointing that lookup would stamp
 *    the session workspace's member id onto a document in another tenant — a
 *    cross-workspace FK whose author nobody in the target workspace can see.
 *    The same goes for the embedding re-index, which carries a workspace_id of
 *    its own and would otherwise make the new doc searchable from the wrong
 *    tenant.
 *
 * 2. `list_action_documents` read `action_document` for a caller-supplied
 *    `action_id` with NO workspace predicate at all. The MCP path hands these
 *    tools a SERVICE-ROLE client (RLS bypassed), so any action uuid — including
 *    one from a tenant the caller has no part in — read back its linked
 *    document titles. It now resolves the action first, and a foreign action is
 *    not-found with the join read never issued.
 *
 * The Supabase double mirrors routing.projects.test.ts.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createDocumentTools } from '../documents'

// create_document re-indexes the body best-effort; the embeddings module pulls
// in model clients that don't load in a test env, and its workspace argument is
// itself part of the routing contract asserted below.
// Typed `unknown[]` so `mock.calls[0][5]` (the workspace argument) is indexable.
const hoisted = vi.hoisted(() => ({
  indexDocument: vi.fn(async (..._args: unknown[]) => undefined),
}))
vi.mock('@/lib/ai/embeddings', () => ({ indexDocument: hoisted.indexDocument }))

const USER_ID = 'user-1'
const WS_ACTIVE = 'ws-1'
const WS_OTHER = 'ws-2'
const WS_STRANGER = 'ws-nope'

const EXEC = {
  toolCallId: 'c',
  messages: [],
  context: {},
} satisfies ToolExecutionOptions<Record<string, unknown>>

type Row = Record<string, unknown>
type Query = { table: string; op: 'select' | 'insert' | 'update' | 'delete'; eq: Record<string, unknown> }

function valueAt(row: Row, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Row)[k] : undefined), row)
}

/** See routing.projects.test.ts for the annotated version of this double. */
function client(tables: Record<string, Row[]>) {
  const queries: Query[] = []
  const inserts: Array<{ table: string; values: Row[] }> = []
  const updates: Array<{ table: string; values: Row }> = []

  const from = vi.fn((table: string) => {
    const q: Query = { table, op: 'select', eq: {} }
    queries.push(q)
    const preds: Array<(r: Row) => boolean> = []
    const matching = () => (tables[table] ?? []).filter((r) => preds.every((p) => p(r)))
    let written: Row[] = []
    let proxy: Record<string, unknown>

    const result = () => {
      if (q.op === 'insert') return written
      if (q.op === 'update') return matching().map((r) => Object.assign(r, written[0]))
      return matching()
    }

    const self: Record<string, unknown> = {
      eq: (col: string, val: unknown) => {
        q.eq[col] = val
        preds.push((r) => valueAt(r, col) === val)
        return proxy
      },
      neq: (col: string, val: unknown) => {
        preds.push((r) => valueAt(r, col) !== val)
        return proxy
      },
      in: (col: string, vals: unknown[]) => {
        preds.push((r) => vals.includes(valueAt(r, col)))
        return proxy
      },
      ilike: (col: string, pattern: string) => {
        const needle = pattern.replace(/%/g, '').toLowerCase()
        preds.push((r) => String(valueAt(r, col) ?? '').toLowerCase().includes(needle))
        return proxy
      },
      insert: (values: Row | Row[]) => {
        q.op = 'insert'
        const list = (Array.isArray(values) ? values : [values]).map((v, i) => ({
          id: `${table}-new-${i}`,
          ...v,
        }))
        inserts.push({ table, values: list })
        ;(tables[table] ??= []).push(...list)
        written = list
        return proxy
      },
      update: (values: Row) => {
        q.op = 'update'
        updates.push({ table, values })
        written = [values]
        return proxy
      },
      delete: () => {
        q.op = 'delete'
        return proxy
      },
      single: async () => {
        const found = result()[0]
        return { data: found ?? null, error: found ? null : { message: 'No rows found' } }
      },
      maybeSingle: async () => ({ data: result()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: result(), error: null }).then(resolve),
    }

    proxy = new Proxy(self, { get: (t, p: string) => (p in t ? t[p] : () => proxy) })
    return proxy
  })

  return { supabase: { from } as never, queries, inserts, updates }
}

const member = (workspaceId: string, name: string): Row => ({
  id: `member-${workspaceId}`,
  user_id: USER_ID,
  workspace_id: workspaceId,
  workspace: { id: workspaceId, name },
})

const MEMBER_OF_BOTH = [member(WS_ACTIVE, 'Marketing'), member(WS_OTHER, 'Engineering')]

const run = (t: { execute?: unknown }, args: Record<string, unknown> = {}) =>
  (t as { execute: (a: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(args, EXEC)

const tools = (
  supabase: never,
  opts: { strict?: boolean; policy?: 'session' | 'explicit' } = {},
) => createDocumentTools(USER_ID, supabase, WS_ACTIVE, opts.strict ?? false, opts.policy ?? 'session')

describe('create_document — create-time workspace routing', () => {
  it('routes an explicit foreign workspace_id, and resolves created_by IN THAT workspace', async () => {
    const { supabase, queries, inserts } = client({ member: [...MEMBER_OF_BOTH] })
    hoisted.indexDocument.mockClear()

    const res = await run(tools(supabase).create_document, {
      title: 'Spec',
      content: '# Spec',
      workspace_id: WS_OTHER,
    })

    expect(res.success).toBe(true)
    const inserted = inserts.find((i) => i.table === 'document')
    expect(inserted?.values[0].workspace_id).toBe(WS_OTHER)
    // The dependent lookup — `member`, which is per (user, workspace) — is
    // filtered on the TARGET, so created_by names someone the target workspace
    // can actually see.
    const memberReads = queries.filter((q) => q.table === 'member')
    expect(memberReads.every((q) => q.eq.workspace_id === WS_OTHER)).toBe(true)
    expect(inserted?.values[0].created_by).toBe(`member-${WS_OTHER}`)
    // The embedding index is workspace-tagged too; it must follow the document.
    expect(hoisted.indexDocument.mock.calls[0]?.[5]).toBe(WS_OTHER)
    expect(res.workspace).toEqual({ id: WS_OTHER, name: 'Engineering' })
  })

  it('refuses an explicit workspace the caller is NOT a member of, and inserts nothing', async () => {
    const { supabase, inserts } = client({ member: [...MEMBER_OF_BOTH] })

    const res = await run(tools(supabase).create_document, { title: 'Spec', workspace_id: WS_STRANGER })

    expect(res).toEqual({ success: false, error: 'Workspace not found' })
    expect(inserts).toHaveLength(0)
  })

  it("policy 'explicit' with several workspaces and no workspace_id asks instead of guessing", async () => {
    const { supabase, inserts } = client({ member: [...MEMBER_OF_BOTH] })

    const res = await run(tools(supabase, { policy: 'explicit' }).create_document, { title: 'Spec' })

    expect(res.success).toBe(false)
    expect(res.error_type).toBe('needs_workspace')
    expect(res.candidates).toEqual([
      { id: WS_ACTIVE, name: 'Marketing', is_active: true },
      { id: WS_OTHER, name: 'Engineering', is_active: false },
    ])
    expect(inserts).toHaveLength(0)
  })

  it("policy 'session' with no workspace_id keeps the old chain: member probe in the session workspace, then insert", async () => {
    const { supabase, queries, inserts } = client({ member: [...MEMBER_OF_BOTH] })

    const res = await run(tools(supabase).create_document, { title: 'Spec' })

    expect(res.success).toBe(true)
    expect(inserts[0].values[0].workspace_id).toBe(WS_ACTIVE)
    expect(queries.map((q) => q.table)).toEqual(['member', 'document'])
    expect(queries[0].eq.workspace_id).toBe(WS_ACTIVE)
    expect(res.workspace).toEqual({ id: WS_ACTIVE, name: null })
  })

  it('under strictWorkspace a foreign workspace_id is not-found, with no membership probe at all', async () => {
    const { supabase, queries, inserts } = client({ member: [...MEMBER_OF_BOTH] })

    const res = await run(tools(supabase, { strict: true }).create_document, {
      title: 'Spec',
      workspace_id: WS_OTHER,
    })

    expect(res).toEqual({ success: false, error: 'Workspace not found' })
    expect(inserts).toHaveLength(0)
    expect(queries.some((q) => q.table === 'member')).toBe(false)
  })
})

describe('list_action_documents — the action is the fence', () => {
  const link = (workspaceId: string): Row => ({
    id: 'link-1',
    action_id: 'a-9',
    created_at: '2026-01-01T00:00:00Z',
    document: {
      id: 'd-1',
      workspace_id: workspaceId,
      title: 'Project Spec',
      updated_at: '2026-01-01T00:00:00Z',
      created_by: { id: 'member-x', display_name: 'Alice' },
    },
  })

  it('returns the links when the action lives in another workspace the user belongs to', async () => {
    const { supabase } = client({
      actions: [{ id: 'a-9', workspace_id: WS_OTHER }],
      action_document: [link(WS_OTHER)],
      member: [...MEMBER_OF_BOTH],
    })

    const res = await run(tools(supabase).list_action_documents, { action_id: 'a-9' })

    expect(res.success).toBe(true)
    expect(res.count).toBe(1)
    expect(res.workspace_id).toBe(WS_OTHER)
  })

  it("refuses an action in a tenant the caller has no part in — and never reads the join table", async () => {
    const { supabase, queries } = client({
      actions: [{ id: 'a-9', workspace_id: WS_STRANGER }],
      action_document: [link(WS_STRANGER)],
      member: [...MEMBER_OF_BOTH],
    })

    const res = await run(tools(supabase).list_action_documents, { action_id: 'a-9' })

    // Same not-found a nonexistent id gets, and the titles never leave the DB.
    expect(res).toEqual({ success: false, error: 'Action not found' })
    expect(queries.some((q) => q.table === 'action_document')).toBe(false)
  })

  it('refuses a foreign-but-member action under strictWorkspace, without reading the join table', async () => {
    const { supabase, queries } = client({
      actions: [{ id: 'a-9', workspace_id: WS_OTHER }],
      action_document: [link(WS_OTHER)],
      member: [...MEMBER_OF_BOTH],
    })

    const res = await run(tools(supabase, { strict: true }).list_action_documents, { action_id: 'a-9' })

    expect(res).toEqual({ success: false, error: 'Action not found' })
    expect(queries.some((q) => q.table === 'action_document')).toBe(false)
  })

  it('drops a linked document that points out of the action’s workspace (fails closed)', async () => {
    const { supabase } = client({
      actions: [{ id: 'a-9', workspace_id: WS_ACTIVE }],
      // A link predating linkScopeError, or a document moved after linking.
      action_document: [link(WS_OTHER)],
      member: [...MEMBER_OF_BOTH],
    })

    const res = await run(tools(supabase).list_action_documents, { action_id: 'a-9' })

    expect(res.success).toBe(true)
    expect(res.count).toBe(0)
  })
})

describe('get_document — the cross-workspace hint', () => {
  it('tells the agent to pass workspace_id explicitly, never to switch the session', async () => {
    const { supabase } = client({
      document: [{ id: 'd-9', workspace_id: WS_OTHER, title: 'Foreign spec', content: '', tags: [], frontmatter: {}, project: null, author: null }],
      member: [...MEMBER_OF_BOTH],
      entity_link: [],
    })

    const res = await run(tools(supabase).get_document, { document_id: 'd-9' })

    expect(res.success).toBe(true)
    const hint = res.workspace_hint as string
    expect(hint).toContain(WS_OTHER)
    expect(hint).toContain('workspace_id')
    // Switching is sticky and silently re-points every LATER create in the turn.
    expect(hint).not.toMatch(/set_workspace|switch/i)
  })
})
