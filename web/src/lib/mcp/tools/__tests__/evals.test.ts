/**
 * The MCP Evals twins — the hand-registered `ni_*` variants of the chat
 * eval tools.
 *
 * The load-bearing properties:
 *   1. NAMES — all six are `ni_<verb>_<noun>` and classify by verb SHAPE
 *      through ../guard.ts's `classifyToolAccess`, so `ni_list_evals` and
 *      `ni_get_eval_run` are reachable by a READ-ONLY token while the four
 *      writers are not, with no allowlist entry anywhere. Renaming one to
 *      something like `ni_run_eval` would silently grant a read-only token a
 *      write — this file is what stops that.
 *   2. OWNER FROM THE SESSION — `userId` and `workspaceId` come from the
 *      authenticated MCP session, never from a tool argument, matching
 *      ./library.ts. A `workspace_id` parameter would let a client write into a
 *      workspace it never authenticated for.
 *   3. MEMBERSHIP BEFORE SERVICE WRITE — the three capture-touching writes read
 *      the parent row on the CALLER's client, scoped to the session workspace,
 *      before anything reaches the service-role client.
 *   4. ok/fail ENVELOPES — every result is JSON in a text content block, and an
 *      error carries `isError` plus a machine-readable code.
 *   5. NO CAPTURE ID — `ni_start_eval_run` cannot be pointed at a real
 *      meeting, which is the one input that would let a run delete a real
 *      capture's pending proposals (batch mode clears them before re-extracting).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { classifyToolAccess } from '../../guard'

const USER_ID = 'user-uuid-1'
const WORKSPACE_ID = 'workspace-uuid-1'
const SUITE_ID = 'suite-uuid-1'
const CASE_ID = 'case-uuid-1'
const RUN_ID = 'run-uuid-1'

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

const { registerEvalTools } = await import('../evals')

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type McpResult = { content: { type: 'text'; text: string }[]; isError?: boolean }
type Handler = (args: Record<string, unknown>) => Promise<McpResult>

interface Registered {
  name: string
  description: string
  shape: Record<string, unknown>
  handler: Handler
}

/** A fake McpServer that records every registration, the way the real one does. */
function fakeServer() {
  const registered = new Map<string, Registered>()
  const server = {
    tool: (name: string, description: string, shape: Record<string, unknown>, handler: Handler) => {
      registered.set(name, { name, description, shape, handler })
    },
  }
  return { server: server as never, registered }
}

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

function register(supabase: unknown) {
  const { server, registered } = fakeServer()
  registerEvalTools(server, USER_ID, supabase as never, WORKSPACE_ID)
  return registered
}

/** Parse an MCP text-content result back into its payload. */
function payload(result: McpResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>
}

function hasFilter(q: Captured, method: string, col: string, val: unknown): boolean {
  return q.filters.some((f) => f.method === method && f.args[0] === col && f.args[1] === val)
}

/** `local_1` / `remote_N` — the label contract, not a style choice: only
 *  `local_1` binds to the owner, and any other self label is revoked on the
 *  first turn. */
const SCRIPT = [
  { t_ms: 0, speaker: 'local_1', stream: 'mic', text: 'so, uh, thanks for making the time' },
  { t_ms: 4200, speaker: 'remote_1', stream: 'system', text: 'yeah of course' },
  { t_ms: 9000, speaker: 'local_1', stream: 'mic', text: "I'll send the security questionnaire today" },
]
const PARTICIPANTS = [
  { speaker_label: 'local_1', display: 'Sam Reyes', is_self: true },
  { speaker_label: 'remote_1', display: 'Dana Whitfield' },
]
const CASE_ROW = {
  id: CASE_ID,
  suite_id: SUITE_ID,
  workspace_id: WORKSPACE_ID,
  name: 'Prospect stalls on pricing',
  capture_id: 'capture-uuid-1',
  script: SCRIPT,
  chunks: [{ index: 0 }, { index: 1 }],
  expected: {},
  modes: ['batch', 'live'],
  polarity: 'positive',
}

const EVAL_TOOL_NAMES = [
  'ni_create_eval_suite',
  'ni_create_eval_case',
  'ni_list_evals',
  'ni_start_eval_run',
  'ni_get_eval_run',
  'ni_update_eval_case',
]

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

