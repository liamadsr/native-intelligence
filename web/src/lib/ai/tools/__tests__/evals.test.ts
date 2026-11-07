/**
 * Tests for the eval-authoring chat tools in evals.ts — the tool surface behind
 * the /create-eval system skill (migration 253).
 *
 * Invariants locked in:
 *  - Every name classifies read-or-mutate with NO tool-registry allowlist edit.
 *    That is the whole reason the verbs are `create_`/`update_`/`start_` and
 *    `list_`/`get_`: `run_eval` would have matched neither pattern and silently
 *    escaped report mode. This test is the thing that makes a rename fail loudly.
 *  - Reads run on the CALLER's client; the three capture-touching writes run on
 *    the SERVICE client, and only AFTER a workspace-membership read on the
 *    caller's own client. A tool that skipped that read would let any workspace
 *    id reach a service-role write.
 *  - `start_eval_run` never accepts a capture id, and surfaces `adopted` rather
 *    than reporting a second run it did not start.
 *  - `get_eval_run` refuses a run from another workspace and never pulls a
 *    trace unless one was asked for by case_id.
 *  - Script/participant coherence is checked BEFORE any write: a speaker with
 *    no participant entry, or zero/two `is_self`, is an authoring mistake worth
 *    a message rather than a mock meeting nobody can grade.
 *
 * Vitest unit tests (no network, no DB). Run via `npm test`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { visibleRecipesFilter } from '@/lib/library/visibility'
import {
  ALL_TOOL_NAMES,
  REPORT_MODE_WRITE_ALLOWLIST,
  getMutatingToolNames,
  isReadShapedToolName,
} from '@/lib/ai/tool-registry'

const USER_ID = 'user-uuid-1'
const WORKSPACE_ID = 'workspace-uuid-1'
const SUITE_ID = 'suite-uuid-1'
const CASE_ID = 'case-uuid-1'
const RUN_ID = 'run-uuid-1'

const EXEC_OPTS = {
  toolCallId: 'test-call-id',
  messages: [],
  context: {},
} satisfies ToolExecutionOptions<Record<string, unknown>>

/**
 * The evals lib is mocked wholesale: `createEvalCase` writes a capture, its
 * participants and a conversation row across four tables, and this file is
 * testing the TOOL layer — argument validation, which client each call lands
 * on, and the shape handed back. The lib's own behavior has its own tests in
 * src/lib/evals/__tests__/.
 */
const hoisted = vi.hoisted(() => ({
  serviceClient: { __service: true } as unknown,
  createEvalCase: vi.fn(),
  updateEvalCase: vi.fn(),
  startEvalRun: vi.fn(),
  listSuites: vi.fn(),
  listCases: vi.fn(),
  getRunDetail: vi.fn(),
  latestCompletedRun: vi.fn(),
}))

vi.mock('@/lib/admin', () => ({ getServiceClient: () => hoisted.serviceClient }))
vi.mock('@/lib/evals/create-case', () => ({
  createEvalCase: hoisted.createEvalCase,
  updateEvalCase: hoisted.updateEvalCase,
}))
vi.mock('@/lib/evals/start-run', () => ({ startEvalRun: hoisted.startEvalRun }))
vi.mock('@/lib/evals/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/evals/queries')>()
  return {
    ...actual,
    listSuites: hoisted.listSuites,
    listCases: hoisted.listCases,
    getRunDetail: hoisted.getRunDetail,
    latestCompletedRun: hoisted.latestCompletedRun,
  }
})

const { createEvalTools } = await import('../evals')

// ---------------------------------------------------------------------------
// A recording caller-side client. The tools only use it for membership reads
// and the suite insert, so a sequence of results plus captured payloads is
// enough — and the CAPTURED FILTERS are the point: a membership read that
// forgot `.eq('workspace_id', …)` is the bug this shape can see.
// ---------------------------------------------------------------------------

type Result = { data: unknown; error: { message: string } | null }

interface Captured {
  table: string
  op: 'select' | 'insert'
  payload?: Record<string, unknown>
  filters: Array<{ method: string; args: unknown[] }>
}

