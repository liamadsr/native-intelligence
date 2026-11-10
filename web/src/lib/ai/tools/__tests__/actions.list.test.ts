/**
 * Tests for the list_actions tool in actions.ts — filter/status interaction.
 *
 * Regression (2026-07-01 live audit): `ni_list_actions` with
 * `filter: 'completed'` + `since`/`time_field: 'updated_at'` returned 0 rows
 * while the equivalent `status: 'completed'` + `since` returned the correct
 * results. Root cause: `status` defaults to 'active' (applied by the zod
 * schema at the MCP layer), so the tool ANDed `status_id IN (active states)`
 * from the defaulted status with `status_id IN (completed states)` from the
 * filter preset — two disjoint sets that always produce an empty result. The
 * fix folds the preset's status semantics into a single effective status so
 * only one status_id IN(...) clause is ever applied.
 *
 * These tests parse args through the tool's zod inputSchema before calling
 * execute — exactly what the MCP server does (it hands the zod shape to
 * server.tool, which fills defaults) — so the defaulted `status: 'active'`
 * that triggers the bug is present. The supabase mock is a tiny in-memory
 * filter engine, so the disjoint-IN bug genuinely returns zero rows against
 * it rather than being masked by a mock that ignores filters.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createActionTools } from '../actions'

// Replace the apply-engine module so importing actions.ts never pulls in
// mcp-client imports that fail in a test environment (same as
// actions.suggestions.test.ts).
vi.mock('@/lib/proposed-changes/apply-engine', () => ({
  applyChange: vi.fn(),
}))

const USER_ID = 'user-uuid-1'
const WORKSPACE_ID = 'workspace-uuid-1'
const TEAM_ID = 'team-uuid-1'

const EXEC_OPTS = {
  toolCallId: 'test-call-id',
  messages: [],
  context: {},
} satisfies ToolExecutionOptions<Record<string, unknown>>

const TODO_STATE = { id: 'state-todo', name: 'Todo', category: 'unstarted', color: '#888' }
const DONE_STATE = { id: 'state-done', name: 'Done', category: 'completed', color: '#0a0' }
const STATES = [TODO_STATE, DONE_STATE]

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()

type Row = Record<string, unknown>

const baseAction = {
  user_id: USER_ID,
  workspace_id: WORKSPACE_ID,
  parent_id: null,
  confirmation: 'confirmed',
  priority: 'none',
  assignee_id: null,
  project_id: null,
  project: null,
  due_at: null,
}

/** Completed 2 days ago — inside a past_30_days window on updated_at. */
const COMPLETED_RECENT: Row = {
  ...baseAction,
  id: 'action-done-recent',
  identifier: 'GEN-1',
  title: 'Recently completed action',
  status_id: DONE_STATE.id,
  workflow_state: DONE_STATE,
  updated_at: daysAgo(2),
  created_at: daysAgo(10),
}

/** Completed 60 days ago — outside a past_30_days window on updated_at. */
const COMPLETED_OLD: Row = {
  ...baseAction,
  id: 'action-done-old',
  identifier: 'GEN-2',
  title: 'Long-ago completed action',
  status_id: DONE_STATE.id,
  workflow_state: DONE_STATE,
  updated_at: daysAgo(60),
  created_at: daysAgo(90),
}

/** Active, past-due — the overdue preset should return exactly this one. */
const ACTIVE_OVERDUE: Row = {
  ...baseAction,
  id: 'action-active-overdue',
  identifier: 'GEN-3',
  title: 'Active overdue action',
  status_id: TODO_STATE.id,
  workflow_state: TODO_STATE,
  updated_at: daysAgo(1),
  created_at: daysAgo(5),
  due_at: daysAgo(3),
}

const ALL_ROWS = [COMPLETED_RECENT, COMPLETED_OLD, ACTIVE_OVERDUE]

/** team table: resolves to the workspace's teams for any chain. */
function makeTeamChain() {
  const chain: Record<string, unknown> = {}
  chain.select = vi.fn(() => chain)
  chain.eq = vi.fn(() => chain)
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: [{ id: TEAM_ID }], error: null }).then(resolve)
  return chain
}

/**
 * workflow_state table: honors the category constraint on the chain
 * (.in('category', [...]) for active lookups, .eq('category', 'completed')
 * for completed lookups) so the two lookups return different state ids.
 */
