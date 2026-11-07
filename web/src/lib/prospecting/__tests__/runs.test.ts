/**
 * The `prospecting_run` data-access layer: kickoff, history, poll, cancel and
 * the transparency ledger.
 *
 * Everything runs against the recording fake, so the tests assert on the
 * QUERIES as much as the results — the invariant that every read and write
 * carries an explicit `workspace_id` filter is only provable by looking at
 * what was actually sent, and these functions are the ones a service-role
 * caller will reuse.
 *
 * `inngest.send` is mocked. What matters is that the event fires with the
 * contract's name and payload AFTER the row exists — a send before the insert
 * would hand the engine a runId that does not resolve.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase, filterArgs, hasWorkspaceFilter, type Captured } from './fake-supabase'

const hoisted = vi.hoisted(() => ({
  send: vi.fn(),
  service: { tag: 'service-client' },
  mirrorQueued: vi.fn(async () => ({})),
  settleByRun: vi.fn(async () => {}),
}))
// The work-ledger mirror (Sequence row 6) writes with the SERVICE client; its
// own suite covers what it writes. Here: that the run writers call it, when.
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => hoisted.service }))
vi.mock('@/lib/work/prospecting-run-mirror', () => ({
  mirrorProspectingRunQueued: hoisted.mirrorQueued,
  settleProspectingWorkByRun: hoisted.settleByRun,
}))
// Only `inngest` is replaced; the event-name constants come from the real
// module, so the asserted names below are the SAME literals the engine's
// trigger and cancelOn use. A mock that invented its own names would pass
// while the two packages disagreed.
vi.mock('@/lib/inngest/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/inngest/client')>()),
  inngest: { send: hoisted.send },
}))

const { chainProfileRun, createRun, getRun, isLive, listRunCandidates, listRuns, requestCancel } = await import(
  '../runs'
)

const WS = 'ws-1'
const USER = 'user-1'
const LIST = 'list-1'
const RUN = 'run-1'

const LIST_ROW = { id: LIST, status: 'active', icp: { target: { description: 'ops teams' } }, max_spend_dollars: 2 }

function runRow(over: Record<string, unknown> = {}) {
  return {
    id: RUN,
    workspace_id: WS,
    list_id: LIST,
    kind: 'discover',
    round_index: 1,
    status: 'queued',
    stage: 'discover',
    icp_snapshot: {},
    budget_dollars: 2,
    spent_dollars: 0,
    exa_calls: 0,
    progress: {},
    counts: {},
    exclusion_snapshot: {},
    error: null,
    started_by: USER,
    started_at: null,
    finished_at: null,
    created_at: '2026-09-04T00:00:00Z',
    ...over,
  }
}

beforeEach(() => {
  hoisted.send.mockReset()
  hoisted.send.mockResolvedValue({ ids: ['evt-1'] })
  hoisted.mirrorQueued.mockClear()
  hoisted.settleByRun.mockClear()
})

// ---------------------------------------------------------------------------
// isLive
// ---------------------------------------------------------------------------

describe('isLive', () => {
  it('is the AgentRunStatus live set, and budget_exhausted is terminal', () => {
    for (const s of ['queued', 'running', 'needs_input', 'canceling']) {
      expect(isLive(s)).toBe(true)
    }
    // The two deliberate divergences from AgentRunStatus are both TERMINAL, so
    // a poll that treated budget_exhausted as live would spin forever.
    for (const s of ['completed', 'failed', 'canceled', 'budget_exhausted']) {
      expect(isLive(s)).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// createRun
// ---------------------------------------------------------------------------

describe('createRun', () => {
  /** `prospect_list` answers the existence check, `prospecting_run` answers
   *  BOTH the round-index read (a select) and the insert. */
  function world(opts: {
    list?: unknown
    lastRound?: number | null
    insert?: { data?: unknown; error?: { message: string; code?: string } }
  } = {}) {
    return makeFakeSupabase((q: Captured) => {
      if (q.table === 'prospect_list') return { data: opts.list === undefined ? LIST_ROW : opts.list }
      if (q.table === 'prospecting_run') {
        if (q.op === 'insert') return opts.insert ?? { data: runRow() }
        return { data: opts.lastRound == null ? null : { round_index: opts.lastRound } }
      }
      return { data: null }
    })
  }

  it('creates a queued discover run and sends prospecting/run.requested', async () => {
    const { client, queries } = world()
    const out = await createRun(client, { workspaceId: WS, userId: USER, listId: LIST })
    expect(out).toMatchObject({ ok: true })

    const insert = queries.find((q) => q.table === 'prospecting_run' && q.op === 'insert')!
    expect(insert.payload).toMatchObject({
      workspace_id: WS,
      list_id: LIST,
      kind: 'discover',
      status: 'queued',
      stage: 'discover',
      round_index: 1,
      budget_dollars: 2,
      spent_dollars: 0,
      exa_calls: 0,
      exclusion_snapshot: {},
      started_by: USER,
    })
    // The ICP AS RUN — history stays honest about what was actually searched.
    expect((insert.payload as { icp_snapshot: unknown }).icp_snapshot).toEqual(LIST_ROW.icp)

    expect(hoisted.send).toHaveBeenCalledWith({
      name: 'prospecting/run.requested',
      data: { runId: RUN, workspaceId: WS, listId: LIST, userId: USER },
    })
    // One queued Activity row, owned by the starter, before the event goes out.
    expect(hoisted.mirrorQueued).toHaveBeenCalledTimes(1)
    expect(hoisted.mirrorQueued).toHaveBeenCalledWith(hoisted.service, {
      id: RUN,
      workspace_id: WS,
      list_id: LIST,
      kind: 'discover',
      started_by: USER,
    })
    expect(hoisted.mirrorQueued.mock.invocationCallOrder[0]).toBeLessThan(hoisted.send.mock.invocationCallOrder[0])
  })

  it('derives is_live from the returned status', async () => {
    const { client } = world()
    const out = await createRun(client, { workspaceId: WS, userId: USER, listId: LIST })
    expect(out.ok && out.run.is_live).toBe(true)
  })

  it('continues the per-list round counter rather than restarting at 1', async () => {
    const { client, queries } = world({ lastRound: 4, insert: { data: runRow({ round_index: 5 }) } })
    await createRun(client, { workspaceId: WS, userId: USER, listId: LIST })
    const insert = queries.find((q) => q.op === 'insert')!
    expect((insert.payload as { round_index: number }).round_index).toBe(5)
    // Highest first, one row — the counter is monotonic across days.
    const roundRead = queries.find((q) => q.table === 'prospecting_run' && q.op === 'select')!
    expect(filterArgs(roundRead, 'order')).toEqual([['round_index', { ascending: false }]])
  })

  it('maps the one-live-per-list 23505 to RUN_ALREADY_LIVE, not a generic failure', async () => {
    const { client } = world({
      insert: { data: null, error: { message: 'duplicate key', code: '23505' } },
    })
    const out = await createRun(client, { workspaceId: WS, userId: USER, listId: LIST })
    expect(out).toMatchObject({ ok: false, code: 'RUN_ALREADY_LIVE' })
    // Nothing was enqueued: a second press must not bill four searches.
    expect(hoisted.send).not.toHaveBeenCalled()
    // …and no second Activity row for a run that was never created.
    expect(hoisted.mirrorQueued).not.toHaveBeenCalled()
  })

  it('404s a cross-workspace list id without inserting', async () => {
    const { client, queries } = world({ list: null })
    const out = await createRun(client, { workspaceId: WS, userId: USER, listId: LIST })
    expect(out).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(queries.some((q) => q.op === 'insert')).toBe(false)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('refuses an archived list', async () => {
    const { client, queries } = world({ list: { ...LIST_ROW, status: 'archived' } })
    const out = await createRun(client, { workspaceId: WS, userId: USER, listId: LIST })
    expect(out).toMatchObject({ ok: false, code: 'LIST_ARCHIVED' })
    expect(queries.some((q) => q.op === 'insert')).toBe(false)
  })

  it('clamps a budget override to 0.25..20 and falls back to the list budget', async () => {
    for (const [given, expected] of [
      [0, 0.25],
      [999, 20],
      [1.5, 1.5],
      [undefined, 2],
      ['lots', 2],
    ] as const) {
      const { client, queries } = world()
      await createRun(client, { workspaceId: WS, userId: USER, listId: LIST, budgetDollars: given })
      const insert = queries.find((q) => q.op === 'insert')!
      expect((insert.payload as { budget_dollars: number }).budget_dollars).toBe(expected)
    }
  })

  it('reports a send failure rather than returning a run nobody will execute', async () => {
    hoisted.send.mockRejectedValue(new Error('inngest down'))
    const { client } = world()
    const out = await createRun(client, { workspaceId: WS, userId: USER, listId: LIST })
    expect(out).toMatchObject({ ok: false, code: 'DB_ERROR' })
  })

  it('scopes every query to the workspace', async () => {
    const { client, queries } = world()
    await createRun(client, { workspaceId: WS, userId: USER, listId: LIST })
    for (const q of queries.filter((x) => x.op === 'select')) {
      expect(hasWorkspaceFilter(q, WS)).toBe(true)
    }
    const insert = queries.find((q) => q.op === 'insert')!
    expect((insert.payload as { workspace_id: string }).workspace_id).toBe(WS)
  })
})