function callerMock(sequence: Result[]) {
  const queries: Captured[] = []
  let i = 0
  const next = () => sequence[Math.min(i++, sequence.length - 1)] ?? { data: null, error: null }

  function from(table: string) {
    const q: Captured = { table, op: 'select', filters: [] }
    queries.push(q)
    const b: Record<string, unknown> = {}
    const chain =
      (name: string) =>
      (...args: unknown[]) => {
        q.filters.push({ method: name, args })
        return b
      }
    const settle = async () => next()
    Object.assign(b, {
      select: chain('select'),
      insert: (payload: Record<string, unknown>) => {
        q.op = 'insert'
        q.payload = payload
        return b
      },
      eq: chain('eq'),
      or: chain('or'),
      neq: chain('neq'),
      in: chain('in'),
      order: chain('order'),
      limit: chain('limit'),
      single: settle,
      maybeSingle: settle,
      then: (resolve: (r: Result) => unknown) => settle().then(resolve),
    })
    return b
  }

  return { supabase: { from } as unknown, queries }
}

function tools(supabase: unknown) {
  return createEvalTools(USER_ID, supabase as never, WORKSPACE_ID)
}

function hasFilter(q: Captured, method: string, col: string, val: unknown): boolean {
  return q.filters.some((f) => f.method === method && f.args[0] === col && f.args[1] === val)
}

/** `local_1` / `remote_N`, which is the CONTRACT rather than a style choice:
 *  the engine binds only `local_1` to the owner, and a self participant called
 *  anything else has its binding revoked on the first turn. */
const SCRIPT = [
  { t_ms: 0, speaker: 'local_1', stream: 'mic' as const, text: 'so, uh, thanks for making the time' },
  { t_ms: 4200, speaker: 'remote_1', stream: 'system' as const, text: 'yeah of course. where do you want to start' },
  { t_ms: 9000, speaker: 'local_1', stream: 'mic' as const, text: "I'll send over the security questionnaire today" },
]
const PARTICIPANTS = [
  { speaker_label: 'local_1', display: 'Sam Reyes', is_self: true, role: 'organizer' },
  { speaker_label: 'remote_1', display: 'Dana Whitfield', role: 'prospect' },
]
const EXPECTED = {
  proposals: [
    {
      key: 'send_questionnaire',
      entity_type: 'action',
      change_type: 'create',
      gist: 'Send Dana the security questionnaire',
      must_have: { assignee: 'self' },
      severity: 'gate' as const,
    },
  ],
  summary: 'Must state the questionnaire commitment.',
}

const CASE_ROW = {
  id: CASE_ID,
  suite_id: SUITE_ID,
  workspace_id: WORKSPACE_ID,
  name: 'Prospect stalls on pricing',
  capture_id: 'capture-uuid-1',
  capture_is_eval: true,
  script: SCRIPT,
  chunks: [
    { index: 0, t_ms_start: 0, t_ms_end: 4200, segment_indices: [0, 1], text: '' },
    { index: 1, t_ms_start: 9000, t_ms_end: 9000, segment_indices: [2], text: '' },
  ],
  expected: EXPECTED,
  modes: ['batch', 'live'],
  polarity: 'positive',
  seeded_from_capture_id: null,
  visibility: 'workspace',
  sort_order: 0,
  created_at: '2026-09-08T00:00:00Z',
  updated_at: '2026-09-08T00:00:00Z',
}

beforeEach(() => {
  for (const fn of [
    hoisted.createEvalCase,
    hoisted.updateEvalCase,
    hoisted.startEvalRun,
    hoisted.listSuites,
    hoisted.listCases,
    hoisted.getRunDetail,
    hoisted.latestCompletedRun,
  ]) {
    fn.mockReset()
  }
  hoisted.latestCompletedRun.mockResolvedValue(null)
})

// ---------------------------------------------------------------------------

describe('name classification — no registry allowlist edit needed', () => {
  const EVAL_TOOL_NAMES = Object.keys(tools(callerMock([]).supabase))

  it('registers all six tools', () => {
    expect(EVAL_TOOL_NAMES.sort()).toEqual([
      'create_eval_case',
      'create_eval_suite',
      'get_eval_run',
      'list_evals',
      'start_eval_run',
      'update_eval_case',
    ])
  })

  it('classifies every eval tool as read or mutate with no allowlist entry', () => {
    const mutating = getMutatingToolNames()
    const unclassified = EVAL_TOOL_NAMES.filter(
      (name) =>
        !mutating.has(name) &&
        !isReadShapedToolName(name) &&
        !(REPORT_MODE_WRITE_ALLOWLIST as readonly string[]).includes(name),
    )
    expect(unclassified).toEqual([])
  })

  it('classifies the three writers as MUTATING (report mode must deny them)', () => {
    const mutating = getMutatingToolNames()
    for (const name of ['create_eval_suite', 'create_eval_case', 'start_eval_run', 'update_eval_case']) {
      expect(mutating.has(name), `${name} must be mutating`).toBe(true)
    }
  })

  it('classifies the two readers as read-shaped', () => {
    const mutating = getMutatingToolNames()
    for (const name of ['list_evals', 'get_eval_run']) {
      expect(isReadShapedToolName(name), `${name} must be read-shaped`).toBe(true)
      expect(mutating.has(name), `${name} must not be mutating`).toBe(false)
    }
  })

  it('every eval tool is in the registry (search_tools can surface it)', () => {
    const missing = EVAL_TOOL_NAMES.filter((name) => !ALL_TOOL_NAMES.includes(name))
    expect(missing).toEqual([])
  })
})

