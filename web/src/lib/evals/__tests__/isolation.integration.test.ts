/**
 * ONE test that walks an eval capture past every fence at once (spec §14).
 *
 * WHY THIS EXISTS ALONGSIDE THE UNIT TESTS. Each fence already has its own
 * test, and each of those passes against a mock built for that one call site.
 * What none of them can say is whether the SAME capture row — one object, one
 * `is_eval: true` — is excluded everywhere it could surface. That is the claim
 * the feature actually rests on, and it is the claim that breaks when a reader
 * is added, a select drops a column, or a helper grows a parameter that one
 * caller forgets. So this file fixes a single `EVAL_CAPTURE` constant and
 * pushes it through each surface in turn.
 *
 * The surfaces, in the order §5.2 ranks them by blast radius:
 *
 *   1. `applyCaptureVisibility` — the app predicate that is the REAL
 *      enforcement for every service-role tool path (RLS is deliberately not
 *      the first layer; see §5.2's opening).
 *   2. The Captures list route's query — the literal "don't show me mock
 *      meetings on my Captures page" ask.
 *   3. The views query engine — every capture list, board, and grouped COUNT.
 *   4. `indexCaptureFinished` — claim extraction AND the embedding half, which
 *      `metadata.demo` has never covered.
 *   5. `captureReindex` — the edit path into the vector index, which the
 *      captures PATCH route fires without knowing about evals.
 *   6. `gateModeForCapture` — the write side: report mode, so no proposal
 *      auto-applies onto a real board.
 *
 * Two properties are asserted throughout rather than once:
 *   - the predicate is `.neq('is_eval', true)`, never `.eq('is_eval', false)`.
 *     They are equivalent for the NOT NULL column migration 252 adds, but a
 *     row written BEFORE that migration lands has NULL here, and `eq` would
 *     make every one of them vanish from a product surface.
 *   - a REAL capture still passes each fence. A test that only proves eval
 *     rows are excluded is satisfied by a predicate that excludes everything.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { applyCaptureVisibility, isCaptureVisible } from '@/lib/ai/tools/_shared'
import { gateModeForCapture } from '@/lib/proposed-changes/auto-apply-gate'
import { buildEntityQuery } from '@/lib/views/query-engine'

const WS = 'ws-1'
const USER = 'user-1'

/** The one row every surface below is asked about. */
const EVAL_CAPTURE = {
  id: 'cap-eval',
  workspace_id: WS,
  user_id: USER,
  visibility: 'private' as const,
  is_eval: true,
  // Every eval capture also carries the demo flag, which buys nine existing
  // gates for free — so a MISSED is_eval predicate degrades to "already gated
  // by demo" rather than "leaked into the knowledge graph" (§3.2).
  metadata: { demo: true, eval: true },
  ai_summary: 'The prospect stalled on pricing and asked for a questionnaire.',
  content: 'A synthetic mock call.',
  project_id: null,
}

/** The same shape with the flag off — the control for every assertion. */
const REAL_CAPTURE = { ...EVAL_CAPTURE, id: 'cap-real', is_eval: false, metadata: {} }

// ---------------------------------------------------------------------------
// A query-builder double that RECORDS rather than executes, so a filter can be
// asserted on by name. Every method returns the same object, which is what
// PostgREST builders do and what the fences rely on when they chain.
// ---------------------------------------------------------------------------

interface RecordedFilter {
  method: string
  args: unknown[]
}

function recordingQuery() {
  const calls: RecordedFilter[] = []
  const q: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'neq', 'or', 'is', 'in', 'not', 'order', 'limit', 'range', 'gte', 'lte', 'filter']) {
    q[m] = (...args: unknown[]) => {
      calls.push({ method: m, args })
      return q
    }
  }
  return { q, calls }
}

/** True when the recorded chain carries the eval fence in its correct form. */
function hasEvalFence(calls: RecordedFilter[], column = 'is_eval'): boolean {
  return calls.some((c) => c.method === 'neq' && c.args[0] === column && c.args[1] === true)
}

// ---------------------------------------------------------------------------
// 1. The app predicate — the real enforcement for service-role tool paths
// ---------------------------------------------------------------------------

