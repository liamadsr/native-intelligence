/**
 * CREATE-TIME (and mutate-time) workspace routing for the action tools.
 *
 * `resolveEntityWorkspace` routes what already EXISTS — the row names its own
 * tenant. A CREATE has nothing to route BY, so it landed wherever the session
 * happened to point: read ENG-42 out of Engineering, file the follow-up in
 * Marketing, find out days later. `resolveCreateWorkspace` (./_shared.ts) is the
 * protocol that replaces that default, and this file is where the ACTION family
 * proves it applies it — including the half that is easy to get wrong.
 *
 * What is pinned here:
 *   1. an explicit `workspace_id` routes the create AND every lookup it makes:
 *      the default team, the workflow state and the assignee-by-name are
 *      resolved in the TARGET workspace, because a team or state id resolved in
 *      the session workspace and written onto a row in another one is a
 *      cross-tenant foreign key, not a cosmetic mismatch;
 *   2. an explicit id the user is not a member of is a flat 'Workspace not
 *      found' with nothing written — the same reply a nonexistent id gets, so
 *      the tool is not an existence oracle for the whole install;
 *   3. policy 'explicit' (the MCP bridge) refuses with `needs_workspace` +
 *      candidates rather than guessing a tenant, and writes nothing;
 *   4. policy 'session' with no id is byte-identical to before — same workspace,
 *      same query chain, no membership read;
 *   5. under `strictWorkspace` a foreign explicit id is not-found with NO member
 *      probe issued at all;
 *   6. the routed MUTATES (proposals, labels, reorder) follow their row's
 *      workspace and re-scope every subsequent query there — the apply engine's
 *      member id included.
 *
 * The Supabase double is a small in-memory engine: eq/in/limit become predicates
 * ANDed over real rows, and insert/update/delete mutate them. A create that
 * resolves its team in the wrong workspace genuinely writes the wrong team_id
 * here rather than being masked by a stub.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createActionTools } from '../actions'

// Same shim the other actions suites use: importing actions.ts must not pull in
// the apply-engine's mcp-client imports, which don't load in a test env.
const { mockApplyChange, mockResolveMemberIdByName } = vi.hoisted(() => ({
  mockApplyChange: vi.fn(),
  mockResolveMemberIdByName: vi.fn(),
}))
vi.mock('@/lib/proposed-changes/apply-engine', () => ({ applyChange: mockApplyChange }))
// Mocked rather than driven through the double because the ONE fact worth
// asserting about assignee resolution is which workspace it was asked about.
vi.mock('@/lib/people/name-match', () => ({ resolveMemberIdByName: mockResolveMemberIdByName }))

const USER_ID = 'user-1'
const WS_ACTIVE = 'ws-1'
const WS_OTHER = 'ws-2'
const WS_THIRD = 'ws-3'
const WS_STRANGER = 'ws-nope'

const EXEC_OPTS = {
  toolCallId: 'test-call-id',
  messages: [],
  context: {},
} satisfies ToolExecutionOptions<Record<string, unknown>>

type Row = Record<string, unknown>
type LogEntry = { table: string; op: string; col?: string; val?: unknown }

const WORKSPACES = [
  { id: WS_ACTIVE, name: 'Alpha' },
  { id: WS_OTHER, name: 'Beta' },
  { id: WS_THIRD, name: 'Gamma' },
]

/** One `member` row per workspace, shaped for all three reads the protocol makes:
 *  the `{ id }` probe (resolveEntityWorkspace), the `{ workspace: { name } }`
 *  embed (resolveCreateWorkspace) and the `{ workspace: { id, name } }` embed
 *  (getUserWorkspaces). */
function memberRows(workspaceIds: string[]): Row[] {
  return workspaceIds.map((id) => ({
    id: `member-${id}`,
    user_id: USER_ID,
    workspace_id: id,
    workspace: WORKSPACES.find((w) => w.id === id) ?? { id, name: id },
  }))
}

/** One team + one default state per workspace, so "which workspace did the
 *  create look in?" is answerable from the ids written onto the row. */
function teamRows(workspaceIds: string[]): Row[] {
  return workspaceIds.map((id) => ({ id: `team-${id}`, workspace_id: id, created_at: '2026-01-01' }))
}