describe('create_eval_suite', () => {
  it('stamps workspace and creator and defaults suite_kind to capability', async () => {
    // Two results: the target-recipe resolve on the caller's client, then the
    // insert.
    const { supabase, queries } = callerMock([
      { data: { id: 'recipe-1' }, error: null },
      { data: { id: SUITE_ID, name: 'Sales Discovery' }, error: null },
    ])

    const result = (await tools(supabase).create_eval_suite.execute!(
      { name: 'Sales Discovery', target_kind: 'agent', target_recipe_id: 'recipe-1' },
      EXEC_OPTS,
    )) as { success: boolean }

    expect(result.success).toBe(true)
    expect(queries[1].payload).toMatchObject({
      workspace_id: WORKSPACE_ID,
      created_by: USER_ID,
      target_kind: 'agent',
      target_recipe_id: 'recipe-1',
      suite_kind: 'capability',
      name: 'Sales Discovery',
    })
  })

  it('surfaces a write failure instead of reporting success', async () => {
    const { supabase } = callerMock([{ data: null, error: { message: 'permission denied for table eval_suite' } }])

    const result = (await tools(supabase).create_eval_suite.execute!(
      { name: 'Sales Discovery', target_kind: 'agent' },
      EXEC_OPTS,
    )) as { success: boolean; error: string }

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/permission denied/)
  })

  /**
   * The target is resolved before the insert, and the WHERE clause is what does
   * it: the eve executor path (`/api/internal/chat/tool`) builds these tools
   * with the SERVICE client, where a bare `.eq('id', ...)` resolves any uuid.
   */
  it('refuses a target_recipe_id the caller cannot see, before the insert', async () => {
    const { supabase, queries } = callerMock([{ data: null, error: null }])

    const result = (await tools(supabase).create_eval_suite.execute!(
      { name: 'Sales Discovery', target_kind: 'agent', target_recipe_id: 'recipe-elsewhere' },
      EXEC_OPTS,
    )) as { success: boolean; error: string }

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/target_recipe_id/)
    expect(queries.some((q) => q.op === 'insert')).toBe(false)
    const recipeRead = queries.find((q) => q.table === 'recipe')!
    expect(recipeRead.filters).toContainEqual({
      method: 'or',
      args: [visibleRecipesFilter(WORKSPACE_ID, USER_ID)],
    })
  })
})

