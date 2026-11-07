/**
 * Workspace routing for the action tools that take a NON-ID reference.
 *
 * Identifiers are unique per (workspace_id, identifier) — migration 022:51 — so
 * `ENG-42` can legitimately name a different action in every workspace the user
 * belongs to. Until now `complete_action` / `update_action` / `delete_action`
 * resolved `action_id` cross-workspace but pinned their `identifier` /
 * `title_match` lookups to `.eq('workspace_id', workspaceId)`: an identifier
 * copied out of another workspace's UI read as "Action not found" even though
 * the user could see it in the product. `get_action` had the same gap on the id
 * path, where `update_action` did not — so an id you could WRITE you could not
 * READ.
 *
 * What is pinned here:
 *   1. get_action resolves a foreign-but-member id, and says so (workspace_id
 *      on the row + a workspace_hint that does NOT tell the agent to switch);
 *   2. an identifier held by exactly ONE other workspace routes there, for all
 *      three write tools (one shared helper — delete/complete exercise it too);
 *   3. an identifier held by TWO workspaces is a STRUCTURED refusal with
 *      candidates, and writes nothing — never a silent guess at the tenant;
 *   4. under `strictWorkspace` the behaviour is byte-identical to before: not
 *      found, and NO cross-workspace probe is issued at all (the fan-out would
 *      otherwise be an existence oracle for a fenced unattended run).
 *
 * The Supabase double is a small in-memory engine — eq/in/ilike/limit become
 * predicates ANDed over the rows, and update/delete mutate them — so a routing
 * bug genuinely writes to the wrong rows here rather than being masked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createActionTools } from '../actions'

// Same shim the other actions suites use: importing actions.ts must not pull in
// the apply-engine's mcp-client imports, which don't load in a test env.
vi.mock('@/lib/proposed-changes/apply-engine', () => ({
  applyChange: vi.fn(),
}))

const USER_ID = 'user-1'
const WS_ACTIVE = 'ws-1'
const WS_OTHER = 'ws-2'
const WS_THIRD = 'ws-3'

const EXEC_OPTS = {
  toolCallId: 'test-call-id',
  messages: [],
  context: {},
} satisfies ToolExecutionOptions<Record<string, unknown>>

type Row = Record<string, unknown>

const WORKSPACES = [
  { id: WS_ACTIVE, name: 'Alpha' },
  { id: WS_OTHER, name: 'Beta' },
  { id: WS_THIRD, name: 'Gamma' },
]

/** One `member` row per workspace, shaped for BOTH member reads:
 *  the `{ id }` membership probe (resolveEntityWorkspace) and the
 *  `{ workspace: { id, name } }` embed (getUserWorkspaces). An owner in each, so
 *  delete_action's owner/admin gate passes and the ROUTING is what's tested. */
function memberRows(workspaceIds: string[]): Row[] {
  return workspaceIds.map((id) => ({
    id: `member-${id}`,
    user_id: USER_ID,
    workspace_id: id,
    role: 'owner',
    workspace: WORKSPACES.find((w) => w.id === id)!,
  }))
}

function action(overrides: Partial<Row> & { id: string; workspace_id: string }): Row {
  return {
    user_id: USER_ID,
    identifier: 'ENG-42',
    title: 'Ship the thing',
    description: null,
    status_id: 'state-todo',
    team_id: 'team-1',
    confirmation: 'confirmed',
    priority: 'none',
    due_at: null,
    all_day: false,
    assignee_id: null,
    parent_id: null,
    estimate: null,
    project_id: null,
    milestone_id: null,
    cycle_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    workflow_state: { id: 'state-todo', name: 'Todo', category: 'unstarted', color: '#888' },
    project: null,
    milestone: null,
    cycle: null,
    labels: [],
    ...overrides,
  }
}

type LogEntry = { table: string; op: string; col?: string; val?: unknown }

/**
 * Chainable table double. Filters accumulate as predicates; `update` / `delete`
 * apply to whatever survives them, so a write scoped to the wrong workspace_id
 * simply matches nothing (exactly like PostgREST).
 */
