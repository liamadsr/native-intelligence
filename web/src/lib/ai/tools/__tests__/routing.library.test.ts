/**
 * Create-time workspace routing for `create_skill`, plus cross-workspace
 * routing for `update_skill` via `fetchEditableSkill`.
 *
 * `delete_skill` is NOT covered here — it lives in
 * src/lib/mcp/tools/library.ts, a different file than this one
 * (src/lib/ai/tools/library.ts), and is out of scope for this suite.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createLibraryTools } from '../library'

const USER = 'user-1'
const WS_SESSION = 'ws-session'
const WS_OTHER = 'ws-other'
const WS_STRANGER = 'ws-stranger'

const EXEC = { toolCallId: 'c', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

type Row = Record<string, unknown>

/** Same row-store double as routing.flows.test.ts — see its header comment. */
function makeClient(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, [...v]]))
  const inserts: Record<string, Row[]> = {}

  const from = vi.fn((table: string) => {
    tables[table] ??= []
    const preds: Array<(r: Row) => boolean> = []
    let mode: 'select' | 'update' | 'insert' = 'select'
    let payload: Row = {}
    let proxy: Record<string, unknown>
    const matching = () => tables[table].filter((r) => preds.every((p) => p(r)))

    const run = (): Row | Row[] | null => {
      if (mode === 'insert') {
        const row = { id: `gen-${Math.random().toString(36).slice(2, 8)}`, ...payload }
        tables[table].push(row)
        ;(inserts[table] ??= []).push(row)
        return row
      }
      if (mode === 'update') {
        const rows = matching()
        for (const r of rows) Object.assign(r, payload)
        return rows
      }
      return matching()
    }

    const self: Record<string, unknown> = {
      eq: (col: string, val: unknown) => { preds.push((r) => r[col] === val); return proxy },
      neq: (col: string, val: unknown) => { preds.push((r) => r[col] !== val); return proxy },
      in: (col: string, vals: unknown[]) => { preds.push((r) => vals.includes(r[col])); return proxy },
      or: () => proxy,
      not: () => proxy,
      order: () => proxy,
      limit: () => proxy,
      select: () => proxy,
      insert: (p: Row) => { mode = 'insert'; payload = p; return proxy },
      update: (p: Row) => { mode = 'update'; payload = p; return proxy },
      single: async () => {
        const r = run()
        const row = Array.isArray(r) ? r[0] : r
        return { data: row ?? null, error: row ? null : { message: 'no rows' } }
      },
      maybeSingle: async () => {
        const r = run()
        const row = Array.isArray(r) ? r[0] : r
        return { data: row ?? null, error: null }
      },
      then: (resolve: (v: unknown) => unknown) => {
        const r = run()
        const data = Array.isArray(r) ? r : r ? [r] : []
        return Promise.resolve({ data, error: null, count: data.length }).then(resolve)
      },
    }
    proxy = new Proxy(self, { get: (t, p: string) => (p in t ? t[p] : () => proxy) })
    return proxy
  })

  return { from, tables, inserts } as never
}

function seeded() {
  return makeClient({
    member: [
      { id: 'm-session', user_id: USER, workspace_id: WS_SESSION, workspace: { id: WS_SESSION, name: 'Session WS' } },
      { id: 'm-other', user_id: USER, workspace_id: WS_OTHER, workspace: { id: WS_OTHER, name: 'Other WS' } },
    ],
  })
}

const baseArgs = (overrides: Record<string, unknown> = {}) => ({
  name: 'Weekly planner',
  description: 'When the user wants to plan their week',
  system_prompt: 'Ask about priorities, then draft a plan.',
  ...overrides,
})