describe('create_eval_case', () => {
  const ARGS = {
    suite_id: SUITE_ID,
    name: 'Prospect stalls on pricing',
    script: SCRIPT,
    participants: PARTICIPANTS,
    expected: EXPECTED,
  }

  it('checks workspace membership on the CALLER client, then writes on the SERVICE client', async () => {
    const { supabase, queries } = callerMock([{ data: { id: SUITE_ID }, error: null }])
    hoisted.createEvalCase.mockResolvedValue(CASE_ROW)

    const result = (await tools(supabase).create_eval_case.execute!(ARGS, EXEC_OPTS)) as {
      success: boolean
      chunk_count: number
      capture_id: string
    }

    // The membership read is scoped to BOTH the suite and the workspace — the
    // service-role write below is only licensed by it.
    const suiteRead = queries.find((q) => q.table === 'eval_suite')!
    expect(hasFilter(suiteRead, 'eq', 'id', SUITE_ID)).toBe(true)
    expect(hasFilter(suiteRead, 'eq', 'workspace_id', WORKSPACE_ID)).toBe(true)

    // And the write went to the service client, not the caller's.
    expect(hoisted.createEvalCase).toHaveBeenCalledWith(
      hoisted.serviceClient,
      expect.objectContaining({ workspaceId: WORKSPACE_ID, userId: USER_ID, suiteId: SUITE_ID }),
    )
    expect(result.success).toBe(true)
    expect(result.chunk_count).toBe(2)
    expect(result.capture_id).toBe('capture-uuid-1')
  })

  it('refuses a suite from another workspace before any write', async () => {
    const { supabase } = callerMock([{ data: null, error: null }])

    const result = (await tools(supabase).create_eval_case.execute!(ARGS, EXEC_OPTS)) as {
      success: boolean
      error: string
    }

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/i)
    expect(hoisted.createEvalCase).not.toHaveBeenCalled()
  })

  it('requires exactly one is_self participant', async () => {
    const { supabase } = callerMock([{ data: { id: SUITE_ID }, error: null }])
    const t = tools(supabase)

    const none = (await t.create_eval_case.execute!(
      { ...ARGS, participants: PARTICIPANTS.map((p) => ({ ...p, is_self: false })) },
      EXEC_OPTS,
    )) as { success: boolean; error: string }
    const two = (await t.create_eval_case.execute!(
      { ...ARGS, participants: PARTICIPANTS.map((p) => ({ ...p, is_self: true })) },
      EXEC_OPTS,
    )) as { success: boolean }

    expect(none.success).toBe(false)
    expect(none.error).toMatch(/is_self/)
    expect(two.success).toBe(false)
    expect(hoisted.createEvalCase).not.toHaveBeenCalled()
  })

  /**
   * The self participant's label is not free text. `seedEvalSelfParticipant`
   * stamps it with `self_binding: 'position'`, and `resolveSelfBinding`
   * re-derives that evidence by matching `/\[(local_\d+)\]/` on the trial
   * clone's transcript — so any other label is REVOKED on the first live turn,
   * the speaker map can no longer resolve the owner, and every
   * `must_have: {"assignee":"self"}` grades as a miss with no error anywhere.
   */
  it('refuses an is_self participant not labelled local_1, before any write', async () => {
    const { supabase } = callerMock([{ data: { id: SUITE_ID }, error: null }])

    const result = (await tools(supabase).create_eval_case.execute!(
      {
        ...ARGS,
        script: [
          { t_ms: 0, speaker: 'Me', stream: 'mic' as const, text: 'hey' },
          { t_ms: 4000, speaker: 'Dana', stream: 'system' as const, text: 'hi' },
        ],
        participants: [
          { speaker_label: 'Me', display: 'Liam', is_self: true },
          { speaker_label: 'Dana', display: 'Dana Whitfield' },
        ],
      },
      EXEC_OPTS,
    )) as { success: boolean; error: string }

    expect(result.success).toBe(false)
    expect(result.error).toContain('local_1')
    expect(hoisted.createEvalCase).not.toHaveBeenCalled()
  })

  it('rejects a script speaker with no participant entry, naming it', async () => {
    const { supabase } = callerMock([{ data: { id: SUITE_ID }, error: null }])

    const result = (await tools(supabase).create_eval_case.execute!(
      {
        ...ARGS,
        script: [...SCRIPT, { t_ms: 12000, speaker: 'Morgan', stream: 'system' as const, text: 'hey' }],
      },
      EXEC_OPTS,
    )) as { success: boolean; error: string }

    expect(result.success).toBe(false)
    expect(result.error).toContain('Morgan')
    expect(hoisted.createEvalCase).not.toHaveBeenCalled()
  })

  it('sorts the script by t_ms before freezing — chunk boundaries are derived from it', async () => {
    const { supabase } = callerMock([{ data: { id: SUITE_ID }, error: null }])
    hoisted.createEvalCase.mockResolvedValue(CASE_ROW)

    await tools(supabase).create_eval_case.execute!(
      { ...ARGS, script: [SCRIPT[2], SCRIPT[0], SCRIPT[1]] },
      EXEC_OPTS,
    )

    const passed = hoisted.createEvalCase.mock.calls[0][1] as { script: { t_ms: number }[] }
    expect(passed.script.map((s) => s.t_ms)).toEqual([0, 4200, 9000])
  })

  it('reports cadence so the author can catch a script with no silences', async () => {
    const { supabase } = callerMock([{ data: { id: SUITE_ID }, error: null }])
    hoisted.createEvalCase.mockResolvedValue(CASE_ROW)

    const result = (await tools(supabase).create_eval_case.execute!(ARGS, EXEC_OPTS)) as {
      cadence: { chunk_count: number; segment_count: number; duration_ms: number }
    }

    expect(result.cadence).toMatchObject({ chunk_count: 2, segment_count: 3, duration_ms: 9000 })
  })

  it('surfaces a lib throw as an error rather than crashing the turn', async () => {
    const { supabase } = callerMock([{ data: { id: SUITE_ID }, error: null }])
    hoisted.createEvalCase.mockRejectedValue(new Error('Failed to create eval capture'))

    const result = (await tools(supabase).create_eval_case.execute!(ARGS, EXEC_OPTS)) as {
      success: boolean
      error: string
    }

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/eval capture/)
  })
})