describe('registration and naming', () => {
  it('registers exactly the six ni_* eval tools', () => {
    const registered = register(callerMock([]).supabase)
    expect([...registered.keys()].sort()).toEqual([...EVAL_TOOL_NAMES].sort())
  })

  it('the two readers are reachable by a READ-ONLY token; the four writers are not', () => {
    // classifyToolAccess strips `ni_` and matches by verb shape — no
    // allowlist. This is why the verbs are list_/get_ and create_/update_/start_.
    expect(classifyToolAccess('ni_list_evals')).toBe('read')
    expect(classifyToolAccess('ni_get_eval_run')).toBe('read')
    for (const name of [
      'ni_create_eval_suite',
      'ni_create_eval_case',
      'ni_start_eval_run',
      'ni_update_eval_case',
    ]) {
      expect(classifyToolAccess(name), `${name} must be write-classified`).toBe('write')
    }
  })

  it('takes no workspace_id or user_id argument — the session owns both', () => {
    const registered = register(callerMock([]).supabase)
    for (const name of EVAL_TOOL_NAMES) {
      const keys = Object.keys(registered.get(name)!.shape)
      expect(keys, `${name} must not take a workspace_id`).not.toContain('workspace_id')
      expect(keys, `${name} must not take a user_id`).not.toContain('user_id')
      expect(keys, `${name} must not take a created_by`).not.toContain('created_by')
    }
  })

  it('ni_start_eval_run exposes no capture id under any name', () => {
    const registered = register(callerMock([]).supabase)
    const keys = Object.keys(registered.get('ni_start_eval_run')!.shape)
    expect(keys.some((k) => k.includes('capture'))).toBe(false)
  })

  it('every tool carries a non-trivial description', () => {
    const registered = register(callerMock([]).supabase)
    for (const name of EVAL_TOOL_NAMES) {
      expect(registered.get(name)!.description.length).toBeGreaterThan(80)
    }
  })
})

describe('ni_create_eval_suite', () => {
  it('stamps the session workspace and creator', async () => {
    const { supabase, queries } = callerMock([{ data: { id: SUITE_ID }, error: null }])
    const registered = register(supabase)

    const result = await registered.get('ni_create_eval_suite')!.handler({
      name: 'Sales Discovery',
      target_kind: 'agent',
    })

    expect(result.isError).toBeUndefined()
    expect(queries[0].payload).toMatchObject({
      workspace_id: WORKSPACE_ID,
      created_by: USER_ID,
      target_kind: 'agent',
      suite_kind: 'capability',
    })
    expect(payload(result).suite).toMatchObject({ id: SUITE_ID })
  })

  it('fails with a code on an empty name, before any write', async () => {
    const { supabase, queries } = callerMock([])
    const registered = register(supabase)

    const result = await registered.get('ni_create_eval_suite')!.handler({
      name: '   ',
      target_kind: 'agent',
    })

    expect(result.isError).toBe(true)
    expect(payload(result).code).toBe('INVALID_NAME')
    expect(queries).toHaveLength(0)
  })

  /** The target is resolved on the CALLER's client first. The column carries
   *  no RLS-aware check of its own, so an id the caller cannot see would be
   *  stored and the suite would target nothing readable. */
  it('refuses a target_recipe_id the caller cannot see, before the insert', async () => {
    const { supabase, queries } = callerMock([{ data: null, error: null }])
    const registered = register(supabase)

    const result = await registered.get('ni_create_eval_suite')!.handler({
      name: 'Sales Discovery',
      target_kind: 'agent',
      target_recipe_id: 'recipe-elsewhere',
    })

    expect(result.isError).toBe(true)
    expect(payload(result).code).toBe('TARGET_NOT_FOUND')
    expect(queries.some((q) => q.op === 'insert')).toBe(false)
  })

  /** The registrar hands these tools the SERVICE client (../auth.ts builds one
   *  per session), so RLS answers nothing here: a foreign recipe row comes back
   *  from a bare `.eq('id', ...)`. Only the `is_system OR workspace_id` predicate
   *  keeps that prompt out of the suite, so this fake honours the predicate and
   *  ignores everything else — the check has to fail on the WHERE clause. */
  it('refuses a foreign-workspace recipe on a SERVICE client that returns the row', async () => {
    const FOREIGN = {
      id: 'recipe-elsewhere',
      workspace_id: 'workspace-uuid-2',
      is_system: false,
      system_prompt: 'another workspace private prompt',
    }
    const queries: Array<{ table: string; op: string }> = []
    const serviceLike = {
      from(table: string) {
        const q = { table, op: 'select' }
        queries.push(q)
        let orClause: string | null = null
        const b: Record<string, unknown> = {}
        const settle = async () => {
          if (table !== 'recipe') return { data: { id: SUITE_ID }, error: null }
          // Service role: the row is readable. Only the predicate can exclude it.
          const allowed =
            orClause === null ||
            (orClause.includes('is_system.eq.true') && FOREIGN.is_system) ||
            orClause.includes(`workspace_id.eq.${FOREIGN.workspace_id}`)
          return { data: allowed ? FOREIGN : null, error: null }
        }
        Object.assign(b, {
          select: () => b,
          insert: () => {
            q.op = 'insert'
            return b
          },
          eq: () => b,
          or: (clause: string) => {
            orClause = clause
            return b
          },
          single: settle,
          maybeSingle: settle,
        })
        return b
      },
    }

    const registered = register(serviceLike)
    const result = await registered.get('ni_create_eval_suite')!.handler({
      name: 'Sales Discovery',
      target_kind: 'agent',
      target_recipe_id: FOREIGN.id,
    })

    expect(result.isError).toBe(true)
    expect(payload(result).code).toBe('TARGET_NOT_FOUND')
    expect(queries.some((q) => q.op === 'insert')).toBe(false)
  })
})