function tableChain(table: string, rows: Row[], log: LogEntry[]) {
  const preds: Array<(r: Row) => boolean> = []
  let limitN: number | null = null
  let mode: 'select' | 'update' | 'delete' = 'select'
  let patch: Row = {}

  const chain: Record<string, unknown> = {}
  const pass = () => chain
  chain.select = vi.fn(pass)
  chain.order = vi.fn(pass)
  chain.range = vi.fn(pass)
  chain.textSearch = vi.fn(pass)
  chain.is = vi.fn((col: string, val: unknown) => {
    preds.push((r) => r[col] === val)
    return chain
  })
  chain.eq = vi.fn((col: string, val: unknown) => {
    log.push({ table, op: 'eq', col, val })
    preds.push((r) => r[col] === val)
    return chain
  })
  chain.in = vi.fn((col: string, vals: unknown[]) => {
    log.push({ table, op: 'in', col, val: vals })
    preds.push((r) => vals.includes(r[col]))
    return chain
  })
  chain.ilike = vi.fn((col: string, pattern: string) => {
    log.push({ table, op: 'ilike', col, val: pattern })
    const needle = pattern.replace(/%/g, '').toLowerCase()
    preds.push((r) => String(r[col] ?? '').toLowerCase().includes(needle))
    return chain
  })
  chain.limit = vi.fn((n: number) => {
    limitN = n
    return chain
  })
  chain.update = vi.fn((p: Row) => {
    log.push({ table, op: 'update', val: p })
    mode = 'update'
    patch = p
    return chain
  })
  chain.delete = vi.fn(() => {
    log.push({ table, op: 'delete' })
    mode = 'delete'
    return chain
  })

  /** Apply the accumulated filters (and the write, if any) exactly once. */
  const run = (): Row[] => {
    let matched = rows.filter((r) => preds.every((p) => p(r)))
    if (limitN !== null) matched = matched.slice(0, limitN)
    if (mode === 'update') {
      for (const r of matched) Object.assign(r, patch)
    } else if (mode === 'delete') {
      for (const r of matched) {
        const i = rows.indexOf(r)
        if (i >= 0) rows.splice(i, 1)
      }
    }
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

function makeSupabase(opts: { actions: Row[]; memberOf?: string[] }) {
  const actions = opts.actions
  const members = memberRows(opts.memberOf ?? [WS_ACTIVE, WS_OTHER, WS_THIRD])
  const log: LogEntry[] = []
  const from = vi.fn((table: string) => {
    if (table === 'actions') return tableChain('actions', actions, log)
    if (table === 'member') return tableChain('member', members, log)
    return tableChain(table, [], log)
  })
  return { supabase: { from } as never, actions, log }
}

const tools = (supabase: never, strict = false) =>
  createActionTools(USER_ID, supabase, WS_ACTIVE, strict)

type ToolResult = {
  success: boolean
  error?: string
  message?: string
  workspace_hint?: string
  action?: { workspace_id?: string; title?: string }
  candidates?: Array<{
    action_id: string
    workspace_id: string
    workspace_name: string
    title: string
  }>
}

const run = (t: { execute?: unknown }, args: Record<string, unknown>) =>
  (t as { execute: (a: unknown, o: unknown) => Promise<ToolResult> }).execute(args, EXEC_OPTS)

let FOREIGN: Row
let LOCAL: Row
let THIRD: Row

beforeEach(() => {
  // Fresh rows per test — the double MUTATES them on update/delete.
  LOCAL = action({ id: 'a-local', workspace_id: WS_ACTIVE, identifier: 'ENG-7', title: 'Local work' })
  FOREIGN = action({ id: 'a-foreign', workspace_id: WS_OTHER, title: 'Foreign work' })
  THIRD = action({ id: 'a-third', workspace_id: WS_THIRD, title: 'Third work' })
})

describe('get_action — target-routed by id', () => {
  it('resolves an id that lives in ANOTHER workspace the user belongs to', async () => {
    const { supabase } = makeSupabase({ actions: [LOCAL, FOREIGN] })
    const res = await run(tools(supabase).get_action, { action_id: 'a-foreign' })

    expect(res.success).toBe(true)
    expect(res.action?.workspace_id).toBe(WS_OTHER)
    expect(res.workspace_hint).toContain(WS_OTHER)
    // The hint must NOT push the agent into switching the session: that would
    // silently re-scope every later call. It hands over the id instead.
    expect(res.workspace_hint).toMatch(/pass this workspace_id explicitly if you act on it/i)
    expect(res.workspace_hint).not.toMatch(/set_workspace/i)
  })

  it('carries workspace_id — and no hint — for an in-workspace id', async () => {
    const { supabase } = makeSupabase({ actions: [LOCAL, FOREIGN] })
    const res = await run(tools(supabase).get_action, { action_id: 'a-local' })

    expect(res.success).toBe(true)
    expect(res.action?.workspace_id).toBe(WS_ACTIVE)
    expect(res.workspace_hint).toBeUndefined()
  })

  it('is still not-found for a foreign id under strictWorkspace', async () => {
    const { supabase } = makeSupabase({ actions: [LOCAL, FOREIGN] })
    const res = await run(tools(supabase, true).get_action, { action_id: 'a-foreign' })

    expect(res).toEqual({ success: false, error: 'Action not found' })
  })
})

describe('update_action — identifier routing', () => {
  it('proceeds in the ONE other workspace that holds the identifier', async () => {
    const { supabase, actions } = makeSupabase({ actions: [LOCAL, FOREIGN] })
    const res = await run(tools(supabase).update_action, {
      identifier: 'ENG-42',
      title: 'Renamed remotely',
    })

    expect(res.success).toBe(true)
    expect(res.action?.workspace_id).toBe(WS_OTHER)
    expect(res.action?.title).toBe('Renamed remotely')
    // The write landed on the foreign row, and only on it.
    expect(actions.find((a) => a.id === 'a-foreign')!.title).toBe('Renamed remotely')
    expect(actions.find((a) => a.id === 'a-local')!.title).toBe('Local work')
  })

  it('prefers the ACTIVE workspace and never fans out when it has a match', async () => {
    const localEng42 = action({ id: 'a-local-42', workspace_id: WS_ACTIVE, title: 'Local ENG-42' })
    const { supabase, log } = makeSupabase({ actions: [localEng42, FOREIGN] })
    const res = await run(tools(supabase).update_action, {
      identifier: 'ENG-42',
      title: 'Renamed locally',
    })

    expect(res.success).toBe(true)
    expect(res.action?.workspace_id).toBe(WS_ACTIVE)
    // Fast path only: the user's workspace list was never resolved.
    expect(log.some((e) => e.table === 'member')).toBe(false)
  })

  it('refuses with structured candidates when TWO workspaces hold the identifier', async () => {
    const { supabase, actions, log } = makeSupabase({ actions: [LOCAL, FOREIGN, THIRD] })
    const res = await run(tools(supabase).update_action, {
      identifier: 'ENG-42',
      title: 'Should not be written',
    })

    expect(res.success).toBe(false)
    expect(res.error).toBe(
      'Identifier ENG-42 matches actions in 2 workspaces: Beta (ws-2), Gamma (ws-3). ' +
        'Pass action_id or workspace_id to disambiguate.',
    )
    expect(res.candidates).toEqual([
      { action_id: 'a-foreign', workspace_id: WS_OTHER, workspace_name: 'Beta', title: 'Foreign work' },
      { action_id: 'a-third', workspace_id: WS_THIRD, workspace_name: 'Gamma', title: 'Third work' },
    ])
    // Nothing was written — an ambiguous tenant must never be guessed at.
    expect(log.some((e) => e.table === 'actions' && e.op === 'update')).toBe(false)
    expect(actions.map((a) => a.title)).toEqual(['Local work', 'Foreign work', 'Third work'])
  })

  it('routes a title_match the same way', async () => {
    const { supabase } = makeSupabase({ actions: [LOCAL, FOREIGN] })
    const res = await run(tools(supabase).update_action, {
      title_match: 'foreign',
      priority: 'high',
    })

    expect(res.success).toBe(true)
    expect(res.action?.workspace_id).toBe(WS_OTHER)
  })
})

describe('update_action — strictWorkspace is byte-identical to before', () => {
  it('reports not-found for an identifier that only exists elsewhere', async () => {
    const { supabase, actions } = makeSupabase({ actions: [LOCAL, FOREIGN] })
    const res = await run(tools(supabase, true).update_action, {
      identifier: 'ENG-42',
      title: 'Should not be written',
    })

    expect(res).toEqual({ success: false, error: 'Action not found' })
    expect(actions.find((a) => a.id === 'a-foreign')!.title).toBe('Foreign work')
  })

  it('issues NO cross-workspace probe at all', async () => {
    const { supabase, log } = makeSupabase({ actions: [LOCAL, FOREIGN] })
    await run(tools(supabase, true).update_action, { identifier: 'ENG-42', title: 'x' })

    // Neither the workspace-list read nor an `.in('workspace_id', ...)` fan-out:
    // a fenced run must not be able to learn that the identifier exists at all.
    expect(log.some((e) => e.table === 'member')).toBe(false)
    expect(log.some((e) => e.op === 'in' && e.col === 'workspace_id')).toBe(false)
  })
})

describe('the identifier lookup is ONE helper shared by all three write tools', () => {
  it('delete_action routes to the other workspace and deletes only there', async () => {
    const { supabase, actions } = makeSupabase({ actions: [LOCAL, FOREIGN] })
    const res = await run(tools(supabase).delete_action, { identifier: 'ENG-42' })

    expect(res.success).toBe(true)
    expect(actions.map((a) => a.id)).toEqual(['a-local'])
  })

  it('complete_action refuses ambiguity with the same structured shape', async () => {
    const { supabase, log } = makeSupabase({ actions: [LOCAL, FOREIGN, THIRD] })
    const res = await run(tools(supabase).complete_action, { identifier: 'ENG-42' })

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/matches actions in 2 workspaces/)
    expect(res.candidates?.map((c) => c.workspace_id)).toEqual([WS_OTHER, WS_THIRD])
    // Refused before reaching the completed-state lookup, so nothing was written.
    expect(log.some((e) => e.table === 'workflow_state')).toBe(false)
    expect(log.some((e) => e.table === 'actions' && e.op === 'update')).toBe(false)
  })

  it('delete_action is not-found when the user is a member of no other workspace', async () => {
    const { supabase, actions } = makeSupabase({
      actions: [LOCAL, FOREIGN],
      memberOf: [WS_ACTIVE],
    })
    const res = await run(tools(supabase).delete_action, { identifier: 'ENG-42' })

    expect(res).toEqual({ success: false, error: 'Action not found' })
    expect(actions).toHaveLength(2)
  })
})