function makeWorkflowStateChain() {
  let categories: string[] | null = null
  const chain: Record<string, unknown> = {}
  chain.select = vi.fn(() => chain)
  chain.in = vi.fn((col: string, vals: string[]) => {
    if (col === 'category') categories = vals
    return chain
  })
  chain.eq = vi.fn((col: string, val: string) => {
    if (col === 'category') categories = [val]
    return chain
  })
  chain.then = (resolve: (v: unknown) => unknown) => {
    const data = STATES.filter((s) => !categories || categories.includes(s.category)).map(
      (s) => ({ id: s.id }),
    )
    return Promise.resolve({ data, error: null }).then(resolve)
  }
  return chain
}

/**
 * actions table: a mini query engine. Every eq/is/in/gte/lte/lt becomes a
 * predicate ANDed over the rows — so a second, disjoint IN('status_id')
 * filters everything out exactly like PostgREST would.
 */
function makeActionsChain(rows: Row[], statusIdInCalls: unknown[][], orderCalls: unknown[][] = []) {
  const preds: Array<(r: Row) => boolean> = []
  const chain: Record<string, unknown> = {}
  const passthrough = () => chain
  chain.select = vi.fn(passthrough)
  chain.order = vi.fn((...args: unknown[]) => {
    orderCalls.push(args)
    return chain
  })
  chain.range = vi.fn(passthrough)
  chain.textSearch = vi.fn(passthrough)
  chain.eq = vi.fn((col: string, val: unknown) => {
    preds.push((r) => r[col] === val)
    return chain
  })
  chain.neq = vi.fn((col: string, val: unknown) => {
    preds.push((r) => r[col] !== val)
    return chain
  })
  chain.is = vi.fn((col: string, val: unknown) => {
    preds.push((r) => r[col] === val)
    return chain
  })
  chain.in = vi.fn((col: string, vals: unknown[]) => {
    if (col === 'status_id') statusIdInCalls.push(vals)
    preds.push((r) => vals.includes(r[col]))
    return chain
  })
  chain.gte = vi.fn((col: string, val: string) => {
    preds.push((r) => typeof r[col] === 'string' && (r[col] as string) >= val)
    return chain
  })
  chain.lte = vi.fn((col: string, val: string) => {
    preds.push((r) => typeof r[col] === 'string' && (r[col] as string) <= val)
    return chain
  })
  chain.lt = vi.fn((col: string, val: string) => {
    preds.push((r) => typeof r[col] === 'string' && (r[col] as string) < val)
    return chain
  })
  chain.then = (resolve: (v: unknown) => unknown) => {
    const data = rows.filter((r) => preds.every((p) => p(r)))
    return Promise.resolve({ data, error: null, count: data.length }).then(resolve)
  }
  return chain
}

function makeSupabase(rows: Row[] = ALL_ROWS) {
  const statusIdInCalls: unknown[][] = []
  const orderCalls: unknown[][] = []
  const from = vi.fn((table: string) => {
    if (table === 'team') return makeTeamChain()
    if (table === 'workflow_state') return makeWorkflowStateChain()
    if (table === 'actions') return makeActionsChain(rows, statusIdInCalls, orderCalls)
    return makeActionsChain([], statusIdInCalls)
  })
  return { supabase: { from }, statusIdInCalls, orderCalls }
}

/**
 * Parse raw args through the tool's zod inputSchema — the MCP layer registers
 * the zod shape with server.tool, so defaults (notably status: 'active') are
 * filled before execute runs. Calling execute with raw args would skip the
 * defaulting and mask the bug.
 */
function runListActions(
  supabase: unknown,
  rawArgs: Record<string, unknown>,
) {
  const tools = createActionTools(USER_ID, supabase as never, WORKSPACE_ID)
  const schema = tools.list_actions.inputSchema as unknown as {
    parse: (v: unknown) => Record<string, unknown>
  }
  const parsed = schema.parse(rawArgs)
  return tools.list_actions.execute!(parsed as never, EXEC_OPTS) as Promise<{
    success: boolean
    error?: string
    actions?: Array<{ id: string; workspace_id?: string; confirmation?: string }>
    count?: number
  }>
}