function stateRows(workspaceIds: string[]): Row[] {
  return workspaceIds.flatMap((id) => [
    { id: `state-todo-${id}`, team_id: `team-${id}`, is_default: true, name: 'Todo', category: 'unstarted', sort_order: 0 },
    { id: `state-doing-${id}`, team_id: `team-${id}`, is_default: false, name: 'In Progress', category: 'started', sort_order: 1 },
  ])
}

/**
 * Chainable table double. Filters accumulate as predicates; insert/update/delete
 * apply to whatever survives them, so a write scoped to the wrong workspace_id
 * simply matches nothing — exactly like PostgREST.
 */
function tableChain(table: string, rows: Row[], log: LogEntry[], nextId: () => string) {
  const preds: Array<(r: Row) => boolean> = []
  let limitN: number | null = null
  let mode: 'select' | 'insert' | 'update' | 'delete' = 'select'
  let patch: Row = {}
  let inserted: Row[] = []

  const chain: Record<string, unknown> = {}
  const pass = () => chain
  chain.select = vi.fn((cols?: string) => {
    log.push({ table, op: 'select', val: cols })
    return chain
  })
  chain.order = vi.fn(pass)
  chain.range = vi.fn(pass)
  chain.or = vi.fn(pass)
  chain.is = vi.fn((col: string, val: unknown) => {
    preds.push((r) => r[col] === val)
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
  chain.in = vi.fn((col: string, vals: unknown[]) => {
    log.push({ table, op: 'in', col, val: vals })
    preds.push((r) => vals.includes(r[col]))
    return chain
  })
  chain.limit = vi.fn((n: number) => {
    limitN = n
    return chain
  })
  chain.insert = vi.fn((payload: Row | Row[]) => {
    log.push({ table, op: 'insert', val: payload })
    mode = 'insert'
    inserted = (Array.isArray(payload) ? payload : [payload]).map((p, i) => ({
      id: nextId(),
      // Enough of an identifier for the tools' message strings; the assertions
      // below care about workspace_id / team_id / status_id, not the label.
      identifier: `GEN-${i + 1}`,
      ...p,
    }))
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
    if (mode === 'insert') {
      rows.push(...inserted)
      return inserted
    }
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
      : { data: null, error: { message: 'no rows returned', code: 'PGRST116' } }
  }
  chain.maybeSingle = async () => ({ data: run()[0] ?? null, error: null })
  chain.then = (resolve: (v: unknown) => unknown) => {
    const data = run()
    return Promise.resolve({ data, error: null, count: data.length }).then(resolve)
  }
  return chain
}

function makeDb(seed: Record<string, Row[]> = {}, memberOf: string[] = [WS_ACTIVE, WS_OTHER, WS_THIRD]) {
  const tables: Record<string, Row[]> = {
    member: memberRows(memberOf),
    team: teamRows([WS_ACTIVE, WS_OTHER, WS_THIRD]),
    workflow_state: stateRows([WS_ACTIVE, WS_OTHER, WS_THIRD]),
    actions: [],
    label: [],
    ...seed,
  }
  const log: LogEntry[] = []
  let seq = 0
  const from = vi.fn((table: string) => {
    tables[table] ??= []
    return tableChain(table, tables[table], log, () => `${table}-row-${++seq}`)
  })
  return { supabase: { from } as never, tables, log }
}

type Policy = 'session' | 'explicit'

const tools = (supabase: never, opts: { strict?: boolean; policy?: Policy } = {}) =>
  createActionTools(USER_ID, supabase, WS_ACTIVE, opts.strict ?? false, false, opts.policy ?? 'session')

type ToolResult = {
  success: boolean
  error?: string
  error_type?: string
  message?: string
  candidates?: Array<{ id: string; name: string; is_active: boolean }>
  workspace?: { id: string; name: string | null }
  action?: Record<string, unknown>
  label?: Record<string, unknown>
  created?: Array<{ id: string }>
  failed?: Array<{ title: string; error: string }>
}

const run = (t: { execute?: unknown }, args: Record<string, unknown>) =>
  (t as { execute: (a: unknown, o: unknown) => Promise<ToolResult> }).execute(args, EXEC_OPTS)

/** Which workspace_id a given table was filtered on, in call order. */
const wsFiltersOn = (log: LogEntry[], table: string) =>
  log.filter((e) => e.table === table && e.op === 'eq' && e.col === 'workspace_id').map((e) => e.val)

beforeEach(() => {
  mockApplyChange.mockReset()
  mockResolveMemberIdByName.mockReset()
  mockResolveMemberIdByName.mockImplementation(async (_s: unknown, ws: string, name: string) => `member-${ws}-${name}`)
})

describe('create_action — an explicit workspace_id routes the create AND its lookups', () => {
  it('writes into the target workspace with that workspace’s team, state and member', async () => {
    const { supabase, tables, log } = makeDb()
    const res = await run(tools(supabase).create_action, {
      workspace_id: WS_OTHER,
      title: 'Follow up on ENG-42',
      assignee_name: 'Dana',
    })

    expect(res.success).toBe(true)
    const row = tables.actions[0]
    expect(row.workspace_id).toBe(WS_OTHER)
    // The two ids that would silently cross tenants if they were resolved in the
    // session workspace — this is the whole point of the protocol.
    expect(row.team_id).toBe(`team-${WS_OTHER}`)
    expect(row.status_id).toBe(`state-todo-${WS_OTHER}`)
    expect(row.assignee_id).toBe(`member-${WS_OTHER}-Dana`)

    // …and the queries that produced them asked about the TARGET, never the session.
    expect(wsFiltersOn(log, 'team')).toEqual([WS_OTHER])
    expect(log.filter((e) => e.table === 'workflow_state' && e.op === 'eq' && e.col === 'team_id').map((e) => e.val)).toEqual([
      `team-${WS_OTHER}`,
    ])
    expect(mockResolveMemberIdByName).toHaveBeenCalledWith(supabase, WS_OTHER, 'Dana')

    // The echo is the in-turn proof of the route (compare with active_workspace).
    expect(res.workspace).toEqual({ id: WS_OTHER, name: 'Beta' })
  })

  it('resolves status_name inside the target workspace’s team', async () => {
    const { supabase, tables } = makeDb()
    const res = await run(tools(supabase).create_action, {
      workspace_id: WS_OTHER,
      title: 'Start immediately',
      status_name: 'In Progress',
    })

    expect(res.success).toBe(true)
    expect(tables.actions[0].status_id).toBe(`state-doing-${WS_OTHER}`)
  })

  it('refuses an explicit workspace the user is not a member of, and writes nothing', async () => {
    const { supabase, tables, log } = makeDb()
    const res = await run(tools(supabase).create_action, { workspace_id: WS_STRANGER, title: 'Nope' })

    expect(res).toEqual({ success: false, error: 'Workspace not found' })
    expect(tables.actions).toHaveLength(0)
    // Same reply a nonexistent workspace gets — and nothing was looked up in it.
    expect(log.some((e) => e.table === 'team')).toBe(false)
  })

  it('is not-found under strictWorkspace, with NO member probe issued', async () => {
    const { supabase, tables, log } = makeDb()
    const res = await run(tools(supabase, { strict: true }).create_action, {
      workspace_id: WS_OTHER,
      title: 'Fenced run',
    })

    expect(res).toEqual({ success: false, error: 'Workspace not found' })
    expect(tables.actions).toHaveLength(0)
    // The probe's very existence would be an existence oracle for a fenced run.
    expect(log.some((e) => e.table === 'member')).toBe(false)
  })

  it('rejects a foreign-workspace project_id on a ROUTED create, before inserting', async () => {
    // The hazard the routing itself opens: ids copied out of the session
    // workspace, written onto a row in another tenant. Postgres will not stop it
    // — every one of these FKs is workspace-blind.
    const { supabase, tables } = makeDb({
      projects: [{ id: 'proj-session', workspace_id: WS_ACTIVE }],
    })
    const res = await run(tools(supabase).create_action, {
      workspace_id: WS_OTHER,
      title: 'Cross-tenant link',
      project_id: 'proj-session',
    })

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/project_id does not belong/i)
    expect(tables.actions).toHaveLength(0)
  })

  it('accepts a project_id that lives in the target workspace', async () => {
    const { supabase, tables } = makeDb({
      projects: [{ id: 'proj-other', workspace_id: WS_OTHER }],
    })
    const res = await run(tools(supabase).create_action, {
      workspace_id: WS_OTHER,
      title: 'Linked properly',
      project_id: 'proj-other',
    })

    expect(res.success).toBe(true)
    expect(tables.actions[0].project_id).toBe('proj-other')
  })
})

describe("create_action — policy governs only the FALLBACK", () => {
  it("'session' with no workspace_id is byte-identical to before", async () => {
    const { supabase, tables, log } = makeDb()
    const res = await run(tools(supabase).create_action, { title: 'Ordinary create' })

    expect(res.success).toBe(true)
    expect(tables.actions[0].workspace_id).toBe(WS_ACTIVE)
    expect(tables.actions[0].team_id).toBe(`team-${WS_ACTIVE}`)
    // The whole query chain, unchanged: team → state → insert. No membership
    // read, because the in-app path must not pay a round-trip for a default it
    // already knows.
    expect([...new Set(log.filter((e) => e.op === 'select' || e.op === 'insert').map((e) => e.table))]).toEqual([
      'team',
      'workflow_state',
      'actions',
    ])
    expect(log.some((e) => e.table === 'member')).toBe(false)
    expect(res.workspace).toEqual({ id: WS_ACTIVE, name: null })
  })

  it("'explicit' with no workspace_id and 2+ workspaces REFUSES with candidates", async () => {
    const { supabase, tables } = makeDb()
    const res = await run(tools(supabase, { policy: 'explicit' }).create_action, { title: 'Where?' })

    expect(res.success).toBe(false)
    expect(res.error_type).toBe('needs_workspace')
    expect(res.error).toMatch(/Specify workspace_id/)
    expect(res.candidates?.map((c) => c.id)).toEqual([WS_ACTIVE, WS_OTHER, WS_THIRD])
    expect(res.candidates?.[0].is_active).toBe(true)
    // A refusal, not a guess: nothing was written and no team was resolved.
    expect(tables.actions).toHaveLength(0)
  })

  it("'explicit' still defaults silently when the user has exactly ONE workspace", async () => {
    const { supabase, tables } = makeDb({}, [WS_ACTIVE])
    const res = await run(tools(supabase, { policy: 'explicit' }).create_action, { title: 'Only one place to go' })

    expect(res.success).toBe(true)
    expect(tables.actions[0].workspace_id).toBe(WS_ACTIVE)
  })
})

describe('noTeamError names the workspace it looked in and asks for workspace_id', () => {
  it('points the agent at the create param, never at set_workspace', async () => {
    // A workspace with no team row: every workspace gets one by trigger, so an
    // empty result means the create is aimed at the wrong tenant.
    const { supabase } = makeDb({ team: teamRows([WS_ACTIVE]) })
    const res = await run(tools(supabase).create_action, { workspace_id: WS_OTHER, title: 'x' })

    expect(res.success).toBe(false)
    expect(res.error).toContain(WS_OTHER)
    expect(res.error).toMatch(/workspace_id/)
    expect(res.error).toMatch(/active_workspace/)
    // Switching the session would silently re-scope every later call in the turn.
    expect(res.error).not.toMatch(/set_workspace/i)
  })
})

describe('create_actions_batch — one resolution for the whole batch', () => {
  it('routes every row, and its team, to the explicit workspace', async () => {
    const { supabase, tables } = makeDb()
    const res = await run(tools(supabase).create_actions_batch, {
      workspace_id: WS_OTHER,
      actions: [{ title: 'One' }, { title: 'Two', assignee_name: 'Dana' }],
    })

    expect(res.success).toBe(true)
    expect(tables.actions).toHaveLength(2)
    expect(tables.actions.every((r) => r.workspace_id === WS_OTHER)).toBe(true)
    expect(tables.actions.every((r) => r.team_id === `team-${WS_OTHER}`)).toBe(true)
    expect(tables.actions.every((r) => r.status_id === `state-todo-${WS_OTHER}`)).toBe(true)
    expect(mockResolveMemberIdByName).toHaveBeenCalledWith(supabase, WS_OTHER, 'Dana')
    expect(res.workspace).toEqual({ id: WS_OTHER, name: 'Beta' })
  })

  it("refuses the whole batch under policy 'explicit' with no workspace_id", async () => {
    const { supabase, tables } = makeDb()
    const res = await run(tools(supabase, { policy: 'explicit' }).create_actions_batch, {
      actions: [{ title: 'One' }, { title: 'Two' }],
    })

    expect(res.error_type).toBe('needs_workspace')
    expect(tables.actions).toHaveLength(0)
  })

  it("'session' with no workspace_id still lands in the session workspace", async () => {
    const { supabase, tables, log } = makeDb()
    const res = await run(tools(supabase).create_actions_batch, { actions: [{ title: 'One' }] })

    expect(res.success).toBe(true)
    expect(tables.actions[0].workspace_id).toBe(WS_ACTIVE)
    expect(log.some((e) => e.table === 'member')).toBe(false)
  })
})

describe('create_label — the ROOT create that mis-files most quietly', () => {
  it('creates in the explicit workspace and echoes it', async () => {
    const { supabase, tables } = makeDb()
    const res = await run(tools(supabase).create_label, { workspace_id: WS_OTHER, name: 'Urgent' })

    expect(res.success).toBe(true)
    // Label names are unique per workspace, so a mis-filed duplicate never
    // collides — it just silently exists in the wrong tenant.
    expect(tables.label[0].workspace_id).toBe(WS_OTHER)
    expect(res.workspace).toEqual({ id: WS_OTHER, name: 'Beta' })
  })

  it('refuses a non-member workspace without inserting', async () => {
    const { supabase, tables } = makeDb()
    const res = await run(tools(supabase).create_label, { workspace_id: WS_STRANGER, name: 'Urgent' })

    expect(res).toEqual({ success: false, error: 'Workspace not found' })
    expect(tables.label).toHaveLength(0)
  })

  it("refuses under policy 'explicit' with no workspace_id", async () => {
    const { supabase, tables } = makeDb()
    const res = await run(tools(supabase, { policy: 'explicit' }).create_label, { name: 'Urgent' })

    expect(res.error_type).toBe('needs_workspace')
    expect(tables.label).toHaveLength(0)
  })
})

describe('update_label / delete_label — routed by the label’s own workspace', () => {
  const foreignLabel = () => ({ id: 'label-1', workspace_id: WS_OTHER, name: 'Old', color: '#000', group_name: null, scopes: null })

  it('renames a foreign-but-member label in ITS workspace', async () => {
    const { supabase, tables } = makeDb({ label: [foreignLabel()] })
    const res = await run(tools(supabase).update_label, { label_id: 'label-1', name: 'New' })

    expect(res.success).toBe(true)
    expect(tables.label[0].name).toBe('New')
  })

  it('is not-found for that same label under strictWorkspace, and changes nothing', async () => {
    const { supabase, tables } = makeDb({ label: [foreignLabel()] })
    const res = await run(tools(supabase, { strict: true }).update_label, { label_id: 'label-1', name: 'New' })

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not found/i)
    expect(tables.label[0].name).toBe('Old')
  })

  it('deletes a foreign-but-member label in ITS workspace', async () => {
    const { supabase, tables } = makeDb({ label: [foreignLabel()] })
    const res = await run(tools(supabase).delete_label, { label_id: 'label-1' })

    expect(res.success).toBe(true)
    expect(tables.label).toHaveLength(0)
  })

  it('keeps the no-op-success shape for an unreachable label instead of erroring', async () => {
    // Turning today's silent no-op into an error would tell the caller the id
    // exists somewhere it cannot reach.
    const { supabase, tables } = makeDb({ label: [foreignLabel()] })
    const res = await run(tools(supabase, { strict: true }).delete_label, { label_id: 'label-1' })

    expect(res).toEqual({ success: true, message: 'Label deleted' })
    expect(tables.label).toHaveLength(1)
  })
})

describe('dismiss_proposal / accept_proposal — routed by the proposal’s workspace', () => {
  const proposal = (over: Partial<Row> = {}): Row => ({
    id: 'prop-1',
    workspace_id: WS_OTHER,
    status: 'pending',
    display_text: 'Liam to follow up',
    change_type: 'create',
    entity_type: 'action',
    extra: null,
    ...over,
  })

  it('dismisses a foreign-but-member proposal in ITS workspace', async () => {
    const { supabase, tables, log } = makeDb({ proposed_change: [proposal()] })
    const res = await run(tools(supabase).dismiss_proposal, { proposal_id: 'prop-1', reason: 'stale' })

    expect(res.success).toBe(true)
    expect(tables.proposed_change[0].status).toBe('dismissed')
    // resolveEntityWorkspace's fast path looks in the session workspace first
    // (ws-1, the cheap "is it already here?" probe); every query the tool itself
    // then makes — the batch read AND the write — is scoped to WS_OTHER.
    expect(wsFiltersOn(log, 'proposed_change')).toEqual([WS_ACTIVE, WS_OTHER, WS_OTHER])
  })

  it('leaves a fenced run with the existing not-found shape and no write', async () => {
    const { supabase, tables } = makeDb({ proposed_change: [proposal()] })
    const res = await run(tools(supabase, { strict: true }).dismiss_proposal, { proposal_id: 'prop-1' })

    expect(res.success).toBe(false)
    expect(res.error).toBe('Proposal not found or already resolved')
    expect(tables.proposed_change[0].status).toBe('pending')
  })

  it('accepts a foreign proposal with the member id resolved IN that workspace', async () => {
    mockApplyChange.mockResolvedValueOnce({ success: true, entity_id: 'action-9' })
    const { supabase, tables, log } = makeDb({
      proposed_change: [proposal()],
      actions: [{ id: 'action-9', workspace_id: WS_OTHER, identifier: 'BETA-9', title: 'Follow up' }],
    })
    const res = await run(tools(supabase).accept_proposal, { proposal_id: 'prop-1' })

    expect(res.success).toBe(true)
    // The apply engine writes everything the proposal implies — it has to be
    // handed the proposal's workspace and a member row FROM it.
    expect(mockApplyChange).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ id: 'prop-1' }),
      WS_OTHER,
      `member-${WS_OTHER}`,
      USER_ID,
    )
    // Both `member` reads — the routing probe and the apply engine's member
    // lookup — asked about WS_OTHER. The session workspace is never consulted.
    expect(wsFiltersOn(log, 'member')).toEqual([WS_OTHER, WS_OTHER])
    expect(tables.proposed_change[0].status).toBe('applied')
    expect(res.workspace).toEqual({ id: WS_OTHER, name: null })
  })

  it('refuses to accept a foreign proposal under strictWorkspace, and never applies', async () => {
    const { supabase, tables } = makeDb({ proposed_change: [proposal()] })
    const res = await run(tools(supabase, { strict: true }).accept_proposal, { proposal_id: 'prop-1' })

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not found/i)
    expect(mockApplyChange).not.toHaveBeenCalled()
    expect(tables.proposed_change[0].status).toBe('pending')
  })
})