describe('list_evals', () => {
  const SUITE = {
    id: SUITE_ID,
    workspace_id: WORKSPACE_ID,
    name: 'Sales Discovery',
    description: null,
    target_kind: 'agent',
    target_recipe_id: 'recipe-1',
    suite_kind: 'capability',
    watch: false,
    judge_model: null,
    created_by: USER_ID,
    created_at: '2026-09-08T00:00:00Z',
    updated_at: '2026-09-08T00:00:00Z',
    case_count: 8,
    last_run: { id: RUN_ID, outcome: 'scored', started_at: '2026-09-08T00:00:00Z', mode: 'batch' },
  }

  it('prices each suite in BOTH modes, and live costs at least as much as batch', async () => {
    const { supabase } = callerMock([])
    hoisted.listSuites.mockResolvedValue([SUITE])

    const result = (await tools(supabase).list_evals.execute!({}, EXEC_OPTS)) as {
      suites: { estimated_cost_usd: { batch: number; live: number }; case_count: number }[]
    }

    const cost = result.suites[0].estimated_cost_usd
    expect(cost.batch).toBeGreaterThan(0)
    expect(cost.live).toBeGreaterThanOrEqual(cost.batch)
  })

  it('scales the estimate with trials_per_case', async () => {
    const { supabase } = callerMock([])
    hoisted.listSuites.mockResolvedValue([SUITE])

    const one = (await tools(supabase).list_evals.execute!({}, EXEC_OPTS)) as {
      suites: { estimated_cost_usd: { batch: number } }[]
    }
    const three = (await tools(supabase).list_evals.execute!({ trials_per_case: 3 }, EXEC_OPTS)) as {
      suites: { estimated_cost_usd: { batch: number } }[]
    }

    expect(three.suites[0].estimated_cost_usd.batch).toBeCloseTo(
      one.suites[0].estimated_cost_usd.batch * 3,
      6,
    )
  })

  it('includes the case list only when one suite is named', async () => {
    const { supabase } = callerMock([])
    hoisted.listSuites.mockResolvedValue([SUITE])
    hoisted.listCases.mockResolvedValue([
      { id: CASE_ID, name: 'Prospect stalls', polarity: 'negative', modes: ['batch'] },
    ])

    const all = (await tools(supabase).list_evals.execute!({}, EXEC_OPTS)) as { cases?: unknown }
    const one = (await tools(supabase).list_evals.execute!({ suite_id: SUITE_ID }, EXEC_OPTS)) as {
      cases?: { polarity: string }[]
    }

    expect(all.cases).toBeUndefined()
    expect(hoisted.listCases).toHaveBeenCalledTimes(1)
    expect(one.cases?.[0].polarity).toBe('negative')
  })

  it('does not list the cases of a suite outside this workspace', async () => {
    const { supabase } = callerMock([])
    hoisted.listSuites.mockResolvedValue([SUITE])
    hoisted.listCases.mockResolvedValue([
      { id: CASE_ID, name: 'Prospect stalls', polarity: 'negative', modes: ['batch'] },
    ])

    const result = (await tools(supabase).list_evals.execute!(
      { suite_id: 'foreign-suite' },
      EXEC_OPTS,
    )) as { suites: unknown[]; cases?: unknown }

    expect(result.suites).toEqual([])
    expect(result.cases).toBeUndefined()
    expect(hoisted.listCases).not.toHaveBeenCalled()
  })

  it('filters by target_recipe_id', async () => {
    const { supabase } = callerMock([])
    hoisted.listSuites.mockResolvedValue([SUITE, { ...SUITE, id: 'suite-2', target_recipe_id: 'recipe-2' }])

    const result = (await tools(supabase).list_evals.execute!(
      { target_recipe_id: 'recipe-2' },
      EXEC_OPTS,
    )) as { suites: { id: string }[] }

    expect(result.suites.map((s) => s.id)).toEqual(['suite-2'])
  })
})