describe('ni_create_eval_case', () => {
  const ARGS = {
    suite_id: SUITE_ID,
    name: 'Prospect stalls on pricing',
    script: SCRIPT,
    participants: PARTICIPANTS,
    expected: {},
  }

  it('reads membership on the caller client, then writes on the SERVICE client', async () => {
    const { supabase, queries } = callerMock([{ data: { id: SUITE_ID }, error: null }])
    hoisted.createEvalCase.mockResolvedValue(CASE_ROW)
    const registered = register(supabase)

    const result = await registered.get('ni_create_eval_case')!.handler(ARGS)

    const suiteRead = queries.find((q) => q.table === 'eval_suite')!
    expect(hasFilter(suiteRead, 'eq', 'workspace_id', WORKSPACE_ID)).toBe(true)
    expect(hoisted.createEvalCase).toHaveBeenCalledWith(
      hoisted.serviceClient,
      expect.objectContaining({ workspaceId: WORKSPACE_ID, userId: USER_ID, suiteId: SUITE_ID }),
    )
    expect(payload(result).chunk_count).toBe(2)
  })

  it('refuses a suite outside the session workspace before any write', async () => {
    const { supabase } = callerMock([{ data: null, error: null }])
    const registered = register(supabase)

    const result = await registered.get('ni_create_eval_case')!.handler(ARGS)

    expect(result.isError).toBe(true)
    expect(payload(result).code).toBe('NOT_FOUND')
    expect(hoisted.createEvalCase).not.toHaveBeenCalled()
  })

  it('rejects zero or two is_self participants with a code', async () => {
    const { supabase } = callerMock([{ data: { id: SUITE_ID }, error: null }])
    const registered = register(supabase)
    const handler = registered.get('ni_create_eval_case')!.handler

    const none = await handler({ ...ARGS, participants: PARTICIPANTS.map((p) => ({ ...p, is_self: false })) })
    const two = await handler({ ...ARGS, participants: PARTICIPANTS.map((p) => ({ ...p, is_self: true })) })

    expect(payload(none).code).toBe('INVALID_PARTICIPANTS')
    expect(payload(two).code).toBe('INVALID_PARTICIPANTS')
    expect(hoisted.createEvalCase).not.toHaveBeenCalled()
  })

  it('names an unmatched script speaker rather than writing an ungradeable case', async () => {
    const { supabase } = callerMock([{ data: { id: SUITE_ID }, error: null }])
    const registered = register(supabase)

    const result = await registered.get('ni_create_eval_case')!.handler({
      ...ARGS,
      script: [...SCRIPT, { t_ms: 12000, speaker: 'Morgan', stream: 'system', text: 'hey' }],
    })

    expect(payload(result).code).toBe('UNKNOWN_SPEAKER')
    expect(String(payload(result).error)).toContain('Morgan')
  })

  it('rejects an empty script', async () => {
    const { supabase } = callerMock([{ data: { id: SUITE_ID }, error: null }])
    const registered = register(supabase)

    const result = await registered.get('ni_create_eval_case')!.handler({ ...ARGS, script: [] })

    expect(payload(result).code).toBe('EMPTY_SCRIPT')
  })

  it('sorts the script by t_ms before freezing', async () => {
    const { supabase } = callerMock([{ data: { id: SUITE_ID }, error: null }])
    hoisted.createEvalCase.mockResolvedValue(CASE_ROW)
    const registered = register(supabase)

    await registered.get('ni_create_eval_case')!.handler({
      ...ARGS,
      script: [SCRIPT[2], SCRIPT[0], SCRIPT[1]],
    })

    const passed = hoisted.createEvalCase.mock.calls[0][1] as { script: { t_ms: number }[] }
    expect(passed.script.map((s) => s.t_ms)).toEqual([0, 4200, 9000])
  })
})

