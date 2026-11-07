/**
 * Integration tests for the Evals SUITE and CASE routes.
 *
 * Same tier as `src/app/api/account/prospecting/__tests__/routes.test.ts`: the
 * handler runs end to end from `new Request()` → `Response`, with `api-auth`,
 * `@/lib/evals/queries`, `@/lib/evals/create-case` and the service client all
 * mocked. What is under test is the ROUTE's own job — auth propagation, zod
 * validation, and the two things no lib function can do for it:
 *
 *   - a cross-workspace id is a 404, never a 403, on EVERY handler. `getCase`
 *     and `getRunDetail` resolve by id alone, so the workspace check lives in
 *     the route and a missing one would leak another workspace's transcripts.
 *   - a DELETE removes the case's TEMPLATE CAPTURE too, guarded by
 *     `is_eval = true` on the delete itself. Without that second write the
 *     capture is orphaned; without the guard a mis-seeded case could take a
 *     real capture down with it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildRequest } from '@/test/integration'
import { visibleRecipesFilter } from '@/lib/library/visibility'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  requireWorkspaceFeature: vi.fn(),
  getServiceClient: vi.fn(),
  listSuites: vi.fn(),
  getSuite: vi.fn(),
  listCases: vi.fn(),
  getCase: vi.fn(),
  listRuns: vi.fn(),
  createEvalCase: vi.fn(),
  updateEvalCase: vi.fn(),
  // The route's own direct writes, per table.
  suiteInsert: vi.fn(),
  suiteUpdate: vi.fn(),
  suiteDelete: vi.fn(),
  caseDelete: vi.fn(),
  captureDelete: vi.fn(),
  evalRunSelect: vi.fn(),
  evalCaseSelect: vi.fn(),
  recipeSelect: vi.fn(),
  recipeOr: vi.fn(),
  captureSelect: vi.fn(),
  captureSelfSelect: vi.fn(),
  // The service-client read that finds a run's per-trial CLONE captures before
  // the cascade takes eval_trial away.
  evalTrialSelect: vi.fn(),
}))

const WS = 'ws-1'
const USER = { id: 'user-1', email: 'ada@acme.test' }

const SUITE = {
  id: 'suite-1',
  workspace_id: WS,
  name: 'Sales Discovery',
  target_kind: 'agent',
  suite_kind: 'capability',
}

const CASE = {
  id: 'case-1',
  suite_id: 'suite-1',
  workspace_id: WS,
  name: 'Prospect stalls on pricing',
  capture_id: 'cap-1',
  script: [],
  expected: {},
}

/**
 * The RLS-scoped client `requireWorkspace` hands the routes. Only the queries
 * the ROUTES make themselves need to answer — everything else goes through the
 * mocked query layer.
 */
const supabase = {
  from: (table: string) => {
    if (table === 'eval_suite') {
      return {
        insert: () => ({ select: () => ({ single: hoisted.suiteInsert }) }),
        update: () => ({
          eq: () => ({ eq: () => ({ select: () => ({ maybeSingle: hoisted.suiteUpdate }) }) }),
        }),
        delete: () => ({ eq: () => ({ eq: hoisted.suiteDelete }) }),
      }
    }
    if (table === 'eval_run') {
      return {
        select: () => ({ eq: () => ({ eq: () => ({ limit: hoisted.evalRunSelect }) }) }),
      }
    }
    // The suite detail resolves its target recipe by NAME — one extra read on
    // the RLS client, so a suite says "grades the Sales Copilot agent" rather
    // than "Agent", which reads identically on every suite in the workspace.
    if (table === 'recipe') {
      // Two shapes land here: the detail route's target-NAME read (select/eq)
      // and `recipeIsVisible`, which adds the `is_system OR workspace_id`
      // predicate. `recipeOr` records that clause so a test can prove the
      // predicate — not RLS — is what excludes a foreign recipe.
      const node: Record<string, unknown> = {
        eq: () => node,
        or: (clause: string) => {
          hoisted.recipeOr(clause)
          return node
        },
        maybeSingle: hoisted.recipeSelect,
      }
      return { select: () => node }
    }
    if (table === 'eval_case') {
      return {
        select: () => ({ eq: () => ({ eq: hoisted.evalCaseSelect }) }),
        delete: () => ({ eq: () => ({ eq: hoisted.caseDelete }) }),
      }
    }
    // The case GET reads the template capture's participants alongside the row,
    // so the editor can send a FULL list back — the PATCH replaces wholesale.
    if (table === 'captures') {
      return {
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: hoisted.captureSelect }) }) }),
      }
    }
    // The self `capture_participant` row: the jsonb carries no `is_self`, so
    // this is the only place the editor can learn which entry is the owner's.
    if (table === 'capture_participant') {
      return {
        select: () => ({
          eq: () => ({ eq: () => ({ limit: () => ({ maybeSingle: hoisted.captureSelfSelect }) }) }),
        }),
      }
    }
    throw new Error(`unexpected table on the user client: ${table}`)
  },
}