describe('start_eval_run', () => {
  const RUN = {
    id: RUN_ID,
    suite_id: SUITE_ID,
    workspace_id: WORKSPACE_ID,
    mode: 'batch',
    status: 'queued',
  }

  it('never exposes a capture id in its input schema', () => {
    const { supabase } = callerMock([])
    const schema = tools(supabase).start_eval_run.inputSchema as unknown as {
      shape: Record<string, unknown>
    }
    expect(Object.keys(schema.shape)).not.toContain('capture_id')
    expect(Object.keys(schema.shape).some((k) => k.includes('capture'))).toBe(false)
  })

  it('checks workspace membership before queueing, on the caller client', async () => {
    const { supabase, queries } = callerMock([{ data: { id: SUITE_ID, name: 'Sales Discovery' }, error: null }])
    hoisted.startEvalRun.mockResolvedValue({ run: RUN, adopted: false, estimated_cost_usd: 0.42 })

    const result = (await tools(supabase).start_eval_run.execute!(
      { suite_id: SUITE_ID, mode: 'batch' },
      EXEC_OPTS,
    )) as { success: boolean; run_id: string; adopted: boolean; estimated_cost_usd: number }

    const suiteRead = queries.find((q) => q.table === 'eval_suite')!
    expect(hasFilter(suiteRead, 'eq', 'workspace_id', WORKSPACE_ID)).toBe(true)
    expect(hoisted.startEvalRun).toHaveBeenCalledWith(
      hoisted.serviceClient,
      expect.objectContaining({ workspaceId: WORKSPACE_ID, userId: USER_ID, mode: 'batch' }),
    )
    expect(result).toMatchObject({ success: true, run_id: RUN_ID, adopted: false, estimated_cost_usd: 0.42 })
  })

  it('refuses a suite from another workspace before queueing', async () => {
    const { supabase } = callerMock([{ data: null, error: null }])

    const result = (await tools(supabase).start_eval_run.execute!(
      { suite_id: SUITE_ID, mode: 'live' },
      EXEC_OPTS,
    )) as { success: boolean }

    expect(result.success).toBe(false)
    expect(hoisted.startEvalRun).not.toHaveBeenCalled()
  })

  it('reports an adopted run as adopted rather than as one it started', async () => {
    const { supabase } = callerMock([{ data: { id: SUITE_ID }, error: null }])
    hoisted.startEvalRun.mockResolvedValue({
      run: { ...RUN, status: 'running' },
      adopted: true,
      estimated_cost_usd: 0.42,
    })

    const result = (await tools(supabase).start_eval_run.execute!(
      { suite_id: SUITE_ID, mode: 'batch' },
      EXEC_OPTS,
    )) as { adopted: boolean; message: string }

    expect(result.adopted).toBe(true)
    expect(result.message).toMatch(/already in flight/i)
  })

  it('forwards speed, trials_per_case and case_ids verbatim', async () => {
    const { supabase } = callerMock([{ data: { id: SUITE_ID }, error: null }])
    hoisted.startEvalRun.mockResolvedValue({ run: RUN, adopted: false, estimated_cost_usd: 1 })

    await tools(supabase).start_eval_run.execute!(
      { suite_id: SUITE_ID, mode: 'live', speed: 'instant', trials_per_case: 3, case_ids: [CASE_ID] },
      EXEC_OPTS,
    )

    expect(hoisted.startEvalRun.mock.calls[0][1]).toMatchObject({
      speed: 'instant',
      trialsPerCase: 3,
      caseIds: [CASE_ID],
    })
  })

  it('offers ONLY the speeds that have a driver', () => {
    // The watched replays need the client driver and would sleep a live case
    // past the Inngest step ceiling. A tool description is a recommendation, so
    // offering them would have the model recommend a timeout.
    const schema = tools(callerMock([]).supabase).start_eval_run.inputSchema as unknown as {
      shape: { speed: { unwrap: () => { options: string[] } } }
    }
    expect(schema.shape.speed.unwrap().options).toEqual(['instant'])
  })

  it('surfaces a budget/queue throw as an error', async () => {
    const { supabase } = callerMock([{ data: { id: SUITE_ID }, error: null }])
    hoisted.startEvalRun.mockRejectedValue(new Error('Monthly eval budget exhausted'))

    const result = (await tools(supabase).start_eval_run.execute!(
      { suite_id: SUITE_ID, mode: 'batch' },
      EXEC_OPTS,
    )) as { success: boolean; error: string }

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/budget/i)
  })
})