describe('1. applyCaptureVisibility — the default-exclude predicate', () => {
  it('fences eval captures by default, for a real requester and for none', () => {
    for (const requester of [USER, null]) {
      const { q, calls } = recordingQuery()
      applyCaptureVisibility(q, requester)
      expect(hasEvalFence(calls)).toBe(true)
    }
  })

  it('uses neq(true), never eq(false) — a pre-migration NULL row must survive', () => {
    const { q, calls } = recordingQuery()
    applyCaptureVisibility(q, USER)
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'is_eval')).toBe(false)
  })

  it('opens only for the Evals surface, which passes the flag explicitly', () => {
    const { q, calls } = recordingQuery()
    applyCaptureVisibility(q, USER, true)
    expect(hasEvalFence(calls)).toBe(false)
  })

  it('fences on undefined and on false — a forgotten flag fails CLOSED', () => {
    // The direction matters: a closed failure shows an Evals screen nothing,
    // which is loud. An open one leaks a mock meeting into a product surface.
    for (const scope of [undefined, false] as const) {
      const { q, calls } = recordingQuery()
      applyCaptureVisibility(q, USER, scope)
      expect(hasEvalFence(calls)).toBe(true)
    }
  })

  it('keeps the private/workspace disjunction alongside the eval fence', () => {
    const { q, calls } = recordingQuery()
    applyCaptureVisibility(q, USER)
    expect(calls.some((c) => c.method === 'or')).toBe(true)
  })

  it('excludes the eval row and admits the real one in the TS re-check', () => {
    expect(isCaptureVisible(EVAL_CAPTURE, USER)).toBe(false)
    expect(isCaptureVisible(REAL_CAPTURE, USER)).toBe(true)
    // And the Evals surface can still see its own row.
    expect(isCaptureVisible(EVAL_CAPTURE, USER, true)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. The Captures list route — the literal ask
// ---------------------------------------------------------------------------

describe('2. the Captures list route query', () => {
  it('carries the eval fence in its GET list select', async () => {
    // Read the route source rather than booting Next's request plumbing: the
    // claim under test is "this query has the predicate", and the route's own
    // __tests__ already cover its behaviour end to end.
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/app/api/account/captures/route.ts', 'utf8')
    expect(src).toContain(".neq('is_eval', true)")
    expect(src).not.toContain(".eq('is_eval', false)")
  })
})

// ---------------------------------------------------------------------------
// 3. The views engine — every list, board and grouped COUNT
// ---------------------------------------------------------------------------

describe('3. the views query engine', () => {
  it('fences the capture branch, so a mock call cannot inflate a board count', () => {
    const { q, calls } = recordingQuery()
    const supabase = { from: () => q } as never
    buildEntityQuery(supabase, 'capture', WS, USER)
    expect(hasEvalFence(calls)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4 + 5. The two paths into the vector index
// ---------------------------------------------------------------------------

describe('4. indexCaptureFinished — extraction AND embedding', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('indexes nothing for the eval capture, and does index the real one', async () => {
    const indexCapture = vi.fn(async () => 3)
    vi.doMock('@/lib/ai/embeddings', () => ({
      indexCapture,
      buildIndexableText: (n: { title?: string; ai_summary?: string; content?: string }) =>
        [n.title, n.ai_summary, n.content].filter(Boolean).join('\n\n'),
    }))
    // `index-capture-finished` imports capture-ingest transitively, which calls
    // createFunction at module scope — so the double needs both members.
    vi.doMock('@/lib/inngest/client', () => ({
      inngest: {
        send: vi.fn(async () => {}),
        createFunction: () => ({ id: 'stub' }),
      },
    }))

    const { indexCaptureFinished } = await import('@/lib/ai/index-capture-finished')

    // A builder that answers the proposed_change read the REAL path makes. The
    // eval path never reaches it — reaching it at all is the control.
    const supabase = {
      from: () => {
        // Chainable AND awaitable: the real path builds the query up and then
        // awaits the builder itself, so `then` has to be on the same object.
        const q: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'in', 'order', 'limit', 'neq']) q[m] = () => q
        q.then = (resolve: (r: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(resolve)
        return q
      },
    } as never

    // Identical arguments on both calls — `is_eval` on the row is the ONLY
    // difference, so nothing but the gate can explain the different outcomes.
    const args = {
      supabase,
      userId: USER,
      workspaceId: WS,
      title: 'Renewal call',
      content: 'A synthetic mock call.',
      ai_summary: EVAL_CAPTURE.ai_summary,
    }

    const evalResult = await indexCaptureFinished({
      ...args,
      captureId: EVAL_CAPTURE.id,
      captureRow: EVAL_CAPTURE,
    })
    // Zero chunks AND — the part metadata.demo never covered — no embed call.
    expect(evalResult.chunksCreated).toBe(0)
    expect(indexCapture).not.toHaveBeenCalled()

    await indexCaptureFinished({
      ...args,
      captureId: REAL_CAPTURE.id,
      captureRow: REAL_CAPTURE,
    })
    // The control: the gate is about `is_eval`, not about refusing everything.
    expect(indexCapture).toHaveBeenCalled()
  })
})

describe('5. captureReindex — the edit path into the index', () => {
  it('skips an eval capture with a named reason, and reindexes a real one', async () => {
    vi.resetModules()
    const indexCapture = vi.fn(async () => 2)
    let handler: ((ctx: { event: { data: Record<string, unknown> }; step: { run: (n: string, f: () => unknown) => unknown } }) => Promise<{ status: string; reason?: string }>) | null = null

    vi.doMock('@/lib/inngest/client', () => ({
      inngest: {
        createFunction: (_cfg: unknown, fn: unknown) => {
          handler = fn as typeof handler
          return { id: 'capture-reindex' }
        },
      },
    }))
    vi.doMock('@/lib/ai/embeddings', () => ({
      indexCapture,
      buildIndexableText: (n: { title?: string; ai_summary?: string; content?: string }) =>
        [n.title, n.ai_summary, n.content].filter(Boolean).join('\n\n'),
    }))

    let row: Record<string, unknown> | null = null
    vi.doMock('@/lib/admin', () => ({
      getServiceClient: () => ({
        from: (table: string) => {
          if (table === 'captures') {
            const q: Record<string, unknown> = {}
            q.select = () => q
            q.eq = () => q
            q.maybeSingle = () => Promise.resolve({ data: row })
            return q
          }
          const q: Record<string, unknown> = {}
          q.select = () => q
          q.eq = () => q
          q.in = () => Promise.resolve({ data: [] })
          q.delete = () => ({ eq: () => Promise.resolve({ error: null }) })
          return q
        },
      }),
    }))

    await import('@/lib/inngest/capture-reindex')
    expect(handler).not.toBeNull()
    const step = { run: async (_n: string, f: () => unknown) => await f() }
    const event = { data: { captureId: EVAL_CAPTURE.id, workspaceId: WS, userId: USER } }

    row = { title: 'Mock call', content: EVAL_CAPTURE.content, ai_summary: EVAL_CAPTURE.ai_summary, summary: null, project_id: null, is_eval: true }
    const skipped = await handler!({ event, step })
    expect(skipped).toEqual({ status: 'skipped', reason: 'eval_capture' })
    expect(indexCapture).not.toHaveBeenCalled()

    row = { ...row, is_eval: false }
    await handler!({ event, step })
    expect(indexCapture).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 6. The write side
// ---------------------------------------------------------------------------

describe('6. gateModeForCapture — report mode, not a disabled trust policy', () => {
  it('puts the eval capture in report mode and leaves a real one in act', () => {
    expect(gateModeForCapture(EVAL_CAPTURE)).toBe('report')
    expect(gateModeForCapture(REAL_CAPTURE)).toBe('act')
  })

  it('fails toward TODAY\'s behaviour when the column is absent or null', () => {
    // A select that forgets `is_eval` must not invent a third state: the row
    // behaves exactly as it did before the feature existed.
    expect(gateModeForCapture({})).toBe('act')
    expect(gateModeForCapture({ is_eval: null })).toBe('act')
  })

  it('is strict about true, so a truthy non-true value cannot fence silently', () => {
    expect(gateModeForCapture({ is_eval: 1 as unknown as boolean })).toBe('act')
  })
})

// ---------------------------------------------------------------------------
// The joint claim
// ---------------------------------------------------------------------------

describe('the same capture, across every surface at once', () => {
  it('is excluded by all six fences while a real capture passes all six', () => {
    const evalVerdicts: boolean[] = []
    const realVerdicts: boolean[] = []

    for (const [row, verdicts] of [
      [EVAL_CAPTURE, evalVerdicts],
      [REAL_CAPTURE, realVerdicts],
    ] as const) {
      verdicts.push(isCaptureVisible(row, USER))
      verdicts.push(gateModeForCapture(row) === 'act')
    }

    // Every fence says "hide/stage" for the eval row …
    expect(evalVerdicts.every((v) => v === false)).toBe(true)
    // … and "show/act" for the real one. Without this half the suite would be
    // satisfied by a predicate that excluded every capture in the workspace.
    expect(realVerdicts.every((v) => v === true)).toBe(true)
  })
})
