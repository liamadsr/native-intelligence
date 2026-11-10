/**
 * Tests for GET /api/cron/index-reconciler — the summary-timing-race self-heal.
 *
 * Invariants locked in:
 *  - Cron auth gate: 503 without CRON_SECRET, 401 on a bad bearer, and neither
 *    touches the DB.
 *  - Straggler detection is INDEPENDENT per gap: a capture missing capture_chunks
 *    OR missing capture-citing claim_source rows is a straggler (either alone).
 *  - Exclusions: demo captures, captures inside the 2h grace window, and captures
 *    whose ai_summary is under MIN_SUMMARY_CHARS never qualify.
 *  - Oldest-first batch cap of 25 per run, over a 30-day lookback: 7 days let a
 *    repeatedly-failing capture age out permanently, and a cap of 10 starved the
 *    tail of an 11-straggler backlog every run.
 *  - The SHARED helper (indexCaptureFinished) is invoked to heal — the cron does
 *    NOT duplicate the index-content logic — with the capture OWNER as the acting
 *    user and the row's workspace/project/TITLE (the title feeds the indexed
 *    summary chunk, so the cron must select it).
 *  - A straggler older than ~26h (survived a full day of hourly runs) triggers a
 *    loud grep-able [index-reconciler] warning.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

// getServiceClient is called inside GET; each test swaps in a fresh fake DB.
let dbFake: unknown = null
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => dbFake,
}))

// The route imports MIN_SUMMARY_CHARS from capture-ingest.ts, whose module load
// defines an Inngest function — stub createFunction so the import chain doesn't
// throw (same reason as the index-content suite).
vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: vi.fn(), createFunction: vi.fn(() => ({})) },
}))

// Spy on the shared helper so we assert it's invoked (not duplicated logic) and
// avoid real embedding/Inngest calls. Keep the real MIN_SUMMARY_CHARS export.
const hoisted = vi.hoisted(() => ({
  indexCaptureFinished: vi.fn(async (..._args: unknown[]) => ({ chunksCreated: 2 })),
}))
vi.mock('@/lib/ai/index-capture-finished', () => ({
  indexCaptureFinished: hoisted.indexCaptureFinished,
}))

const { GET, POST } = await import('@/app/api/cron/index-reconciler/route')

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const LONG_SUMMARY = 'A real meeting summary. '.repeat(20) // ~480 chars

function agoIso(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

type CaptureRow = {
  id: string
  user_id?: string | null
  workspace_id?: string | null
  project_id?: string | null
  title?: string | null
  ai_summary?: string | null
  content?: string | null
  metadata?: unknown
  created_at: string
  ended_at?: string | null
}

/**
 * Multi-table fake honoring the exact query shapes the route issues:
 *  - captures: .gte('created_at').lte('created_at').not('ai_summary','is',null)
 *              .or('metadata->>demo.is.null,metadata->>demo.neq.true').order('created_at')
 *  - capture_chunks: .select('capture_id').in('capture_id', ids)
 *  - claim_source: .select('source_id').eq('source_type','capture').in('source_id', ids)
 *
 * `chunkFor` / `claimFor` are the sets of capture ids that HAVE chunks / claims.
 */
