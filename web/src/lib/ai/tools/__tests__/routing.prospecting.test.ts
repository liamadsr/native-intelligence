/**
 * Workspace routing for the prospecting tools (src/lib/ai/tools/prospecting.ts).
 *
 * `create_prospect_list` is a ROOT create: with no `workspace_id` it lands in
 * the session workspace, an explicit foreign id routes there after a
 * membership check, and policy 'explicit' with several workspaces and no id
 * refuses rather than guessing. Every other tool here routes by an id it was
 * already given:
 *   - `update_prospect_list`, `publish_prospect_list`, `run_prospect_discovery`
 *     (representative of the run-starting tools) resolve by `list_id`;
 *   - `cancel_prospecting_run` resolves by `run_id`;
 *   - `save_prospect_entries` and `dismiss_prospect_entries` have no list_id to
 *     anchor on, so each `entry_id` is resolved INDIVIDUALLY.
 *
 * The prospecting LIB is mocked wholesale (same style as prospecting.test.ts)
 * — this file tests ONLY which `workspaceId` reaches those lib calls, not
 * their own business rules. The routing resolve itself runs on a small
 * in-memory Supabase double (same shape as actions.workspace-routing.test.ts),
 * so a routing bug would genuinely read the wrong row here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  getServiceClient: vi.fn(),
  establishAndResearchSourceCompany: vi.fn(),
  createList: vi.fn(),
  updateList: vi.fn(),
  listEntries: vi.fn(),
  listLists: vi.fn(),
  promoteEntries: vi.fn(),
  saveEntriesToList: vi.fn(),
  updateEntryStage: vi.fn(),
  publishEntries: vi.fn(),
  publishList: vi.fn(),
  createRun: vi.fn(),
  getRun: vi.fn(),
  listRuns: vi.fn(),
  listRunCandidates: vi.fn(),
  requestCancel: vi.fn(),
  resolveSourceCompany: vi.fn(),
  suggestedDomainFor: vi.fn(),
}))

vi.mock('@/lib/admin', () => ({ getServiceClient: hoisted.getServiceClient }))
vi.mock('@/lib/prospecting/establish', () => ({
  establishAndResearchSourceCompany: hoisted.establishAndResearchSourceCompany,
}))
vi.mock('@/lib/prospecting/lists', () => ({
  createList: hoisted.createList,
  updateList: hoisted.updateList,
  listEntries: hoisted.listEntries,
  listLists: hoisted.listLists,
  promoteEntries: hoisted.promoteEntries,
  saveEntriesToList: hoisted.saveEntriesToList,
  updateEntryStage: hoisted.updateEntryStage,
}))
vi.mock('@/lib/prospecting/publish', () => ({
  publishEntries: hoisted.publishEntries,
  publishList: hoisted.publishList,
}))
vi.mock('@/lib/prospecting/runs', () => ({
  createRun: hoisted.createRun,
  getRun: hoisted.getRun,
  listRuns: hoisted.listRuns,
  listRunCandidates: hoisted.listRunCandidates,
  requestCancel: hoisted.requestCancel,
}))
vi.mock('@/lib/prospecting/source-company', () => ({
  resolveSourceCompany: hoisted.resolveSourceCompany,
  suggestedDomainFor: hoisted.suggestedDomainFor,
}))

const { createProspectingTools } = await import('../prospecting')

const USER_ID = 'user-1'
const WS_ACTIVE = 'ws-1'
const WS_OTHER = 'ws-2'
const WS_THIRD = 'ws-3'

const WORKSPACES = [
  { id: WS_ACTIVE, name: 'Dial8 Marketing' },
  { id: WS_OTHER, name: 'Engineering' },
  { id: WS_THIRD, name: 'Personal' },
]

type Row = Record<string, unknown>
type LogEntry = { table: string; col?: string; val?: unknown }

function memberRows(memberOf: string[]): Row[] {
  return memberOf.map((id) => ({
    id: `member-${id}`,
    user_id: USER_ID,
    workspace_id: id,
    workspace: WORKSPACES.find((w) => w.id === id) ?? { id, name: id },
  }))
}

/** Read-only chainable table double — every routing resolve here is a SELECT,
 *  the actual writes all go through the mocked lib functions. */