describe('ni_list_evals', () => {
  const SUITE = {
    id: SUITE_ID,
    name: 'Sales Discovery',
    description: null,
    target_kind: 'agent',
    target_recipe_id: 'recipe-1',
    suite_kind: 'capability',
    watch: false,
    case_count: 8,
    last_run: { id: RUN_ID, outcome: 'scored', started_at: 'x', mode: 'batch' },
  }

  it('returns an estimated cost per mode so a client can quote before spending', async () => {
    const { supabase } = callerMock([])
    hoisted.listSuites.mockResolvedValue([SUITE])
    const registered = register(supabase)

    const result = await registered.get('ni_list_evals')!.handler({})
    const suites = payload(result).suites as { estimated_cost_usd: { batch: number; live: number } }[]

    expect(suites[0].estimated_cost_usd.batch).toBeGreaterThan(0)
    expect(suites[0].estimated_cost_usd.live).toBeGreaterThanOrEqual(suites[0].estimated_cost_usd.batch)
  })

  it('includes cases only when one suite is named', async () => {
    const { supabase } = callerMock([])
    hoisted.listSuites.mockResolvedValue([SUITE])
    hoisted.listCases.mockResolvedValue([{ id: CASE_ID, name: 'A case', polarity: 'negative', modes: ['batch'] }])
    const registered = register(supabase)

    const all = payload(await registered.get('ni_list_evals')!.handler({}))
    const one = payload(await registered.get('ni_list_evals')!.handler({ suite_id: SUITE_ID }))

    expect(all.cases).toBeUndefined()
    expect((one.cases as { polarity: string }[])[0].polarity).toBe('negative')
  })

  it("never lists cases for a suite outside the session workspace", async () => {
    const { supabase } = callerMock([])
    hoisted.listSuites.mockResolvedValue([SUITE])
    hoisted.listCases.mockResolvedValue([{ id: CASE_ID, name: 'Theirs', polarity: 'negative', modes: ['batch'] }])
    const registered = register(supabase)

    const body = payload(await registered.get('ni_list_evals')!.handler({ suite_id: 'suite-from-another-workspace' }))

    expect(body.cases).toEqual([])
    expect(hoisted.listCases).not.toHaveBeenCalled()
  })

  it('scopes the read to the session workspace', async () => {
    const { supabase } = callerMock([])
    hoisted.listSuites.mockResolvedValue([])
    const registered = register(supabase)

    await registered.get('ni_list_evals')!.handler({})

    expect(hoisted.listSuites).toHaveBeenCalledWith(expect.anything(), WORKSPACE_ID)
  })

  it('stamps active_workspace, so a hand-registered result is indistinguishable from a bridged one', async () => {
    // The adapter loop in ../index.ts stamps every BRIDGED result; these tools
    // build their own content block, so the stamp has to happen in the registrar
    // or the six ni_*_eval* results are the only ones in the catalog that
    // don't say which workspace they came from.
    const { supabase } = callerMock([])
    hoisted.listSuites.mockResolvedValue([])
    const { server, registered } = fakeServer()
    registerEvalTools(server, USER_ID, supabase as never, WORKSPACE_ID, 'Alpha')

    const body = payload(await registered.get('ni_list_evals')!.handler({}))
    expect(body.active_workspace).toEqual({ id: WORKSPACE_ID, name: 'Alpha' })
  })
})