describe('get_eval_run', () => {
  const RUN = {
    id: RUN_ID,
    suite_id: SUITE_ID,
    workspace_id: WORKSPACE_ID,
    mode: 'batch',
    speed: 'instant',
    status: 'completed',
    is_live: false,
    outcome: 'failed',
    scores: { proposals: { pass: 3, fail: 1, unknown: 0, skipped: 0, rate: 0.75 } },
    progress: { cases_total: 2, trials_total: 2, trials_done: 2, stage: 'done' },
    trials_per_case: 1,
    estimated_cost_usd: 0.4,
    cost_usd: 0.38,
    duration_ms: 41000,
    target_prompt_hash: 'hash-b',
    error_code: null,
    error_message: null,
  }
  const TRIALS = [
    {
      id: 'trial-1',
      run_id: RUN_ID,
      case_id: CASE_ID,
      case_name: 'Prospect stalls on pricing',
      trial_index: 0,
      status: 'completed',
      outcome: 'failed',
      cost_usd: 0.19,
      duration_ms: 20000,
      error_code: null,
      checks: [
        {
          id: 'check-1',
          dimension: 'proposals',
          check_key: 'send_questionnaire',
          label: 'Send Dana the security questionnaire',
          severity: 'gate',
          outcome: 'fail',
          rationale: 'No proposal matched the expected gist.',
        },
        {
          id: 'check-2',
          dimension: 'summary',
          check_key: 'summary_states_pushback',
          label: 'Summary states the pricing pushback',
          severity: 'soft',
          outcome: 'pass',
          rationale: 'Stated verbatim.',
        },
      ],
    },
  ]

  it('returns only the FAILING checks, with their rationale', async () => {
    const { supabase } = callerMock([])
    hoisted.getRunDetail.mockResolvedValue({ run: RUN, trials: TRIALS })

    const result = (await tools(supabase).get_eval_run.execute!({ run_id: RUN_ID }, EXEC_OPTS)) as {
      success: boolean
      failing_checks: { check_key: string; rationale: string }[]
    }

    expect(result.success).toBe(true)
    expect(result.failing_checks).toHaveLength(1)
    expect(result.failing_checks[0]).toMatchObject({
      check_key: 'send_questionnaire',
      rationale: 'No proposal matched the expected gist.',
    })
  })

  it('resolves the baseline EXCLUDING this run\'s own prompt hash', async () => {
    const { supabase } = callerMock([])
    hoisted.getRunDetail.mockResolvedValue({ run: RUN, trials: TRIALS })
    hoisted.latestCompletedRun.mockResolvedValue({ id: 'run-0', outcome: 'passed', scores: {}, started_at: 'x' })

    const result = (await tools(supabase).get_eval_run.execute!({ run_id: RUN_ID }, EXEC_OPTS)) as {
      baseline_run: { id: string } | null
    }

    // Two runs of the SAME prompt are variance samples, never a before/after —
    // passing the hash is what makes that true.
    expect(hoisted.latestCompletedRun).toHaveBeenCalledWith(expect.anything(), SUITE_ID, 'batch', 'hash-b')
    expect(result.baseline_run?.id).toBe('run-0')
  })

  it('refuses a run belonging to another workspace', async () => {
    const { supabase } = callerMock([])
    hoisted.getRunDetail.mockResolvedValue({ run: { ...RUN, workspace_id: 'other-ws' }, trials: TRIALS })

    const result = (await tools(supabase).get_eval_run.execute!({ run_id: RUN_ID }, EXEC_OPTS)) as {
      success: boolean
      error: string
    }

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/i)
  })

  it('never pulls a trace unless asked for', async () => {
    const { supabase, queries } = callerMock([])
    hoisted.getRunDetail.mockResolvedValue({ run: RUN, trials: TRIALS })

    const result = (await tools(supabase).get_eval_run.execute!({ run_id: RUN_ID }, EXEC_OPTS)) as {
      trace?: unknown
    }

    expect(result.trace).toBeUndefined()
    expect(queries.filter((q) => q.table === 'eval_trial')).toHaveLength(0)
  })

  it('pulls one trial\'s trace when include_trace names a case', async () => {
    const { supabase, queries } = callerMock([{ data: { trace: { mode: 'batch', flushes: [] } }, error: null }])
    hoisted.getRunDetail.mockResolvedValue({ run: RUN, trials: TRIALS })

    const result = (await tools(supabase).get_eval_run.execute!(
      { run_id: RUN_ID, include_trace: true, case_id: CASE_ID },
      EXEC_OPTS,
    )) as { trace: { mode: string } }

    const traceRead = queries.find((q) => q.table === 'eval_trial')!
    expect(hasFilter(traceRead, 'eq', 'id', 'trial-1')).toBe(true)
    expect(result.trace.mode).toBe('batch')
  })

  it('explains rather than guesses when include_trace has no case_id', async () => {
    const { supabase, queries } = callerMock([])
    hoisted.getRunDetail.mockResolvedValue({ run: RUN, trials: TRIALS })

    const result = (await tools(supabase).get_eval_run.execute!(
      { run_id: RUN_ID, include_trace: true },
      EXEC_OPTS,
    )) as { trace_error: string; trace?: unknown }

    expect(result.trace_error).toMatch(/case_id/)
    expect(result.trace).toBeUndefined()
    expect(queries.filter((q) => q.table === 'eval_trial')).toHaveLength(0)
  })

  it('reports a missing run rather than an empty one', async () => {
    const { supabase } = callerMock([])
    hoisted.getRunDetail.mockResolvedValue(null)

    const result = (await tools(supabase).get_eval_run.execute!({ run_id: RUN_ID }, EXEC_OPTS)) as {
      success: boolean
    }

    expect(result.success).toBe(false)
  })
})

