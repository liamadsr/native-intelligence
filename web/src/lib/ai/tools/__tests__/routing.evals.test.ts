/**
 * Workspace routing for the eval tools (src/lib/ai/tools/evals.ts).
 *
 * `create_eval_suite` is a ROOT create: with no `workspace_id` it lands in the
 * session workspace, an explicit foreign id routes there after a membership
 * check, and policy 'explicit' with several workspaces and no id refuses
 * rather than guessing. `create_eval_case` is PARENT-ANCHORED — it takes no
 * `workspace_id` of its own and instead routes by `suite_id`: a
 * foreign-but-member suite is fine, and under `strictWorkspace` the suite must
 * already be in the session workspace. `update_eval_case` and `start_eval_run`
 * route the same way, by `case_id` / `suite_id`.
 *
 * `createEvalCase`, `updateEvalCase` and `startEvalRun` are mocked (this file
 * tests ONLY which `workspaceId` reaches them — their own business rules are
 * covered by evals.test.ts). Reads and the suite insert run on a small
 * in-memory Supabase double (same shape as actions.workspace-routing.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  createEvalCase: vi.fn(),
  updateEvalCase: vi.fn(),
  startEvalRun: vi.fn(),
  serviceClient: { __service: true } as unknown,
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => hoisted.serviceClient }))
vi.mock('@/lib/evals/create-case', () => ({
  createEvalCase: hoisted.createEvalCase,
  updateEvalCase: hoisted.updateEvalCase,
}))
vi.mock('@/lib/evals/start-run', () => ({ startEvalRun: hoisted.startEvalRun }))

const { createEvalTools } = await import('../evals')

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

function tableChain(table: string, rows: Row[], log: LogEntry[]) {
  const preds: Array<(r: Row) => boolean> = []
  let mode: 'select' | 'insert' = 'select'
  let inserted: Row | null = null

  const chain: Record<string, unknown> = {}
  chain.select = () => chain
  chain.eq = (col: string, val: unknown) => {
    log.push({ table, col, val })
    preds.push((r) => r[col] === val)
    return chain
  }
  chain.insert = (payload: Row) => {
    mode = 'insert'
    inserted = { id: `${table}-${rows.length + 1}`, ...payload }
    return chain
  }
  const run = (): Row[] => {
    if (mode === 'insert' && inserted) {
      rows.push(inserted)
      return [inserted]
    }
    return rows.filter((r) => preds.every((p) => p(r)))
  }
  chain.single = async () => {
    const matched = run()
    return matched.length === 1 ? { data: matched[0], error: null } : { data: null, error: { message: 'no rows' } }
  }
  chain.maybeSingle = async () => ({ data: run()[0] ?? null, error: null })
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: run(), error: null }).then(resolve)
  return chain
}

function makeSupabase(opts: { suites?: Row[]; cases?: Row[]; memberOf: string[] }) {
  const suites = opts.suites ?? []
  const cases = opts.cases ?? []
  const members = memberRows(opts.memberOf)
  const log: LogEntry[] = []
  const from = (table: string) => {
    if (table === 'eval_suite') return tableChain('eval_suite', suites, log)
    if (table === 'eval_case') return tableChain('eval_case', cases, log)
    if (table === 'member') return tableChain('member', members, log)
    return tableChain(table, [], log)
  }
  return { supabase: { from } as never, suites, cases, log }
}

const SCRIPT = [
  { t_ms: 0, speaker: 'local_1', stream: 'mic' as const, text: 'hey there' },
  { t_ms: 4000, speaker: 'remote_1', stream: 'system' as const, text: 'hi, thanks for calling' },
]
const PARTICIPANTS = [
  { speaker_label: 'local_1', display: 'Sam', is_self: true },
  { speaker_label: 'remote_1', display: 'Dana' },
]
const EXPECTED = { summary: 'Says hello.' }

const CASE_ROW = { id: 'case-1', suite_id: 'suite-1', name: 'Case', chunks: [] }

const run = (t: { execute?: unknown }, args: Record<string, unknown>) =>
  (t as { execute: (a: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(args, {} as never)

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.createEvalCase.mockResolvedValue(CASE_ROW)
  hoisted.updateEvalCase.mockResolvedValue(CASE_ROW)
  hoisted.startEvalRun.mockResolvedValue({
    run: { id: 'run-1', status: 'queued', mode: 'batch' },
    adopted: false,
    estimated_cost_usd: 0.1,
  })
})

describe('create_eval_suite — workspace routing', () => {
  it('(a) explicit foreign workspace_id while a member — insert carries it', async () => {
    const { supabase, suites } = makeSupabase({ memberOf: [WS_ACTIVE, WS_OTHER] })
    const tools = createEvalTools(USER_ID, supabase, WS_ACTIVE)
    const res = await run(tools.create_eval_suite, {
      name: 'Sales Discovery',
      target_kind: 'skill',
      workspace_id: WS_OTHER,
    })

    expect(res).toMatchObject({ success: true, workspace: { id: WS_OTHER, name: 'Engineering' } })
    expect(suites).toHaveLength(1)
    expect(suites[0].workspace_id).toBe(WS_OTHER)
  })

  it('(b) explicit non-member workspace_id — "Workspace not found", no insert', async () => {
    const { supabase, suites } = makeSupabase({ memberOf: [WS_ACTIVE] })
    const tools = createEvalTools(USER_ID, supabase, WS_ACTIVE)
    const res = await run(tools.create_eval_suite, {
      name: 'Sales Discovery',
      target_kind: 'skill',
      workspace_id: WS_OTHER,
    })

    expect(res).toEqual({ success: false, error: 'Workspace not found' })
    expect(suites).toHaveLength(0)
  })

  it("(c) policy 'explicit', 2+ workspaces, no id — needs_workspace, no insert", async () => {
    const { supabase, suites } = makeSupabase({ memberOf: [WS_ACTIVE, WS_OTHER, WS_THIRD] })
    const tools = createEvalTools(USER_ID, supabase, WS_ACTIVE, false, 'explicit')
    const res = await run(tools.create_eval_suite, { name: 'Sales Discovery', target_kind: 'skill' })

    expect(res).toMatchObject({ success: false, error_type: 'needs_workspace' })
    expect(suites).toHaveLength(0)
  })

  it("(d) policy 'session', no id — lands in the session workspace, unchanged call chain", async () => {
    const { supabase, suites, log } = makeSupabase({ memberOf: [WS_ACTIVE, WS_OTHER, WS_THIRD] })
    const tools = createEvalTools(USER_ID, supabase, WS_ACTIVE)
    const res = await run(tools.create_eval_suite, { name: 'Sales Discovery', target_kind: 'skill' })

    expect(res).toMatchObject({ success: true, workspace: { id: WS_ACTIVE, name: null } })
    expect(suites[0].workspace_id).toBe(WS_ACTIVE)
    expect(log.some((e) => e.table === 'member')).toBe(false)
  })

  it('(e) strictWorkspace + explicit foreign workspace_id — not found, no member probe', async () => {
    const { supabase, suites, log } = makeSupabase({ memberOf: [WS_ACTIVE, WS_OTHER] })
    const tools = createEvalTools(USER_ID, supabase, WS_ACTIVE, true)
    const res = await run(tools.create_eval_suite, {
      name: 'Sales Discovery',
      target_kind: 'skill',
      workspace_id: WS_OTHER,
    })

    expect(res).toEqual({ success: false, error: 'Workspace not found' })
    expect(suites).toHaveLength(0)
    expect(log.some((e) => e.table === 'member')).toBe(false)
  })
})

describe('create_eval_case — parent-anchored routing', () => {
  const SUITE_IN_OTHER = { id: 'suite-1', workspace_id: WS_OTHER }

  it('foreign-but-member suite_id — routed to the SUITE\'s own workspace', async () => {
    const { supabase } = makeSupabase({ suites: [SUITE_IN_OTHER], memberOf: [WS_ACTIVE, WS_OTHER] })
    const tools = createEvalTools(USER_ID, supabase, WS_ACTIVE)
    const res = await run(tools.create_eval_case, {
      suite_id: 'suite-1',
      name: 'Case one',
      script: SCRIPT,
      participants: PARTICIPANTS,
      expected: EXPECTED,
    })

    expect(res).toMatchObject({ success: true })
    expect(hoisted.createEvalCase).toHaveBeenCalledWith(
      hoisted.serviceClient,
      expect.objectContaining({ workspaceId: WS_OTHER, suiteId: 'suite-1' }),
    )
  })

  it('under strictWorkspace, the parent must already be in the session workspace — not found, no create', async () => {
    const { supabase } = makeSupabase({ suites: [SUITE_IN_OTHER], memberOf: [WS_ACTIVE, WS_OTHER] })
    const tools = createEvalTools(USER_ID, supabase, WS_ACTIVE, true)
    const res = await run(tools.create_eval_case, {
      suite_id: 'suite-1',
      name: 'Case one',
      script: SCRIPT,
      participants: PARTICIPANTS,
      expected: EXPECTED,
    })

    expect(res).toEqual({ success: false, error: 'Suite not found in this workspace' })
    expect(hoisted.createEvalCase).not.toHaveBeenCalled()
  })
})

describe('update_eval_case — workspace routing', () => {
  const CASE_IN_OTHER = { id: 'case-1', suite_id: 'suite-1', workspace_id: WS_OTHER }

  it('foreign-but-member case_id — routed to the CASE\'s own workspace', async () => {
    const { supabase } = makeSupabase({ cases: [CASE_IN_OTHER], memberOf: [WS_ACTIVE, WS_OTHER] })
    const tools = createEvalTools(USER_ID, supabase, WS_ACTIVE)
    const res = await run(tools.update_eval_case, { case_id: 'case-1', name: 'Renamed' })

    expect(res).toMatchObject({ success: true })
    expect(hoisted.updateEvalCase).toHaveBeenCalledWith(
      hoisted.serviceClient,
      expect.objectContaining({ caseId: 'case-1', workspaceId: WS_OTHER }),
    )
  })

  it('is not-found under strictWorkspace, and update is never called', async () => {
    const { supabase } = makeSupabase({ cases: [CASE_IN_OTHER], memberOf: [WS_ACTIVE, WS_OTHER] })
    const tools = createEvalTools(USER_ID, supabase, WS_ACTIVE, true)
    const res = await run(tools.update_eval_case, { case_id: 'case-1', name: 'Renamed' })

    expect(res).toEqual({ success: false, error: 'Case not found in this workspace' })
    expect(hoisted.updateEvalCase).not.toHaveBeenCalled()
  })
})

describe('start_eval_run — workspace routing (by suite)', () => {
  const SUITE_IN_OTHER = { id: 'suite-1', workspace_id: WS_OTHER }

  it('foreign-but-member suite_id — the run is started against ITS workspace', async () => {
    const { supabase } = makeSupabase({ suites: [SUITE_IN_OTHER], memberOf: [WS_ACTIVE, WS_OTHER] })
    const tools = createEvalTools(USER_ID, supabase, WS_ACTIVE)
    const res = await run(tools.start_eval_run, { suite_id: 'suite-1', mode: 'batch' })

    expect(res).toMatchObject({ success: true, run_id: 'run-1' })
    expect(hoisted.startEvalRun).toHaveBeenCalledWith(
      hoisted.serviceClient,
      expect.objectContaining({ workspaceId: WS_OTHER, suiteId: 'suite-1' }),
    )
  })

  it('is not-found under strictWorkspace, and no run is started', async () => {
    const { supabase } = makeSupabase({ suites: [SUITE_IN_OTHER], memberOf: [WS_ACTIVE, WS_OTHER] })
    const tools = createEvalTools(USER_ID, supabase, WS_ACTIVE, true)
    const res = await run(tools.start_eval_run, { suite_id: 'suite-1', mode: 'batch' })

    expect(res).toEqual({ success: false, error: 'Suite not found in this workspace' })
    expect(hoisted.startEvalRun).not.toHaveBeenCalled()
  })
})