// ---------------------------------------------------------------------------
// createRun — the three run kinds
// ---------------------------------------------------------------------------

/**
 * `account_card` and `people` runs act on an EXPLICIT selection the user made
 * at the consent gate, and the whole point of validating it here is that a bad
 * selection must never reach the Inngest lane. A run that got that far would
 * already hold the one-live-per-list lock and would surface a plain 400 to the
 * user as a failed run in their history.
 *
 * The four rules, from the contract: `entry_ids` is REQUIRED for both targeted
 * kinds, every id must be a company entry OF THIS LIST that is not dismissed,
 * and there may be at most 50 of them.
 */
describe('createRun — run kinds', () => {
  const A = 'entry-a'
  const B = 'entry-b'

  /** A world whose `prospect_list_entry` read answers with the rows given. */
  function kindWorld(
    entries: Array<{ id: string; kind: string; stage: string }> = [
      { id: A, kind: 'company', stage: 'discovered' },
      { id: B, kind: 'company', stage: 'shortlisted' },
    ],
  ) {
    return makeFakeSupabase((q: Captured) => {
      if (q.table === 'prospect_list') return { data: LIST_ROW }
      if (q.table === 'prospect_list_entry') return { data: entries }
      if (q.table === 'prospecting_run') {
        if (q.op === 'insert') return { data: runRow({ kind: 'account_card' }) }
        return { data: null }
      }
      return { data: null }
    })
  }

  it('stores the kind, the start stage and the selection IN THE USER’S ORDER', async () => {
    const { client, queries } = kindWorld()
    const out = await createRun(client, {
      workspaceId: WS,
      userId: USER,
      listId: LIST,
      kind: 'account_card',
      // Deliberately B first: the engine loops in this order, and the UI's
      // "3 of 18" counts against the list the user actually picked.
      entryIds: [B, A],
    })
    expect(out).toMatchObject({ ok: true })

    const insert = queries.find((q) => q.table === 'prospecting_run' && q.op === 'insert')!
    expect(insert.payload).toMatchObject({
      kind: 'account_card',
      stage: 'account_card',
      target_entry_ids: [B, A],
    })
    // ONE event for all three kinds — the function reads `kind` off the row.
    expect(hoisted.send).toHaveBeenCalledWith({
      name: 'prospecting/run.requested',
      data: { runId: RUN, workspaceId: WS, listId: LIST, userId: USER },
    })
  })

  it('starts a people run at stage `people`', async () => {
    const { client, queries } = kindWorld()
    const out = await createRun(client, {
      workspaceId: WS,
      userId: USER,
      listId: LIST,
      kind: 'people',
      entryIds: [A],
    })
    expect(out).toMatchObject({ ok: true })
    const insert = queries.find((q) => q.op === 'insert')!
    expect(insert.payload).toMatchObject({ kind: 'people', stage: 'people' })
  })

  it('defaults an ABSENT kind to discover with a null selection', async () => {
    const { client, queries } = kindWorld()
    await createRun(client, { workspaceId: WS, userId: USER, listId: LIST })
    const insert = queries.find((q) => q.op === 'insert')!
    expect(insert.payload).toMatchObject({ kind: 'discover', target_entry_ids: null })
    // A discovery run picks its own targets, so it must not read entries.
    expect(queries.some((q) => q.table === 'prospect_list_entry')).toBe(false)
  })

  it('refuses an UNKNOWN kind rather than silently discovering', async () => {
    const { client, queries } = kindWorld()
    const out = await createRun(client, {
      workspaceId: WS,
      userId: USER,
      listId: LIST,
      kind: 'enrich_everything',
      entryIds: [A],
    })
    expect(out).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    expect(queries.some((q) => q.op === 'insert')).toBe(false)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('requires a non-empty selection for a targeted kind', async () => {
    for (const entryIds of [undefined, []]) {
      const { client, queries } = kindWorld()
      const out = await createRun(client, {
        workspaceId: WS,
        userId: USER,
        listId: LIST,
        kind: 'account_card',
        entryIds,
      })
      expect(out).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
      expect(queries.some((q) => q.op === 'insert')).toBe(false)
    }
  })

  it('refuses a selection on a DISCOVER run rather than ignoring it', async () => {
    // Ignoring it would look to the user like it had been honoured.
    const { client, queries } = kindWorld()
    const out = await createRun(client, {
      workspaceId: WS,
      userId: USER,
      listId: LIST,
      kind: 'discover',
      entryIds: [A],
    })
    expect(out).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    expect(queries.some((q) => q.op === 'insert')).toBe(false)
  })

  it('refuses more than 50 ids without reading a single entry', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `entry-${i}`)
    const { client, queries } = kindWorld()
    const out = await createRun(client, {
      workspaceId: WS,
      userId: USER,
      listId: LIST,
      kind: 'account_card',
      entryIds: ids,
    })
    expect(out).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    expect(String(out.ok === false && out.error)).toContain('50')
    expect(queries.some((q) => q.table === 'prospect_list_entry')).toBe(false)
    expect(queries.some((q) => q.op === 'insert')).toBe(false)
  })

  it('accepts exactly 50', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `entry-${i}`)
    const { client } = kindWorld(ids.map((id) => ({ id, kind: 'company', stage: 'discovered' })))
    const out = await createRun(client, {
      workspaceId: WS,
      userId: USER,
      listId: LIST,
      kind: 'account_card',
      entryIds: ids,
    })
    expect(out).toMatchObject({ ok: true })
  })

  it('refuses a FOREIGN entry id — one this list does not hold', async () => {
    // Only A comes back; B belongs to another list or another workspace. It is
    // INVALID_INPUT rather than NOT_FOUND on purpose: distinguishing the two
    // would confirm whether an entry exists in a list the caller cannot see.
    const { client, queries } = kindWorld([{ id: A, kind: 'company', stage: 'discovered' }])
    const out = await createRun(client, {
      workspaceId: WS,
      userId: USER,
      listId: LIST,
      kind: 'account_card',
      entryIds: [A, B],
    })
    expect(out).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    expect(queries.some((q) => q.op === 'insert')).toBe(false)
  })

  it('refuses a DISMISSED entry — the user already said no to it', async () => {
    const { client, queries } = kindWorld([
      { id: A, kind: 'company', stage: 'discovered' },
      { id: B, kind: 'company', stage: 'dismissed' },
    ])
    const out = await createRun(client, {
      workspaceId: WS,
      userId: USER,
      listId: LIST,
      kind: 'account_card',
      entryIds: [A, B],
    })
    expect(out).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    expect(queries.some((q) => q.op === 'insert')).toBe(false)
  })

  it('refuses a PERSON entry — only companies can be researched', async () => {
    const { client, queries } = kindWorld([{ id: A, kind: 'person', stage: 'discovered' }])
    const out = await createRun(client, {
      workspaceId: WS,
      userId: USER,
      listId: LIST,
      kind: 'people',
      entryIds: [A],
    })
    expect(out).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    expect(queries.some((q) => q.op === 'insert')).toBe(false)
  })

  it('rejects a malformed entry_ids value instead of coercing it', async () => {
    for (const entryIds of ['entry-a', [1, 2], [''], [null], {}]) {
      const { client, queries } = kindWorld()
      const out = await createRun(client, {
        workspaceId: WS,
        userId: USER,
        listId: LIST,
        kind: 'account_card',
        entryIds,
      })
      expect(out).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
      expect(queries.some((q) => q.op === 'insert')).toBe(false)
    }
  })

  it('de-duplicates a repeated id rather than researching it twice', async () => {
    const { client, queries } = kindWorld()
    await createRun(client, {
      workspaceId: WS,
      userId: USER,
      listId: LIST,
      kind: 'account_card',
      entryIds: [A, B, A],
    })
    const insert = queries.find((q) => q.op === 'insert')!
    expect((insert.payload as { target_entry_ids: string[] }).target_entry_ids).toEqual([A, B])
  })

  it('scopes the entry read to the workspace AND the list', async () => {
    const { client, queries } = kindWorld()
    await createRun(client, {
      workspaceId: WS,
      userId: USER,
      listId: LIST,
      kind: 'account_card',
      entryIds: [A],
    })
    const read = queries.find((q) => q.table === 'prospect_list_entry')!
    expect(hasWorkspaceFilter(read, WS)).toBe(true)
    expect(filterArgs(read, 'eq')).toContainEqual(['list_id', LIST])
    expect(filterArgs(read, 'in')).toContainEqual(['id', [A]])
  })
})

