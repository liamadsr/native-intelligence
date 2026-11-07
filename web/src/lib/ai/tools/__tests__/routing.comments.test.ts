/**
 * Workspace routing for the comment tools — the other PARENT-ANCHORED create.
 *
 * A `comment` row carries no workspace_id: it inherits the tenant of the thing
 * it is attached to. So the commentable IS the workspace, `add_comment` needs no
 * `workspace_id` param, and one resolver (`resolveCommentableWorkspace`) routes
 * the write and both reads alike — being able to comment on something you cannot
 * list would be the stranger of the two asymmetries.
 *
 * What is pinned here:
 *   1. a commentable in ANOTHER workspace the user belongs to is reachable, and
 *      the comment is authored by the member row FROM THAT WORKSPACE — member
 *      ids are workspace-scoped, so the session's would be a cross-tenant
 *      author_id for a row nothing in that workspace can resolve;
 *   2. the result echoes which workspace the comment landed in, because the row
 *      cannot;
 *   3. capture visibility is re-checked in the RESOLVED workspace, so a private
 *      capture belonging to someone else is still not-found after routing;
 *   4. under `strictWorkspace` a foreign commentable is not-found and nothing is
 *      inserted — no member probe, no insert.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createCommentTools } from '../comments'

const USER_ID = 'user-1'
const OTHER_USER = 'user-2'
const WS_ACTIVE = 'ws-1'
const WS_OTHER = 'ws-2'

const EXEC_OPTS = {
  toolCallId: 'c1',
  messages: [],
  context: {},
} satisfies ToolExecutionOptions<Record<string, unknown>>

type Row = Record<string, unknown>
type LogEntry = { table: string; op: string; col?: string; val?: unknown }

function tableChain(table: string, rows: Row[], log: LogEntry[], nextId: () => string) {
  const preds: Array<(r: Row) => boolean> = []
  let mode: 'select' | 'insert' = 'select'
  let inserted: Row[] = []

  const chain: Record<string, unknown> = {}
  const pass = () => chain
  chain.select = vi.fn(pass)
  chain.order = vi.fn(pass)
  chain.limit = vi.fn(pass)
  chain.is = vi.fn((col: string, val: unknown) => {
    preds.push((r) => (r[col] ?? null) === val)
    return chain
  })
  chain.eq = vi.fn((col: string, val: unknown) => {
    log.push({ table, op: 'eq', col, val })
    preds.push((r) => r[col] === val)
    return chain
  })
  chain.neq = vi.fn((col: string, val: unknown) => {
    preds.push((r) => r[col] !== val)
    return chain
  })
  chain.insert = vi.fn((payload: Row) => {
    log.push({ table, op: 'insert', val: payload })
    mode = 'insert'
    inserted = [{ id: nextId(), created_at: '2026-01-01T00:00:00.000Z', ...payload }]
    return chain
  })

  const run = (): Row[] => {
    if (mode === 'insert') {
      rows.push(...inserted)
      return inserted
    }
    return rows.filter((r) => preds.every((p) => p(r)))
  }

  chain.single = async () => {
    const matched = run()
    return matched.length === 1
      ? { data: matched[0], error: null }
      : { data: null, error: { message: 'no rows returned' } }
  }
  chain.maybeSingle = async () => ({ data: run()[0] ?? null, error: null })
  chain.then = (resolve: (v: unknown) => unknown) => {
    const data = run()
    return Promise.resolve({ data, error: null, count: data.length }).then(resolve)
  }
  return chain
}

function makeDb(seed: Record<string, Row[]> = {}, memberOf: string[] = [WS_ACTIVE, WS_OTHER]) {
  const tables: Record<string, Row[]> = {
    member: memberOf.map((id) => ({ id: `member-${id}`, user_id: USER_ID, workspace_id: id, display_name: 'Ada' })),
    actions: [],
    captures: [],
    document: [],
    comment: [],
    ...seed,
  }
  const log: LogEntry[] = []
  let seq = 0
  const from = vi.fn((table: string) => {
    tables[table] ??= []
    return tableChain(table, tables[table], log, () => `${table}-${++seq}`)
  })
  return { supabase: { from } as never, tables, log }
}

const tools = (supabase: never, opts: { strict?: boolean; omitPrivate?: boolean } = {}) =>
  createCommentTools(USER_ID, supabase, WS_ACTIVE, opts.omitPrivate ?? false, opts.strict ?? false)

type ToolResult = {
  success: boolean
  error?: string
  message?: string
  workspace?: { id: string; name: string | null }
  comment?: Record<string, unknown>
  comments?: Array<Record<string, unknown>>
  count?: number
}

const run = (t: { execute?: unknown }, args: Record<string, unknown>) =>
  (t as { execute: (a: unknown, o: unknown) => Promise<ToolResult> }).execute(args, EXEC_OPTS)

describe('add_comment — routed by the commentable', () => {
  it('comments on a foreign-but-member action, authored by THAT workspace’s member', async () => {
    const { supabase, tables } = makeDb({ actions: [{ id: 'act-1', workspace_id: WS_OTHER }] })
    const res = await run(tools(supabase).add_comment, {
      commentable_type: 'action',
      commentable_id: 'act-1',
      body: 'Following up here',
    })

    expect(res.success).toBe(true)
    // author_id is a `member` id, and member ids are workspace-scoped: the
    // session workspace's row would name a member that does not exist in WS_OTHER.
    expect(tables.comment[0].author_id).toBe(`member-${WS_OTHER}`)
    expect(res.workspace).toEqual({ id: WS_OTHER, name: null })
  })

  it('routes a capture the same way', async () => {
    const { supabase, tables } = makeDb({
      captures: [{ id: 'cap-1', workspace_id: WS_OTHER, user_id: USER_ID, visibility: 'workspace' }],
    })
    const res = await run(tools(supabase).add_comment, {
      commentable_type: 'capture',
      commentable_id: 'cap-1',
      body: 'Good call',
    })

    expect(res.success).toBe(true)
    expect(tables.comment[0].commentable_id).toBe('cap-1')
    expect(res.workspace).toEqual({ id: WS_OTHER, name: null })
  })

  it('still comments on an in-session-workspace action', async () => {
    const { supabase, tables } = makeDb({ actions: [{ id: 'act-1', workspace_id: WS_ACTIVE }] })
    const res = await run(tools(supabase).add_comment, {
      commentable_type: 'action',
      commentable_id: 'act-1',
      body: 'Local note',
    })

    expect(res.success).toBe(true)
    expect(tables.comment[0].author_id).toBe(`member-${WS_ACTIVE}`)
  })

  it('is not-found for a foreign commentable under strictWorkspace, and inserts nothing', async () => {
    const { supabase, tables, log } = makeDb({ actions: [{ id: 'act-1', workspace_id: WS_OTHER }] })
    const res = await run(tools(supabase, { strict: true }).add_comment, {
      commentable_type: 'action',
      commentable_id: 'act-1',
      body: 'Fenced run',
    })

    expect(res).toEqual({ success: false, error: 'action not found' })
    expect(tables.comment).toHaveLength(0)
    expect(log.some((e) => e.table === 'member')).toBe(false)
  })

  it('is not-found for a commentable in a workspace the user does not belong to', async () => {
    const { supabase, tables } = makeDb({ actions: [{ id: 'act-1', workspace_id: WS_OTHER }] }, [WS_ACTIVE])
    const res = await run(tools(supabase).add_comment, {
      commentable_type: 'action',
      commentable_id: 'act-1',
      body: 'Nope',
    })

    expect(res).toEqual({ success: false, error: 'action not found' })
    expect(tables.comment).toHaveLength(0)
  })

  it("re-checks capture visibility IN the resolved workspace, so someone else's private capture stays hidden", async () => {
    const { supabase, tables } = makeDb({
      captures: [{ id: 'cap-1', workspace_id: WS_OTHER, user_id: OTHER_USER, visibility: 'private' }],
    })
    const res = await run(tools(supabase).add_comment, {
      commentable_type: 'capture',
      commentable_id: 'cap-1',
      body: 'Should never land',
    })

    expect(res).toEqual({ success: false, error: 'capture not found' })
    expect(tables.comment).toHaveLength(0)
  })
})

describe('list_comments / get_comment_replies — the same resolver', () => {
  it('lists comments on a foreign-but-member document', async () => {
    const { supabase } = makeDb({
      document: [{ id: 'doc-1', workspace_id: WS_OTHER }],
      comment: [
        { id: 'cmt-1', commentable_type: 'document', commentable_id: 'doc-1', body: 'First', parent_id: null, author: null },
      ],
    })
    const res = await run(tools(supabase).list_comments, {
      commentable_type: 'document',
      commentable_id: 'doc-1',
    })

    expect(res.success).toBe(true)
    expect(res.count).toBe(1)
  })

  it('keeps that document not-found under strictWorkspace', async () => {
    const { supabase } = makeDb({
      document: [{ id: 'doc-1', workspace_id: WS_OTHER }],
      comment: [
        { id: 'cmt-1', commentable_type: 'document', commentable_id: 'doc-1', body: 'First', parent_id: null, author: null },
      ],
    })
    const res = await run(tools(supabase, { strict: true }).list_comments, {
      commentable_type: 'document',
      commentable_id: 'doc-1',
    })

    expect(res).toEqual({ success: false, error: 'document not found' })
  })

  it('routes replies through the parent comment’s commentable', async () => {
    const { supabase } = makeDb({
      actions: [{ id: 'act-1', workspace_id: WS_OTHER }],
      comment: [
        { id: 'cmt-1', commentable_type: 'action', commentable_id: 'act-1', body: 'Root', parent_id: null, author: null },
        { id: 'cmt-2', commentable_type: 'action', commentable_id: 'act-1', body: 'Reply', parent_id: 'cmt-1', author: null },
      ],
    })
    const res = await run(tools(supabase).get_comment_replies, { comment_id: 'cmt-1' })

    expect(res.success).toBe(true)
    expect(res.count).toBe(1)
  })
})
