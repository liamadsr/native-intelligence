/**
 * Create-time workspace routing for the PROJECT family (projects.ts).
 *
 * `resolveEntityWorkspace` already routes writes to rows that EXIST. A create
 * has nothing to route by, so it landed wherever the session pointed — read a
 * project out of Engineering, file its milestone in Marketing. These tests pin
 * the two halves of the replacement protocol as they apply here:
 *
 *   ROOT create (create_project) — takes an optional `workspace_id`, checks
 *   membership, and under policy 'explicit' REFUSES (needs_workspace) rather
 *   than defaulting when the default could be wrong. Policy 'session' is
 *   byte-identical to today, down to issuing no membership query at all.
 *
 *   PARENT-ANCHORED create (create_milestone) — `milestone` has no workspace
 *   column, so the PROJECT decides the tenant. No `workspace_id` param exists;
 *   the parent is resolved instead, and `workspaceEcho` is the only way the
 *   landing workspace is visible at all.
 *
 *   MUTATES (list_milestones, update_milestone) — both reach the milestone
 *   through a caller-supplied id, so both route by the parent project instead
 *   of pinning it to the session workspace.
 *
 * Under `strictWorkspace` every one of these is not-found, with NO membership
 * probe issued: for a run fenced to one workspace even the probe's existence
 * would be an existence oracle for other tenants.
 *
 * The Supabase double is a small in-memory engine (eq/in/ilike become real
 * predicates, writes are recorded), so a lookup aimed at the wrong workspace
 * genuinely misses here rather than being waved through by a canned result.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createProjectTools } from '../projects'

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

/** Read `a.b` out of an embedded row, the way PostgREST's dotted filters do. */
function valueAt(row: Row, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Row)[k] : undefined), row)
}

/**
 * In-memory Supabase double. Every chain is recorded in `queries` (table, op,
 * eq filters) and every write in `inserts` / `updates`, so "the lookup was
 * filtered on the TARGET workspace", "nothing was inserted" and "no membership
 * probe was issued" are assertions rather than assumptions.
 */
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

/** One `member` row per workspace, shaped for BOTH reads the resolver makes. */
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
) => createProjectTools(USER_ID, supabase, WS_ACTIVE, opts.strict ?? false, false, opts.policy ?? 'session')

describe('create_project — create-time workspace routing', () => {
  it('routes an explicit foreign workspace_id the caller is a member of', async () => {
    const { supabase, queries, inserts } = client({ member: [...MEMBER_OF_BOTH] })

    const res = await run(tools(supabase).create_project, {
      name: 'Atlas',
      workspace_id: WS_OTHER,
      label_ids: ['label-1'],
    })

    expect(res.success).toBe(true)
    // The row lands in the NAMED workspace, not the session's.
    const projectInsert = inserts.find((i) => i.table === 'projects')
    expect(projectInsert?.values[0].workspace_id).toBe(WS_OTHER)
    // The only lookup this create makes is the membership probe, and it is
    // filtered on the target — a probe against the session workspace would
    // green-light a write into a tenant the user may not belong to.
    const probe = queries.find((q) => q.table === 'member')
    expect(probe?.eq.workspace_id).toBe(WS_OTHER)
    expect(probe?.eq.user_id).toBe(USER_ID)
    // The echo is what makes the routing visible in the same turn.
    expect(res.workspace).toEqual({ id: WS_OTHER, name: 'Engineering' })
    // Labels still ride along — routing must not quietly drop the join write.
    expect(inserts.some((i) => i.table === 'project_label')).toBe(true)
  })

  it('refuses an explicit workspace the caller is NOT a member of, and inserts nothing', async () => {
    const { supabase, inserts } = client({ member: [...MEMBER_OF_BOTH] })

    const res = await run(tools(supabase).create_project, { name: 'Atlas', workspace_id: WS_STRANGER })

    // Same flat shape a nonexistent id gets: never an existence oracle.
    expect(res).toEqual({ success: false, error: 'Workspace not found' })
    expect(inserts).toHaveLength(0)
  })

  it("policy 'explicit' with several workspaces and no workspace_id asks instead of guessing", async () => {
    const { supabase, inserts } = client({ member: [...MEMBER_OF_BOTH] })

    const res = await run(tools(supabase, { policy: 'explicit' }).create_project, { name: 'Atlas' })

    expect(res.success).toBe(false)
    expect(res.error_type).toBe('needs_workspace')
    expect(res.candidates).toEqual([
      { id: WS_ACTIVE, name: 'Marketing', is_active: true },
      { id: WS_OTHER, name: 'Engineering', is_active: false },
    ])
    expect(inserts).toHaveLength(0)
  })

  it("policy 'session' with no workspace_id is byte-identical to before — session workspace, no probe", async () => {
    const { supabase, queries, inserts } = client({ member: [...MEMBER_OF_BOTH] })

    const res = await run(tools(supabase).create_project, { name: 'Atlas' })

    expect(res.success).toBe(true)
    expect(inserts[0].values[0].workspace_id).toBe(WS_ACTIVE)
    // The in-app path must not pay a round-trip for a default it already knows:
    // the query chain is exactly the one this tool issued before routing existed.
    expect(queries.map((q) => q.table)).toEqual(['projects'])
    expect(res.workspace).toEqual({ id: WS_ACTIVE, name: null })
  })

  it('under strictWorkspace a foreign workspace_id is not-found, with no membership probe at all', async () => {
    const { supabase, queries, inserts } = client({ member: [...MEMBER_OF_BOTH] })

    const res = await run(tools(supabase, { strict: true }).create_project, {
      name: 'Atlas',
      workspace_id: WS_OTHER,
    })

    expect(res).toEqual({ success: false, error: 'Workspace not found' })
    expect(inserts).toHaveLength(0)
    expect(queries.some((q) => q.table === 'member')).toBe(false)
  })
})

