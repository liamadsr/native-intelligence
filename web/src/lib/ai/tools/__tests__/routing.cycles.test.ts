/**
 * Workspace routing for the cycle tools — the PARENT-ANCHORED case.
 *
 * A `cycle` row carries no workspace_id of its own (migration 024): it inherits
 * scope from its team. That makes the team the tenant, and it makes every cycle
 * tool routable WITHOUT a `workspace_id` param — `create_cycle` already names a
 * team, and `start_cycle` / `complete_cycle` reach one through the cycle. The
 * protocol's create-time refusal (`needs_workspace`) cannot apply here, because
 * there is no ambiguous fallback to arbitrate: the parent answers the question.
 *
 * What is pinned here:
 *   1. create_cycle acts in the TEAM's workspace once membership there is
 *      proven, and echoes which one — the row itself cannot carry it;
 *   2. a team in a workspace the user is not a member of reads exactly like a
 *      team that does not exist ('Team not found', nothing inserted);
 *   3. start_cycle / complete_cycle route the same way, and complete_cycle's
 *      follow-on writes (the next cycle, the rolled actions) all land in the
 *      resolved workspace;
 *   4. under `strictWorkspace` every foreign parent is not-found, with NO member
 *      probe issued — for a fenced run the probe itself is the leak.
 *
 * The double is an in-memory engine: filters are real predicates and writes
 * really mutate, so a cycle rolled into the wrong tenant's actions shows up as a
 * wrong row here rather than a passing stub.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createCycleTools } from '../cycles'

const USER_ID = 'user-1'
const WS_ACTIVE = 'ws-1'
const WS_OTHER = 'ws-2'
const WS_STRANGER = 'ws-nope'

const EXEC_OPTS = {
  toolCallId: 'c1',
  messages: [],
  context: {},
} satisfies ToolExecutionOptions<Record<string, unknown>>

const DATES = { start_date: '2026-01-01', end_date: '2026-01-15' }

type Row = Record<string, unknown>
type LogEntry = { table: string; op: string; col?: string; val?: unknown }

function tableChain(table: string, rows: Row[], log: LogEntry[], nextId: () => string) {
  const preds: Array<(r: Row) => boolean> = []
  let limitN: number | null = null
  let mode: 'select' | 'insert' | 'update' = 'select'
  let patch: Row = {}
  let inserted: Row[] = []

  const chain: Record<string, unknown> = {}
  const pass = () => chain
  chain.select = vi.fn(pass)
  chain.order = vi.fn(pass)
  chain.gte = vi.fn(pass)
  chain.lte = vi.fn(pass)
  chain.eq = vi.fn((col: string, val: unknown) => {
    log.push({ table, op: 'eq', col, val })
    preds.push((r) => r[col] === val)
    return chain
  })
  chain.neq = vi.fn((col: string, val: unknown) => {
    preds.push((r) => r[col] !== val)
    return chain
  })
  chain.in = vi.fn((col: string, vals: unknown[]) => {
    preds.push((r) => vals.includes(r[col]))
    return chain
  })
  chain.limit = vi.fn((n: number) => {
    limitN = n
    return chain
  })
  chain.insert = vi.fn((payload: Row) => {
    log.push({ table, op: 'insert', val: payload })
    mode = 'insert'
    inserted = [{ id: nextId(), name: 'Cycle N', ...payload }]
    return chain
  })
  chain.update = vi.fn((p: Row) => {
    log.push({ table, op: 'update', val: p })
    mode = 'update'
    patch = p
    return chain
  })

  const run = (): Row[] => {
    if (mode === 'insert') {
      rows.push(...inserted)
      return inserted
    }
    let matched = rows.filter((r) => preds.every((p) => p(r)))
    if (limitN !== null) matched = matched.slice(0, limitN)
    if (mode === 'update') for (const r of matched) Object.assign(r, patch)
    return matched
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
    member: memberOf.map((id) => ({ id: `member-${id}`, user_id: USER_ID, workspace_id: id })),
    team: [
      { id: `team-${WS_ACTIVE}`, workspace_id: WS_ACTIVE },
      { id: `team-${WS_OTHER}`, workspace_id: WS_OTHER },
      { id: `team-${WS_STRANGER}`, workspace_id: WS_STRANGER },
    ],
    cycle: [],
    actions: [],
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

const tools = (supabase: never, strict = false) =>
  createCycleTools(USER_ID, supabase, WS_ACTIVE, strict)

type ToolResult = {
  success: boolean
  error?: string
  message?: string
  workspace?: { id: string; name: string | null }
  cycle?: Record<string, unknown>
  next_cycle?: Record<string, unknown> | null
  rolled_count?: number
}

const run = (t: { execute?: unknown }, args: Record<string, unknown>) =>
  (t as { execute: (a: unknown, o: unknown) => Promise<ToolResult> }).execute(args, EXEC_OPTS)

describe('create_cycle — routed by its team', () => {
  it('creates in the workspace of a team the user belongs to, and echoes it', async () => {
    const { supabase, tables } = makeDb()
    const res = await run(tools(supabase).create_cycle, { team_id: `team-${WS_OTHER}`, ...DATES })

    expect(res.success).toBe(true)
    expect(tables.cycle).toHaveLength(1)
    expect(tables.cycle[0].team_id).toBe(`team-${WS_OTHER}`)
    // The only in-band signal of the route: the row names no workspace.
    expect(res.workspace).toEqual({ id: WS_OTHER, name: null })
  })

  it('still creates against the active workspace’s own team', async () => {
    const { supabase, tables } = makeDb()
    const res = await run(tools(supabase).create_cycle, { team_id: `team-${WS_ACTIVE}`, ...DATES })

    expect(res.success).toBe(true)
    expect(res.workspace).toEqual({ id: WS_ACTIVE, name: null })
    expect(tables.cycle).toHaveLength(1)
  })

  it('rejects a team in a workspace the user is NOT a member of', async () => {
    const { supabase, tables } = makeDb()
    const res = await run(tools(supabase).create_cycle, { team_id: `team-${WS_STRANGER}`, ...DATES })

    expect(res.success).toBe(false)
    expect(res.error).toBe('Team not found')
    // Identical to a team that does not exist — it must not confirm that this id
    // is a real team somewhere else.
    expect(res.error).not.toMatch(new RegExp(WS_STRANGER))
    expect(tables.cycle).toHaveLength(0)
  })

  it('is not-found for a foreign team under strictWorkspace, with NO member probe', async () => {
    const { supabase, tables, log } = makeDb()
    const res = await run(tools(supabase, true).create_cycle, { team_id: `team-${WS_OTHER}`, ...DATES })

    expect(res).toEqual({ success: false, error: 'Team not found' })
    expect(tables.cycle).toHaveLength(0)
    expect(log.some((e) => e.table === 'member')).toBe(false)
  })

  it('still validates the date range for a routed team', async () => {
    const { supabase, tables } = makeDb()
    const res = await run(tools(supabase).create_cycle, {
      team_id: `team-${WS_OTHER}`,
      start_date: '2026-01-15',
      end_date: '2026-01-01',
    })

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/end_date must be after start_date/)
    expect(tables.cycle).toHaveLength(0)
  })
})

describe('start_cycle — routed by the cycle’s team', () => {
  const foreignCycle = () => ({
    id: 'cyc-1',
    team_id: `team-${WS_OTHER}`,
    name: 'Sprint 4',
    status: 'upcoming',
    end_date: '2026-01-15',
  })

  it('starts a cycle whose team is in another member workspace', async () => {
    const { supabase, tables } = makeDb({ cycle: [foreignCycle()] })
    const res = await run(tools(supabase).start_cycle, { cycle_id: 'cyc-1' })

    expect(res.success).toBe(true)
    expect(tables.cycle[0].status).toBe('active')
    expect(res.workspace).toEqual({ id: WS_OTHER, name: null })
  })

  it('is not-found under strictWorkspace and leaves the cycle alone', async () => {
    const { supabase, tables } = makeDb({ cycle: [foreignCycle()] })
    const res = await run(tools(supabase, true).start_cycle, { cycle_id: 'cyc-1' })

    expect(res).toEqual({ success: false, error: 'Cycle not found' })
    expect(tables.cycle[0].status).toBe('upcoming')
  })

  it('is not-found when the cycle’s team belongs to a workspace the user left', async () => {
    const { supabase, tables } = makeDb({ cycle: [foreignCycle()] }, [WS_ACTIVE])
    const res = await run(tools(supabase).start_cycle, { cycle_id: 'cyc-1' })

    expect(res).toEqual({ success: false, error: 'Cycle not found' })
    expect(tables.cycle[0].status).toBe('upcoming')
  })
})

describe('complete_cycle — every follow-on write lands in the resolved workspace', () => {
  const seed = () => ({
    cycle: [
      { id: 'cyc-1', team_id: `team-${WS_OTHER}`, name: 'Sprint 4', status: 'active', end_date: '2026-01-15' },
    ],
    actions: [
      // Unfinished, in the cycle, in the cycle's workspace: rolls forward.
      { id: 'act-1', workspace_id: WS_OTHER, cycle_id: 'cyc-1', confirmation: 'confirmed', workflow_state: { category: 'started' } },
      // A same-id-collision decoy in the SESSION workspace: it must not move.
      { id: 'act-2', workspace_id: WS_ACTIVE, cycle_id: 'cyc-1', confirmation: 'confirmed', workflow_state: { category: 'started' } },
    ],
  })

  it('completes, creates the next cycle, and rolls only the resolved workspace’s actions', async () => {
    const { supabase, tables } = makeDb(seed())
    const res = await run(tools(supabase).complete_cycle, { cycle_id: 'cyc-1', roll_to_next: true })

    expect(res.success).toBe(true)
    expect(tables.cycle[0].status).toBe('completed')
    expect(res.rolled_count).toBe(1)
    expect(res.workspace).toEqual({ id: WS_OTHER, name: null })

    const next = tables.cycle.find((c) => c.status === 'upcoming')!
    expect(next.team_id).toBe(`team-${WS_OTHER}`)
    // Only the foreign-workspace action moved; the session-workspace decoy that
    // shares the cycle_id was never in scope.
    expect(tables.actions.find((a) => a.id === 'act-1')!.cycle_id).toBe(next.id)
    expect(tables.actions.find((a) => a.id === 'act-2')!.cycle_id).toBe('cyc-1')
  })

  it('is not-found under strictWorkspace and completes nothing', async () => {
    const { supabase, tables } = makeDb(seed())
    const res = await run(tools(supabase, true).complete_cycle, { cycle_id: 'cyc-1', roll_to_next: true })

    expect(res).toEqual({ success: false, error: 'Cycle not found' })
    expect(tables.cycle[0].status).toBe('active')
    expect(tables.cycle).toHaveLength(1)
  })
})