function makeSupabase(opts: {
  captures: CaptureRow[]
  chunkFor?: string[]
  claimFor?: string[]
  /** Table whose read answers with an error. */
  failTable?: string
}) {
  const chunkFor = new Set(opts.chunkFor ?? [])
  const claimFor = new Set(opts.claimFor ?? [])

  function capturesBuilder() {
    const gte: Array<[string, string]> = []
    const lte: Array<[string, string]> = []
    const notNull: string[] = []
    const ors: string[] = []
    const orderKeys: Array<[string, boolean]> = []

    const api: Record<string, unknown> = {
      select: () => api,
      gte: (k: string, v: string) => {
        gte.push([k, v])
        return api
      },
      lte: (k: string, v: string) => {
        lte.push([k, v])
        return api
      },
      not: (k: string, _op: string, _v: unknown) => {
        notNull.push(k)
        return api
      },
      or: (expr: string) => {
        ors.push(expr)
        return api
      },
      order: (k: string, o?: { ascending?: boolean }) => {
        orderKeys.push([k, o?.ascending !== false])
        return api
      },
      range: (from: number, to: number) => {
        rangeBounds = [from, to]
        return api
      },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(term()).then(resolve),
    }
    let rangeBounds: [number, number] | null = null

    function match(r: CaptureRow): boolean {
      for (const [k, v] of gte) {
        if (String((r as Record<string, unknown>)[k]) < v) return false
      }
      for (const [k, v] of lte) {
        if (String((r as Record<string, unknown>)[k]) > v) return false
      }
      for (const k of notNull) {
        if ((r as Record<string, unknown>)[k] == null) return false
      }
      for (const expr of ors) {
        // SQL three-valued logic: a bare `metadata->>demo <> 'true'` is NULL
        // (row excluded) when the key is absent, so the route must OR in
        // `is.null`. Only this exact expression is honoured; anything else
        // excludes the row so a regression to a bare filter fails loudly.
        const demo = (r.metadata as { demo?: unknown } | null)?.demo
        const demoStr = demo === true || demo === 'true' ? 'true' : demo == null ? null : String(demo)
        if (expr !== 'metadata->>demo.is.null,metadata->>demo.neq.true') return false
        if (demoStr === 'true') return false
      }
      return true
    }

    function term() {
      let out = opts.captures.filter(match)
      // Reverse + stable sort = lexicographic over the order keys.
      for (const [k, asc] of [...orderKeys].reverse()) {
        out = [...out].sort((a, b) => {
          const av = String((a as Record<string, unknown>)[k])
          const bv = String((b as Record<string, unknown>)[k])
          return asc ? av.localeCompare(bv) : bv.localeCompare(av)
        })
      }
      if (rangeBounds) out = out.slice(rangeBounds[0], rangeBounds[1] + 1)
      return { data: out.map((r) => ({ ...r })), error: null }
    }
    return api
  }

  function projectionBuilder(rows: () => Array<Record<string, unknown>>, fail = false) {
    const eqs: Array<[string, unknown]> = []
    let inCol: string | null = null
    let inVals: unknown[] = []
    const api: Record<string, unknown> = {
      select: () => api,
      eq: (k: string, v: unknown) => {
        eqs.push([k, v])
        return api
      },
      in: (k: string, v: unknown[]) => {
        inCol = k
        inVals = v
        return api
      },
      order: () => api,
      range: () => api,
      then: (resolve: (v: unknown) => unknown) => {
        const filtered = rows().filter((r) => {
          if (!eqs.every(([k, v]) => r[k] === v)) return false
          if (inCol && !inVals.includes(r[inCol])) return false
          return true
        })
        if (fail) return Promise.resolve({ data: null, error: { message: 'URI too long' } }).then(resolve)
        return Promise.resolve({ data: filtered, error: null }).then(resolve)
      },
    }
    return api
  }

  return {
    from: (table: string) => {
      if (table === 'captures') return capturesBuilder()
      if (table === 'capture_chunks') {
        return projectionBuilder(
          () => [...chunkFor].map((id) => ({ capture_id: id })),
          opts.failTable === 'capture_chunks',
        )
      }
      if (table === 'claim_source') {
        return projectionBuilder(
          () => [...claimFor].map((id) => ({ source_id: id, source_type: 'capture' })),
          opts.failTable === 'claim_source',
        )
      }
      throw new Error(`unexpected table ${table}`)
    },
  } as never
}

function request(bearer?: string): NextRequest {
  return new NextRequest('https://nativeintelligence.dev/api/cron/index-reconciler', {
    headers: bearer !== undefined ? { authorization: bearer } : {},
  })
}

/** A healthy candidate: recent, past grace, real summary, owned, not demo. */
function candidate(over: Partial<CaptureRow> & { id: string }): CaptureRow {
  return {
    user_id: 'owner-1',
    workspace_id: 'ws-1',
    project_id: 'proj-1',
    title: 'Weekly Sync',
    ai_summary: LONG_SUMMARY,
    content: null,
    metadata: null,
    created_at: agoIso(3 * HOUR),
    ended_at: agoIso(3 * HOUR),
    ...over,
  }
}