describe('create_milestone — routed by its PARENT project', () => {
  const withForeignProject = () =>
    client({
      projects: [{ id: 'p-9', workspace_id: WS_OTHER, user_id: USER_ID, name: 'Foreign' }],
      member: [...MEMBER_OF_BOTH],
    })

  it('creates the milestone under a foreign-but-member project and echoes that workspace', async () => {
    const { supabase, inserts } = withForeignProject()

    const res = await run(tools(supabase).create_milestone, { name: 'Beta', project_id: 'p-9' })

    expect(res.success).toBe(true)
    const inserted = inserts.find((i) => i.table === 'milestone')
    expect(inserted?.values[0].project_id).toBe('p-9')
    // `milestone` names no workspace of its own, so the echo is the ONLY signal
    // of which tenant this row now belongs to.
    expect(res.workspace).toEqual({ id: WS_OTHER, name: null })
  })

  it('is not-found under strictWorkspace, and writes nothing', async () => {
    const { supabase, inserts } = withForeignProject()

    const res = await run(tools(supabase, { strict: true }).create_milestone, {
      name: 'Beta',
      project_id: 'p-9',
    })

    expect(res).toEqual({ success: false, error: 'Project not found' })
    expect(inserts).toHaveLength(0)
  })

  it('takes no workspace_id param — the parent is the only router', () => {
    const { supabase } = withForeignProject()
    const schema = tools(supabase).create_milestone.inputSchema as unknown as {
      shape: Record<string, unknown>
    }
    expect(Object.keys(schema.shape)).not.toContain('workspace_id')
  })
})

describe('milestone reads/writes route by the parent project', () => {
  const fixture = () =>
    client({
      projects: [{ id: 'p-9', workspace_id: WS_OTHER, user_id: USER_ID, name: 'Foreign' }],
      milestone: [{ id: 'm-1', project_id: 'p-9', name: 'Beta', status: 'pending', sort_order: 1 }],
      member: [...MEMBER_OF_BOTH],
    })

  it('list_milestones answers for a project in another workspace the user belongs to', async () => {
    const { supabase } = fixture()

    const res = await run(tools(supabase).list_milestones, { project_id: 'p-9' })

    expect(res.success).toBe(true)
    expect(res.count).toBe(1)
    expect(res.workspace_id).toBe(WS_OTHER)
  })

  it('list_milestones is not-found for that same project under strictWorkspace', async () => {
    const { supabase } = fixture()

    const res = await run(tools(supabase, { strict: true }).list_milestones, { project_id: 'p-9' })

    expect(res).toEqual({ success: false, error: 'Project not found' })
  })

  it('update_milestone follows the milestone to its project’s workspace', async () => {
    const { supabase, updates } = fixture()

    const res = await run(tools(supabase).update_milestone, { milestone_id: 'm-1', status: 'completed' })

    expect(res.success).toBe(true)
    expect(res.workspace_id).toBe(WS_OTHER)
    expect(updates).toEqual([{ table: 'milestone', values: { status: 'completed' } }])
  })

  it('update_milestone refuses the same milestone under strictWorkspace, writing nothing', async () => {
    const { supabase, updates } = fixture()

    const res = await run(tools(supabase, { strict: true }).update_milestone, {
      milestone_id: 'm-1',
      status: 'completed',
    })

    expect(res).toEqual({ success: false, error: 'Milestone not found' })
    expect(updates).toHaveLength(0)
  })
})