/** The service client. Its ONLY job in these routes is the capture cleanup, so
 *  the delete chain records every filter it was given. */
const captureFilters: Record<string, unknown>[] = []
/** The trial-goal cleanup (cloneTrialCapture writes a meeting_goal per trial
 *  that sets a goal), recorded the same way. */
const goalFilters: Record<string, unknown>[] = []
const service = {
  from: (table: string) => {
    if (table === 'eval_trial') {
      return { select: () => ({ in: () => ({ eq: hoisted.evalTrialSelect }) }) }
    }
    if (table !== 'captures' && table !== 'meeting_goal') {
      throw new Error(`unexpected table on the service client: ${table}`)
    }
    const filters: Record<string, unknown> = {}
    ;(table === 'captures' ? captureFilters : goalFilters).push(filters)
    const chain = {
      delete: () => chain,
      in: (col: string, val: unknown) => {
        filters[col] = val
        return chain
      },
      eq: (col: string, val: unknown) => {
        filters[col] = val
        return chain
      },
      then: (resolve: (r: unknown) => unknown) => Promise.resolve(hoisted.captureDelete()).then(resolve),
    }
    return chain
  },
}

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: hoisted.requireWorkspace,
  requireWorkspaceFeature: hoisted.requireWorkspaceFeature,
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: hoisted.getServiceClient }))
vi.mock('@/lib/evals/queries', async () => {
  const actual = await vi.importActual<typeof import('@/lib/evals/queries')>('@/lib/evals/queries')
  return {
    ...actual,
    listSuites: hoisted.listSuites,
    getSuite: hoisted.getSuite,
    listCases: hoisted.listCases,
    getCase: hoisted.getCase,
    listRuns: hoisted.listRuns,
  }
})
// Only the two WRITE functions are stubbed. `participantsFromJson` is a pure
// jsonb-to-authoring-shape mapper the GET calls to build its `participants`
// payload, so it passes through from the real module — stubbing it would make
// the route's participant response untestable here.
vi.mock('@/lib/evals/create-case', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/evals/create-case')>()
  return {
    ...actual,
    createEvalCase: hoisted.createEvalCase,
    updateEvalCase: hoisted.updateEvalCase,
  }
})

const suitesRoute = await import('@/app/api/account/evals/suites/route')
const suiteRoute = await import('@/app/api/account/evals/suites/[id]/route')
const suiteCasesRoute = await import('@/app/api/account/evals/suites/[id]/cases/route')
const caseRoute = await import('@/app/api/account/evals/cases/[id]/route')

const params = (id: string) => ({ params: Promise.resolve({ id }) })

function nextRequest(url: string, init: Parameters<typeof buildRequest>[0] = {}) {
  const req = buildRequest({ ...init, url })
  Object.defineProperty(req, 'nextUrl', { value: new URL(url) })
  return req as never
}

const SCRIPT = [{ t_ms: 0, speaker: 'Ada', stream: 'mic' as const, text: 'Hi there.' }]