// ---------------------------------------------------------------------------
// listRuns / getRun
// ---------------------------------------------------------------------------

describe('listRuns', () => {
  it('returns the history newest first with is_live derived', async () => {
    const { client, queries } = makeFakeSupabase((q) =>
      q.table === 'prospect_list'
        ? { data: { id: LIST } }
        : { data: [runRow({ id: 'r2', status: 'running' }), runRow({ id: 'r1', status: 'completed' })] },
    )
    const out = await listRuns(client, { workspaceId: WS, listId: LIST })
    expect(out.ok && out.runs.map((r) => [r.id, r.is_live])).toEqual([
      ['r2', true],
      ['r1', false],
    ])
    const read = queries.find((q) => q.table === 'prospecting_run')!
    expect(filterArgs(read, 'order')).toEqual([['created_at', { ascending: false }]])
    expect(hasWorkspaceFilter(read, WS)).toBe(true)
  })

  it('404s a cross-workspace list rather than reporting an empty history', async () => {
    const { client } = makeFakeSupabase((q) => (q.table === 'prospect_list' ? { data: null } : { data: [] }))
    const out = await listRuns(client, { workspaceId: WS, listId: LIST })
    expect(out).toMatchObject({ ok: false, code: 'NOT_FOUND' })
  })

  it('clamps the limit', async () => {
    const { client, queries } = makeFakeSupabase((q) =>
      q.table === 'prospect_list' ? { data: { id: LIST } } : { data: [] },
    )
    await listRuns(client, { workspaceId: WS, listId: LIST, limit: 5000 })
    const read = queries.find((q) => q.table === 'prospecting_run')!
    expect(filterArgs(read, 'limit')).toEqual([[100]])
  })
})