beforeEach(() => {
  hoisted.indexCaptureFinished.mockClear()
  hoisted.indexCaptureFinished.mockResolvedValue({ chunksCreated: 2 })
  vi.stubEnv('CRON_SECRET', 'test-secret')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')
  dbFake = null
})
afterEach(() => {
  vi.unstubAllEnvs()
  dbFake = null
})

describe('GET /api/cron/index-reconciler — cron auth gate', () => {
  it('returns 503 when CRON_SECRET is unset (never touches the DB)', async () => {
    vi.stubEnv('CRON_SECRET', '')
    dbFake = makeSupabase({ captures: [] })
    const res = await GET(request('Bearer whatever'))
    expect(res.status).toBe(503)
    expect(hoisted.indexCaptureFinished).not.toHaveBeenCalled()
  })

  it('returns 401 with a missing bearer', async () => {
    dbFake = makeSupabase({ captures: [] })
    const res = await GET(request())
    expect(res.status).toBe(401)
    expect(hoisted.indexCaptureFinished).not.toHaveBeenCalled()
  })

  it('returns 401 with a wrong bearer', async () => {
    dbFake = makeSupabase({ captures: [] })
    const res = await GET(request('Bearer nope'))
    expect(res.status).toBe(401)
    expect(hoisted.indexCaptureFinished).not.toHaveBeenCalled()
  })

  it('exports POST as an alias of GET so manual curl-triggering works', () => {
    expect(POST).toBe(GET)
  })
})

describe('GET /api/cron/index-reconciler — straggler detection', () => {
  it('heals a capture missing ONLY chunks (has claims)', async () => {
    const cap = candidate({ id: 'cap-chunks' })
    dbFake = makeSupabase({ captures: [cap], chunkFor: [], claimFor: ['cap-chunks'] })
    const res = await GET(request('Bearer test-secret'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, candidates: 1, stragglers: 1, healed: 1 })
    expect(hoisted.indexCaptureFinished).toHaveBeenCalledOnce()
  })

  it('heals a capture missing ONLY claims (has chunks)', async () => {
    const cap = candidate({ id: 'cap-claims' })
    dbFake = makeSupabase({ captures: [cap], chunkFor: ['cap-claims'], claimFor: [] })
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(body).toMatchObject({ stragglers: 1, healed: 1 })
    expect(hoisted.indexCaptureFinished).toHaveBeenCalledOnce()
  })

  it('leaves a fully-indexed capture alone (has both chunks and claims)', async () => {
    const cap = candidate({ id: 'cap-ok' })
    dbFake = makeSupabase({ captures: [cap], chunkFor: ['cap-ok'], claimFor: ['cap-ok'] })
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(body).toMatchObject({ candidates: 1, stragglers: 0, healed: 0 })
    expect(hoisted.indexCaptureFinished).not.toHaveBeenCalled()
  })

  it('invokes the shared helper with the capture OWNER and the row workspace/project/title', async () => {
    const cap = candidate({
      id: 'cap-1',
      user_id: 'owner-9',
      workspace_id: 'ws-9',
      project_id: 'proj-9',
      title: 'APIM — mapping file configuration',
      content: 'Full transcript body.',
    })
    dbFake = makeSupabase({ captures: [cap], chunkFor: [], claimFor: [] })
    await GET(request('Bearer test-secret'))
    expect(hoisted.indexCaptureFinished).toHaveBeenCalledOnce()
    const arg = hoisted.indexCaptureFinished.mock.calls[0][0] as {
      captureId: string
      userId: string
      workspaceId: string
      captureRow: {
        workspace_id: string
        project_id: string
        title: string
        ai_summary: string
        content: string
      }
    }
    expect(arg.captureId).toBe('cap-1')
    expect(arg.userId).toBe('owner-9')
    expect(arg.workspaceId).toBe('ws-9')
    expect(arg.captureRow.project_id).toBe('proj-9')
    expect(arg.captureRow.ai_summary).toBe(LONG_SUMMARY)
    // title + content ARE the indexable body — the helper has no other source
    // for them on the cron path (it passes no bare params).
    expect(arg.captureRow.title).toBe('APIM — mapping file configuration')
    expect(arg.captureRow.content).toBe('Full transcript body.')
  })
})