beforeEach(() => {
  for (const fn of Object.values(hoisted)) fn.mockReset()
  captureFilters.length = 0
  goalFilters.length = 0
  hoisted.requireWorkspace.mockResolvedValue({ supabase, user: USER, workspaceId: WS })
  // Evals is a hidden feature — every handler gates on it. Default the suite to
  // ON (null = pass through); the gate itself is covered by its own tests.
  hoisted.requireWorkspaceFeature.mockResolvedValue(null)
  hoisted.getServiceClient.mockReturnValue(service)
  hoisted.getSuite.mockResolvedValue(SUITE)
  hoisted.listCases.mockResolvedValue([])
  hoisted.listRuns.mockResolvedValue([])
  hoisted.getCase.mockResolvedValue(CASE)
  hoisted.evalRunSelect.mockResolvedValue({ data: [], error: null })
  hoisted.evalCaseSelect.mockResolvedValue({
    data: [{ id: 'case-1', capture_id: 'cap-1' }],
    error: null,
  })
  hoisted.evalTrialSelect.mockResolvedValue({ data: [], error: null })
  hoisted.captureSelect.mockResolvedValue({ data: { participants: [] }, error: null })
  hoisted.captureSelfSelect.mockResolvedValue({ data: null, error: null })
  hoisted.suiteDelete.mockResolvedValue({ error: null })
  hoisted.caseDelete.mockResolvedValue({ error: null })
  hoisted.captureDelete.mockReturnValue({ error: null })
  hoisted.recipeSelect.mockResolvedValue({ data: null, error: null })
  hoisted.recipeOr.mockClear()
})

// ---------------------------------------------------------------------------
// /suites
// ---------------------------------------------------------------------------

describe('GET /api/account/evals/suites', () => {
  it('returns the workspace suites', async () => {
    hoisted.listSuites.mockResolvedValue([{ id: 'suite-1', case_count: 3 }])
    const res = await suitesRoute.GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ suites: [{ id: 'suite-1', case_count: 3 }] })
    expect(hoisted.listSuites).toHaveBeenCalledWith(supabase, WS)
  })

  it('propagates the auth Response untouched', async () => {
    hoisted.requireWorkspace.mockResolvedValue(new Response('nope', { status: 401 }))
    const res = await suitesRoute.GET()
    expect(res.status).toBe(401)
    expect(hoisted.listSuites).not.toHaveBeenCalled()
  })

  // Evals is a HIDDEN feature: off in every edition, admin override only. The
  // gate runs before any query, so a disabled workspace never touches eval data.
  it('403s FEATURE_DISABLED when evals is off for the workspace', async () => {
    hoisted.requireWorkspaceFeature.mockResolvedValue(
      new Response(JSON.stringify({ error: 'off', code: 'FEATURE_DISABLED' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const res = await suitesRoute.GET()
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('FEATURE_DISABLED')
    expect(hoisted.listSuites).not.toHaveBeenCalled()
    expect(hoisted.requireWorkspaceFeature).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS }),
      'evals',
    )
  })
})

