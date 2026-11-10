/**
 * /api/cron/prospecting-prune — the weekly retention sweep (spec §3).
 *
 * The sweep deletes rows, so the interesting assertions are all about what it
 * REFUSES to touch. A retention job that is slightly too eager is much worse
 * than one that is slightly too slow: an over-broad filter would silently
 * delete a live run's ledger mid-run, or a user's saved entries.
 *
 * What is pinned here:
 *   1. Only `prospect_run_candidate` is ever deleted — never an entry, never a
 *      run row (the monthly ceiling sums those; deleting one makes a month's
 *      spend appear to shrink).
 *   2. TERMINAL runs only, and `canceling` is NOT terminal: the engine still
 *      owns that row and writes the final status itself.
 *   3. `finished_at` is the retention clock, at 90 days, and a terminal run
 *      with no finish stamp is left alone rather than guessed at.
 *   4. The DELETE is BATCHED and bounded, so a backlog cannot become one long
 *      lock on the table a live run is writing to.
 *   5. Cron auth runs BEFORE anything reads or deletes.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'

interface Captured {
  table: string
  op: 'select' | 'delete'
  filters: Array<{ method: string; args: unknown[] }>
}

const hoisted = vi.hoisted(() => ({
  queries: [] as Captured[],
  /** Ids the stale-run query answers with. */
  staleRunIds: [] as string[],
  /** Rows one DELETE reports as removed, by call index. */
  deleteError: null as { message: string } | null,
  failNthDelete: -1,
  deleteCalls: 0,
}))

vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from(table: string) {
      const q: Captured = { table, op: 'select', filters: [] }
      hoisted.queries.push(q)
      const chain =
        (name: string) =>
        (...args: unknown[]) => {
          q.filters.push({ method: name, args })
          return builder
        }
      const settle = async () => {
        if (q.op === 'delete') {
          const index = hoisted.deleteCalls++
          if (hoisted.failNthDelete === index) {
            return { data: null, error: { message: 'delete boom' } }
          }
          // One candidate row per run in the chunk, so the count is checkable.
          const ids = (q.filters.find((f) => f.method === 'in')?.args[1] ?? []) as string[]
          return { data: ids.map((id) => ({ id: `cand-${id}` })), error: null }
        }
        if (hoisted.deleteError) return { data: null, error: hoisted.deleteError }
        return { data: hoisted.staleRunIds.map((id) => ({ id })), error: null }
      }
      const builder: Record<string, unknown> = {
        select: (...args: unknown[]) => {
          q.filters.push({ method: 'select', args })
          // A DELETE ... .select('id') must still settle as the deleted rows.
          return q.op === 'delete' ? { then: (f: (v: unknown) => unknown) => settle().then(f) } : builder
        },
        delete: () => {
          q.op = 'delete'
          return builder
        },
        in: chain('in'),
        not: chain('not'),
        lt: chain('lt'),
        order: chain('order'),
        limit: chain('limit'),
        then: (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) => settle().then(f, r),
      }
      return builder
    },
  }),
}))

const { GET } = await import('@/app/api/cron/prospecting-prune/route')

function req(bearer = 'Bearer test-secret'): Request {
  return new Request('https://nativeintelligence.dev/api/cron/prospecting-prune', {
    method: 'GET',
    headers: { authorization: bearer },
  })
}

/** Every argument list a filter method was called with, on one query. */
function args(q: Captured, method: string): unknown[][] {
  return q.filters.filter((f) => f.method === method).map((f) => f.args)
}

const runQuery = () => hoisted.queries.find((q) => q.table === 'prospecting_run')!
const deletes = () => hoisted.queries.filter((q) => q.op === 'delete')