function tableChain(table: string, rows: Row[], log: LogEntry[]) {
  const preds: Array<(r: Row) => boolean> = []
  const chain: Record<string, unknown> = {}
  chain.select = () => chain
  chain.eq = (col: string, val: unknown) => {
    log.push({ table, col, val })
    preds.push((r) => r[col] === val)
    return chain
  }
  chain.maybeSingle = async () => {
    const matched = rows.filter((r) => preds.every((p) => p(r)))
    return { data: matched[0] ?? null, error: null }
  }
  // getUserWorkspaces (policy 'explicit' with no id) awaits the query builder
  // directly rather than calling .maybeSingle() — it wants every membership
  // row, not one.
  chain.then = (resolve: (v: unknown) => unknown) => {
    const matched = rows.filter((r) => preds.every((p) => p(r)))
    return Promise.resolve({ data: matched, error: null }).then(resolve)
  }
  return chain
}

function makeSupabase(opts: {
  lists?: Row[]
  entries?: Row[]
  runs?: Row[]
  memberOf: string[]
}) {
  const lists = opts.lists ?? []
  const entries = opts.entries ?? []
  const runs = opts.runs ?? []
  const members = memberRows(opts.memberOf)
  const log: LogEntry[] = []
  const from = (table: string) => {
    if (table === 'prospect_list') return tableChain('prospect_list', lists, log)
    if (table === 'prospect_list_entry') return tableChain('prospect_list_entry', entries, log)
    if (table === 'prospecting_run') return tableChain('prospecting_run', runs, log)
    if (table === 'member') return tableChain('member', members, log)
    return tableChain(table, [], log)
  }
  return { supabase: { from } as never, log }
}

const run = (t: { execute?: unknown }, args: Record<string, unknown>) =>
  (t as { execute: (a: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(args, {} as never)

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.listRuns.mockResolvedValue({ ok: true, runs: [] })
})

describe('create_prospect_list — workspace routing', () => {
  const LIST_ROW = { id: 'list-1', name: 'Series A fintechs', purpose: 'buyers', icp: {}, max_rounds: 2, target_new_candidates: 20, people_per_company: 3 }

  beforeEach(() => {
    hoisted.createList.mockResolvedValue({ ok: true, list: LIST_ROW })
  })

  it('(a) explicit foreign workspace_id while a member — createList is called with it', async () => {
    const { supabase } = makeSupabase({ memberOf: [WS_ACTIVE, WS_OTHER] })
    const tools = createProspectingTools(USER_ID, supabase, WS_ACTIVE)
    const res = await run(tools.create_prospect_list, { name: 'Series A fintechs', workspace_id: WS_OTHER })

    expect(res).toMatchObject({ success: true, workspace: { id: WS_OTHER, name: 'Engineering' } })
    expect(hoisted.createList).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ workspaceId: WS_OTHER, userId: USER_ID }),
    )
  })

  it('(b) explicit non-member workspace_id — "Workspace not found", createList never called', async () => {
    const { supabase } = makeSupabase({ memberOf: [WS_ACTIVE] })
    const tools = createProspectingTools(USER_ID, supabase, WS_ACTIVE)
    const res = await run(tools.create_prospect_list, { name: 'Series A fintechs', workspace_id: WS_OTHER })

    expect(res).toEqual({ success: false, error: 'Workspace not found' })
    expect(hoisted.createList).not.toHaveBeenCalled()
  })

  it("(c) policy 'explicit', 2+ workspaces, no id — needs_workspace, createList never called", async () => {
    const { supabase } = makeSupabase({ memberOf: [WS_ACTIVE, WS_OTHER, WS_THIRD] })
    const tools = createProspectingTools(USER_ID, supabase, WS_ACTIVE, false, 'explicit')
    const res = await run(tools.create_prospect_list, { name: 'Series A fintechs' })

    expect(res).toMatchObject({ success: false, error_type: 'needs_workspace' })
    expect(hoisted.createList).not.toHaveBeenCalled()
  })

  it("(d) policy 'session', no id — lands in the session workspace, unchanged call chain", async () => {
    const { supabase, log } = makeSupabase({ memberOf: [WS_ACTIVE, WS_OTHER, WS_THIRD] })
    const tools = createProspectingTools(USER_ID, supabase, WS_ACTIVE)
    const res = await run(tools.create_prospect_list, { name: 'Series A fintechs' })

    expect(res).toMatchObject({ success: true, workspace: { id: WS_ACTIVE, name: null } })
    expect(hoisted.createList).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ workspaceId: WS_ACTIVE }),
    )
    expect(log.some((e) => e.table === 'member')).toBe(false)
  })

  it('(e) strictWorkspace + explicit foreign workspace_id — not found, no member probe', async () => {
    const { supabase, log } = makeSupabase({ memberOf: [WS_ACTIVE, WS_OTHER] })
    const tools = createProspectingTools(USER_ID, supabase, WS_ACTIVE, true)
    const res = await run(tools.create_prospect_list, { name: 'Series A fintechs', workspace_id: WS_OTHER })

    expect(res).toEqual({ success: false, error: 'Workspace not found' })
    expect(hoisted.createList).not.toHaveBeenCalled()
    expect(log.some((e) => e.table === 'member')).toBe(false)
  })
})