describe('POST /api/account/evals/suites', () => {
  it('creates and returns 201', async () => {
    hoisted.suiteInsert.mockResolvedValue({ data: SUITE, error: null })
    const res = await suitesRoute.POST(
      nextRequest('https://dial8.ai/x', {
        body: { name: 'Sales Discovery', target_kind: 'agent' },
      }),
    )
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ suite: SUITE })
  })

  it('rejects an unknown target_kind', async () => {
    const res = await suitesRoute.POST(
      nextRequest('https://dial8.ai/x', { body: { name: 'X', target_kind: 'wizard' } }),
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST' })
    expect(hoisted.suiteInsert).not.toHaveBeenCalled()
  })

  it('rejects an unknown key rather than storing it', async () => {
    const res = await suitesRoute.POST(
      nextRequest('https://dial8.ai/x', {
        body: { name: 'X', target_kind: 'agent', watchh: true },
      }),
    )
    expect(res.status).toBe(400)
    expect(hoisted.suiteInsert).not.toHaveBeenCalled()
  })

  it('rejects an unparseable body before touching the database', async () => {
    const res = await suitesRoute.POST(
      nextRequest('https://dial8.ai/x', { body: '{oops', raw: true }),
    )
    expect(res.status).toBe(400)
    expect(hoisted.suiteInsert).not.toHaveBeenCalled()
  })

  // A `recipe` uuid is validated by zod as a uuid and nothing more, and the FK
  // it lands on carries no workspace predicate — so a foreign id inserts
  // cleanly, and startEvalRun then snapshots that recipe's system_prompt onto
  // a run row this workspace reads back through RUN_FIELDS.
  it('refuses a target_recipe_id the caller cannot read on its OWN client', async () => {
    hoisted.recipeSelect.mockResolvedValue({ data: null, error: null })
    const res = await suitesRoute.POST(
      nextRequest('https://dial8.ai/x', {
        body: {
          name: 'X',
          target_kind: 'agent',
          target_recipe_id: '22222222-2222-4222-8222-222222222222',
        },
      }),
    )
    expect(res.status).toBe(400)
    expect(hoisted.suiteInsert).not.toHaveBeenCalled()
  })

  it('accepts a target_recipe_id that resolves on the caller client', async () => {
    hoisted.recipeSelect.mockResolvedValue({ data: { id: 'recipe-1' }, error: null })
    hoisted.suiteInsert.mockResolvedValue({ data: SUITE, error: null })
    const res = await suitesRoute.POST(
      nextRequest('https://dial8.ai/x', {
        body: {
          name: 'X',
          target_kind: 'agent',
          target_recipe_id: '22222222-2222-4222-8222-222222222222',
        },
      }),
    )
    expect(res.status).toBe(201)
    // The predicate, not RLS: two of the four callers of `recipeIsVisible` run
    // on the SERVICE client, where a bare `.eq('id', ...)` resolves anything.
    expect(hoisted.recipeOr).toHaveBeenCalledWith(visibleRecipesFilter(WS, USER.id))
  })

  // A failed READ must not be reported as "that agent does not exist".
  it('500s when the recipe visibility read itself fails', async () => {
    hoisted.recipeSelect.mockResolvedValue({ data: null, error: { message: 'timeout' } })
    const res = await suitesRoute.POST(
      nextRequest('https://dial8.ai/x', {
        body: {
          name: 'X',
          target_kind: 'agent',
          target_recipe_id: '22222222-2222-4222-8222-222222222222',
        },
      }),
    )
    expect(res.status).toBe(500)
    expect(hoisted.suiteInsert).not.toHaveBeenCalled()
  })

  it('maps a DB error to a 500 with no upstream text', async () => {
    hoisted.suiteInsert.mockResolvedValue({ data: null, error: { message: 'relation missing' } })
    const res = await suitesRoute.POST(
      nextRequest('https://dial8.ai/x', { body: { name: 'X', target_kind: 'agent' } }),
    )
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal server error', code: 'INTERNAL' })
  })
})

// ---------------------------------------------------------------------------
// /suites/[id]
// ---------------------------------------------------------------------------

