/**
 * THE SEAM between the prospecting TOOLS and the chat RUN CARD.
 *
 * These two halves were built by different packages against a written contract
 * rather than against each other: the tools project a run row into a result,
 * and `ProspectingRunCard` reads that result back out in the message stream.
 * Both sides have their own thorough tests — and both sides pass those tests
 * against fixtures they wrote THEMSELVES. A field renamed on one side (say
 * `run_id` → `id`, or `cards.skipped_already_researched` losing its prefix)
 * breaks nothing in either suite: the tools' tests assert the new name and the
 * card's tests assert the old one. The transcript silently falls back to the
 * generic JSON chip, which is exactly the failure nobody would notice.
 *
 * So this file runs the REAL tools and hands their REAL output to the REAL
 * reader. It asserts only the seam — whether the card can read what the tools
 * emit — and deliberately not the rendering (the card's own suite covers that)
 * nor the tools' behaviour (the tools' suite covers that).
 *
 * Kept beside the tools rather than beside the card because the card's suite
 * runs in jsdom and this needs none of it: `canRenderProspectingRunCard` is a
 * pure function over a plain object.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const hoisted = vi.hoisted(() => ({
  createRun: vi.fn(),
  getRun: vi.fn(),
  listRuns: vi.fn(),
  listRunCandidates: vi.fn(),
  requestCancel: vi.fn(),
  getServiceClient: vi.fn(),
  establishAndResearchSourceCompany: vi.fn(),
  createList: vi.fn(),
  updateList: vi.fn(),
  listEntries: vi.fn(),
  promoteEntries: vi.fn(),
  updateEntryStage: vi.fn(),
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
  promoteEntries: hoisted.promoteEntries,
  updateEntryStage: hoisted.updateEntryStage,
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
// The REAL reader the chat stream dispatches on — not a copy of its rules.
const { canRenderProspectingRunCard, SCOUT_RUN_CARD_TOOLS } = await import(
  '@/app/account/(dashboard)/chat/prospecting-run-card'
)

const WS = 'ws-1'
const USER = 'user-1'

const tableData: Record<string, { data: unknown; error?: { message: string } | null }> = {}
const supabase = {
  auth: { getUser: async () => ({ data: { user: { id: USER, email: 'ada@acme.test' } } }) },
  from: (table: string) => {
    const settle = async () => tableData[table] ?? { data: null, error: null }
    const b: Record<string, unknown> = {}
    const chain = () => () => b
    Object.assign(b, {
      select: chain(),
      eq: chain(),
      in: chain(),
      maybeSingle: settle,
      single: settle,
      then: (ok: (v: unknown) => unknown, no?: (e: unknown) => unknown) => settle().then(ok, no),
    })
    return b
  },
} as unknown as SupabaseClient

const tools = createProspectingTools(USER, supabase, WS)
type ToolResult = Record<string, any>
const run = (name: string, input: unknown): Promise<ToolResult> =>
  (
    tools[name as keyof typeof tools] as unknown as {
      execute: (i: unknown, o: unknown) => Promise<ToolResult>
    }
  ).execute(input, undefined)

const RUN_ROW = {
  id: 'run-1',
  list_id: 'list-1',
  kind: 'discover',
  status: 'queued',
  stage: 'discover',
  round_index: 1,
  budget_dollars: 2,
  spent_dollars: 0,
  exa_calls: 0,
  progress: { stage: 'discover', round: 1 },
  counts: {},
  error: null,
  is_live: true,
}

const realFetch = globalThis.fetch
globalThis.fetch = (async () => {
  throw new Error('no HTTP in this suite')
}) as typeof fetch
afterAll(() => {
  globalThis.fetch = realFetch
})

beforeEach(() => {
  // The wait tool looks for a hand-off after a settled discovery run; "none"
  // is the default so the seam tests read the settled output they built.
  hoisted.listRuns.mockResolvedValue({ ok: true, runs: [] })
  vi.clearAllMocks()
  for (const k of Object.keys(tableData)) delete tableData[k]
  tableData.prospect_list = { data: { id: 'list-1', name: 'Series A fintechs' }, error: null }
  // Workspace-routing default (see prospecting.test.ts): resolveEntityWorkspace's
  // fast path just needs a truthy row to confirm "lives in the session
  // workspace" — queried by cancel_prospecting_run's routing resolve before it
  // ever reaches the mocked requestCancel.
  tableData.prospecting_run = { data: { id: 'run-1', workspace_id: WS }, error: null }
})

describe('tools → chat run card seam', () => {
  it('every tool the card claims to render is a real tool on the surface', () => {
    // The card's dispatch set is a hand-written list of strings. A tool renamed
    // in `createProspectingTools` would leave a dead entry here that silently
    // never matches — the card would simply stop appearing for that tool.
    for (const name of SCOUT_RUN_CARD_TOOLS) {
      expect(Object.keys(tools)).toContain(name)
    }
  })

  it('reads a single-run output (run_prospect_discovery)', async () => {
    hoisted.createRun.mockResolvedValue({ ok: true, run: { ...RUN_ROW } })
    const out = await run('run_prospect_discovery', {
      list_id: 'list-1',
      confirmed_with_user: true,
    })
    expect(out.success).not.toBe(false)
    expect(canRenderProspectingRunCard(out)).toBe(true)
  })

  it('reads a targeted-run output (research_prospect_companies)', async () => {
    hoisted.createRun.mockResolvedValue({
      ok: true,
      run: { ...RUN_ROW, kind: 'account_card', stage: 'account_card' },
    })
    const out = await run('research_prospect_companies', {
      list_id: 'list-1',
      entry_ids: ['e1'],
      confirmed_with_user: true,
    })
    expect(canRenderProspectingRunCard(out)).toBe(true)
  })

  it('reads a people-run output (find_prospect_people)', async () => {
    hoisted.createRun.mockResolvedValue({
      ok: true,
      run: { ...RUN_ROW, kind: 'people', stage: 'people' },
    })
    const out = await run('find_prospect_people', {
      list_id: 'list-1',
      entry_ids: ['e1'],
      confirmed_with_user: true,
    })
    expect(canRenderProspectingRunCard(out)).toBe(true)
  })

  it('reads a settled wait_for_prospecting_run output', async () => {
    hoisted.getRun.mockResolvedValue({
      ok: true,
      run: {
        ...RUN_ROW,
        status: 'completed',
        is_live: false,
        progress: { stage: 'discover', round: 1, candidates_found: 12, entries_created: 9 },
      },
    })
    const out = await run('wait_for_prospecting_run', { run_id: 'run-1' })
    expect(canRenderProspectingRunCard(out)).toBe(true)
  })

  it('reads a cancel_prospecting_run output', async () => {
    hoisted.requestCancel.mockResolvedValue({
      ok: true,
      run: { ...RUN_ROW, status: 'canceling' },
    })
    const out = await run('cancel_prospecting_run', { run_id: 'run-1' })
    expect(canRenderProspectingRunCard(out)).toBe(true)
  })

  it('reads BOTH legs of a find_prospects people_started output', async () => {
    // The two-leg shape is the one most likely to drift: it is the only output
    // where the runs are NESTED, and the card reads them through `cards.run` /
    // `people.run` rather than off the top level.
    tableData.prospect_list_entry = {
      data: [
        { id: 'e1', kind: 'company', stage: 'discovered', candidate: { name: 'e1' }, research: {} },
      ],
      error: null,
    }
    hoisted.createRun
      .mockResolvedValueOnce({
        ok: true,
        run: { ...RUN_ROW, id: 'run-cards', kind: 'account_card', stage: 'account_card' },
      })
      .mockResolvedValueOnce({
        ok: true,
        run: { ...RUN_ROW, id: 'run-people', kind: 'people', stage: 'people' },
      })
    hoisted.getRun.mockResolvedValue({
      ok: true,
      run: {
        ...RUN_ROW,
        id: 'run-cards',
        kind: 'account_card',
        stage: 'account_card',
        status: 'completed',
        is_live: false,
      },
    })

    const out = await run('find_prospects', {
      list_id: 'list-1',
      entry_ids: ['e1'],
      confirmed_with_user: true,
    })

    expect(out.phase).toBe('people_started')
    expect(canRenderProspectingRunCard(out)).toBe(true)
    // The skip count is the one number that only exists on this shape, and the
    // only place the user learns the profiled ones were not run twice.
    expect(out.cards).toHaveProperty('skipped_already_researched')
  }, 20_000)

  it('reads a find_prospects output whose card leg was skipped entirely', async () => {
    // Every company already carded: `cards.run` is null and the ONLY readable
    // run is the people leg. The card must still render — this is the shape a
    // second "find people at these" produces, which is a common path.
    tableData.prospect_list_entry = {
      data: [
        {
          id: 'e1',
          kind: 'company',
          stage: 'discovered',
          candidate: { name: 'e1', account_card_at: '2026-09-04T00:00:00Z' },
          research: {},
        },
      ],
      error: null,
    }
    hoisted.createRun.mockResolvedValue({
      ok: true,
      run: { ...RUN_ROW, id: 'run-people', kind: 'people', stage: 'people' },
    })

    const out = await run('find_prospects', {
      list_id: 'list-1',
      entry_ids: ['e1'],
      confirmed_with_user: true,
    })

    expect(out.cards.run).toBeNull()
    expect(out.cards.skipped_already_researched).toBe(1)
    expect(canRenderProspectingRunCard(out)).toBe(true)
  })

  it('every list-bearing run output carries the list_name the chip labels with', async () => {
    // B3: the chip label comes from `list_name`. When it is absent the chip
    // falls back to "Prospect list", which is not wrong but is not the list
    // the user named either — and nothing else in either suite would catch it.
    hoisted.createRun.mockResolvedValue({ ok: true, run: { ...RUN_ROW } })
    const discovery = await run('run_prospect_discovery', {
      list_id: 'list-1',
      confirmed_with_user: true,
    })
    expect(discovery.list_name).toBe('Series A fintechs')

    hoisted.getRun.mockResolvedValue({ ok: true, run: { ...RUN_ROW, status: 'completed', is_live: false } })
    const waited = await run('wait_for_prospecting_run', { run_id: 'run-1' })
    expect(waited.list_name).toBe('Series A fintechs')
  })

  it('a REFUSED output is NOT card-shaped, so it falls back to the generic chip', async () => {
    // The negative half of the seam. A refusal carries no run, and a card that
    // claimed it could read one would draw an empty rail for a run that never
    // started. Falling through to `<Tool>` shows the refusal text instead.
    const refused = await run('run_prospect_discovery', { list_id: 'list-1' })
    expect(refused.success).toBe(false)
    expect(canRenderProspectingRunCard(refused)).toBe(false)
  })
})