describe('getRun', () => {
  it('404s a cross-workspace run id', async () => {
    const { client, queries } = makeFakeSupabase(() => ({ data: null }))
    const out = await getRun(client, { workspaceId: WS, runId: RUN })
    expect(out).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(hasWorkspaceFilter(queries[0], WS)).toBe(true)
  })

  it('reports budget_exhausted as terminal', async () => {
    const { client } = makeFakeSupabase(() => ({ data: runRow({ status: 'budget_exhausted' }) }))
    const out = await getRun(client, { workspaceId: WS, runId: RUN })
    expect(out.ok && out.run.is_live).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// requestCancel
// ---------------------------------------------------------------------------

describe('requestCancel', () => {
  /** The first `prospecting_run` query is the read, the second the CAS update. */
  function world(status: string, updated: unknown[] | null = [runRow({ status: 'canceling' })]) {
    let seen = 0
    return makeFakeSupabase((q: Captured) => {
      if (q.table !== 'prospecting_run') return { data: null }
      if (q.op === 'update') return { data: updated }
      seen += 1
      return { data: runRow({ status }) }
    })
  }

  it('flips a running run to canceling and emits prospecting/run.cancel', async () => {
    const { client, queries } = world('running')
    const out = await requestCancel(client, { workspaceId: WS, runId: RUN })
    expect(out).toMatchObject({ ok: true })
    expect(out.ok && out.run.status).toBe('canceling')
    // `canceling` is not terminal; the engine's settle mirrors the outcome.
    expect(hoisted.settleByRun).not.toHaveBeenCalled()

    const update = queries.find((q) => q.op === 'update')!
    expect(update.payload).toEqual({ status: 'canceling' })
    // CAS: the update itself refuses a run that settled in the gap.
    expect(filterArgs(update, 'in')).toEqual([['status', ['queued', 'running']]])
    expect(hasWorkspaceFilter(update, WS)).toBe(true)

    expect(hoisted.send).toHaveBeenCalledWith({
      name: 'prospecting/run.cancel',
      data: { runId: RUN },
    })
  })

  it('settles a QUEUED run straight to canceled — there is no engine to notice canceling', async () => {
    // The engine is the only writer of `canceled`, from its between-units
    // poll, which a run that was never claimed never reaches. Left at
    // `canceling`, the rail says "Cancelling…" forever. So the cancel route
    // settles a queued run itself, CAS on `status = queued`.
    const { client, queries } = makeFakeSupabase((q: Captured) => {
      if (q.table !== 'prospecting_run') return { data: null }
      if (q.op === 'update') {
        return { data: [runRow({ status: 'canceled', finished_at: '2026-09-05T00:00:00Z' })] }
      }
      return { data: runRow({ status: 'queued' }) }
    })
    const out = await requestCancel(client, { workspaceId: WS, runId: RUN })
    expect(out).toMatchObject({ ok: true })
    expect(out.ok && out.run.status).toBe('canceled')
    expect(out.ok && out.run.is_live).toBe(false)

    const updates = queries.filter((q) => q.op === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].payload).toMatchObject({ status: 'canceled' })
    expect((updates[0].payload as { finished_at?: string }).finished_at).toBeTruthy()
    expect(filterArgs(updates[0], 'eq')).toContainEqual(['status', 'queued'])
    expect(hasWorkspaceFilter(updates[0], WS)).toBe(true)
    // The event still goes out, best effort, so Inngest can drop a function
    // run that is waiting on the workspace lane.
    expect(hoisted.send).toHaveBeenCalledWith({
      name: 'prospecting/run.cancel',
      data: { runId: RUN },
    })
    // No engine will ever settle this run, so the route settles its Activity row.
    expect(hoisted.settleByRun).toHaveBeenCalledWith(hoisted.service, RUN, { status: 'canceled' })
  })

  it('a queued run claimed in the gap falls through to the canceling path', async () => {
    // Read says queued; by the time the settle runs the engine has claimed
    // it (running). The queued CAS matches nothing, so the ordinary
    // `canceling` write + event happens instead — never a false 409.
    let updates = 0
    const { client, queries } = makeFakeSupabase((q: Captured) => {
      if (q.table !== 'prospecting_run') return { data: null }
      if (q.op === 'update') {
        updates += 1
        return updates === 1 ? { data: [] } : { data: [runRow({ status: 'canceling' })] }
      }
      return { data: runRow({ status: 'queued' }) }
    })
    const out = await requestCancel(client, { workspaceId: WS, runId: RUN })
    expect(out).toMatchObject({ ok: true })
    expect(out.ok && out.run.status).toBe('canceling')
    const writes = queries.filter((q) => q.op === 'update')
    expect(writes).toHaveLength(2)
    expect(writes[1].payload).toEqual({ status: 'canceling' })
    expect(hoisted.send).toHaveBeenCalledTimes(1)
    // The engine owns this run now; it settles the Activity row when it stops.
    expect(hoisted.settleByRun).not.toHaveBeenCalled()
  })

  it('a queued settle survives a failed event send — the row is already terminal', async () => {
    hoisted.send.mockRejectedValue(new Error('inngest down'))
    const { client } = makeFakeSupabase((q: Captured) => {
      if (q.table !== 'prospecting_run') return { data: null }
      if (q.op === 'update') return { data: [runRow({ status: 'canceled' })] }
      return { data: runRow({ status: 'queued' }) }
    })
    const out = await requestCancel(client, { workspaceId: WS, runId: RUN })
    expect(out).toMatchObject({ ok: true })
    expect(out.ok && out.run.status).toBe('canceled')
  })

  it('409s a run that already finished, and never emits the event', async () => {
    const { client, queries } = world('completed')
    const out = await requestCancel(client, { workspaceId: WS, runId: RUN })
    expect(out).toMatchObject({ ok: false, code: 'NOT_CANCELABLE' })
    expect(queries.some((q) => q.op === 'update')).toBe(false)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('409s a run already canceling rather than re-emitting', async () => {
    const { client } = world('canceling')
    const out = await requestCancel(client, { workspaceId: WS, runId: RUN })
    expect(out).toMatchObject({ ok: false, code: 'NOT_CANCELABLE' })
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('does not resurrect a run that settled between the read and the update', async () => {
    // The CAS update matches nothing: the run completed in the gap. Emitting
    // the cancel now would have the engine settle a finished run as canceled.
    const { client } = world('running', [])
    const out = await requestCancel(client, { workspaceId: WS, runId: RUN })
    expect(out).toMatchObject({ ok: false, code: 'NOT_CANCELABLE' })
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('404s a cross-workspace run', async () => {
    const { client } = makeFakeSupabase(() => ({ data: null }))
    const out = await requestCancel(client, { workspaceId: WS, runId: RUN })
    expect(out).toMatchObject({ ok: false, code: 'NOT_FOUND' })
  })
})

// ---------------------------------------------------------------------------
// listRunCandidates — the ledger
// ---------------------------------------------------------------------------

describe('listRunCandidates', () => {
  function candidate(over: Record<string, unknown>) {
    return {
      id: 'c-x',
      workspace_id: WS,
      run_id: RUN,
      list_id: LIST,
      identity_key: 'company:acme.com',
      display_name: 'Acme',
      raw: {},
      discovery_angle: 'segment',
      outcome: 'suppressed',
      suppressed_by: null,
      suppressed_ref_id: null,
      entry_id: null,
      created_at: '2026-09-04T00:00:00Z',
      ...over,
    }
  }

  function world(rows: unknown[], opts: { companies?: string[]; contacts?: string[] } = {}) {
    return makeFakeSupabase((q: Captured) => {
      if (q.table === 'prospecting_run') return { data: runRow({ status: 'completed' }) }
      if (q.table === 'prospect_run_candidate') return { data: rows }
      if (q.table === 'company') return { data: (opts.companies ?? []).map((id) => ({ id })) }
      if (q.table === 'contact') return { data: (opts.contacts ?? []).map((id) => ({ id })) }
      return { data: null }
    })
  }

  it('groups by outcome, then by suppression reason in precedence order', async () => {
    const { client } = world([
      candidate({ id: 'a', outcome: 'new', entry_id: 'e-1' }),
      candidate({ id: 'b', suppressed_by: 'crm', suppressed_ref_id: 'co-1' }),
      candidate({ id: 'c', suppressed_by: 'this_list', suppressed_ref_id: 'e-9' }),
      candidate({ id: 'd', suppressed_by: 'this_list', suppressed_ref_id: 'e-8' }),
      candidate({ id: 'e', outcome: 'invalid' }),
    ], { companies: ['co-1'] })

    const out = await listRunCandidates(client, { workspaceId: WS, runId: RUN })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.total).toBe(5)
    expect(out.groups.map((g) => [g.outcome, g.reason, g.count])).toEqual([
      ['new', null, 1],
      // `this_list` before `crm`: the exclusion set's own precedence order, so
      // the most actionable reason reads first.
      ['suppressed', 'this_list', 2],
      ['suppressed', 'crm', 1],
      ['invalid', null, 1],
    ])
  })

  it('links a new candidate to the entry it became', async () => {
    const { client } = world([candidate({ outcome: 'new', entry_id: 'e-1' })])
    const out = await listRunCandidates(client, { workspaceId: WS, runId: RUN })
    expect(out.ok && out.groups[0].candidates[0].link).toEqual({ kind: 'entry', id: 'e-1' })
  })

  it('links entry-backed suppressions to the entry', async () => {
    const { client } = world([
      candidate({ id: 'a', suppressed_by: 'this_list', suppressed_ref_id: 'e-1' }),
      candidate({ id: 'b', suppressed_by: 'other_list', suppressed_ref_id: 'e-2' }),
      candidate({ id: 'c', suppressed_by: 'dismissed_global', suppressed_ref_id: 'e-3' }),
    ])
    const out = await listRunCandidates(client, { workspaceId: WS, runId: RUN })
    expect(out.ok && out.groups.flatMap((g) => g.candidates).map((c) => c.link)).toEqual([
      { kind: 'entry', id: 'e-1' },
      { kind: 'entry', id: 'e-2' },
      { kind: 'entry', id: 'e-3' },
    ])
  })

  it('resolves a crm ref by asking which table holds it, not by guessing', async () => {
    const { client, queries } = world(
      [
        candidate({ id: 'a', suppressed_by: 'crm', suppressed_ref_id: 'co-1' }),
        candidate({ id: 'b', suppressed_by: 'crm', suppressed_ref_id: 'ct-1' }),
        candidate({ id: 'c', suppressed_by: 'crm', suppressed_ref_id: 'gone' }),
      ],
      { companies: ['co-1'], contacts: ['ct-1'] },
    )
    const out = await listRunCandidates(client, { workspaceId: WS, runId: RUN })
    const links = out.ok ? out.groups.flatMap((g) => g.candidates).map((c) => c.link) : []
    expect(links).toEqual([
      { kind: 'company', id: 'co-1' },
      { kind: 'contact', id: 'ct-1' },
      // Deleted since the run: the entry survives, the link does not.
      null,
    ])
    for (const table of ['company', 'contact']) {
      const probe = queries.find((q) => q.table === table)!
      expect(hasWorkspaceFilter(probe, WS)).toBe(true)
    }
  })

  it('leaves non-row-backed reasons unlinked instead of faking a target', async () => {
    const { client, queries } = world([
      candidate({ id: 'a', suppressed_by: 'contacted', suppressed_ref_id: 'enr-1' }),
      candidate({ id: 'b', suppressed_by: 'opted_out', suppressed_ref_id: 'sup-1' }),
      candidate({ id: 'c', suppressed_by: 'self' }),
      candidate({ id: 'd', suppressed_by: 'personal_domain' }),
    ])
    const out = await listRunCandidates(client, { workspaceId: WS, runId: RUN })
    expect(out.ok && out.groups.flatMap((g) => g.candidates).every((c) => c.link === null)).toBe(true)
    // No refs to resolve, so no probe reads at all.
    expect(queries.some((q) => q.table === 'company' || q.table === 'contact')).toBe(false)
  })

  it('surfaces a suppressed row with no reason rather than hiding it', async () => {
    const { client } = world([candidate({ id: 'a', outcome: 'suppressed', suppressed_by: null })])
    const out = await listRunCandidates(client, { workspaceId: WS, runId: RUN })
    expect(out.ok && out.groups).toEqual([
      expect.objectContaining({ outcome: 'suppressed', reason: null, count: 1 }),
    ])
  })

  it('404s a cross-workspace run before reading the ledger', async () => {
    const { client, queries } = makeFakeSupabase(() => ({ data: null }))
    const out = await listRunCandidates(client, { workspaceId: WS, runId: RUN })
    expect(out).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(queries.some((q) => q.table === 'prospect_run_candidate')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// chainProfileRun — the hand-off discovery makes by itself
// ---------------------------------------------------------------------------

describe('chainProfileRun', () => {
  /** The list answers the existence check; entries answer BOTH reads (the
   *  target pick and createRun's own validation); the run table answers the
   *  round read and the insert. */
  function world(opts: {
    entries?: Array<{ id: string; kind?: string; stage?: string }>
    entriesError?: { message: string }
    insert?: { data?: unknown; error?: { message: string; code?: string } }
  } = {}) {
    return makeFakeSupabase((q: Captured) => {
      if (q.table === 'prospect_list') return { data: LIST_ROW }
      if (q.table === 'prospect_list_entry') {
        if (opts.entriesError) return { data: null, error: opts.entriesError }
        return {
          data: (opts.entries ?? []).map((e) => ({ kind: 'company', stage: 'discovered', ...e })),
        }
      }
      if (q.table === 'prospecting_run') {
        if (q.op === 'insert') return opts.insert ?? { data: runRow({ id: 'run-2', kind: 'account_card' }) }
        return { data: null }
      }
      return { data: null }
    })
  }

  it('targets every unscored, undismissed company on the list — newest first, capped — and starts the profile run', async () => {
    const { client, queries } = world({ entries: [{ id: 'e1' }, { id: 'e2' }] })
    const out = await chainProfileRun(client, {
      workspaceId: WS,
      listId: LIST,
      userId: USER,
      before: '2026-09-06T13:42:00.000Z',
    })
    expect(out).toEqual({
      runId: 'run-2',
      targets: 2,
      skipped: null,
      before: '2026-09-06T13:42:00.000Z',
    })

    const pick = queries.find((q) => q.table === 'prospect_list_entry')!
    expect(hasWorkspaceFilter(pick, WS)).toBe(true)
    expect(filterArgs(pick, 'eq')).toContainEqual(['list_id', LIST])
    expect(filterArgs(pick, 'eq')).toContainEqual(['kind', 'company'])
    expect(filterArgs(pick, 'neq')).toContainEqual(['stage', 'dismissed'])
    expect(filterArgs(pick, 'is')).toContainEqual(['fit_score', null])
    // Never carded, or carded BEFORE the hand-off began — what makes the
    // passes terminate: a card stamped by this hand-off is never picked again.
    expect(filterArgs(pick, 'or')).toEqual([
      [
        'candidate->>account_card_at.is.null,candidate->>account_card_at.lt.2026-09-06T13:42:00.000Z',
      ],
    ])
    expect(filterArgs(pick, 'order')).toEqual([['created_at', { ascending: false }]])
    expect(filterArgs(pick, 'limit')).toEqual([[50]])

    const insert = queries.find((q) => q.table === 'prospecting_run' && q.op === 'insert')!
    expect(insert.payload).toMatchObject({
      kind: 'account_card',
      target_entry_ids: ['e1', 'e2'],
      started_by: USER,
    })
    // The hand-off marker rides on the EVENT, so the engine can chain the
    // next pass with the same `before`.
    expect(hoisted.send).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          runId: 'run-2',
          userId: USER,
          handoff: { before: '2026-09-06T13:42:00.000Z' },
        }),
      }),
    )
  })

  it('defaults `before` to now for the first pass, and reports it', async () => {
    const { client } = world({ entries: [{ id: 'e1' }] })
    const out = await chainProfileRun(client, { workspaceId: WS, listId: LIST, userId: USER })
    expect(out.runId).toBe('run-2')
    expect(Date.parse(out.before)).not.toBeNaN()
    expect(Date.now() - Date.parse(out.before)).toBeLessThan(10_000)
  })

  it('starts nothing when every company already has a score', async () => {
    const { client, queries } = world({ entries: [] })
    const out = await chainProfileRun(client, { workspaceId: WS, listId: LIST, userId: null })
    expect(out).toMatchObject({ runId: null, targets: 0, skipped: 'nothing_to_score' })
    expect(queries.find((q) => q.table === 'prospecting_run')).toBeUndefined()
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('accepts a NULL starter — the engine chained it, nobody pressed a button', async () => {
    const { client, queries } = world({ entries: [{ id: 'e1' }] })
    const out = await chainProfileRun(client, { workspaceId: WS, listId: LIST, userId: null })
    expect(out.runId).toBe('run-2')
    const insert = queries.find((q) => q.table === 'prospecting_run' && q.op === 'insert')!
    expect((insert.payload as { started_by: unknown }).started_by).toBeNull()
  })

  it('reports — never throws — when another run holds the list, or the read fails', async () => {
    const busy = world({
      entries: [{ id: 'e1' }],
      insert: { error: { message: 'duplicate key', code: '23505' } },
    })
    const out = await chainProfileRun(busy.client, { workspaceId: WS, listId: LIST, userId: USER })
    expect(out).toMatchObject({ runId: null, targets: 1, skipped: 'RUN_ALREADY_LIVE' })

    const broken = world({ entriesError: { message: 'boom' } })
    const failed = await chainProfileRun(broken.client, { workspaceId: WS, listId: LIST, userId: USER })
    expect(failed).toMatchObject({ runId: null, targets: 0, skipped: 'read_failed' })
  })
})

// ---------------------------------------------------------------------------
// createRun — joining a live people run (queue-on-click)
// ---------------------------------------------------------------------------

/**
 * A people request that loses the one-live-run index to a LIVE PEOPLE RUN
 * joins it: the fresh ids are appended to that run's target list with a
 * compare-and-swap on the list itself, and no event is sent (the engine is
 * already running and re-reads the list before each search). Every other
 * collision is still the 409.
 */
describe('createRun — joining a live people run (queue-on-click)', () => {
  const live = (targets: string[], over: Record<string, unknown> = {}) =>
    runRow({
      id: 'run-live',
      kind: 'people',
      status: 'running',
      stage: 'people',
      target_entry_ids: targets,
      ...over,
    })
  const DUP = { data: null, error: { message: 'duplicate key', code: '23505' } }

  /**
   * The insert loses to the index (until `insertAfter`, for the settled
   * case); the live-run read (a select filtered on status) answers from
   * `reads`, one per read with the last one sticky; the CAS update answers
   * from `swaps`, one per attempt.
   */
  function world(opts: { reads?: unknown[]; swaps?: unknown[]; insertAfter?: unknown } = {}) {
    const reads = [...(opts.reads ?? [live(['c1', 'c2'])])]
    const swaps = [...(opts.swaps ?? [])]
    let inserts = 0
    return makeFakeSupabase((q: Captured) => {
      if (q.table === 'prospect_list') return { data: LIST_ROW }
      if (q.table === 'prospect_list_entry') {
        const ids = (filterArgs(q, 'in').find(([c]) => c === 'id')?.[1] as string[]) ?? []
        return { data: ids.map((id) => ({ id, kind: 'company', stage: 'discovered' })) }
      }
      if (q.table === 'prospecting_run') {
        if (q.op === 'insert') {
          inserts += 1
          return inserts > 1 && opts.insertAfter !== undefined ? { data: opts.insertAfter } : DUP
        }
        if (q.op === 'update') return { data: swaps.length > 0 ? swaps.shift() : null }
        if (filterArgs(q, 'in').some(([c]) => c === 'status')) {
          return { data: reads.length > 1 ? reads.shift() : (reads[0] ?? null) }
        }
        return { data: null } // the round-index read
      }
      return { data: null }
    })
  }

  const people = (entryIds: string[]) => ({
    workspaceId: WS,
    userId: USER,
    listId: LIST,
    kind: 'people',
    entryIds,
  })

  it('appends the fresh ids after the running search’s own — de-duplicated — and hands back that run, sending no event', async () => {
    const { client, queries } = world({ swaps: [live(['c1', 'c2', 'c3', 'c4'])] })
    const out = await createRun(client, people(['c2', 'c3', 'c4']))

    expect(out).toMatchObject({
      ok: true,
      run: { id: 'run-live', kind: 'people', is_live: true, target_entry_ids: ['c1', 'c2', 'c3', 'c4'] },
      joined: { appended: ['c3', 'c4'] },
    })
    const swap = queries.find((q) => q.table === 'prospecting_run' && q.op === 'update')!
    expect(swap.payload).toEqual({ target_entry_ids: ['c1', 'c2', 'c3', 'c4'] })
    // The compare-and-swap: the list AS READ, as a Postgres array literal, and
    // only while the run is still live. Scoped to the workspace like every write.
    expect(filterArgs(swap, 'eq')).toEqual(
      expect.arrayContaining([
        ['id', 'run-live'],
        ['target_entry_ids', '{c1,c2}'],
      ]),
    )
    expect(filterArgs(swap, 'in')).toEqual([['status', ['queued', 'running']]])
    expect(hasWorkspaceFilter(swap, WS)).toBe(true)
    // The engine is already running: nothing to enqueue.
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('is a no-op join when every id is already on the run — no write, still the run to follow', async () => {
    const { client, queries } = world()
    const out = await createRun(client, people(['c1']))
    expect(out).toMatchObject({ ok: true, run: { id: 'run-live' }, joined: { appended: [] } })
    expect(queries.some((q) => q.table === 'prospecting_run' && q.op === 'update')).toBe(false)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('refuses to overfill the running search', async () => {
    const full = Array.from({ length: 49 }, (_, i) => `c${i}`)
    const { client, queries } = world({ reads: [live(full)] })
    const out = await createRun(client, people(['x1', 'x2']))
    expect(out).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    expect(out.ok ? '' : out.error).toMatch(/at most 50/)
    expect(queries.some((q) => q.table === 'prospecting_run' && q.op === 'update')).toBe(false)
  })

  it('is still the 409 when the live run is a discovery or profile run, or the request is not a people run', async () => {
    const { client, queries } = world({ reads: [live(['c1'], { kind: 'account_card', stage: 'account_card' })] })
    expect(await createRun(client, people(['c3']))).toMatchObject({ ok: false, code: 'RUN_ALREADY_LIVE' })
    expect(queries.some((q) => q.op === 'update')).toBe(false)

    // An account_card request never joins anything — not even a people run.
    const other = world()
    expect(
      await createRun(other.client, { ...people(['c3']), kind: 'account_card' }),
    ).toMatchObject({ ok: false, code: 'RUN_ALREADY_LIVE' })
    expect(other.queries.some((q) => q.op === 'update')).toBe(false)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('starts its own run when the live one settled between the insert and the read', async () => {
    const { client, queries } = world({
      reads: [null],
      insertAfter: runRow({ id: 'run-new', kind: 'people', stage: 'people', target_entry_ids: ['c3'] }),
    })
    const out = await createRun(client, people(['c3']))
    expect(out).toMatchObject({ ok: true, run: { id: 'run-new', target_entry_ids: ['c3'] } })
    expect(out.ok && out.joined).toBeUndefined()
    expect(queries.filter((q) => q.table === 'prospecting_run' && q.op === 'insert')).toHaveLength(2)
    expect(hoisted.send).toHaveBeenCalledTimes(1)
  })

  it('re-reads and retries the swap when another append landed first', async () => {
    const { client, queries } = world({
      reads: [live(['c1', 'c2']), live(['c1', 'c2', 'c9'])],
      // The first swap misses (the list moved under it), the second lands.
      swaps: [null, live(['c1', 'c2', 'c9', 'c3'])],
    })
    const out = await createRun(client, people(['c3']))
    expect(out).toMatchObject({
      ok: true,
      run: { target_entry_ids: ['c1', 'c2', 'c9', 'c3'] },
      joined: { appended: ['c3'] },
    })
    const swaps = queries.filter((q) => q.table === 'prospecting_run' && q.op === 'update')
    expect(swaps).toHaveLength(2)
    expect(filterArgs(swaps[1], 'eq')).toEqual(
      expect.arrayContaining([['target_entry_ids', '{c1,c2,c9}']]),
    )
    expect(swaps[1].payload).toEqual({ target_entry_ids: ['c1', 'c2', 'c9', 'c3'] })
  })

  it('gives up as the 409 after three lost swaps rather than looping', async () => {
    const { client, queries } = world({ swaps: [null, null, null] })
    expect(await createRun(client, people(['c3']))).toMatchObject({ ok: false, code: 'RUN_ALREADY_LIVE' })
    expect(queries.filter((q) => q.table === 'prospecting_run' && q.op === 'update')).toHaveLength(3)
  })
})