describe('update_eval_case', () => {
  it('requires at least one field', async () => {
    const { supabase, queries } = callerMock([])

    const result = (await tools(supabase).update_eval_case.execute!({ case_id: CASE_ID }, EXEC_OPTS)) as {
      success: boolean
      error: string
    }

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/at least one field/)
    // Refused before touching the table at all.
    expect(queries).toHaveLength(0)
    expect(hoisted.updateEvalCase).not.toHaveBeenCalled()
  })

  it('checks workspace membership on the caller client, then writes on the service client', async () => {
    const { supabase, queries } = callerMock([{ data: { id: CASE_ID }, error: null }])
    hoisted.updateEvalCase.mockResolvedValue(CASE_ROW)

    const result = (await tools(supabase).update_eval_case.execute!(
      { case_id: CASE_ID, name: 'Renamed' },
      EXEC_OPTS,
    )) as { success: boolean }

    const caseRead = queries.find((q) => q.table === 'eval_case')!
    expect(hasFilter(caseRead, 'eq', 'workspace_id', WORKSPACE_ID)).toBe(true)
    expect(hoisted.updateEvalCase).toHaveBeenCalledWith(
      hoisted.serviceClient,
      expect.objectContaining({ caseId: CASE_ID, workspaceId: WORKSPACE_ID, name: 'Renamed' }),
    )
    expect(result.success).toBe(true)
  })

  it('refuses a case from another workspace', async () => {
    const { supabase } = callerMock([{ data: null, error: null }])

    const result = (await tools(supabase).update_eval_case.execute!(
      { case_id: CASE_ID, name: 'Renamed' },
      EXEC_OPTS,
    )) as { success: boolean }

    expect(result.success).toBe(false)
    expect(hoisted.updateEvalCase).not.toHaveBeenCalled()
  })

  it('sorts a replacement script and reports the RE-FROZEN chunk count', async () => {
    const { supabase } = callerMock([{ data: { id: CASE_ID }, error: null }])
    hoisted.updateEvalCase.mockResolvedValue(CASE_ROW)

    const result = (await tools(supabase).update_eval_case.execute!(
      { case_id: CASE_ID, script: [SCRIPT[2], SCRIPT[0], SCRIPT[1]] },
      EXEC_OPTS,
    )) as { chunk_count: number; cadence: { duration_ms: number } }

    const passed = hoisted.updateEvalCase.mock.calls[0][1] as { script: { t_ms: number }[] }
    expect(passed.script.map((s) => s.t_ms)).toEqual([0, 4200, 9000])
    expect(result.chunk_count).toBe(2)
    expect(result.cadence.duration_ms).toBe(9000)
  })

  it('omits cadence when the script was not touched', async () => {
    const { supabase } = callerMock([{ data: { id: CASE_ID }, error: null }])
    hoisted.updateEvalCase.mockResolvedValue(CASE_ROW)

    const result = (await tools(supabase).update_eval_case.execute!(
      { case_id: CASE_ID, expected: EXPECTED },
      EXEC_OPTS,
    )) as { cadence?: unknown }

    expect(result.cadence).toBeUndefined()
  })
})