describe('GET /api/cron/index-reconciler — exclusions', () => {
  it('includes a normal capture whose metadata has no demo key', async () => {
    const cap = candidate({ id: 'cap-plain', metadata: {} })
    dbFake = makeSupabase({ captures: [cap], chunkFor: [], claimFor: [] })
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(body).toMatchObject({ candidates: 1 })
  })

  it('excludes demo captures', async () => {
    const cap = candidate({ id: 'cap-demo', metadata: { demo: true } })
    dbFake = makeSupabase({ captures: [cap], chunkFor: [], claimFor: [] })
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(body).toMatchObject({ candidates: 0, stragglers: 0, healed: 0 })
    expect(hoisted.indexCaptureFinished).not.toHaveBeenCalled()
  })

  it('excludes captures younger than the 2h grace window', async () => {
    // created 3h ago (past grace) but ended just 30min ago → still in-flight.
    const cap = candidate({ id: 'cap-fresh-end', created_at: agoIso(3 * HOUR), ended_at: agoIso(30 * 60 * 1000) })
    dbFake = makeSupabase({ captures: [cap], chunkFor: [], claimFor: [] })
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(body).toMatchObject({ candidates: 0, stragglers: 0, healed: 0 })
    expect(hoisted.indexCaptureFinished).not.toHaveBeenCalled()
  })

  it('excludes captures whose ai_summary is under MIN_SUMMARY_CHARS', async () => {
    const cap = candidate({ id: 'cap-short', ai_summary: 'too short' })
    dbFake = makeSupabase({ captures: [cap], chunkFor: [], claimFor: [] })
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(body).toMatchObject({ candidates: 0, stragglers: 0, healed: 0 })
    expect(hoisted.indexCaptureFinished).not.toHaveBeenCalled()
  })

  it('skips a straggler with a null owner (records a failure, no helper call)', async () => {
    const cap = candidate({ id: 'cap-noowner', user_id: null })
    dbFake = makeSupabase({ captures: [cap], chunkFor: [], claimFor: [] })
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(body).toMatchObject({ stragglers: 1, healed: 0, failures: 1 })
    expect(hoisted.indexCaptureFinished).not.toHaveBeenCalled()
  })
})

describe('GET /api/cron/index-reconciler — batch cap + ordering', () => {
  it('caps the batch at 25, oldest first', async () => {
    // 30 stragglers, ages 3..32 hours (all past grace). Oldest 25 heal this run.
    const caps = Array.from({ length: 30 }, (_, i) =>
      candidate({ id: `cap-${i}`, created_at: agoIso((i + 3) * HOUR), ended_at: agoIso((i + 3) * HOUR) }),
    )
    dbFake = makeSupabase({ captures: caps, chunkFor: [], claimFor: [] })
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(body).toMatchObject({ candidates: 30, stragglers: 30, healed: 25 })
    expect(hoisted.indexCaptureFinished).toHaveBeenCalledTimes(25)
    // Oldest first: the 25 healed are the 25 oldest (largest age = cap-29..cap-5).
    const healedIds = hoisted.indexCaptureFinished.mock.calls.map(
      (c) => (c[0] as { captureId: string }).captureId,
    )
    expect(healedIds).toContain('cap-29') // oldest
    expect(healedIds).not.toContain('cap-3') // one of the 5 youngest stragglers
  })

  it('clears an 11-straggler backlog in ONE run (the PROD case that starved rank #11)', async () => {
    const caps = Array.from({ length: 11 }, (_, i) =>
      candidate({ id: `cap-${i}`, created_at: agoIso((i + 3) * HOUR), ended_at: agoIso((i + 3) * HOUR) }),
    )
    dbFake = makeSupabase({ captures: caps, chunkFor: [], claimFor: [] })
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(body).toMatchObject({ stragglers: 11, healed: 11, failures: 0 })
    expect(hoisted.indexCaptureFinished).toHaveBeenCalledTimes(11)
  })
})