describe('update_prospect_list — workspace routing (by list_id)', () => {
  const LIST_IN_OTHER = { id: 'list-1', workspace_id: WS_OTHER }

  it('foreign-but-member list_id — updateList is called with ITS workspace', async () => {
    const { supabase } = makeSupabase({ lists: [LIST_IN_OTHER], memberOf: [WS_ACTIVE, WS_OTHER] })
    hoisted.updateList.mockResolvedValue({
      ok: true,
      list: { id: 'list-1', name: 'Renamed', icp: {}, icp_version: 1, status: 'active' },
      icp_version_bumped: false,
    })
    const tools = createProspectingTools(USER_ID, supabase, WS_ACTIVE)
    const res = await run(tools.update_prospect_list, { list_id: 'list-1', name: 'Renamed' })

    expect(res).toMatchObject({ success: true })
    expect(hoisted.updateList).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ workspaceId: WS_OTHER, listId: 'list-1' }),
    )
  })

  it('is not-found under strictWorkspace, and updateList is never called', async () => {
    const { supabase } = makeSupabase({ lists: [LIST_IN_OTHER], memberOf: [WS_ACTIVE, WS_OTHER] })
    const tools = createProspectingTools(USER_ID, supabase, WS_ACTIVE, true)
    const res = await run(tools.update_prospect_list, { list_id: 'list-1', name: 'Renamed' })

    expect(res).toEqual({ success: false, error: 'List not found', code: 'NOT_FOUND' })
    expect(hoisted.updateList).not.toHaveBeenCalled()
  })
})

describe('publish_prospect_list — workspace routing (by list_id)', () => {
  const LIST_IN_OTHER = { id: 'list-1', workspace_id: WS_OTHER }

  it('foreign-but-member list_id — publishList is called with ITS workspace', async () => {
    const { supabase } = makeSupabase({ lists: [LIST_IN_OTHER], memberOf: [WS_ACTIVE, WS_OTHER] })
    hoisted.publishList.mockResolvedValue({
      ok: true,
      saved: [],
      skipped: [],
      published_at: '2026-09-17T00:00:00Z',
      list_name: 'Series A fintechs',
    })
    const tools = createProspectingTools(USER_ID, supabase, WS_ACTIVE)
    const res = await run(tools.publish_prospect_list, {
      list_id: 'list-1',
      confirmed_with_user: true,
    })

    expect(res).toMatchObject({ success: true, published: true })
    expect(hoisted.publishList).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ workspaceId: WS_OTHER, listId: 'list-1' }),
    )
  })

  it('is not-found under strictWorkspace, and nothing is published', async () => {
    const { supabase } = makeSupabase({ lists: [LIST_IN_OTHER], memberOf: [WS_ACTIVE, WS_OTHER] })
    const tools = createProspectingTools(USER_ID, supabase, WS_ACTIVE, true)
    const res = await run(tools.publish_prospect_list, {
      list_id: 'list-1',
      confirmed_with_user: true,
    })

    expect(res).toEqual({ success: false, error: 'List not found', code: 'NOT_FOUND' })
    expect(hoisted.publishList).not.toHaveBeenCalled()
    expect(hoisted.publishEntries).not.toHaveBeenCalled()
  })
})