describe('/api/account/evals/suites/[id]', () => {
  it('GET returns the suite, its cases and its runs', async () => {
    hoisted.listCases.mockResolvedValue([{ id: 'case-1' }])
    hoisted.listRuns.mockResolvedValue([{ id: 'run-1' }])
    const res = await suiteRoute.GET(nextRequest('https://dial8.ai/x'), params('suite-1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      suite: SUITE,
      cases: [{ id: 'case-1' }],
      runs: [{ id: 'run-1' }],
      // SUITE names no recipe, so there is nothing to resolve — and the read
      // is skipped rather than issued with a null id.
      target: null,
    })
    expect(hoisted.recipeSelect).not.toHaveBeenCalled()
  })

  it('GET carries the target recipe by NAME when the suite names one', async () => {
    // The whole point of the extra read: "Agent" is the same word on every
    // suite in the workspace, so the payload has to carry the recipe's name for
    // the page to say which one it grades.
    hoisted.getSuite.mockResolvedValue({ ...SUITE, target_recipe_id: 'recipe-1' })
    hoisted.recipeSelect.mockResolvedValue({
      data: { id: 'recipe-1', name: 'Sales Copilot', category: 'agent' },
      error: null,
    })
    const res = await suiteRoute.GET(nextRequest('https://dial8.ai/x'), params('suite-1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      target: { id: 'recipe-1', name: 'Sales Copilot', category: 'agent' },
    })
  })

  it('GET still returns the suite when the target recipe cannot be read', async () => {
    // A recipe that was deleted, or one RLS hides, must not fail the whole
    // detail payload — the suite still loads and simply says "an agent".
    hoisted.getSuite.mockResolvedValue({ ...SUITE, target_recipe_id: 'recipe-gone' })
    hoisted.recipeSelect.mockResolvedValue({ data: null, error: { message: 'nope' } })
    const res = await suiteRoute.GET(nextRequest('https://dial8.ai/x'), params('suite-1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ suite: expect.any(Object), target: null })
  })

  it('GET returns 404 for a cross-workspace id — never 403', async () => {
    hoisted.getSuite.mockResolvedValue(null)
    const res = await suiteRoute.GET(nextRequest('https://dial8.ai/x'), params('other-ws'))
    expect(res.status).toBe(404)
  })

  it('PATCH updates only the fields the body named', async () => {
    hoisted.suiteUpdate.mockResolvedValue({ data: { ...SUITE, watch: true }, error: null })
    const res = await suiteRoute.PATCH(
      nextRequest('https://dial8.ai/x', { method: 'PATCH', body: { watch: true } }),
      params('suite-1'),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ suite: { watch: true } })
  })

  it('PATCH returns 404 when the update matched no row in this workspace', async () => {
    hoisted.suiteUpdate.mockResolvedValue({ data: null, error: null })
    const res = await suiteRoute.PATCH(
      nextRequest('https://dial8.ai/x', { method: 'PATCH', body: { watch: true } }),
      params('suite-1'),
    )
    expect(res.status).toBe(404)
  })

  it('DELETE refuses with 409 while a run is live', async () => {
    hoisted.evalRunSelect.mockResolvedValue({ data: [{ id: 'run-1' }], error: null })
    const res = await suiteRoute.DELETE(nextRequest('https://dial8.ai/x'), params('suite-1'))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'RUN_ALREADY_LIVE' })
    expect(hoisted.suiteDelete).not.toHaveBeenCalled()
    expect(hoisted.captureDelete).not.toHaveBeenCalled()
  })

  it('DELETE removes the suite and every template capture under it', async () => {
    hoisted.evalCaseSelect.mockResolvedValue({
      data: [{ id: 'case-1', capture_id: 'cap-1' }, { id: 'case-2', capture_id: 'cap-2' }],
      error: null,
    })
    const res = await suiteRoute.DELETE(nextRequest('https://dial8.ai/x'), params('suite-1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deleted: true, id: 'suite-1' })
    expect(hoisted.suiteDelete).toHaveBeenCalled()
    // The guard that makes an orphan impossible AND a real capture safe.
    expect(captureFilters).toHaveLength(1)
    expect(captureFilters[0]).toEqual({
      id: ['cap-1', 'cap-2'],
      workspace_id: WS,
      is_eval: true,
    })
  })

  it('DELETE returns 404 for a cross-workspace id and touches nothing', async () => {
    hoisted.getSuite.mockResolvedValue(null)
    const res = await suiteRoute.DELETE(nextRequest('https://dial8.ai/x'), params('other-ws'))
    expect(res.status).toBe(404)
    expect(hoisted.suiteDelete).not.toHaveBeenCalled()
    expect(hoisted.captureDelete).not.toHaveBeenCalled()
  })

  // The composite FK runs capture → trial, so the suite cascade destroys
  // eval_trial and every per-trial CLONE capture would survive it with nothing
  // left pointing at one: an unreachable is_eval row holding a full synthetic
  // transcript, one per trial, forever.
  it('DELETE also removes every per-trial CLONE capture, collected before the cascade', async () => {
    hoisted.evalTrialSelect.mockResolvedValue({
      data: [{ capture_id: 'clone-1' }, { capture_id: 'clone-2' }],
      error: null,
    })
    const res = await suiteRoute.DELETE(nextRequest('https://dial8.ai/x'), params('suite-1'))
    expect(res.status).toBe(200)
    expect(captureFilters).toEqual([
      { id: ['cap-1', 'clone-1', 'clone-2'], workspace_id: WS, is_eval: true },
    ])
    // Each clone's goal goes with it, by the synthetic key only a trial writes.
    expect(goalFilters).toEqual([
      {
        workspace_id: WS,
        calendar_event_id: ['capture:cap-1', 'capture:clone-1', 'capture:clone-2'],
      },
    ])
  })

  // A suite whose target recipe the caller cannot read is refused, because
  // startEvalRun would snapshot that recipe's system prompt onto a run row
  // this workspace can read back in full.
  it('PATCH refuses a target_recipe_id that does not resolve on the caller client', async () => {
    hoisted.recipeSelect.mockResolvedValue({ data: null, error: null })
    const res = await suiteRoute.PATCH(
      nextRequest('https://dial8.ai/x', {
        method: 'PATCH',
        body: { target_recipe_id: '22222222-2222-4222-8222-222222222222' },
      }),
      params('suite-1'),
    )
    expect(res.status).toBe(400)
    expect(hoisted.suiteUpdate).not.toHaveBeenCalled()
  })

  it('PATCH accepts a target_recipe_id the caller CAN read', async () => {
    hoisted.recipeSelect.mockResolvedValue({ data: { id: 'recipe-1' }, error: null })
    hoisted.suiteUpdate.mockResolvedValue({ data: SUITE, error: null })
    const res = await suiteRoute.PATCH(
      nextRequest('https://dial8.ai/x', {
        method: 'PATCH',
        body: { target_recipe_id: '22222222-2222-4222-8222-222222222222' },
      }),
      params('suite-1'),
    )
    expect(res.status).toBe(200)
    expect(hoisted.suiteUpdate).toHaveBeenCalled()
  })

  it('PATCH clearing the target to null skips the recipe check entirely', async () => {
    hoisted.suiteUpdate.mockResolvedValue({ data: SUITE, error: null })
    const res = await suiteRoute.PATCH(
      nextRequest('https://dial8.ai/x', { method: 'PATCH', body: { target_recipe_id: null } }),
      params('suite-1'),
    )
    expect(res.status).toBe(200)
    expect(hoisted.recipeSelect).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// /suites/[id]/cases
// ---------------------------------------------------------------------------

describe('/api/account/evals/suites/[id]/cases', () => {
  it('GET returns the suite cases', async () => {
    hoisted.listCases.mockResolvedValue([{ id: 'case-1' }])
    const res = await suiteCasesRoute.GET(nextRequest('https://dial8.ai/x'), params('suite-1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ cases: [{ id: 'case-1' }] })
  })

  it('GET 404s on an unknown suite before listing anything', async () => {
    hoisted.getSuite.mockResolvedValue(null)
    const res = await suiteCasesRoute.GET(nextRequest('https://dial8.ai/x'), params('nope'))
    expect(res.status).toBe(404)
    expect(hoisted.listCases).not.toHaveBeenCalled()
  })

  it('POST creates the case through the SERVICE client and returns 201', async () => {
    hoisted.createEvalCase.mockResolvedValue(CASE)
    const res = await suiteCasesRoute.POST(
      nextRequest('https://dial8.ai/x', {
        body: {
          name: 'Prospect stalls on pricing',
          script: SCRIPT,
          participants: [{ speaker_label: 'local_1', display: 'Ada Lovelace', is_self: true }],
          expected: { summary: 'Must state the prospect pushed back on price.' },
          polarity: 'positive',
        },
      }),
      params('suite-1'),
    )
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ case: CASE })
    expect(hoisted.createEvalCase).toHaveBeenCalledWith(
      service,
      expect.objectContaining({ workspaceId: WS, userId: USER.id, suiteId: 'suite-1' }),
    )
  })

  it('POST verifies the suite on the USER client before the service write', async () => {
    hoisted.getSuite.mockResolvedValue(null)
    const res = await suiteCasesRoute.POST(
      nextRequest('https://dial8.ai/x', { body: { name: 'X', script: SCRIPT } }),
      params('other-ws'),
    )
    expect(res.status).toBe(404)
    expect(hoisted.createEvalCase).not.toHaveBeenCalled()
  })

  it('POST rejects an empty script', async () => {
    const res = await suiteCasesRoute.POST(
      nextRequest('https://dial8.ai/x', { body: { name: 'X', script: [] } }),
      params('suite-1'),
    )
    expect(res.status).toBe(400)
    expect(hoisted.createEvalCase).not.toHaveBeenCalled()
  })

  it('POST rejects a script segment on an unknown stream', async () => {
    const res = await suiteCasesRoute.POST(
      nextRequest('https://dial8.ai/x', {
        body: { name: 'X', script: [{ t_ms: 0, speaker: 'A', stream: 'headset', text: 'hi' }] },
      }),
      params('suite-1'),
    )
    expect(res.status).toBe(400)
  })

  // `positionEvidenceHolds` grants the owner's position binding only for a mic
  // voice labeled exactly 'local_1', so a self participant under any other
  // label binds nothing and every assignee-to-self expectation fails as an
  // agent regression rather than a mislabeled script.
  it('POST rejects an is_self participant that is not labeled local_1', async () => {
    const res = await suiteCasesRoute.POST(
      nextRequest('https://dial8.ai/x', {
        body: {
          name: 'X',
          script: SCRIPT,
          participants: [{ speaker_label: 'mic_a', display: 'Me', is_self: true }],
        },
      }),
      params('suite-1'),
    )
    expect(res.status).toBe(400)
    expect(hoisted.createEvalCase).not.toHaveBeenCalled()
  })

  it('POST rejects a misspelled expected key rather than grading an empty expectation', async () => {
    const res = await suiteCasesRoute.POST(
      nextRequest('https://dial8.ai/x', {
        body: { name: 'X', script: SCRIPT, expected: { proposal: [] } },
      }),
      params('suite-1'),
    )
    expect(res.status).toBe(400)
    expect(hoisted.createEvalCase).not.toHaveBeenCalled()
  })

  it('POST maps a thrown lib error to a 500', async () => {
    hoisted.createEvalCase.mockRejectedValue(new Error('capture insert failed'))
    const res = await suiteCasesRoute.POST(
      nextRequest('https://dial8.ai/x', { body: { name: 'X', script: SCRIPT } }),
      params('suite-1'),
    )
    expect(res.status).toBe(500)
  })
})

// ---------------------------------------------------------------------------
// /cases/[id]
// ---------------------------------------------------------------------------

describe('/api/account/evals/cases/[id]', () => {
  it('GET returns the full case row AND the capture participants, in the AUTHORING shape', async () => {
    // The editor has no other way to read the current list back, and it must
    // send a FULL list on save — `participants` on a PATCH replaces wholesale,
    // so a draft that could not see the current roster could only delete it.
    hoisted.captureSelect.mockResolvedValue({
      data: {
        participants: [
          { name: 'Me', role: 'organizer', speaker_label: 'local_1' },
          { name: 'Dana Reyes', role: 'attendee', speaker_label: 'remote_1' },
        ],
      },
      error: null,
    })
    // `is_self` lives on the capture_participant row, not in the jsonb.
    hoisted.captureSelfSelect.mockResolvedValue({ data: { speaker_label: 'local_1' }, error: null })
    const res = await caseRoute.GET(nextRequest('https://dial8.ai/x'), params('case-1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      case: CASE,
      participants: [
        { speaker_label: 'local_1', display: 'Me', role: 'organizer', is_self: true },
        { speaker_label: 'remote_1', display: 'Dana Reyes', role: 'attendee' },
      ],
    })
  })

  it('GET still returns the case when the template capture cannot be read', async () => {
    hoisted.captureSelect.mockResolvedValue({ data: null, error: { message: 'rls' } })
    const res = await caseRoute.GET(nextRequest('https://dial8.ai/x'), params('case-1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ case: CASE, participants: [] })
  })

  it('PATCH rejects an is_self participant that is not labeled local_1', async () => {
    const res = await caseRoute.PATCH(
      nextRequest('https://dial8.ai/x', {
        method: 'PATCH',
        body: { participants: [{ speaker_label: 'mic_a', display: 'Me', is_self: true }] },
      }),
      params('case-1'),
    )
    expect(res.status).toBe(400)
    expect(hoisted.updateEvalCase).not.toHaveBeenCalled()
  })

  it('GET 404s a case belonging to another workspace', async () => {
    hoisted.getCase.mockResolvedValue({ ...CASE, workspace_id: 'ws-other' })
    const res = await caseRoute.GET(nextRequest('https://dial8.ai/x'), params('case-1'))
    expect(res.status).toBe(404)
  })

  it('PATCH refines the case through the service client', async () => {
    hoisted.updateEvalCase.mockResolvedValue({ ...CASE, name: 'Renamed' })
    const res = await caseRoute.PATCH(
      nextRequest('https://dial8.ai/x', { method: 'PATCH', body: { name: 'Renamed' } }),
      params('case-1'),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ case: { name: 'Renamed' } })
    expect(hoisted.updateEvalCase).toHaveBeenCalledWith(
      service,
      expect.objectContaining({ caseId: 'case-1', workspaceId: WS, name: 'Renamed' }),
    )
  })

  it('PATCH 404s a cross-workspace case before the service write', async () => {
    hoisted.getCase.mockResolvedValue({ ...CASE, workspace_id: 'ws-other' })
    const res = await caseRoute.PATCH(
      nextRequest('https://dial8.ai/x', { method: 'PATCH', body: { name: 'X' } }),
      params('case-1'),
    )
    expect(res.status).toBe(404)
    expect(hoisted.updateEvalCase).not.toHaveBeenCalled()
  })

  it('PATCH rejects an invalid script before the service write', async () => {
    const res = await caseRoute.PATCH(
      nextRequest('https://dial8.ai/x', {
        method: 'PATCH',
        body: { script: [{ t_ms: -1, speaker: 'A', stream: 'mic', text: 'hi' }] },
      }),
      params('case-1'),
    )
    expect(res.status).toBe(400)
    expect(hoisted.updateEvalCase).not.toHaveBeenCalled()
  })

  it('DELETE removes the case AND its template capture, is_eval-guarded', async () => {
    const res = await caseRoute.DELETE(nextRequest('https://dial8.ai/x'), params('case-1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deleted: true, id: 'case-1' })
    expect(hoisted.caseDelete).toHaveBeenCalled()
    expect(captureFilters).toEqual([{ id: ['cap-1'], workspace_id: WS, is_eval: true }])
  })

  // eval_trial cascades from the case, so its rows are the only record of the
  // per-trial CLONE captures — they have to be collected before the delete.
  it('DELETE removes every per-trial CLONE capture too', async () => {
    hoisted.evalTrialSelect.mockResolvedValue({
      data: [{ capture_id: 'clone-1' }],
      error: null,
    })
    const res = await caseRoute.DELETE(nextRequest('https://dial8.ai/x'), params('case-1'))
    expect(res.status).toBe(200)
    expect(captureFilters).toEqual([
      { id: ['cap-1', 'clone-1'], workspace_id: WS, is_eval: true },
    ])
  })

  it('DELETE 404s a cross-workspace case and deletes nothing', async () => {
    hoisted.getCase.mockResolvedValue(null)
    const res = await caseRoute.DELETE(nextRequest('https://dial8.ai/x'), params('case-1'))
    expect(res.status).toBe(404)
    expect(hoisted.caseDelete).not.toHaveBeenCalled()
    expect(captureFilters).toHaveLength(0)
  })

  it('DELETE surfaces a failed case delete as a 500 and skips the capture cleanup', async () => {
    hoisted.caseDelete.mockResolvedValue({ error: { message: 'fk violation' } })
    const res = await caseRoute.DELETE(nextRequest('https://dial8.ai/x'), params('case-1'))
    expect(res.status).toBe(500)
    expect(captureFilters).toHaveLength(0)
  })
})