describe('GET /api/cron/index-reconciler — 30-day lookback', () => {
  it('still heals a straggler that broke ~3 weeks ago (7 days would have lost it)', async () => {
    const cap = candidate({ id: 'cap-old', created_at: agoIso(21 * DAY), ended_at: agoIso(21 * DAY) })
    dbFake = makeSupabase({ captures: [cap], chunkFor: [], claimFor: [] })
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(body).toMatchObject({ candidates: 1, stragglers: 1, healed: 1 })
    expect(hoisted.indexCaptureFinished).toHaveBeenCalledOnce()
  })

  it('ignores a capture older than the 30-day window', async () => {
    const cap = candidate({ id: 'cap-ancient', created_at: agoIso(45 * DAY), ended_at: agoIso(45 * DAY) })
    dbFake = makeSupabase({ captures: [cap], chunkFor: [], claimFor: [] })
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(body).toMatchObject({ candidates: 0, stragglers: 0, healed: 0 })
    expect(hoisted.indexCaptureFinished).not.toHaveBeenCalled()
  })
})

describe('GET /api/cron/index-reconciler — still-unhealed warning', () => {
  it('warns loudly for a straggler older than ~26h', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cap = candidate({ id: 'cap-stale', created_at: agoIso(2 * DAY), ended_at: agoIso(2 * DAY) })
    dbFake = makeSupabase({ captures: [cap], chunkFor: [], claimFor: [] })
    await GET(request('Bearer test-secret'))
    const warned = warn.mock.calls.some(
      (c) => String(c[0]).includes('[index-reconciler]') && String(c[0]).includes('STILL UNHEALED'),
    )
    expect(warned).toBe(true)
    warn.mockRestore()
  })

  it('does NOT warn for a fresh straggler (created well under 26h ago)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cap = candidate({ id: 'cap-recent', created_at: agoIso(3 * HOUR), ended_at: agoIso(3 * HOUR) })
    dbFake = makeSupabase({ captures: [cap], chunkFor: [], claimFor: [] })
    await GET(request('Bearer test-secret'))
    const warnedStale = warn.mock.calls.some((c) => String(c[0]).includes('STILL UNHEALED'))
    expect(warnedStale).toBe(false)
    warn.mockRestore()
  })
})

describe('GET /api/cron/index-reconciler — per-capture failure isolation', () => {
  it('one helper failure does not abort the run; failures are counted', async () => {
    const caps = [candidate({ id: 'cap-a' }), candidate({ id: 'cap-b' })]
    dbFake = makeSupabase({ captures: caps, chunkFor: [], claimFor: [] })
    hoisted.indexCaptureFinished
      .mockRejectedValueOnce(new Error('embedding boom'))
      .mockResolvedValueOnce({ chunksCreated: 3 })
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(body).toMatchObject({ stragglers: 2, healed: 1, failures: 1 })
    expect(hoisted.indexCaptureFinished).toHaveBeenCalledTimes(2)
  })
})

describe('GET /api/cron/index-reconciler — large candidate sets', () => {
  it('reads gaps for hundreds of candidates in chunks and finds no stragglers when all are indexed', async () => {
    const caps = Array.from({ length: 260 }, (_, i) => candidate({ id: `cap-${i}` }))
    const ids = caps.map((c) => c.id)
    dbFake = makeSupabase({ captures: caps, chunkFor: ids, claimFor: ids })
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(body).toMatchObject({ candidates: 260, stragglers: 0, healed: 0 })
    expect(hoisted.indexCaptureFinished).not.toHaveBeenCalled()
  })

  it.each(['capture_chunks', 'claim_source'])(
    'aborts with 500 and heals nothing when the %s read fails',
    async (failTable) => {
      const cap = candidate({ id: 'cap-1' })
      dbFake = makeSupabase({ captures: [cap], chunkFor: [], claimFor: [], failTable })
      const res = await GET(request('Bearer test-secret'))
      expect(res.status).toBe(500)
      expect(hoisted.indexCaptureFinished).not.toHaveBeenCalled()
    },
  )
})