describe('ni_start_eval_run', () => {
  const RUN = { id: RUN_ID, suite_id: SUITE_ID, mode: 'batch', status: 'queued' }

  it('checks membership, queues on the service client, and reports the estimate', async () => {
    const { supabase, queries } = callerMock([{ data: { id: SUITE_ID }, error: null }])
    hoisted.startEvalRun.mockResolvedValue({ run: RUN, adopted: false, estimated_cost_usd: 0.42 })
    const registered = register(supabase)

    const result = await registered.get('ni_start_eval_run')!.handler({ suite_id: SUITE_ID, mode: 'batch' })

    const suiteRead = queries.find((q) => q.table === 'eval_suite')!
    expect(hasFilter(suiteRead, 'eq', 'workspace_id', WORKSPACE_ID)).toBe(true)
    expect(hoisted.startEvalRun).toHaveBeenCalledWith(
      hoisted.serviceClient,
      expect.objectContaining({ workspaceId: WORKSPACE_ID, userId: USER_ID }),
    )
    expect(payload(result)).toMatchObject({ run_id: RUN_ID, adopted: false, estimated_cost_usd: 0.42 })
  })

  it('surfaces adopted:true rather than claiming a second run', async () => {
    const { supabase } = callerMock([{ data: { id: SUITE_ID }, error: null }])
    hoisted.startEvalRun.mockResolvedValue({ run: RUN, adopted: true, estimated_cost_usd: 0.42 })
    const registered = register(supabase)

    const result = await registered.get('ni_start_eval_run')!.handler({ suite_id: SUITE_ID, mode: 'batch' })

    expect(payload(result).adopted).toBe(true)
  })

  it('refuses a suite outside the session workspace', async () => {
    const { supabase } = callerMock([{ data: null, error: null }])
    const registered = register(supabase)

    const result = await registered.get('ni_start_eval_run')!.handler({ suite_id: SUITE_ID, mode: 'batch' })

    expect(result.isError).toBe(true)
    expect(hoisted.startEvalRun).not.toHaveBeenCalled()
  })

  it('reports a thrown budget error as an MCP error', async () => {
    const { supabase } = callerMock([{ data: { id: SUITE_ID }, error: null }])
    hoisted.startEvalRun.mockRejectedValue(new Error('Monthly eval budget exhausted'))
    const registered = register(supabase)

    const result = await registered.get('ni_start_eval_run')!.handler({ suite_id: SUITE_ID, mode: 'batch' })

    expect(result.isError).toBe(true)
    expect(String(payload(result).error)).toMatch(/budget/i)
  })
})