describe('workspace_id on update/complete/delete — answering the ambiguity up front', () => {
  /** The same identifier in two workspaces — the case that produces the
   *  'Pass action_id or workspace_id to disambiguate' refusal. */
  const twins = () => [
    { id: 'a-other', workspace_id: WS_OTHER, user_id: USER_ID, identifier: 'ENG-42', title: 'Beta work' },
    { id: 'a-third', workspace_id: WS_THIRD, user_id: USER_ID, identifier: 'ENG-42', title: 'Gamma work' },
  ]

  it('resolves an otherwise-ambiguous identifier in the named workspace, with no candidates refusal', async () => {
    const { supabase, tables } = makeDb({ actions: twins() })
    const res = await run(tools(supabase).update_action, {
      identifier: 'ENG-42',
      workspace_id: WS_THIRD,
      title: 'Renamed in Gamma',
    })

    expect(res.success).toBe(true)
    expect(tables.actions.find((a) => a.id === 'a-third')!.title).toBe('Renamed in Gamma')
    // …and only there: the twin in the other workspace is untouched.
    expect(tables.actions.find((a) => a.id === 'a-other')!.title).toBe('Beta work')
  })

  it('searches ONLY the named workspace — no active-first fast path, no fan-out', async () => {
    const localTwin = { id: 'a-local', workspace_id: WS_ACTIVE, user_id: USER_ID, identifier: 'ENG-42', title: 'Alpha work' }
    const { supabase, tables, log } = makeDb({ actions: [localTwin, ...twins()] })
    const res = await run(tools(supabase).update_action, {
      identifier: 'ENG-42',
      workspace_id: WS_THIRD,
      title: 'Renamed in Gamma',
    })

    expect(res.success).toBe(true)
    expect(tables.actions.find((a) => a.id === 'a-local')!.title).toBe('Alpha work')
    // The lookup never asked the active workspace, and never fanned out.
    expect(wsFiltersOn(log, 'actions')).not.toContain(WS_ACTIVE)
    expect(log.some((e) => e.op === 'in' && e.col === 'workspace_id')).toBe(false)
  })

  it('refuses a workspace the user is not a member of, and writes nothing', async () => {
    const { supabase, tables } = makeDb({ actions: twins() })
    const res = await run(tools(supabase).delete_action, {
      identifier: 'ENG-42',
      workspace_id: WS_STRANGER,
    })

    // The same flat shape the creates use — never a different reply for "exists
    // but not yours" than for "does not exist".
    expect(res).toEqual({ success: false, error: 'Workspace not found' })
    expect(tables.actions).toHaveLength(2)
  })

  it('is not-found under strictWorkspace, with NO member probe issued', async () => {
    const { supabase, tables, log } = makeDb({ actions: twins() })
    const res = await run(tools(supabase, { strict: true }).update_action, {
      identifier: 'ENG-42',
      workspace_id: WS_THIRD,
      title: 'Should not be written',
    })

    expect(res).toEqual({ success: false, error: 'Workspace not found' })
    expect(tables.actions.find((a) => a.id === 'a-third')!.title).toBe('Gamma work')
    expect(log.some((e) => e.table === 'member')).toBe(false)
  })

  it('ignores it when an action_id is given — the id already carries its workspace', async () => {
    const { supabase, tables } = makeDb({ actions: twins() })
    const res = await run(tools(supabase).update_action, {
      action_id: 'a-other',
      workspace_id: WS_THIRD, // contradicts the id, and must not be honoured
      title: 'Renamed by id',
    })

    expect(res.success).toBe(true)
    expect(tables.actions.find((a) => a.id === 'a-other')!.title).toBe('Renamed by id')
    expect(tables.actions.find((a) => a.id === 'a-third')!.title).toBe('Gamma work')
  })

  it('still refuses an ambiguous identifier when no workspace_id is given', async () => {
    const { supabase, tables } = makeDb({ actions: twins() })
    const res = await run(tools(supabase).update_action, { identifier: 'ENG-42', title: 'Nope' })

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/matches actions in 2 workspaces/)
    // The message names the param the tools now actually take.
    expect(res.error).toMatch(/Pass action_id or workspace_id to disambiguate/)
    expect(tables.actions.map((a) => a.title)).toEqual(['Beta work', 'Gamma work'])
  })
})