describe('list_actions — filter=completed with a time window', () => {
  it("returns time-bounded completed actions for filter='completed' + since/time_field=updated_at (regression: was always 0)", async () => {
    const { supabase } = makeSupabase()
    const result = await runListActions(supabase, {
      filter: 'completed',
      since: 'past_30_days',
      time_field: 'updated_at',
    })

    expect(result.success).toBe(true)
    expect(result.actions?.map((a) => a.id)).toEqual([COMPLETED_RECENT.id])
    expect(result.count).toBe(1)
  })

  it("agrees with the equivalent status='completed' + since path", async () => {
    const filterPath = await runListActions(makeSupabase().supabase, {
      filter: 'completed',
      since: 'past_30_days',
      time_field: 'updated_at',
    })
    const statusPath = await runListActions(makeSupabase().supabase, {
      status: 'completed',
      since: 'past_30_days',
      time_field: 'updated_at',
    })

    expect(filterPath.success).toBe(true)
    expect(statusPath.success).toBe(true)
    expect(filterPath.actions?.map((a) => a.id)).toEqual(
      statusPath.actions?.map((a) => a.id),
    )
  })

  it('applies exactly one status_id IN(...) clause — never two disjoint ones', async () => {
    const { supabase, statusIdInCalls } = makeSupabase()
    await runListActions(supabase, {
      filter: 'completed',
      since: 'past_30_days',
      time_field: 'updated_at',
    })

    expect(statusIdInCalls).toHaveLength(1)
    expect(statusIdInCalls[0]).toEqual([DONE_STATE.id])
  })

  it("returns all completed actions for a plain filter='completed' (no window)", async () => {
    const { supabase } = makeSupabase()
    const result = await runListActions(supabase, { filter: 'completed' })

    expect(result.success).toBe(true)
    expect(result.actions?.map((a) => a.id).sort()).toEqual(
      [COMPLETED_RECENT.id, COMPLETED_OLD.id].sort(),
    )
  })
})

/**
 * Every row names its own workspace. An id-addressable tool (get_action,
 * update_action) resolves cross-workspace, so an agent holding a row must never
 * have to infer the tenant from the session's active workspace — and a list the
 * agent feeds straight back into a write is exactly where that inference goes
 * wrong.
 */
describe('list_actions — rows are workspace-qualified', () => {
  it('tags every compact row with workspace_id', async () => {
    const { supabase } = makeSupabase()
    const result = await runListActions(supabase, { filter: 'all', status: 'all' })

    expect(result.success).toBe(true)
    expect(result.actions?.length).toBe(ALL_ROWS.length)
    for (const a of result.actions!) expect(a.workspace_id).toBe(WORKSPACE_ID)
  })

  it('tags every verbose row too', async () => {
    const { supabase } = makeSupabase()
    const result = await runListActions(supabase, { filter: 'all', status: 'all', verbose: true })

    expect(result.success).toBe(true)
    for (const a of result.actions!) expect(a.workspace_id).toBe(WORKSPACE_ID)
  })
})