describe('ni_get_eval_run', () => {
  const RUN = {
    id: RUN_ID,
    suite_id: SUITE_ID,
    workspace_id: WORKSPACE_ID,
    mode: 'batch',
    speed: 'instant',
    status: 'completed',
    is_live: false,
    outcome: 'failed',
    scores: {},
    progress: {},
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
      case_id: CASE_ID,
      case_name: 'Prospect stalls',
      trial_index: 0,
      status: 'completed',
      outcome: 'failed',
      cost_usd: 0.19,
      duration_ms: 20000,
      error_code: null,
      checks: [
        {
          dimension: 'proposals',
          check_key: 'send_questionnaire',
          label: 'Send the questionnaire',
          severity: 'gate',
          outcome: 'fail',
          rationale: 'Nothing matched.',
        },
        {
          dimension: 'summary',
          check_key: 'summary_ok',
          label: 'Summary',
          severity: 'soft',
          outcome: 'pass',
          rationale: 'Fine.',
        },
      ],
    },
  ]

  it('returns only failing checks, with rationale', async () => {
    const { supabase } = callerMock([])
    hoisted.getRunDetail.mockResolvedValue({ run: RUN, trials: TRIALS })
    const registered = register(supabase)

    const result = payload(await registered.get('ni_get_eval_run')!.handler({ run_id: RUN_ID }))
    const failing = result.failing_checks as { check_key: string; rationale: string }[]

    expect(failing).toHaveLength(1)
    expect(failing[0].check_key).toBe('send_questionnaire')
  })

  it('excludes this run\'s own prompt hash when resolving the baseline', async () => {
    const { supabase } = callerMock([])
    hoisted.getRunDetail.mockResolvedValue({ run: RUN, trials: TRIALS })
    const registered = register(supabase)

    await registered.get('ni_get_eval_run')!.handler({ run_id: RUN_ID })

    expect(hoisted.latestCompletedRun).toHaveBeenCalledWith(expect.anything(), SUITE_ID, 'batch', 'hash-b')
  })

  it('refuses a run from another workspace', async () => {
    const { supabase } = callerMock([])
    hoisted.getRunDetail.mockResolvedValue({ run: { ...RUN, workspace_id: 'other-ws' }, trials: TRIALS })
    const registered = register(supabase)

    const result = await registered.get('ni_get_eval_run')!.handler({ run_id: RUN_ID })

    expect(result.isError).toBe(true)
    expect(payload(result).code).toBe('NOT_FOUND')
  })

  it('does not touch eval_trial unless a trace was asked for', async () => {
    const { supabase, queries } = callerMock([])
    hoisted.getRunDetail.mockResolvedValue({ run: RUN, trials: TRIALS })
    const registered = register(supabase)

    const result = payload(await registered.get('ni_get_eval_run')!.handler({ run_id: RUN_ID }))

    expect(result.trace).toBeUndefined()
    expect(queries.filter((q) => q.table === 'eval_trial')).toHaveLength(0)
  })

  it('reads exactly the named case\'s trial when include_trace + case_id are given', async () => {
    const { supabase, queries } = callerMock([{ data: { trace: { mode: 'batch' } }, error: null }])
    hoisted.getRunDetail.mockResolvedValue({ run: RUN, trials: TRIALS })
    const registered = register(supabase)

    const result = payload(
      await registered.get('ni_get_eval_run')!.handler({
        run_id: RUN_ID,
        include_trace: true,
        case_id: CASE_ID,
      }),
    )

    expect(hasFilter(queries.find((q) => q.table === 'eval_trial')!, 'eq', 'id', 'trial-1')).toBe(true)
    expect((result.trace as { mode: string }).mode).toBe('batch')
  })

  it('explains a missing case_id instead of guessing a trial', async () => {
    const { supabase, queries } = callerMock([])
    hoisted.getRunDetail.mockResolvedValue({ run: RUN, trials: TRIALS })
    const registered = register(supabase)

    const result = payload(
      await registered.get('ni_get_eval_run')!.handler({ run_id: RUN_ID, include_trace: true }),
    )

    expect(String(result.trace_error)).toMatch(/case_id/)
    expect(queries.filter((q) => q.table === 'eval_trial')).toHaveLength(0)
  })
})

