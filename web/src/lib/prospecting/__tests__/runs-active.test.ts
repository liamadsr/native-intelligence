/**
 * `listActiveRuns` — the one workspace-wide "is anything happening right now?"
 * read.
 *
 * Every other run query in this lib is scoped to one list or one run, which is
 * exactly why a run started from the chat (or from another tab) was invisible
 * until you reloaded the page it belonged to. This one backs the Prospecting
 * nav dot, the index's live list-card badges, and a list page adopting a run it
 * did not start — so what is under test is the SHAPE of the query as much as
 * the result: the status set, the cap, the ordering, and the workspace filter.
 */
import { describe, it, expect, vi } from 'vitest'
import { makeFakeSupabase, filterArgs, hasWorkspaceFilter } from './fake-supabase'

vi.mock('@/lib/inngest/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/inngest/client')>()),
  inngest: { send: vi.fn() },
}))

const { listActiveRuns } = await import('../runs')

const WS = 'ws-1'

function runRow(over: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    workspace_id: WS,
    list_id: 'list-1',
    kind: 'discover',
    status: 'running',
    stage: 'discover',
    round_index: 1,
    budget_dollars: 2,
    spent_dollars: 0.11,
    exa_calls: 3,
    progress: {},
    counts: {},
    error: null,
    created_at: '2026-09-04T00:00:00Z',
    prospect_list: { name: 'Series A fintechs' },
    ...over,
  }
}

describe('listActiveRuns', () => {
  it('returns live runs with is_live and the list name, newest first', async () => {
    const { client } = makeFakeSupabase((q) =>
      q.table === 'prospecting_run'
        ? {
            data: [
              runRow({ id: 'r2', list_id: 'list-2', prospect_list: { name: 'Investors' } }),
              runRow({ id: 'r1', status: 'queued' }),
            ],
          }
        : { data: null },
    )
    const out = await listActiveRuns(client, { workspaceId: WS })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.runs.map((r) => [r.id, r.list_name, r.is_live])).toEqual([
      ['r2', 'Investors', true],
      ['r1', 'Series A fintechs', true],
    ])
  })

  it('queries queued, running AND canceling — a cancel in flight is still a run doing work', async () => {
    // Dropping `canceling` would blink the nav dot off a beat before the run
    // actually stopped. `needs_input` is deliberately absent: v1 never parks a
    // run there, and a status nothing can produce should not shape a query.
    const { client, queries } = makeFakeSupabase(() => ({ data: [] }))
    await listActiveRuns(client, { workspaceId: WS })
    const read = queries.find((q) => q.table === 'prospecting_run')!
    expect(filterArgs(read, 'in')).toEqual([['status', ['queued', 'running', 'canceling']]])
  })

  it('carries the workspace filter, orders newest first, and caps the page', async () => {
    const { client, queries } = makeFakeSupabase(() => ({ data: [] }))
    await listActiveRuns(client, { workspaceId: WS })
    const read = queries.find((q) => q.table === 'prospecting_run')!
    expect(hasWorkspaceFilter(read, WS)).toBe(true)
    expect(filterArgs(read, 'order')).toEqual([['created_at', { ascending: false }]])
    expect(filterArgs(read, 'limit')).toEqual([[50]])
  })

  it('embeds the list name in the SAME query rather than reading it per run', async () => {
    // This is polled every 5 seconds while something is live; a per-run
    // follow-up query would multiply that by the number of live runs.
    const { client, queries } = makeFakeSupabase(() => ({ data: [] }))
    await listActiveRuns(client, { workspaceId: WS })
    const read = queries.find((q) => q.table === 'prospecting_run')!
    expect(String(filterArgs(read, 'select')[0][0])).toContain('prospect_list!inner(name)')
    expect(queries.filter((q) => q.table === 'prospect_list')).toHaveLength(0)
  })

  it('reads the embedded list as an object OR a one-element array', async () => {
    // PostgREST returns a to-one embed as an object; the generated types (and
    // older versions) model it as an array. Reading only one shape would leave
    // every chip labelled "Untitled list" after a client bump.
    const { client } = makeFakeSupabase((q) =>
      q.table === 'prospecting_run'
        ? { data: [runRow({ id: 'r1', prospect_list: [{ name: 'From an array' }] })] }
        : { data: null },
    )
    const out = await listActiveRuns(client, { workspaceId: WS })
    expect(out.ok && out.runs[0].list_name).toBe('From an array')
  })

  it('falls back to a placeholder name rather than undefined', async () => {
    const { client } = makeFakeSupabase((q) =>
      q.table === 'prospecting_run'
        ? { data: [runRow({ id: 'r1', prospect_list: null })] }
        : { data: null },
    )
    const out = await listActiveRuns(client, { workspaceId: WS })
    expect(out.ok && out.runs[0].list_name).toBe('Untitled list')
  })

  it('does NOT leak the embedded relation onto the run row', async () => {
    const { client } = makeFakeSupabase((q) =>
      q.table === 'prospecting_run' ? { data: [runRow()] } : { data: null },
    )
    const out = await listActiveRuns(client, { workspaceId: WS })
    expect(out.ok && out.runs[0]).not.toHaveProperty('prospect_list')
  })

  it('reports DB_ERROR rather than an empty "nothing is running"', async () => {
    // An empty array is a claim ("nothing is live") that a failed read has no
    // right to make — the nav dot would go dark mid-run.
    const { client } = makeFakeSupabase(() => ({ error: { message: 'boom' } }))
    const out = await listActiveRuns(client, { workspaceId: WS })
    expect(out).toMatchObject({ ok: false, code: 'DB_ERROR' })
  })

  it('an empty workspace is an empty list, not an error', async () => {
    const { client } = makeFakeSupabase(() => ({ data: [] }))
    const out = await listActiveRuns(client, { workspaceId: WS })
    expect(out).toMatchObject({ ok: true, runs: [] })
  })
})