beforeEach(() => {
  hoisted.queries.length = 0
  hoisted.staleRunIds = []
  hoisted.deleteError = null
  hoisted.failNthDelete = -1
  hoisted.deleteCalls = 0
  process.env.CRON_SECRET = 'test-secret'
})

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('cron auth gate', () => {
  it('401s a wrong bearer without reading or deleting anything', async () => {
    const res = await GET(req('Bearer nope') as never)
    expect(res.status).toBe(401)
    expect(hoisted.queries).toHaveLength(0)
  })

  it('401s a missing bearer', async () => {
    const res = await GET(
      new Request('https://nativeintelligence.dev/api/cron/prospecting-prune') as never,
    )
    expect(res.status).toBe(401)
    expect(hoisted.queries).toHaveLength(0)
  })

  it('503s when CRON_SECRET is unset — fails CLOSED', async () => {
    delete process.env.CRON_SECRET
    const res = await GET(req() as never)
    expect(res.status).toBe(503)
    expect(hoisted.queries).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// What is selected
// ---------------------------------------------------------------------------

describe('the stale-run filter', () => {
  it('selects only TERMINAL runs, and canceling is NOT one', async () => {
    await GET(req() as never)
    const statuses = args(runQuery(), 'in').find(([col]) => col === 'status')![1] as string[]

    for (const terminal of ['completed', 'failed', 'canceled', 'budget_exhausted']) {
      expect(statuses, terminal).toContain(terminal)
    }
    // The engine still owns a `canceling` row and writes the terminal status
    // itself; pruning under it would delete the partial results a cancel
    // exists to preserve.
    for (const live of ['queued', 'running', 'needs_input', 'canceling']) {
      expect(statuses, live).not.toContain(live)
    }
  })

  it('ages on finished_at at 90 days, not on created_at', async () => {
    // A run that queued in March and ran in June is 90 days past useful in
    // September, not in June.
    const before = Date.now()
    const res = await GET(req() as never)
    const body = await res.json()

    const [column, cutoff] = args(runQuery(), 'lt')[0] as [string, string]
    expect(column).toBe('finished_at')
    expect(cutoff).toBe(body.cutoff)
    const ageMs = before - Date.parse(cutoff)
    expect(ageMs).toBeGreaterThan(89.9 * 24 * 60 * 60 * 1000)
    expect(ageMs).toBeLessThan(90.1 * 24 * 60 * 60 * 1000)
    expect(args(runQuery(), 'lt')).toHaveLength(1)
  })

  it('leaves a terminal run with NO finish stamp alone rather than guessing', async () => {
    await GET(req() as never)
    expect(args(runQuery(), 'not')).toContainEqual(['finished_at', 'is', null])
  })

  it('bounds and orders the run page — oldest first', async () => {
    await GET(req() as never)
    expect(args(runQuery(), 'limit')[0]).toEqual([500])
    expect(args(runQuery(), 'order')[0]).toEqual(['finished_at', { ascending: true }])
  })
})

// ---------------------------------------------------------------------------
// What is deleted
// ---------------------------------------------------------------------------

describe('the delete', () => {
  it('does nothing at all when no run is stale', async () => {
    const res = await GET(req() as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: true,
      stale_runs: 0,
      runs_pruned: 0,
      candidates_deleted: 0,
      batches: 0,
      truncated: false,
    })
    expect(deletes()).toHaveLength(0)
  })

  it('deletes ONLY prospect_run_candidate rows', async () => {
    hoisted.staleRunIds = ['run-1', 'run-2']
    await GET(req() as never)
    // Never an entry, never the run row: entries are the user's work and the
    // run row is what the monthly ceiling sums.
    expect(deletes().map((q) => q.table)).toEqual(['prospect_run_candidate'])
    for (const table of ['prospect_list_entry', 'prospecting_run', 'prospect_list']) {
      expect(hoisted.queries.filter((q) => q.table === table && q.op === 'delete')).toHaveLength(0)
    }
  })

  it('scopes each delete to the stale run ids and counts what it removed', async () => {
    hoisted.staleRunIds = ['run-1', 'run-2', 'run-3']
    const body = await (await GET(req() as never)).json()

    expect(deletes()).toHaveLength(1)
    expect(args(deletes()[0], 'in')[0]).toEqual(['run_id', ['run-1', 'run-2', 'run-3']])
    expect(body).toMatchObject({
      ok: true,
      stale_runs: 3,
      runs_pruned: 3,
      candidates_deleted: 3,
      batches: 1,
      truncated: false,
    })
  })

  it('BATCHES a large backlog rather than issuing one huge statement', async () => {
    // A single unbounded DELETE over every stale run is a long lock on the hot
    // path of any live run writing its ledger.
    hoisted.staleRunIds = Array.from({ length: 120 }, (_, i) => `run-${i}`)
    const body = await (await GET(req() as never)).json()

    expect(deletes()).toHaveLength(3)
    for (const q of deletes()) {
      const ids = args(q, 'in')[0][1] as string[]
      expect(ids.length).toBeLessThanOrEqual(50)
    }
    // Every id lands in exactly one batch — no gaps, no repeats.
    const seen = deletes().flatMap((q) => args(q, 'in')[0][1] as string[])
    expect(seen).toEqual(hoisted.staleRunIds)
    expect(body).toMatchObject({ batches: 3, runs_pruned: 120, candidates_deleted: 120 })
  })

  it('reports truncated when the run page came back full', async () => {
    // 500 rows is the page size, so there may be more behind it. Weekly at a
    // bounded rate still drains a backlog; the flag says so out loud.
    hoisted.staleRunIds = Array.from({ length: 500 }, (_, i) => `run-${i}`)
    const body = await (await GET(req() as never)).json()
    expect(body.truncated).toBe(true)
  })

  it('stops at the per-tick delete ceiling and leaves the rest for next week', async () => {
    // The ceiling is the LIVE bound on the work, not slack behind the page
    // size: 8 chunks × 50 runs = 400 of the 500 resolved, and the remaining
    // 100 are reported as truncated rather than deleted under a long lock.
    // Pinned exactly, because a ceiling that can never be hit is a comment.
    hoisted.staleRunIds = Array.from({ length: 500 }, (_, i) => `run-${i}`)
    const body = await (await GET(req() as never)).json()

    expect(body.batches).toBe(8)
    expect(body.runs_pruned).toBe(400)
    expect(body.truncated).toBe(true)
    // The untouched runs are genuinely untouched — no DELETE named them, so
    // the next tick finds them still stale rather than silently skipped.
    const seen = deletes().flatMap((q) => args(q, 'in')[0][1] as string[])
    expect(seen).toHaveLength(400)
    expect(seen).toEqual(hoisted.staleRunIds.slice(0, 400))
  })

  it('500s on the run query failure without deleting anything', async () => {
    hoisted.deleteError = { message: 'boom' }
    const res = await GET(req() as never)
    expect(res.status).toBe(500)
    expect(deletes()).toHaveLength(0)
  })

  it('keeps going after one bad batch, and says ok:false', async () => {
    // The chunks are independent and the sweep is idempotent, so abandoning
    // the tick would just defer the same work by a week for no benefit.
    hoisted.staleRunIds = Array.from({ length: 120 }, (_, i) => `run-${i}`)
    hoisted.failNthDelete = 1
    const body = await (await GET(req() as never)).json()

    expect(body.ok).toBe(false)
    expect(body.batches).toBe(3)
    // The two surviving chunks still pruned their runs.
    expect(body.runs_pruned).toBe(70)
    expect(body.candidates_deleted).toBe(70)
  })

  it('is idempotent — a second tick with nothing stale is a clean no-op', async () => {
    hoisted.staleRunIds = ['run-1']
    await GET(req() as never)
    hoisted.queries.length = 0
    hoisted.staleRunIds = []
    const body = await (await GET(req() as never)).json()
    expect(body).toMatchObject({ ok: true, candidates_deleted: 0, batches: 0 })
  })
})

// ---------------------------------------------------------------------------
// The schedule
// ---------------------------------------------------------------------------

describe('vercel.json registers the sweep', () => {
  it('runs it weekly, and is the ONLY thing that makes it run at all', () => {
    // Native Inngest cron triggers are banned in this codebase, so this entry
    // is the whole scheduler. Without it the route is live, correct, and never
    // invoked — the ledger grows forever and nothing anywhere says so.
    const vercel = JSON.parse(
      readFileSync(join(process.cwd(), 'vercel.json'), 'utf8'),
    ) as { crons: Array<{ path: string; schedule: string }> }

    const entry = vercel.crons.find((c) => c.path === '/api/cron/prospecting-prune')
    expect(entry).toBeDefined()
    // Sunday 04:00 UTC: weekly is plenty for a 90-day window, and the hour is
    // off the peak the other sweeps share.
    expect(entry!.schedule).toBe('0 4 * * 0')
  })
})