describe('ni_update_eval_case', () => {
  it('refuses an empty patch before touching the table', async () => {
    const { supabase, queries } = callerMock([])
    const registered = register(supabase)

    const result = await registered.get('ni_update_eval_case')!.handler({ case_id: CASE_ID })

    expect(payload(result).code).toBe('NOTHING_TO_UPDATE')
    expect(queries).toHaveLength(0)
    expect(hoisted.updateEvalCase).not.toHaveBeenCalled()
  })

  it('checks membership on the caller client, then writes on the service client', async () => {
    const { supabase, queries } = callerMock([{ data: { id: CASE_ID }, error: null }])
    hoisted.updateEvalCase.mockResolvedValue(CASE_ROW)
    const registered = register(supabase)

    await registered.get('ni_update_eval_case')!.handler({ case_id: CASE_ID, name: 'Renamed' })

    expect(hasFilter(queries.find((q) => q.table === 'eval_case')!, 'eq', 'workspace_id', WORKSPACE_ID)).toBe(true)
    expect(hoisted.updateEvalCase).toHaveBeenCalledWith(
      hoisted.serviceClient,
      expect.objectContaining({ caseId: CASE_ID, workspaceId: WORKSPACE_ID, name: 'Renamed' }),
    )
  })

  it('refuses a case outside the session workspace', async () => {
    const { supabase } = callerMock([{ data: null, error: null }])
    const registered = register(supabase)

    const result = await registered.get('ni_update_eval_case')!.handler({ case_id: CASE_ID, name: 'Renamed' })

    expect(payload(result).code).toBe('NOT_FOUND')
    expect(hoisted.updateEvalCase).not.toHaveBeenCalled()
  })

  it('re-reports the chunk count after a script edit re-freezes the boundaries', async () => {
    const { supabase } = callerMock([{ data: { id: CASE_ID }, error: null }])
    hoisted.updateEvalCase.mockResolvedValue(CASE_ROW)
    const registered = register(supabase)

    const result = payload(
      await registered.get('ni_update_eval_case')!.handler({ case_id: CASE_ID, script: SCRIPT }),
    )

    expect(result.chunk_count).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// The two authoring invariants both doors have to enforce
// ---------------------------------------------------------------------------

describe('self speaker label', () => {
  /**
   * `seedEvalSelfParticipant` stamps the authored self label with
   * `self_binding: 'position'`, and `resolveSelfBinding` re-derives that
   * evidence from the trial clone's transcript by matching
   * `/\[(local_\d+)\]/` — so a self participant called anything else has its
   * binding REVOKED on the first live turn and every
   * `must_have: {"assignee":"self"}` expectation grades as a miss, silently.
   */
  it('is refused on create when it is not local_1, before any write', async () => {
    const { supabase } = callerMock([{ data: { id: SUITE_ID }, error: null }])
    const registered = register(supabase)

    const result = await registered.get('ni_create_eval_case')!.handler({
      suite_id: SUITE_ID,
      name: 'Prospect stalls on pricing',
      script: [{ t_ms: 0, speaker: 'Me', stream: 'mic', text: 'hey' }],
      participants: [{ speaker_label: 'Me', display: 'Liam', is_self: true }],
      expected: {},
    })

    expect(result.isError).toBe(true)
    expect(payload(result).code).toBe('INVALID_SELF_LABEL')
    expect(payload(result).error).toContain('local_1')
    expect(hoisted.createEvalCase).not.toHaveBeenCalled()
  })

  it('is refused on update too — the same mislabel arrives through either door', async () => {
    const { supabase } = callerMock([{ data: { id: CASE_ID }, error: null }])
    const registered = register(supabase)

    const result = await registered.get('ni_update_eval_case')!.handler({
      case_id: CASE_ID,
      participants: [{ speaker_label: 'mic_a', display: 'Liam', is_self: true }],
    })

    expect(result.isError).toBe(true)
    expect(payload(result).code).toBe('INVALID_SELF_LABEL')
    expect(hoisted.updateEvalCase).not.toHaveBeenCalled()
  })

  it('accepts local_1', async () => {
    const { supabase } = callerMock([{ data: { id: SUITE_ID }, error: null }])
    hoisted.createEvalCase.mockResolvedValue(CASE_ROW)
    const registered = register(supabase)

    const result = await registered.get('ni_create_eval_case')!.handler({
      suite_id: SUITE_ID,
      name: 'Prospect stalls on pricing',
      script: SCRIPT,
      participants: PARTICIPANTS,
      expected: {},
    })

    expect(result.isError).toBeUndefined()
  })
})

describe('the expected schema is strict', () => {
  /**
   * An open record was the old shape. Every key in the contract is optional,
   * so a misspelled one ("proposal" for "proposals") validated, was stored
   * verbatim, and graded as an EMPTY expectation — the case passes because it
   * expects nothing, and no screen shows it. The route schemas were made
   * `.strict()` for exactly this; the MCP door has to be too.
   *
   * Asserted against the REGISTERED shape rather than through the handler,
   * because the real MCP server validates with it and the fake one here does
   * not.
   */
  function expectedSchema(name: string) {
    const registered = register(callerMock([]).supabase)
    return registered.get(name)!.shape.expected as {
      safeParse: (v: unknown) => { success: boolean }
    }
  }

  for (const [name, schema] of [
    ['ni_create_eval_case', () => expectedSchema('ni_create_eval_case')],
    ['ni_update_eval_case', () => expectedSchema('ni_update_eval_case')],
  ] as const) {
    it(`${name} rejects a misspelled expectation key`, () => {
      const s = schema()
      expect(
        s.safeParse({ proposal: [], forbidden_proposal: [] }).success,
        'a typo must not validate',
      ).toBe(false)
    })

    it(`${name} still accepts the real contract`, () => {
      const s = schema()
      expect(
        s.safeParse({
          proposals: [
            {
              key: 'send_questionnaire',
              entity_type: 'action',
              change_type: 'create',
              gist: 'Send Dana the security questionnaire',
              must_have: { assignee: 'self' },
              severity: 'gate',
            },
          ],
          forbidden_proposals: [{ key: 'no_dana_owner', gist: 'Any commitment Dana owns' }],
          summary: 'Names the pricing objection.',
          tools: { must_call: ['propose_change'] },
        }).success,
      ).toBe(true)
    })
  }
})