describe('create_skill — create-time workspace routing', () => {
  it('(a) explicit foreign workspace_id while a member → insert carries it', async () => {
    const client = seeded()
    const tools = createLibraryTools(USER, client, WS_SESSION)
    const res = (await tools.create_skill.execute!(baseArgs({ workspace_id: WS_OTHER }), EXEC)) as Record<
      string,
      unknown
    >

    expect(res.success).toBe(true)
    expect((client as unknown as { inserts: Record<string, Row[]> }).inserts.recipe?.[0]?.workspace_id).toBe(WS_OTHER)
    expect((res.workspace as { id: string }).id).toBe(WS_OTHER)
  })

  it('(b) explicit non-member workspace_id → "Workspace not found", no insert', async () => {
    const client = seeded()
    const tools = createLibraryTools(USER, client, WS_SESSION)
    const res = (await tools.create_skill.execute!(baseArgs({ workspace_id: WS_STRANGER }), EXEC)) as Record<
      string,
      unknown
    >

    expect(res).toMatchObject({ success: false, error: 'Workspace not found' })
    expect((client as unknown as { inserts: Record<string, Row[]> }).inserts.recipe).toBeUndefined()
  })

  it("(c) policy 'explicit', ≥2 workspaces, no id → needs_workspace, no insert", async () => {
    const client = seeded()
    const tools = createLibraryTools(USER, client, WS_SESSION, false, 'explicit')
    const res = (await tools.create_skill.execute!(baseArgs(), EXEC)) as Record<string, unknown>

    expect(res.error_type).toBe('needs_workspace')
    expect((client as unknown as { inserts: Record<string, Row[]> }).inserts.recipe).toBeUndefined()
  })

  it("(d) policy 'session', no id → session workspace, unchanged call chain", async () => {
    const client = seeded()
    const tools = createLibraryTools(USER, client, WS_SESSION)
    const res = (await tools.create_skill.execute!(baseArgs(), EXEC)) as Record<string, unknown>

    expect((res.workspace as { id: string }).id).toBe(WS_SESSION)
    expect((client as unknown as { inserts: Record<string, Row[]> }).inserts.recipe?.[0]?.workspace_id).toBe(
      WS_SESSION,
    )
  })

  it('(e) strictWorkspace + explicit foreign → not found, no member probe', async () => {
    const client = seeded()
    const tools = createLibraryTools(USER, client, WS_SESSION, true)
    const res = (await tools.create_skill.execute!(baseArgs({ workspace_id: WS_OTHER }), EXEC)) as Record<
      string,
      unknown
    >

    expect(res).toMatchObject({ success: false, error: 'Workspace not found' })
    const fromMock = (client as unknown as { from: { mock: { calls: unknown[][] } } }).from
    expect(fromMock.mock.calls.some((c) => c[0] === 'member')).toBe(false)
  })
})

describe('update_skill — cross-workspace routing via fetchEditableSkill', () => {
  function skillIn(ws: string) {
    return makeClient({
      member: [{ id: 'm-other', user_id: USER, workspace_id: ws }],
      recipe: [
        {
          id: 'skill-1',
          is_system: false,
          category: 'skill',
          workspace_id: ws,
          created_by: USER,
          visibility: 'personal',
          name: 'Old name',
          slug: 'old-name',
        },
      ],
    })
  }

  it('foreign-but-member skill routes to its own workspace', async () => {
    const client = skillIn(WS_OTHER)
    const tools = createLibraryTools(USER, client, WS_SESSION)
    const res = (await tools.update_skill.execute!({ id: 'skill-1', name: 'New name' }, EXEC)) as Record<
      string,
      unknown
    >

    expect(res).toMatchObject({ success: true, skill: { name: 'New name' } })
  })

  it('strictWorkspace fences a foreign skill id to not-found', async () => {
    const client = skillIn(WS_OTHER)
    const tools = createLibraryTools(USER, client, WS_SESSION, true)
    const res = (await tools.update_skill.execute!({ id: 'skill-1', name: 'New name' }, EXEC)) as Record<
      string,
      unknown
    >

    expect(res).toEqual({ success: false, error: 'Skill not found' })
  })

  it('a system skill is still refused before any workspace routing runs', async () => {
    const client = makeClient({
      recipe: [{ id: 'sys-1', is_system: true, category: 'skill', workspace_id: null, name: 'System', slug: 'system' }],
    })
    const tools = createLibraryTools(USER, client, WS_SESSION)
    const res = (await tools.update_skill.execute!({ id: 'sys-1', name: 'New name' }, EXEC)) as Record<
      string,
      unknown
    >

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/Cannot modify a system skill/)
  })
})
