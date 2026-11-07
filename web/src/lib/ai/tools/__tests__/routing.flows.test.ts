/**
 * Create-time workspace routing for `create_flow`, plus cross-workspace
 * routing for the existing-flow mutates (`update_flow`, `delete_flow`).
 *
 * See the "CREATE-TIME WORKSPACE ROUTING" section of ../_shared.ts for the
 * protocol these tests pin down: an explicit `workspace_id` wins after a
 * membership check, an absent one falls through `createWorkspacePolicy`, and
 * `strictWorkspace` skips the membership probe entirely (a foreign id is
 * not-found with no timing signal).
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createFlowTools } from '../flows'

// Every loop has a bot (bots-v3 Phase 3): the default is resolved on the
// service client (flow-bot.test.ts covers it); here it is a fixed teammate so
// the routing under test is all that runs.
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({}) }))
const approvals = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }))
vi.mock('@/lib/safety/approvals', () => ({
  createToolApproval: async (_c: unknown, a: Record<string, unknown>) => (approvals.calls.push(a), { ok: true, approvalId: 'appr-1', cardId: 'card-1' }),
}))
vi.mock('@/lib/flows/flow-bot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/flows/flow-bot')>()),
  defaultFlowBot: async () => ({ teammateId: 'bot-default', created: false }),
}))

const USER = 'user-1'
const WS_SESSION = 'ws-session'
const WS_OTHER = 'ws-other'
const WS_STRANGER = 'ws-stranger'

const EXEC = { toolCallId: 'c', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

type Row = Record<string, unknown>

/**
 * Row-store double. `.eq()`/`.in()` become real predicates — required because
 * resolveEntityWorkspace and resolveCreateWorkspace both issue TWO sequential
 * queries against the SAME table (a fast path scoped to a workspace, then an
 * unscoped slow path / membership probe), which a fixed per-table mock can't
 * tell apart. `.insert()`/`.upsert()` append to the table AND are captured in
 * `inserts[table]` so a test can assert "no insert happened" by absence.
 */