describe('list_actions — filter=overdue unchanged by the fix', () => {
  it('returns only past-due active actions', async () => {
    const { supabase } = makeSupabase()
    const result = await runListActions(supabase, { filter: 'overdue' })

    expect(result.success).toBe(true)
    expect(result.actions?.map((a) => a.id)).toEqual([ACTIVE_OVERDUE.id])
  })

  it("still rejects filter='overdue' + status='completed' loudly", async () => {
    const { supabase } = makeSupabase()
    const result = await runListActions(supabase, {
      filter: 'overdue',
      status: 'completed',
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/incompatible/i)
  })
})

/**
 * `actions.priority` is the enum ('none', 'low', 'medium', 'high', 'urgent'),
 * which sorts by declared order: ascending put urgent LAST, and under a page
 * the urgent rows fell off it. Priority sorts descending, then due_at
 * ascending with undated rows last.
 */
describe('list_actions — order', () => {
  it('orders priority descending (urgent first), then due_at ascending with nulls last', async () => {
    const { supabase, orderCalls } = makeSupabase()
    await runListActions(supabase, {})

    expect(orderCalls).toEqual([
      ['priority', { ascending: false, nullsFirst: false }],
      ['due_at', { ascending: true, nullsFirst: false }],
    ])
  })
})

/**
 * A meeting's proposal is an action row too: `suggested` until accepted,
 * `dismissed` once rejected. Dismissed rows are nobody's work.
 */
describe('list_actions — confirmation', () => {
  const SUGGESTED: Row = { ...ACTIVE_OVERDUE, id: 'action-suggested', identifier: 'GEN-4', confirmation: 'suggested' }
  const DISMISSED: Row = { ...ACTIVE_OVERDUE, id: 'action-dismissed', identifier: 'GEN-5', confirmation: 'dismissed' }
  const ROWS = [ACTIVE_OVERDUE, SUGGESTED, DISMISSED]

  it('leaves dismissed rows out by default, keeping confirmed and suggested', async () => {
    const result = await runListActions(makeSupabase(ROWS).supabase, {})

    expect(result.success).toBe(true)
    expect(result.actions?.map((a) => a.id).sort()).toEqual([ACTIVE_OVERDUE.id, SUGGESTED.id].sort())
  })

  it("'confirmed' returns accepted work only", async () => {
    const result = await runListActions(makeSupabase(ROWS).supabase, { confirmation: 'confirmed' })
    expect(result.actions?.map((a) => a.id)).toEqual([ACTIVE_OVERDUE.id])
  })

  it("'suggested' returns proposals nobody accepted yet", async () => {
    const result = await runListActions(makeSupabase(ROWS).supabase, { confirmation: 'suggested' })
    expect(result.actions?.map((a) => a.id)).toEqual([SUGGESTED.id])
  })

  it("'any' includes dismissed rows too", async () => {
    const result = await runListActions(makeSupabase(ROWS).supabase, { confirmation: 'any' })
    expect(result.actions?.map((a) => a.id).sort()).toEqual([ACTIVE_OVERDUE.id, SUGGESTED.id, DISMISSED.id].sort())
  })

  it('rejects any other value', () => {
    const tools = createActionTools(USER_ID, makeSupabase().supabase as never, WORKSPACE_ID)
    const schema = tools.list_actions.inputSchema as unknown as { safeParse: (v: unknown) => { success: boolean } }
    expect(schema.safeParse({ confirmation: 'dismissed' }).success).toBe(false)
  })

  it('every row, compact or verbose, carries its confirmation', async () => {
    for (const verbose of [false, true]) {
      const result = await runListActions(makeSupabase(ROWS).supabase, { confirmation: 'any', verbose })
      const byId = new Map<unknown, string | undefined>(result.actions!.map((a) => [a.id, a.confirmation]))
      expect(byId.get(ACTIVE_OVERDUE.id)).toBe('confirmed')
      expect(byId.get(SUGGESTED.id)).toBe('suggested')
      expect(byId.get(DISMISSED.id)).toBe('dismissed')
    }
  })
})

/**
 * `project_id` and `team_id` filter in the database: a skill no longer pages
 * the whole workspace and keeps one project's rows client-side.
 */
describe('list_actions — project and team filters', () => {
  const PROJECT_A = '11111111-1111-4111-8111-111111111111'
  const PROJECT_B = '22222222-2222-4222-8222-222222222222'
  const TEAM_A = '33333333-3333-4333-8333-333333333333'
  const TEAM_B = '44444444-4444-4444-8444-444444444444'
  const IN_A: Row = { ...ACTIVE_OVERDUE, id: 'in-a', project_id: PROJECT_A, team_id: TEAM_A }
  const IN_B: Row = { ...ACTIVE_OVERDUE, id: 'in-b', project_id: PROJECT_B, team_id: TEAM_B }
  const NO_PROJECT: Row = { ...ACTIVE_OVERDUE, id: 'no-project', project_id: null, team_id: TEAM_A }
  const ROWS = [IN_A, IN_B, NO_PROJECT]

  it("project_id keeps that project's actions only", async () => {
    const result = await runListActions(makeSupabase(ROWS).supabase, { project_id: PROJECT_A })
    expect(result.success).toBe(true)
    expect(result.actions?.map((a) => a.id)).toEqual(['in-a'])
  })

  it("team_id keeps that team's actions only", async () => {
    const result = await runListActions(makeSupabase(ROWS).supabase, { team_id: TEAM_A })
    expect(result.actions?.map((a) => a.id).sort()).toEqual(['in-a', 'no-project'])
  })

  it('they combine with each other and with filter', async () => {
    const result = await runListActions(makeSupabase(ROWS).supabase, { team_id: TEAM_A, project_id: PROJECT_A, filter: 'overdue' })
    expect(result.actions?.map((a) => a.id)).toEqual(['in-a'])
  })

  it('refuses a name where an id goes, saying how to find the id', async () => {
    const byName = await runListActions(makeSupabase(ROWS).supabase, { project_id: 'Atlas' })
    expect(byName.success).toBe(false)
    expect(byName.error).toMatch(/list_projects/)
    const team = await runListActions(makeSupabase(ROWS).supabase, { team_id: 'Design' })
    expect(team.success).toBe(false)
    expect(team.error).toMatch(/list_workflow_states/)
  })
})

describe('list_actions — limit and offset bounds', () => {
  const schema = () =>
    createActionTools(USER_ID, makeSupabase().supabase as never, WORKSPACE_ID).list_actions.inputSchema as unknown as {
      safeParse: (v: unknown) => { success: boolean }
    }

  it('accepts 1 to 200 rows and refuses more, so the advertised schema says the real maximum', () => {
    expect(schema().safeParse({ limit: 200 }).success).toBe(true)
    expect(schema().safeParse({ limit: 1 }).success).toBe(true)
    expect(schema().safeParse({ limit: 201 }).success).toBe(false)
    expect(schema().safeParse({ limit: 0 }).success).toBe(false)
    expect(schema().safeParse({ offset: -1 }).success).toBe(false)
  })
})
