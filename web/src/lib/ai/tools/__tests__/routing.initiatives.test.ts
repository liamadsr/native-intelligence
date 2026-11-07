/**
 * Create-time workspace routing for the INITIATIVE family (initiatives.ts).
 *
 * `create_initiative` is a pure ROOT create: an initiative sits at the top of
 * the hierarchy, so nothing existing can route it and the session workspace was
 * the only answer the tool had. It now takes an optional `workspace_id`,
 * membership-checks it, and under policy 'explicit' (the MCP bridge, whose
 * "active workspace" is a months-old OAuth artifact no human looked at this
 * turn) refuses with `needs_workspace` instead of guessing a tenant.
 *
 * Nothing else in this file needed converting: `update_initiative` and
 * `get_initiative` already route their id through resolveEntityWorkspace, and
 * their `name_match` lookups stay pinned to the active workspace on purpose —
 * a name, unlike an id, can legitimately exist in every workspace at once.
 *
 * The Supabase double mirrors routing.projects.test.ts: eq/in/ilike are real
 * predicates and writes are recorded, so "inserted into the target workspace"
 * and "inserted nothing" are assertions rather than assumptions.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createInitiativeTools } from '../initiatives'

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
) => createInitiativeTools(USER_ID, supabase, WS_ACTIVE, opts.strict ?? false, opts.policy ?? 'session')

describe('create_initiative — create-time workspace routing', () => {
  it('routes an explicit foreign workspace_id the caller is a member of', async () => {
    const { supabase, queries, inserts } = client({ member: [...MEMBER_OF_BOTH] })

    const res = await run(tools(supabase).create_initiative, {
      name: 'Grow revenue',
      workspace_id: WS_OTHER,
      label_ids: ['label-1'],
    })

    expect(res.success).toBe(true)
    const inserted = inserts.find((i) => i.table === 'initiative')
    expect(inserted?.values[0].workspace_id).toBe(WS_OTHER)
    // The membership probe — the one lookup this create makes — is filtered on
    // the TARGET, not the session workspace.
    const probe = queries.find((q) => q.table === 'member')
    expect(probe?.eq.workspace_id).toBe(WS_OTHER)
    expect(res.workspace).toEqual({ id: WS_OTHER, name: 'Engineering' })
    expect(inserts.some((i) => i.table === 'initiative_label')).toBe(true)
  })

  it('refuses an explicit workspace the caller is NOT a member of, and inserts nothing', async () => {
    const { supabase, inserts } = client({ member: [...MEMBER_OF_BOTH] })

    const res = await run(tools(supabase).create_initiative, {
      name: 'Grow revenue',
      workspace_id: WS_STRANGER,
    })

    expect(res).toEqual({ success: false, error: 'Workspace not found' })
    expect(inserts).toHaveLength(0)
  })

  it("policy 'explicit' with several workspaces and no workspace_id asks instead of guessing", async () => {
    const { supabase, inserts } = client({ member: [...MEMBER_OF_BOTH] })

    const res = await run(tools(supabase, { policy: 'explicit' }).create_initiative, { name: 'Grow revenue' })

    expect(res.success).toBe(false)
    expect(res.error_type).toBe('needs_workspace')
    // The candidates ARE the answer sheet: the retry costs one turn, no lookup.
    expect(res.candidates).toEqual([
      { id: WS_ACTIVE, name: 'Marketing', is_active: true },
      { id: WS_OTHER, name: 'Engineering', is_active: false },
    ])
    expect(inserts).toHaveLength(0)
  })

  it("policy 'explicit' still defaults when the user has exactly ONE workspace", async () => {
    const { supabase, inserts } = client({ member: [member(WS_ACTIVE, 'Marketing')] })

    const res = await run(tools(supabase, { policy: 'explicit' }).create_initiative, { name: 'Grow revenue' })

    expect(res.success).toBe(true)
    expect(inserts[0].values[0].workspace_id).toBe(WS_ACTIVE)
  })

  it("policy 'session' with no workspace_id is byte-identical to before — session workspace, no probe", async () => {
    const { supabase, queries, inserts } = client({ member: [...MEMBER_OF_BOTH] })

    const res = await run(tools(supabase).create_initiative, { name: 'Grow revenue' })

    expect(res.success).toBe(true)
    expect(inserts[0].values[0].workspace_id).toBe(WS_ACTIVE)
    expect(queries.map((q) => q.table)).toEqual(['initiative'])
    expect(res.workspace).toEqual({ id: WS_ACTIVE, name: null })
  })

  it('under strictWorkspace a foreign workspace_id is not-found, with no membership probe at all', async () => {
    const { supabase, queries, inserts } = client({ member: [...MEMBER_OF_BOTH] })

    const res = await run(tools(supabase, { strict: true }).create_initiative, {
      name: 'Grow revenue',
      workspace_id: WS_OTHER,
    })

    expect(res).toEqual({ success: false, error: 'Workspace not found' })
    expect(inserts).toHaveLength(0)
    expect(queries.some((q) => q.table === 'member')).toBe(false)
  })
})