describe('reorder_actions — one ordering, one board', () => {
  const rowsIn = (ws: string, ids: string[]) =>
    ids.map((id, i) => ({ id, workspace_id: ws, user_id: USER_ID, sort_order: i }))

  it('reorders a list that lives entirely in another member workspace', async () => {
    const { supabase, tables } = makeDb({ actions: rowsIn(WS_OTHER, ['a', 'b']) })
    const res = await run(tools(supabase).reorder_actions, { action_ids: ['b', 'a'] })

    expect(res.success).toBe(true)
    expect(tables.actions.find((r) => r.id === 'b')!.sort_order).toBe(0)
    expect(tables.actions.find((r) => r.id === 'a')!.sort_order).toBe(1)
  })

  it('refuses a list spanning two workspaces and writes nothing', async () => {
    const { supabase, tables, log } = makeDb({
      actions: [...rowsIn(WS_OTHER, ['a']), ...rowsIn(WS_THIRD, ['z'])],
    })
    const res = await run(tools(supabase).reorder_actions, { action_ids: ['a', 'z'] })

    expect(res).toEqual({ success: false, error: 'Actions are in different workspaces' })
    // Names neither id nor workspace, and no sort_order moved.
    expect(log.some((e) => e.table === 'actions' && e.op === 'update')).toBe(false)
    expect(tables.actions.map((r) => r.sort_order)).toEqual([0, 0])
  })

  it('issues no cross-workspace spread probe under strictWorkspace', async () => {
    const { supabase, log } = makeDb({ actions: rowsIn(WS_OTHER, ['a', 'b']) })
    const res = await run(tools(supabase, { strict: true }).reorder_actions, { action_ids: ['b', 'a'] })

    // A fenced run sees foreign ids as absent — the same zero-row failure a
    // nonexistent id gets — rather than being told they exist elsewhere.
    expect(res).toEqual({ success: false, error: 'Failed to reorder 2 actions' })
    expect(log.some((e) => e.table === 'member')).toBe(false)
    expect(log.some((e) => e.op === 'in' && e.col === 'id')).toBe(false)
  })
})