describe('run_prospect_discovery — workspace routing (by list_id)', () => {
  const LIST_IN_OTHER = { id: 'list-1', workspace_id: WS_OTHER }

  it('foreign-but-member list_id — createRun is called with ITS workspace', async () => {
    const { supabase } = makeSupabase({ lists: [LIST_IN_OTHER], memberOf: [WS_ACTIVE, WS_OTHER] })
    hoisted.createRun.mockResolvedValue({
      ok: true,
      run: {
        id: 'run-1',
        list_id: 'list-1',
        kind: 'discover',
        status: 'queued',
        stage: 'discover',
        round_index: 1,
        progress: {},
        counts: {},
        error: null,
        is_live: true,
      },
    })
    const tools = createProspectingTools(USER_ID, supabase, WS_ACTIVE)
    const res = await run(tools.run_prospect_discovery, {
      list_id: 'list-1',
      confirmed_with_user: true,
    })

    expect(res).toMatchObject({ success: true })
    expect(hoisted.createRun).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ workspaceId: WS_OTHER, listId: 'list-1' }),
    )
  })

  it('is not-found under strictWorkspace, and no run is created', async () => {
    const { supabase } = makeSupabase({ lists: [LIST_IN_OTHER], memberOf: [WS_ACTIVE, WS_OTHER] })
    const tools = createProspectingTools(USER_ID, supabase, WS_ACTIVE, true)
    const res = await run(tools.run_prospect_discovery, {
      list_id: 'list-1',
      confirmed_with_user: true,
    })

    expect(res).toEqual({ success: false, error: 'List not found', code: 'NOT_FOUND' })
    expect(hoisted.createRun).not.toHaveBeenCalled()
  })
})

describe('cancel_prospecting_run — workspace routing (by run_id)', () => {
  const RUN_IN_OTHER = { id: 'run-1', workspace_id: WS_OTHER, list_id: 'list-1' }

  it('foreign-but-member run_id — requestCancel is called with ITS workspace', async () => {
    const { supabase } = makeSupabase({ runs: [RUN_IN_OTHER], memberOf: [WS_ACTIVE, WS_OTHER] })
    hoisted.requestCancel.mockResolvedValue({
      ok: true,
      run: {
        id: 'run-1',
        list_id: 'list-1',
        kind: 'discover',
        status: 'canceling',
        stage: 'discover',
        round_index: 1,
        progress: {},
        counts: {},
        error: null,
        is_live: true,
      },
    })
    const tools = createProspectingTools(USER_ID, supabase, WS_ACTIVE)
    const res = await run(tools.cancel_prospecting_run, { run_id: 'run-1' })

    expect(res).toMatchObject({ success: true })
    expect(hoisted.requestCancel).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ workspaceId: WS_OTHER, runId: 'run-1' }),
    )
  })

  it('is not-found under strictWorkspace, and requestCancel is never called', async () => {
    const { supabase } = makeSupabase({ runs: [RUN_IN_OTHER], memberOf: [WS_ACTIVE, WS_OTHER] })
    const tools = createProspectingTools(USER_ID, supabase, WS_ACTIVE, true)
    const res = await run(tools.cancel_prospecting_run, { run_id: 'run-1' })

    expect(res).toEqual({ success: false, error: 'Run not found', code: 'NOT_FOUND' })
    expect(hoisted.requestCancel).not.toHaveBeenCalled()
  })
})

describe('save_prospect_entries — workspace routing (per entry, no list_id to anchor on)', () => {
  const ENTRY_IN_OTHER = { id: 'e-1', workspace_id: WS_OTHER, list_id: 'list-1' }

  it('foreign-but-member entry_id — saveEntriesToList is called with ITS workspace', async () => {
    const { supabase } = makeSupabase({ entries: [ENTRY_IN_OTHER], memberOf: [WS_ACTIVE, WS_OTHER] })
    hoisted.saveEntriesToList.mockResolvedValue({
      ok: true,
      saved: [{ entry_id: 'e-1', list_id: 'list-1', kind: 'company' }],
      skipped: [],
    })
    const tools = createProspectingTools(USER_ID, supabase, WS_ACTIVE)
    const res = await run(tools.save_prospect_entries, { entry_ids: ['e-1'] })

    expect(res).toMatchObject({ success: true, saved_count: 1 })
    expect(hoisted.saveEntriesToList).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ workspaceId: WS_OTHER, entryIds: ['e-1'] }),
    )
  })

  it('under strictWorkspace, a foreign-but-member entry is reported not_found and saveEntriesToList is never called', async () => {
    const { supabase } = makeSupabase({ entries: [ENTRY_IN_OTHER], memberOf: [WS_ACTIVE, WS_OTHER] })
    const tools = createProspectingTools(USER_ID, supabase, WS_ACTIVE, true)
    const res = await run(tools.save_prospect_entries, { entry_ids: ['e-1'] })

    expect(res).toMatchObject({
      success: true,
      saved_count: 0,
      skipped: [{ entry_id: 'e-1', list_id: '', reason: 'not_found' }],
    })
    expect(hoisted.saveEntriesToList).not.toHaveBeenCalled()
  })
})