function makeClient(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, [...v]]))
  const inserts: Record<string, Row[]> = {}

  const from = vi.fn((table: string) => {
    tables[table] ??= []
    const preds: Array<(r: Row) => boolean> = []
    let mode: 'select' | 'update' | 'delete' | 'insert' = 'select'
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
      if (mode === 'delete') {
        const rows = matching()
        tables[table] = tables[table].filter((r) => !rows.includes(r))
        return rows
      }
      return matching()
    }

    const self: Record<string, unknown> = {
      eq: (col: string, val: unknown) => { preds.push((r) => r[col] === val); return proxy },
      neq: (col: string, val: unknown) => { preds.push((r) => r[col] !== val); return proxy },
      in: (col: string, vals: unknown[]) => { preds.push((r) => vals.includes(r[col])); return proxy },
      order: () => proxy,
      limit: () => proxy,
      select: () => proxy,
      insert: (p: Row) => { mode = 'insert'; payload = p; return proxy },
      update: (p: Row) => { mode = 'update'; payload = p; return proxy },
      delete: () => { mode = 'delete'; return proxy },
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

/** Membership + team fixtures shared by the create_flow cases below. */
function seeded() {
  return makeClient({
    member: [
      { id: 'm-session', user_id: USER, workspace_id: WS_SESSION, workspace: { id: WS_SESSION, name: 'Session WS' } },
      { id: 'm-other', user_id: USER, workspace_id: WS_OTHER, workspace: { id: WS_OTHER, name: 'Other WS' } },
    ],
    team: [
      { id: 'team-session', workspace_id: WS_SESSION },
      { id: 'team-other', workspace_id: WS_OTHER },
    ],
    // An action loop's team is its status's team.
    workflow_state: [
      { id: 'wf-done', team_id: 'team-session' },
      { id: 'wf-other-done', team_id: 'team-other' },
    ],
  })
}

// Cast to `never`: the `ai` SDK types `execute`'s parameter from the schema's
// OUTPUT (post-default) shape, which makes zod-defaulted fields (e.g.
// `enabled`) look required even though callers may omit them — same
// workaround used throughout the existing test suite (actions.list.test.ts,
// captures.visibility.test.ts, …) when calling `execute` directly, bypassing
// the runtime zod parse that normally fills those defaults in.
const baseArgs = (overrides: Record<string, unknown> = {}) =>
  ({
    name: 'Notify on done',
    trigger: { type: 'entity_status_change', to_status_id: 'wf-done' },
    actions: [{ url: 'https://example.com/hook' }],
    ...overrides,
  }) as never

/** The status loop in the OTHER workspace: its state belongs to team-other. */
const otherTrigger = { trigger: { type: 'entity_status_change', to_status_id: 'wf-other-done' } }

describe('create_flow — create-time workspace routing', () => {
  it('(a) explicit foreign workspace_id while a member → insert carries it', async () => {
    const client = seeded()
    const tools = createFlowTools(USER, client, WS_SESSION)
    const res = (await tools.create_flow.execute!(
      baseArgs({ ...otherTrigger, team_id: 'team-other', workspace_id: WS_OTHER }),
      EXEC,
    )) as Record<string, unknown>

    expect((client as unknown as { inserts: Record<string, Row[]> }).inserts.flow?.[0]?.workspace_id).toBe(WS_OTHER)
    expect((res.workspace as { id: string }).id).toBe(WS_OTHER)
    expect((res.flow as { workspace_id: string }).workspace_id).toBe(WS_OTHER)
  })

  it('(b) explicit non-member workspace_id → "Workspace not found", no insert', async () => {
    const client = seeded()
    const tools = createFlowTools(USER, client, WS_SESSION)
    const res = (await tools.create_flow.execute!(
      baseArgs({ ...otherTrigger, team_id: 'team-other', workspace_id: WS_STRANGER }),
      EXEC,
    )) as Record<string, unknown>

    expect(res).toMatchObject({ success: false, error: 'Workspace not found' })
    expect((client as unknown as { inserts: Record<string, Row[]> }).inserts.flow).toBeUndefined()
  })

  it("(c) policy 'explicit', ≥2 workspaces, no id → needs_workspace, no insert", async () => {
    const client = seeded()
    const tools = createFlowTools(USER, client, WS_SESSION, false, 'explicit')
    const res = (await tools.create_flow.execute!(
      baseArgs({ team_id: 'team-session' }),
      EXEC,
    )) as Record<string, unknown>

    expect(res.error_type).toBe('needs_workspace')
    expect((client as unknown as { inserts: Record<string, Row[]> }).inserts.flow).toBeUndefined()
  })

  it("(d) policy 'session', no id → session workspace, unchanged call chain", async () => {
    const client = seeded()
    const tools = createFlowTools(USER, client, WS_SESSION)
    const res = (await tools.create_flow.execute!(
      baseArgs({ team_id: 'team-session' }),
      EXEC,
    )) as Record<string, unknown>

    expect((res.flow as { workspace_id: string }).workspace_id).toBe(WS_SESSION)
    expect((res.workspace as { id: string }).id).toBe(WS_SESSION)
    // Every loop has a bot: with none asked for, the default fronts it.
    expect((res.flow as { ai_team_member_id: string }).ai_team_member_id).toBe('bot-default')
  })

  it('refuses a bot face that is not one of the characters', async () => {
    const tools = createFlowTools(USER, seeded(), WS_SESSION)
    const res = (await tools.create_flow.execute!(
      baseArgs({ team_id: 'team-session', bot_character: 'not-a-bot' }),
      EXEC,
    )) as Record<string, unknown>
    expect(res).toMatchObject({ error: 'bot_character must be one of the characters' })
  })

  it('(e) strictWorkspace + explicit foreign → not found, no member probe', async () => {
    const client = seeded()
    const tools = createFlowTools(USER, client, WS_SESSION, true)
    const res = (await tools.create_flow.execute!(
      baseArgs({ ...otherTrigger, team_id: 'team-other', workspace_id: WS_OTHER }),
      EXEC,
    )) as Record<string, unknown>

    expect(res).toMatchObject({ success: false, error: 'Workspace not found' })
    const fromMock = (client as unknown as { from: { mock: { calls: unknown[][] } } }).from
    expect(fromMock.mock.calls.some((c) => c[0] === 'member')).toBe(false)
  })
})

describe('update_flow / delete_flow — cross-workspace entity routing', () => {
  function flowIn(ws: string) {
    return makeClient({
      member: [{ id: 'm-other', user_id: USER, workspace_id: ws }],
      flow: [
        {
          id: 'flow-1',
          workspace_id: ws,
          team_id: 'team-1',
          name: 'Original',
          description: null,
          enabled: true,
          trigger_type: 'entity_status_change',
          trigger_config: { entity_type: 'action', from_status_id: null, to_status_id: 'wf-done' },
          actions: [],
          created_by: USER,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          seed_key: null,
        },
      ],
    })
  }

  it('update_flow: foreign-but-member flow_id routes to the flow\'s own workspace', async () => {
    const client = flowIn(WS_OTHER)
    const tools = createFlowTools(USER, client, WS_SESSION)
    const res = (await tools.update_flow.execute!({ flow_id: 'flow-1', name: 'Renamed' }, EXEC)) as Record<
      string,
      unknown
    >

    expect((res.flow as { name: string; workspace_id: string }).name).toBe('Renamed')
    expect((res.flow as { workspace_id: string }).workspace_id).toBe(WS_OTHER)
  })

  it('update_flow: strictWorkspace fences a foreign flow_id to not-found', async () => {
    const client = flowIn(WS_OTHER)
    const tools = createFlowTools(USER, client, WS_SESSION, true)
    const res = (await tools.update_flow.execute!({ flow_id: 'flow-1', name: 'Renamed' }, EXEC)) as Record<
      string,
      unknown
    >

    expect(res).toEqual({ error: 'Flow not found' })
  })

  it('delete_flow: a foreign-but-member flow_id raises the card in its own workspace; the accepted replay deletes there', async () => {
    approvals.calls.length = 0
    const client = flowIn(WS_OTHER)
    const tools = createFlowTools(USER, client, WS_SESSION)
    const res = (await tools.delete_flow.execute!({ flow_id: 'flow-1' }, EXEC)) as Record<string, unknown>
    expect(res).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED' })
    expect(approvals.calls[0]).toMatchObject({ workspaceId: WS_OTHER, toolName: 'delete_flow' })

    const flow = (approvals.calls[0].context as { flow: { kind: 'delete'; flow_id: string; definition_hash: string } }).flow
    const replay = createFlowTools(USER, client, WS_SESSION, false, 'session', undefined, {
      approvedCall: { approvalId: 'appr-1', tool: 'delete_flow', flow },
    })
    expect(await replay.delete_flow.execute!({ flow_id: 'flow-1' }, EXEC)).toMatchObject({ ok: true })
  })

  it('delete_flow: strictWorkspace fences a foreign flow_id to not-found', async () => {
    const client = flowIn(WS_OTHER)
    const tools = createFlowTools(USER, client, WS_SESSION, true)
    const res = (await tools.delete_flow.execute!({ flow_id: 'flow-1' }, EXEC)) as Record<string, unknown>

    expect(res).toEqual({ error: 'Flow not found' })
  })
})