describe('dismiss_prospect_entries — workspace routing (per entry, no list_id to anchor on)', () => {
  const ENTRY_IN_OTHER = { id: 'e-1', workspace_id: WS_OTHER, list_id: 'list-1' }

  it('foreign-but-member entry_id — updateEntryStage is called with ITS workspace', async () => {
    const { supabase } = makeSupabase({ entries: [ENTRY_IN_OTHER], memberOf: [WS_ACTIVE, WS_OTHER] })
    hoisted.updateEntryStage.mockResolvedValue({
      ok: true,
      entry: { id: 'e-1', list_id: 'list-1' },
    })
    const tools = createProspectingTools(USER_ID, supabase, WS_ACTIVE)
    const res = await run(tools.dismiss_prospect_entries, {
      entry_ids: ['e-1'],
      reason: 'not_a_fit',
      confirmed_with_user: true,
    })

    expect(res).toMatchObject({ success: true, updated: 1 })
    expect(hoisted.updateEntryStage).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ workspaceId: WS_OTHER, entryId: 'e-1' }),
    )
  })

  it('is "Entry not found" under strictWorkspace, and updateEntryStage is never called', async () => {
    const { supabase } = makeSupabase({ entries: [ENTRY_IN_OTHER], memberOf: [WS_ACTIVE, WS_OTHER] })
    const tools = createProspectingTools(USER_ID, supabase, WS_ACTIVE, true)
    const res = await run(tools.dismiss_prospect_entries, {
      entry_ids: ['e-1'],
      reason: 'not_a_fit',
      confirmed_with_user: true,
    })

    expect(res).toMatchObject({
      success: false,
      failed: [{ entry_id: 'e-1', ok: false, error: 'Entry not found' }],
    })
    expect(hoisted.updateEntryStage).not.toHaveBeenCalled()
  })
})

describe('list_prospect_entries / get_prospecting_run_candidates — routed like the run tools', () => {
  it('foreign-but-member list_id — listEntries is called with ITS workspace', async () => {
    const { supabase } = makeSupabase({
      lists: [{ id: 'list-1', workspace_id: WS_OTHER }],
      memberOf: [WS_ACTIVE, WS_OTHER],
    })
    hoisted.listEntries.mockResolvedValue({ ok: true, entries: [], counts: {} })
    const tools = createProspectingTools(USER_ID, supabase, WS_ACTIVE)
    const res = await run(tools.list_prospect_entries, { list_id: 'list-1' })

    expect(res).toMatchObject({ success: true })
    expect(hoisted.listEntries).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ workspaceId: WS_OTHER, listId: 'list-1' }),
    )
  })

  it('foreign-but-member run_id — listRunCandidates is called with ITS workspace', async () => {
    const { supabase } = makeSupabase({
      runs: [{ id: 'run-1', workspace_id: WS_OTHER, list_id: 'list-1' }],
      memberOf: [WS_ACTIVE, WS_OTHER],
    })
    hoisted.listRunCandidates.mockResolvedValue({
      ok: true,
      run: { id: 'run-1', list_id: 'list-1', status: 'completed', counts: {} },
      total: 0,
      groups: [],
    })
    const tools = createProspectingTools(USER_ID, supabase, WS_ACTIVE)
    const res = await run(tools.get_prospecting_run_candidates, { run_id: 'run-1' })

    expect(res).toMatchObject({ success: true })
    expect(hoisted.listRunCandidates).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ workspaceId: WS_OTHER, runId: 'run-1' }),
    )
  })

  it('a foreign run is not-found under strictWorkspace, and nothing is read', async () => {
    const { supabase } = makeSupabase({
      runs: [{ id: 'run-1', workspace_id: WS_OTHER, list_id: 'list-1' }],
      memberOf: [WS_ACTIVE, WS_OTHER],
    })
    const tools = createProspectingTools(USER_ID, supabase, WS_ACTIVE, true)
    const res = await run(tools.get_prospecting_run_candidates, { run_id: 'run-1' })

    expect(res).toEqual({ success: false, error: 'Run not found', code: 'NOT_FOUND' })
    expect(hoisted.listRunCandidates).not.toHaveBeenCalled()
  })
})
