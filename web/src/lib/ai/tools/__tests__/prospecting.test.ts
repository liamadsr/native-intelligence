/**
 * `createProspectingTools` — the Scout agent's surface.
 *
 * Three things are under test here, and only the first is ordinary:
 *
 *   1. HAPPY PATHS. Each tool calls the right lib function with the right
 *      arguments and projects the result into something a model can read.
 *
 *   2. THE GO-AHEAD GATE. Four tools start real searches on the call. Each
 *      must refuse — running NOTHING — unless `confirmed_with_user` is true,
 *      and none of them may say a word about money: prices, budgets and caps
 *      live in the backend and the user never hears them. "Running nothing"
 *      is asserted the only way that means anything: the lib function that
 *      would have run was never called.
 *
 *   3. TENANCY AND NO HTTP. Every lib call carries the CONSTRUCTOR's
 *      workspaceId/userId by default, never anything the model supplied — no
 *      tool here takes a workspace parameter EXCEPT `create_prospect_list`'s
 *      optional `workspace_id` (a ROOT create with no existing row to route
 *      by; see routing.prospecting.test.ts for that routing behavior, and for
 *      how every list_id/run_id/entry_id-bearing tool routes to THAT id's own
 *      workspace via `resolveEntityWorkspace`). And `fetch` is stubbed to
 *      throw for the whole file: a tool that reached for its own
 *      API route would fail loudly here rather than silently in production
 *      where it has no session cookie.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { untrustedPrefix, wrapUntrusted } from '@/lib/email/untrusted'

const hoisted = vi.hoisted(() => ({
  establishAndResearchSourceCompany: vi.fn(),
  createList: vi.fn(),
  updateList: vi.fn(),
  listEntries: vi.fn(),
  listLists: vi.fn(),
  promoteEntries: vi.fn(),
  saveEntriesToList: vi.fn(),
  publishEntries: vi.fn(),
  publishList: vi.fn(),
  updateEntryStage: vi.fn(),
  createRun: vi.fn(),
  getRun: vi.fn(),
  listRuns: vi.fn(),
  listRunCandidates: vi.fn(),
  requestCancel: vi.fn(),
  getServiceClient: vi.fn(),
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
  listLists: hoisted.listLists,
  promoteEntries: hoisted.promoteEntries,
  saveEntriesToList: hoisted.saveEntriesToList,
  updateEntryStage: hoisted.updateEntryStage,
}))
vi.mock('@/lib/prospecting/publish', () => ({
  publishEntries: hoisted.publishEntries,
  publishList: hoisted.publishList,
}))
vi.mock('@/lib/prospecting/runs', () => ({
  createRun: hoisted.createRun,
  getRun: hoisted.getRun,
  listRuns: hoisted.listRuns,
  listRunCandidates: hoisted.listRunCandidates,
  requestCancel: hoisted.requestCancel,
}))
// research_my_company RESOLVES before it decides whether the go-ahead is
// required — the pre-check that keeps an unconfirmed ICP card from firing. Mocked here so a
// test can put the workspace in either state (carded / never carded).
vi.mock('@/lib/prospecting/source-company', () => ({
  resolveSourceCompany: hoisted.resolveSourceCompany,
  suggestedDomainFor: hoisted.suggestedDomainFor,
}))

const { createProspectingTools } = await import('../prospecting')

const WS = 'ws-1'
const USER = 'user-1'
/** A workspace id the MODEL might try to reach. Nothing may ever address it. */
const OTHER_WS = 'ws-evil'

/**
 * The tools DO make two direct reads of their own now, both through the
 * constructor-bound client: `listName` (one `prospect_list.select('name')`, so
 * every list-bearing output can carry a chip label) and `find_prospects`'s
 * pre-flight read of the selected entries. Everything else still goes through
 * the mocked lib functions.
 *
 * This fake records every query so the tenancy assertions can prove BOTH reads
 * carried `.eq('workspace_id', WS)` — the tools take no workspace parameter, so
 * a read that forgot the filter would be reaching across workspaces under the
 * caller's own RLS client.
 */
interface FakeQuery {
  table: string
  filters: Array<[string, ...unknown[]]>
}
const queries: FakeQuery[] = []
/** What `from(<table>)` settles to, per table. Reset in beforeEach. */
const tableData: Record<string, { data: unknown; error?: { message: string } | null }> = {}

const supabase = {
  auth: { getUser: async () => ({ data: { user: { id: USER, email: 'ada@acme.test' } } }) },
  from: (table: string) => {
    const q: FakeQuery = { table, filters: [] }
    queries.push(q)
    const settle = async () => tableData[table] ?? { data: null, error: null }
    const b: Record<string, unknown> = {}
    const chain =
      (method: string) =>
      (...args: unknown[]) => {
        q.filters.push([method, ...args])
        return b
      }
    Object.assign(b, {
      select: chain('select'),
      eq: chain('eq'),
      in: chain('in'),
      maybeSingle: settle,
      single: settle,
      then: (ok: (v: unknown) => unknown, no?: (e: unknown) => unknown) => settle().then(ok, no),
    })
    return b
  },
} as unknown as SupabaseClient

/** Every `eq`/`in` argument pair a read of one table carried. */
function readsOf(table: string): FakeQuery[] {
  return queries.filter((q) => q.table === table)
}

const tools = createProspectingTools(USER, supabase, WS)

/** Call a tool's `execute` the way the AI SDK does. The SDK passes a second
 *  options argument the tools here ignore; `undefined` is enough.
 *
 *  The return is deliberately an index signature over `any`: these tools return
 *  a dozen different discriminated shapes and the assertions below reach two
 *  levels into several of them, so a stricter alias would cost a cast on
 *  almost every line and prove nothing. The SHAPES are what the assertions
 *  test; the type here only carries them to the matcher. */
type ToolResult = Record<string, any>
const run = (name: keyof typeof tools, input: unknown): Promise<ToolResult> =>
  (
    tools[name] as unknown as { execute: (i: unknown, o: unknown) => Promise<ToolResult> }
  ).execute(input, undefined)

/** The go-ahead every run tool needs. Spread into a call to make it run. */
const GO = { confirmed_with_user: true as const }

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

/** The two lib functions that must not have run when the go-ahead is refused. */
const RUNNERS = [hoisted.createRun, hoisted.establishAndResearchSourceCompany]

// ── No HTTP, for the whole file ───────────────────────────────────────────
const realFetch = globalThis.fetch
/** A source company that has ALREADY been ICP-carded: `research_my_company`
 *  runs nothing on it, which is the state that makes the go-ahead optional. */
const CARDED_SOURCE = {
  company: {
    id: 'co-1',
    name: 'Acme',
    domain: 'acme.test',
    metadata: { enrichment: { icp_card_at: '2026-09-01T00:00:00.000Z' } },
  },
  resolved_by: 'is_workspace_company',
}
/** The same company with no card stamp — the next call FIRES a search. */
const UNCARDED_SOURCE = {
  company: { id: 'co-1', name: 'Acme', domain: 'acme.test', metadata: {} },
  resolved_by: 'is_workspace_company',
}

beforeEach(() => {
  for (const fn of Object.values(hoisted)) fn.mockReset()
  // The wait tool looks for a hand-off after every settled discovery run;
  // "none" is the default so unrelated tests never pay its retries.
  hoisted.listRuns.mockResolvedValue({ ok: true, runs: [] })
  queries.length = 0
  for (const key of Object.keys(tableData)) delete tableData[key]
  // The default list every `listName` read resolves to. A tool that reports a
  // run without this name is reporting a chip the user cannot recognise.
  tableData.prospect_list = { data: { name: 'Series A fintechs' }, error: null }
  // Workspace-routing default: `resolveEntityWorkspace`'s fast path just needs
  // a TRUTHY row to confirm "lives in the session workspace" — these two
  // tables are queried by the routing resolve in cancel_prospecting_run and
  // save/dismiss_prospect_entries (by run_id / entry_id respectively) before
  // ever reaching the mocked lib call. Individual tests below override this
  // with real per-entry shapes where the row's OWN fields matter (find_prospects).
  tableData.prospecting_run = { data: { id: 'run-1', workspace_id: WS }, error: null }
  tableData.prospect_list_entry = { data: { id: 'e-1', workspace_id: WS }, error: null }
  hoisted.getServiceClient.mockReturnValue(supabase)
  // Default to the already-researched workspace: the common path, and the one
  // where calling without the go-ahead is legitimate.
  hoisted.resolveSourceCompany.mockResolvedValue(CARDED_SOURCE)
  // A work-email caller by default: a domain IS guessable from the address.
  hoisted.suggestedDomainFor.mockReturnValue('acme.test')
  globalThis.fetch = vi.fn(() => {
    throw new Error('a prospecting tool must never make an HTTP request')
  }) as unknown as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
})

// ---------------------------------------------------------------------------
// The go-ahead gate
// ---------------------------------------------------------------------------

/** Words the user must never read from these tools. Case-insensitive. */
const MONEY = /\$\d|\b(budget|budgets|spend|spent|spends|cost|costs|price|prices|free|bill|bills|billed|cap|caps|capped|quote|quoted)\b/i

describe('the go-ahead gate refuses, and runs nothing', () => {
  const runners = [
    ['run_prospect_discovery', { list_id: 'list-1' }],
    ['research_prospect_companies', { list_id: 'list-1', entry_ids: ['e-1'] }],
    ['find_prospect_people', { list_id: 'list-1', entry_ids: ['e-1'] }],
  ] as const

  for (const [name, base] of runners) {
    it(`${name} refuses without confirmed_with_user`, async () => {
      const out = await run(name, base)
      expect(out.success).toBe(false)
      expect(out.needs_go_ahead).toBe(true)
      expect(out.error).toMatch(/go-ahead/i)
      for (const runner of RUNNERS) expect(runner).not.toHaveBeenCalled()
    })

    it(`${name} refuses an explicit false too`, async () => {
      const out = await run(name, { ...base, confirmed_with_user: false })
      expect(out.success).toBe(false)
      expect(out.needs_go_ahead).toBe(true)
      for (const runner of RUNNERS) expect(runner).not.toHaveBeenCalled()
    })

    it(`${name} says nothing about money in its refusal`, async () => {
      const out = await run(name, base)
      expect(out.error).not.toMatch(MONEY)
    })

    it(`${name} runs once it carries the go-ahead`, async () => {
      hoisted.createRun.mockResolvedValue({ ok: true, run: RUN_ROW })
      const out = await run(name, { ...base, ...GO })
      expect(out.success).toBe(true)
      expect(hoisted.createRun).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(out)).not.toMatch(MONEY)
    })
  }

  it('research_my_company REFUSES an unconfirmed call that would fire a card', async () => {
    // The running branch: the company exists but has never been carded, so
    // `establishAndResearchSourceCompany` would fire an Exa search. An
    // optional `confirmed_with_user` must mean "optional when nothing runs",
    // never "skippable" — this is the one place a search could start without
    // the user ever being asked.
    hoisted.resolveSourceCompany.mockResolvedValue(UNCARDED_SOURCE)
    const out = await run('research_my_company', {})
    expect(out.success).toBe(false)
    expect(out.needs_go_ahead).toBe(true)
    expect(out.already_researched).toBe(false)
    expect(out.error).not.toMatch(MONEY)
    expect(hoisted.establishAndResearchSourceCompany).not.toHaveBeenCalled()
  })

  it('research_my_company REFUSES an unconfirmed call carrying a domain', async () => {
    // A named domain may re-point at a DIFFERENT company, whose card state the
    // resolve above says nothing about. Already-carded here, and it still
    // refuses: the resolved company is not the one about to be researched.
    const out = await run('research_my_company', { domain: 'other.test' })
    expect(out.success).toBe(false)
    expect(out.needs_go_ahead).toBe(true)
    expect(hoisted.establishAndResearchSourceCompany).not.toHaveBeenCalled()
  })

  it('research_my_company PROCEEDS once the go-ahead is supplied', async () => {
    hoisted.resolveSourceCompany.mockResolvedValue(UNCARDED_SOURCE)
    hoisted.establishAndResearchSourceCompany.mockResolvedValue({
      ok: true,
      source: { id: 'co-1', name: 'Acme', domain: 'acme.test', metadata: null },
      resolved_by: 'is_workspace_company',
      company_id: 'co-1',
      established: false,
      enrichment: 'already',
      icp_card: { status: 'fired', fields: ['target_customer'], cost: 0.012 },
    })
    const out = await run('research_my_company', GO)
    expect(out.success).toBe(true)
    expect(hoisted.establishAndResearchSourceCompany).toHaveBeenCalledTimes(1)
  })

  it('research_my_company runs WITHOUT the go-ahead — the common case runs nothing', async () => {
    hoisted.establishAndResearchSourceCompany.mockResolvedValue({
      ok: true,
      source: { id: 'co-1', name: 'Acme', domain: 'acme.test', metadata: null },
      resolved_by: 'self_contact',
      company_id: 'co-1',
      established: false,
      enrichment: 'already',
      icp_card: { status: 'skipped', reason: 'already_present', cost: 0 },
    })
    const out = await run('research_my_company', {})
    expect(out.success).toBe(true)
    expect(out.icp_card).toEqual({ status: 'skipped' })
    expect(out.message).toMatch(/already researched/i)
  })
})

// ---------------------------------------------------------------------------
// research_my_company
// ---------------------------------------------------------------------------

describe('research_my_company', () => {
  it('flattens the ICP card fields and says nothing about what it cost', async () => {
    hoisted.establishAndResearchSourceCompany.mockResolvedValue({
      ok: true,
      source: {
        id: 'co-1',
        name: 'Acme',
        domain: 'acme.test',
        industry: 'SaaS',
        description: 'Sales tooling',
        metadata: {
          enrichment: {
            fields: {
              target_customer: { value: 'B2B sales teams', confidence: 'high' },
              what_we_sell: { value: 'a CRM', confidence: 'medium' },
            },
          },
        },
      },
      resolved_by: 'is_workspace_company',
      company_id: 'co-1',
      established: true,
      enrichment: 'started',
      icp_card: { status: 'fired', fields: ['target_customer'], cost: 0.012 },
    })

    const out = await run('research_my_company', { domain: 'acme.test', ...GO })
    expect(out.success).toBe(true)
    expect(out.company_id).toBe('co-1')
    expect(out.established).toBe(true)
    // The confidence envelope is unwrapped — the model reads a sentence back,
    // inside the WEB untrusted fence: it was read off the company's site.
    expect(out.icp_fields).toEqual({
      target_customer: wrapUntrusted('B2B sales teams', 'WEB'),
      what_we_sell: wrapUntrusted('a CRM', 'WEB'),
    })
    expect(out.description).toBe(wrapUntrusted('Sales tooling', 'WEB'))
    expect(out.industry).toBe(wrapUntrusted('SaaS', 'WEB'))
    // Names and domains stay plain: other tools take them verbatim.
    expect(out.name).toBe('Acme')
    expect(out.domain).toBe('acme.test')
    // The lib reports the card's cost; the tool must not pass it on. The
    // model repeats whatever a tool tells it, and this is the number Liam
    // does not want the user to hear.
    expect(out.spent_dollars).toBeUndefined()
    expect(out.icp_card).toEqual({ status: 'fired' })
    expect(JSON.stringify(out)).not.toMatch(MONEY)
  })

  it('passes the CONSTRUCTOR workspace/user, never anything from the model', async () => {
    hoisted.establishAndResearchSourceCompany.mockResolvedValue({
      ok: true,
      source: null,
      resolved_by: 'none',
      company_id: 'co-1',
      established: true,
      enrichment: 'started',
      icp_card: { status: 'fired', fields: [], cost: 0.012 },
    })
    // A model-authored workspace id is not even expressible in the schema, so
    // the proof is that the call carries the bound one regardless of input.
    await run('research_my_company', { domain: OTHER_WS, ...GO })
    expect(hoisted.establishAndResearchSourceCompany.mock.calls[0][1]).toMatchObject({
      workspaceId: WS,
      userId: USER,
    })
  })

  it('turns NEEDS_DOMAIN into an instruction to ask, not a dead end', async () => {
    hoisted.establishAndResearchSourceCompany.mockResolvedValue({
      ok: false,
      code: 'NEEDS_DOMAIN',
      error: "Tell us your company's website",
    })
    const out = await run('research_my_company', GO)
    expect(out.success).toBe(false)
    expect(out.needs_domain).toBe(true)
    expect(out.error).toMatch(/website/i)
  })

  it('asks for the website BEFORE asking for the go-ahead when there is nothing to research', async () => {
    // Personal webmail, nothing in the workspace. Demanding the go-ahead here
    // would send the model to collect a yes for a call that comes back
    // NEEDS_DOMAIN anyway — the question owed is the website.
    hoisted.resolveSourceCompany.mockResolvedValue({ company: null, resolved_by: 'none' })
    hoisted.suggestedDomainFor.mockReturnValue(null)
    const out = await run('research_my_company', {})
    expect(out.needs_domain).toBe(true)
    expect(out.needs_go_ahead).toBeUndefined()
    expect(hoisted.establishAndResearchSourceCompany).not.toHaveBeenCalled()
  })

  it('passes a domain refusal through with its code', async () => {
    hoisted.establishAndResearchSourceCompany.mockResolvedValue({
      ok: false,
      code: 'PERSONAL_DOMAIN',
      error: 'That is a personal email provider, not a company website',
    })
    // Confirmed, so the gate lets it through to the lib, which is what
    // rejects the domain.
    const out = await run('research_my_company', { domain: 'gmail.com', ...GO })
    expect(out).toMatchObject({ success: false, code: 'PERSONAL_DOMAIN' })
  })
})

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

describe('create_prospect_list / update_prospect_list', () => {
  it('creates with the bound tenancy and returns a deep link', async () => {
    hoisted.createList.mockResolvedValue({
      ok: true,
      list: {
        id: 'list-1',
        name: 'Fintechs',
        purpose: 'buyers',
        icp: {},
        max_spend_dollars: 2,
        max_rounds: 2,
        target_new_candidates: 20,
        people_per_company: 3,
      },
    })
    const out = await run('create_prospect_list', { name: 'Fintechs', purpose: 'buyers' })
    expect(out.success).toBe(true)
    expect(out.list_id).toBe('list-1')
    expect(out.url).toContain('prospect_list=list-1')
    expect(hoisted.createList.mock.calls[0][1]).toMatchObject({ workspaceId: WS, userId: USER })
  })

  it('turns a name collision into an instruction rather than a failure', async () => {
    hoisted.createList.mockResolvedValue({
      ok: false,
      code: 'LIST_NAME_TAKEN',
      error: 'A list called "Fintechs" already exists in this workspace',
    })
    const out = await run('create_prospect_list', { name: 'Fintechs' })
    expect(out.success).toBe(false)
    expect(out.code).toBe('LIST_NAME_TAKEN')
    expect(out.error).toMatch(/different name/i)
  })

  it('update reports whether the ICP version actually moved', async () => {
    hoisted.updateList.mockResolvedValue({
      ok: true,
      list: { id: 'list-1', name: 'Fintechs', icp: {}, icp_version: 2, status: 'active' },
      icp_version_bumped: true,
    })
    const out = await run('update_prospect_list', { list_id: 'list-1', icp: { a: 1 } })
    expect(out.icp_version_bumped).toBe(true)
    expect(out.icp_version).toBe(2)
    expect(hoisted.updateList.mock.calls[0][1]).toMatchObject({
      workspaceId: WS,
      listId: 'list-1',
    })
    // `list_id` must not travel into the patch as a writable field.
    expect(hoisted.updateList.mock.calls[0][1].input).not.toHaveProperty('list_id')
  })

  it('a foreign list id resolves to the lib\'s NOT_FOUND — never a cross-workspace read', async () => {
    hoisted.updateList.mockResolvedValue({ ok: false, code: 'NOT_FOUND', error: 'List not found' })
    const out = await run('update_prospect_list', { list_id: 'list-in-other-ws', name: 'x' })
    expect(out).toMatchObject({ success: false, code: 'NOT_FOUND' })
    // The workspace it was asked under is still the bound one.
    expect(hoisted.updateList.mock.calls[0][1].workspaceId).toBe(WS)
  })
})

// ---------------------------------------------------------------------------
// list_prospect_lists
// ---------------------------------------------------------------------------

/*
 * THE INCIDENT: asked on a phone to "pull my list of prospects", the agent
 * answered that it had no tool for it — and it was right. Every prospect tool
 * takes a list_id, and nothing enumerated the lists. The UI's index page has
 * always been there; the agent had no way to see it.
 */
describe('list_prospect_lists', () => {
  const list = (over: Record<string, unknown> = {}) => ({
    id: 'list-1',
    name: 'Investors',
    description: 'Seed funds in NYC',
    purpose: 'investors',
    status: 'active',
    published_at: null,
    created_at: '2026-09-01T00:00:00Z',
    entry_counts: { total: 12, discovered: 8, shortlisted: 0, saved: 4, dismissed: 0, saved_people: 3 },
    ...over,
  })

  it('returns every list with its tally, its stage and a link to it', async () => {
    hoisted.listLists.mockResolvedValue({
      ok: true,
      lists: [list(), list({ id: 'list-2', name: 'Series A fintechs', purpose: 'buyers' })],
    })

    const out = await run('list_prospect_lists', {})

    expect(out.success).toBe(true)
    expect(out.count).toBe(2)
    expect(out.lists[0]).toMatchObject({
      list_id: 'list-1',
      list_name: 'Investors',
      purpose: 'investors',
      status: 'active',
      entry_counts: { total: 12, saved: 4, saved_people: 3 },
    })
    expect(out.lists[0].url).toContain('list-1')
    // Archived lists are off by default — the index page's own rule.
    expect(hoisted.listLists.mock.calls[0][1]).toEqual({
      workspaceId: WS,
      includeArchived: undefined,
    })
  })

  it('includes archived lists when asked', async () => {
    hoisted.listLists.mockResolvedValue({ ok: true, lists: [] })
    const out = await run('list_prospect_lists', { include_archived: true })
    expect(out).toMatchObject({ success: true, count: 0, lists: [] })
    expect(hoisted.listLists.mock.calls[0][1].includeArchived).toBe(true)
  })

  it('surfaces a read failure as a tool error', async () => {
    hoisted.listLists.mockResolvedValue({ ok: false, error: 'Failed to load lists', code: 'DB_ERROR' })
    const out = await run('list_prospect_lists', {})
    expect(out).toMatchObject({ success: false, code: 'DB_ERROR' })
  })
})

// ---------------------------------------------------------------------------
// list_prospect_entries
// ---------------------------------------------------------------------------

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'e-1',
  kind: 'company',
  candidate: { name: 'Vanta', domain: 'vanta.com' },
  stage: 'discovered',
  identity_state: 'resolved',
  fit_tier: 'B',
  fit_score: 61,
  fit_confidence: 'medium',
  fit_signals: [
    { label: 'Series A or later', met: true },
    { label: 'US-based', met: true },
    { label: 'Has a sales team', met: false },
  ],
  fit_rationale: 'Compliance, not sales tooling',
  dismissed_reason: null,
  company_id: null,
  contact_id: null,
  parent_entry_id: null,
  ...over,
})

describe('list_prospect_entries', () => {
  beforeEach(() => {
    hoisted.listEntries.mockResolvedValue({
      ok: true,
      entries: [
        entry({ id: 'e-a', fit_score: 91, candidate: { name: 'Rippling', domain: 'rippling.com' } }),
        entry({ id: 'e-b', fit_score: 64 }),
        entry({
          id: 'e-p',
          kind: 'person',
          fit_score: null,
          candidate: {
            name: 'Ada L',
            title: 'VP Sales',
            linkedin_url: 'https://linkedin.com/in/ada',
            account_card_at: '2026-09-04T00:00:00Z',
          },
        }),
      ],
      entry_counts: { total: 3, discovered: 3, shortlisted: 0, saved: 0, dismissed: 0, saved_people: 0 },
    })
  })

  it('projects the fields a model needs and drops the research blobs', async () => {
    const out = await run('list_prospect_entries', { list_id: 'list-1' })
    expect(out.success).toBe(true)
    expect(out.entries[0]).toMatchObject({
      entry_id: 'e-a',
      name: 'Rippling',
      domain: 'rippling.com',
      fit_score: 91,
      fit_label: 'strong',
      researched: false,
    })
    expect(out.entries[1]).toMatchObject({ fit_score: 64, fit_label: 'good' })
    // Dropped with migration 256 — a model must not be handed a tier to state.
    for (const gone of ['fit_tier', 'fit_confidence', 'fit_display', 'signals_met']) {
      expect(out.entries[0]).not.toHaveProperty(gone)
    }
    // The account-card STAMP, not an inference about which keys are present.
    // A person's title and every why-fit paragraph are web-derived: fenced (WEB).
    expect(out.entries[2]).toMatchObject({ entry_id: 'e-p', researched: true, title: wrapUntrusted('VP Sales', 'WEB') })
    for (const entry of out.entries as Array<{ fit_rationale: unknown }>) {
      if (entry.fit_rationale != null) expect(String(entry.fit_rationale).startsWith(untrustedPrefix('WEB'))).toBe(true)
    }
    expect(out.entries[0]).not.toHaveProperty('research')
    expect(out.entries[0]).not.toHaveProperty('sources')
  })

  it('pushes ALL THREE filters down to the lib — none is applied to the array', async () => {
    // This used to filter the score and kind in the tool, over the fully paged
    // result: answering "show me the hot ones" on a 1200-entry list read all
    // 1200 rows and threw most of them away. The lib now takes all three as
    // SQL predicates, so what comes back IS the slice.
    await run('list_prospect_entries', {
      list_id: 'list-1',
      stage: 'discovered',
      min_fit_score: 80,
      kind: 'company',
    })
    expect(hoisted.listEntries.mock.calls[0][1]).toMatchObject({
      workspaceId: WS,
      listId: 'list-1',
      stage: 'discovered',
      min_fit_score: 80,
      kind: 'company',
    })
  })

  it('reports the filters it applied and the WHOLE-list counts under a name that says so', async () => {
    const out = await run('list_prospect_entries', { list_id: 'list-1', min_fit_score: 80 })
    expect(out.filters_applied).toEqual({ stage: null, min_fit_score: 80, kind: null })
    // Renamed from `entry_counts`: a model reading "entry_counts.total = 3"
    // next to "matched = 2" has every reason to report the wrong number.
    expect(out.whole_list_entry_counts.total).toBe(3)
    expect(out).not.toHaveProperty('entry_counts')
    expect(out).not.toHaveProperty('filtered_in_tool')
  })

  it('caps with `limit` in the TOOL and reports truncation honestly', async () => {
    // `limit` stays a tool concern: it bounds the token cost of one reply, and
    // `matched` must stay the honest size of the filtered set so the model can
    // say "showing 1 of 3".
    const out = await run('list_prospect_entries', { list_id: 'list-1', limit: 1 })
    expect(out.returned).toBe(1)
    expect(out.matched).toBe(3)
    expect(out.truncated).toBe(true)
  })

  it('reports fit_label beside the score — the same word the page shows — and null when unprofiled', async () => {
    // Discovery does not score (fit.ts), so a null score is "not profiled",
    // never a bad fit; the prompt tells the model to say so. The label is the
    // band the page prints beside the number, so chat and page agree.
    hoisted.listEntries.mockResolvedValue({
      ok: true,
      entries: [
        entry({ id: 'e-hot', fit_score: 92 }),
        entry({ id: 'e-warm', fit_score: 70 }),
        entry({ id: 'e-mod', fit_score: 45 }),
        entry({ id: 'e-cold', fit_score: 0, fit_rationale: 'Matches excluded industry "crypto".' }),
        entry({ id: 'e-unscored', fit_score: null }),
      ],
      entry_counts: { total: 5 },
    })
    const out = await run('list_prospect_entries', { list_id: 'list-1' })
    expect(out.entries.map((e: Record<string, unknown>) => [e.entry_id, e.fit_score, e.fit_label])).toEqual([
      ['e-hot', 92, 'strong'],
      ['e-warm', 70, 'good'],
      ['e-mod', 45, 'partial'],
      ['e-cold', 0, 'weak'],
      ['e-unscored', null, null],
    ])
    expect(out.entries[3].fit_rationale).toContain('excluded industry')
  })

  it('carries the list NAME, read with a workspace filter', async () => {
    const out = await run('list_prospect_entries', { list_id: 'list-1' })
    expect(out.list_name).toBe('Series A fintechs')
    const read = readsOf('prospect_list').at(-1)!
    expect(read.filters).toContainEqual(['eq', 'workspace_id', WS])
    expect(read.filters).toContainEqual(['eq', 'id', 'list-1'])
  })

  it('degrades to a null name rather than failing the read', async () => {
    // A name that could not be read is not a reason to withhold the entries;
    // the chip falls back to "Open list". The FIRST prospect_list read is the
    // workspace-routing resolve (which must find the list); only the name read
    // after it fails.
    let listReads = 0
    Object.defineProperty(tableData, 'prospect_list', {
      configurable: true,
      enumerable: true,
      get: () =>
        listReads++ === 0
          ? { data: { id: 'list-1', workspace_id: WS }, error: null }
          : { data: null, error: { message: 'boom' } },
    })
    const out = await run('list_prospect_entries', { list_id: 'list-1' })
    expect(out.success).toBe(true)
    expect(out.list_name).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The three runs
// ---------------------------------------------------------------------------

describe('starting runs', () => {
  it('discovery passes kind discover with no entry ids', async () => {
    hoisted.createRun.mockResolvedValue({ ok: true, run: RUN_ROW })
    const out = await run('run_prospect_discovery', { list_id: 'list-1', ...GO })
    expect(out.success).toBe(true)
    expect(out.run_id).toBe('run-1')
    expect(hoisted.createRun.mock.calls[0][1]).toMatchObject({
      workspaceId: WS,
      userId: USER,
      listId: 'list-1',
      kind: 'discover',
      entryIds: undefined,
    })
    // No budget reaches the lib from the model: the per-run cap is the
    // server's default, not a tool argument.
    expect(hoisted.createRun.mock.calls[0][1].budgetDollars).toBeUndefined()
  })

  it('research and people pass their kinds and the selection', async () => {
    hoisted.createRun.mockResolvedValue({ ok: true, run: { ...RUN_ROW, kind: 'account_card' } })
    await run('research_prospect_companies', {
      list_id: 'list-1',
      entry_ids: ['e-1', 'e-2'],
      confirmed_with_user: true,
    })
    expect(hoisted.createRun.mock.calls[0][1]).toMatchObject({
      kind: 'account_card',
      entryIds: ['e-1', 'e-2'],
    })

    hoisted.createRun.mockClear()
    hoisted.createRun.mockResolvedValue({ ok: true, run: { ...RUN_ROW, kind: 'people' } })
    await run('find_prospect_people', {
      list_id: 'list-1',
      entry_ids: ['e-1'],
      confirmed_with_user: true,
    })
    expect(hoisted.createRun.mock.calls[0][1]).toMatchObject({ kind: 'people', entryIds: ['e-1'] })
  })

  it('RUN_ALREADY_LIVE tells the model to wait, not to retry', async () => {
    hoisted.createRun.mockResolvedValue({
      ok: false,
      code: 'RUN_ALREADY_LIVE',
      error: 'A run is already live',
    })
    const out = await run('run_prospect_discovery', { list_id: 'list-1', confirmed_with_user: true })
    expect(out.success).toBe(false)
    expect(out.error).toMatch(/wait_for_prospecting_run/)
    expect(out.error).toMatch(/do not start another/i)
  })

  it('a people request that joined the search already running says so, with the run to follow', async () => {
    hoisted.createRun.mockResolvedValue({
      ok: true,
      run: { ...RUN_ROW, kind: 'people' },
      joined: { appended: ['e-2'] },
    })
    const out = await run('find_prospect_people', {
      list_id: 'list-1',
      entry_ids: ['e-1', 'e-2'],
      confirmed_with_user: true,
    })
    expect(out.success).toBe(true)
    expect(out.joined_live_run).toBe(true)
    expect(out.appended).toBe(1)
    expect(out.message).toMatch(/already running/)
    expect(out.message).toMatch(/wait_for_prospecting_run/)
  })

  it('an archived list is refused in plain words', async () => {
    hoisted.createRun.mockResolvedValue({
      ok: false,
      code: 'LIST_ARCHIVED',
      error: 'archived',
    })
    const out = await run('run_prospect_discovery', { list_id: 'list-1', confirmed_with_user: true })
    expect(out).toMatchObject({ success: false, code: 'LIST_ARCHIVED' })
    expect(out.error).toMatch(/archived/i)
  })
})

// ---------------------------------------------------------------------------
// wait_for_prospecting_run
// ---------------------------------------------------------------------------

describe('wait_for_prospecting_run', () => {
  beforeEach(() => {
    // No hand-off unless a test says so — and answered on the first look, so
    // the follow-up retries never add their delay to an unrelated test.
    hoisted.listRuns.mockResolvedValue({ ok: true, runs: [] })
  })

  it('reports the profile run a settled DISCOVERY run handed off to', async () => {
    hoisted.getRun.mockResolvedValue({
      ok: true,
      run: { ...RUN_ROW, kind: 'discover', status: 'completed', is_live: false },
    })
    hoisted.listRuns.mockResolvedValue({
      ok: true,
      runs: [{ ...RUN_ROW, id: 'run-2', kind: 'account_card', status: 'running', is_live: true }],
    })
    const out = await run('wait_for_prospecting_run', { run_id: 'run-1' })
    expect(out.done).toBe(true)
    expect(out.follow_up_run).toMatchObject({ run_id: 'run-2', kind: 'account_card', is_live: true })
    expect(out.message).toContain('run-2')
    expect(out.message).toMatch(/wait_for_prospecting_run on that run/)
    expect(hoisted.listRuns.mock.calls[0][1]).toEqual({ workspaceId: WS, listId: RUN_ROW.list_id, limit: 1 })
  })

  it('does not report the run it just waited on as its own follow-up, nor look for one after a people run', async () => {
    hoisted.getRun.mockResolvedValue({
      ok: true,
      run: { ...RUN_ROW, kind: 'discover', status: 'completed', is_live: false },
    })
    // The newest run IS the one that just settled (still reads live on a stale
    // replica): not a follow-up.
    hoisted.listRuns.mockResolvedValue({
      ok: true,
      runs: [{ ...RUN_ROW, id: 'run-1', kind: 'discover', status: 'running', is_live: true }],
    })
    const out = await run('wait_for_prospecting_run', { run_id: 'run-1' })
    expect(out.follow_up_run).toBeNull()

    hoisted.listRuns.mockClear()
    hoisted.getRun.mockResolvedValue({
      ok: true,
      run: { ...RUN_ROW, kind: 'people', status: 'completed', is_live: false },
    })
    const people = await run('wait_for_prospecting_run', { run_id: 'run-1' })
    expect(people.follow_up_run).toBeNull()
    expect(hoisted.listRuns).not.toHaveBeenCalled()
  }, 15_000)

  it('returns as soon as the run is terminal', async () => {
    hoisted.getRun.mockResolvedValue({
      ok: true,
      run: { ...RUN_ROW, status: 'completed', spent_dollars: 0.19, is_live: false },
    })
    const out = await run('wait_for_prospecting_run', { run_id: 'run-1' })
    expect(out.done).toBe(true)
    expect(out.status).toBe('completed')
    expect(out.budget_exhausted).toBe(false)
    expect(hoisted.getRun).toHaveBeenCalledTimes(1)
    expect(hoisted.getRun.mock.calls[0][1]).toEqual({ workspaceId: WS, runId: 'run-1' })
  })

  it('treats budget_exhausted as an OUTCOME with results kept, not a failure', async () => {
    hoisted.getRun.mockResolvedValue({
      ok: true,
      run: { ...RUN_ROW, status: 'budget_exhausted', spent_dollars: 2, is_live: false },
    })
    const out = await run('wait_for_prospecting_run', { run_id: 'run-1' })
    expect(out.success).toBe(true)
    expect(out.done).toBe(true)
    expect(out.budget_exhausted).toBe(true)
    expect(out.message).toMatch(/kept/i)
  })

  it('polls, then returns still_running when the wall clock runs out', async () => {
    hoisted.getRun.mockResolvedValue({ ok: true, run: { ...RUN_ROW, status: 'running' } })
    // 5s of budget with a 2s first delay: one sleep fits, the second does not.
    const out = await run('wait_for_prospecting_run', { run_id: 'run-1', max_wait_seconds: 5 })
    expect(out.done).toBe(false)
    expect(out.still_running).toBe(true)
    expect(out.message).toMatch(/do not start another run/i)
    expect(hoisted.getRun.mock.calls.length).toBeGreaterThan(1)
  }, 20_000)

  it('a foreign run id is NOT_FOUND, and it does not poll for four minutes first', async () => {
    hoisted.getRun.mockResolvedValue({ ok: false, code: 'NOT_FOUND', error: 'Run not found' })
    const out = await run('wait_for_prospecting_run', { run_id: 'run-in-other-ws' })
    expect(out).toMatchObject({ success: false, code: 'NOT_FOUND' })
    expect(hoisted.getRun).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// find_prospects — the combined two-leg verb
// ---------------------------------------------------------------------------

/** A selected company entry as `find_prospects` reads it back. `carded: true`
 *  stamps `candidate.account_card_at`, which is what makes the card leg skip
 *  it — the SAME predicate (`hasAccountCard`) the list page's gate uses. */
const selected = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: 'company',
  stage: 'discovered',
  candidate: { name: id, domain: `${id}.test` },
  research: {},
  ...over,
})
const carded = (id: string) =>
  selected(id, { candidate: { name: id, account_card_at: '2026-09-04T00:00:00Z' } })

/** The card run, then the people run — the order `find_prospects` creates them
 *  in. Returned by `createRun` in sequence so each leg is distinguishable. */
function stageRuns(cardOver: Record<string, unknown> = {}) {
  hoisted.createRun
    .mockResolvedValueOnce({
      ok: true,
      run: { ...RUN_ROW, id: 'run-cards', kind: 'account_card', stage: 'account_card', ...cardOver },
    })
    .mockResolvedValueOnce({
      ok: true,
      run: { ...RUN_ROW, id: 'run-people', kind: 'people', stage: 'people' },
    })
}

describe('find_prospects', () => {
  beforeEach(() => {
    tableData.prospect_list = { data: { id: 'list-1', name: 'Series A fintechs' }, error: null }
  })

  it('refuses without the go-ahead, and runs NOTHING — not even the card leg', async () => {
    tableData.prospect_list_entry = { data: [selected('e1')], error: null }
    const out = await run('find_prospects', {
      list_id: 'list-1',
      entry_ids: ['e1'],
    })
    expect(out.success).toBe(false)
    expect(hoisted.createRun).not.toHaveBeenCalled()
  })

  it('SKIPS the card leg for companies already carded, and never re-runs them', async () => {
    // THE point of the tool doing this itself: `account-run.ts` bills every id
    // it is handed, so an unfiltered selection of 3 where 2 are carded costs
    // three cards.
    tableData.prospect_list_entry = {
      data: [selected('e1'), carded('e2'), carded('e3')],
      error: null,
    }
    stageRuns()
    hoisted.getRun.mockResolvedValue({
      ok: true,
      run: { ...RUN_ROW, id: 'run-cards', status: 'completed' },
    })

    const out = await run('find_prospects', {
      list_id: 'list-1',
      entry_ids: ['e1', 'e2', 'e3'],
      confirmed_with_user: true,
    })
    expect(out.success).toBe(true)
    expect(out.cards.skipped_already_researched).toBe(2)
    // Leg 1 got ONLY the uncarded id...
    expect(hoisted.createRun.mock.calls[0][1]).toMatchObject({
      kind: 'account_card',
      entryIds: ['e1'],
    })
    // ...and leg 2 got ALL THREE: a company that was already researched is
    // exactly the one the user wants people at.
    expect(hoisted.createRun.mock.calls[1][1]).toMatchObject({
      kind: 'people',
      entryIds: ['e1', 'e2', 'e3'],
    })
  })

  it('skips the card leg ENTIRELY when every selected company is carded', async () => {
    tableData.prospect_list_entry = { data: [carded('e1'), carded('e2')], error: null }
    hoisted.createRun.mockResolvedValue({
      ok: true,
      run: { ...RUN_ROW, id: 'run-people', kind: 'people' },
    })

    const out = await run('find_prospects', {
      list_id: 'list-1',
      entry_ids: ['e1', 'e2'],
      confirmed_with_user: true,
    })
    expect(out).toMatchObject({ success: true, phase: 'people_started' })
    expect(out.cards).toMatchObject({ skipped_already_researched: 2, run: null })
    // ONE run, and it is the people leg. `getRun` was never polled because
    // there was no card run to poll.
    expect(hoisted.createRun).toHaveBeenCalledTimes(1)
    expect(hoisted.createRun.mock.calls[0][1]).toMatchObject({ kind: 'people' })
    expect(hoisted.getRun).not.toHaveBeenCalled()
    expect(out.message).toMatch(/already profiled/i)
  })

  it('refuses ids that are not on this list, before either leg', async () => {
    tableData.prospect_list_entry = { data: [selected('e1')], error: null }
    const out = await run('find_prospects', {
      list_id: 'list-1',
      entry_ids: ['e1', 'e-foreign'],
      confirmed_with_user: true,
    })
    expect(out).toMatchObject({ success: false, code: 'INVALID_INPUT' })
    expect(out.invalid_entry_ids).toEqual(['e-foreign'])
    expect(hoisted.createRun).not.toHaveBeenCalled()
  })

  it('refuses PERSON ids — this tool takes companies', async () => {
    tableData.prospect_list_entry = {
      data: [selected('e1'), selected('e2', { kind: 'person' })],
      error: null,
    }
    const out = await run('find_prospects', {
      list_id: 'list-1',
      entry_ids: ['e1', 'e2'],
      confirmed_with_user: true,
    })
    expect(out).toMatchObject({ success: false, code: 'INVALID_INPUT' })
    expect(out.invalid_entry_ids).toEqual(['e2'])
    expect(hoisted.createRun).not.toHaveBeenCalled()
  })

  it('refuses DISMISSED companies', async () => {
    tableData.prospect_list_entry = {
      data: [selected('e1', { stage: 'dismissed' })],
      error: null,
    }
    const out = await run('find_prospects', {
      list_id: 'list-1',
      entry_ids: ['e1'],
      confirmed_with_user: true,
    })
    expect(out).toMatchObject({ success: false, code: 'INVALID_INPUT' })
    expect(hoisted.createRun).not.toHaveBeenCalled()
  })

  it('a FAILED card leg does not start the people leg', async () => {
    tableData.prospect_list_entry = { data: [selected('e1')], error: null }
    stageRuns()
    hoisted.getRun.mockResolvedValue({
      ok: true,
      run: { ...RUN_ROW, id: 'run-cards', status: 'failed', error: 'exa down' },
    })

    const out = await run('find_prospects', {
      list_id: 'list-1',
      entry_ids: ['e1'],
      confirmed_with_user: true,
    })
    expect(out).toMatchObject({ success: false, phase: 'cards_failed' })
    expect(out.people).toBeNull()
    expect(out.error).toMatch(/exa down/)
    expect(hoisted.createRun).toHaveBeenCalledTimes(1)
  })

  it('a CANCELED card leg does not start the people leg either', async () => {
    tableData.prospect_list_entry = { data: [selected('e1')], error: null }
    stageRuns()
    hoisted.getRun.mockResolvedValue({
      ok: true,
      run: { ...RUN_ROW, id: 'run-cards', status: 'canceled' },
    })

    const out = await run('find_prospects', {
      list_id: 'list-1',
      entry_ids: ['e1'],
      confirmed_with_user: true,
    })
    expect(out).toMatchObject({ success: false, phase: 'cards_failed' })
    expect(hoisted.createRun).toHaveBeenCalledTimes(1)
  })

  it('budget_exhausted on the card leg is an OUTCOME — the people leg still runs', async () => {
    tableData.prospect_list_entry = { data: [selected('e1')], error: null }
    stageRuns()
    hoisted.getRun.mockResolvedValue({
      ok: true,
      run: { ...RUN_ROW, id: 'run-cards', status: 'budget_exhausted', spent_dollars: 1 },
    })

    const out = await run('find_prospects', {
      list_id: 'list-1',
      entry_ids: ['e1'],
      confirmed_with_user: true,
    })
    expect(out).toMatchObject({ success: true, phase: 'people_started' })
    expect(out.cards.run.status).toBe('budget_exhausted')
    expect(hoisted.createRun).toHaveBeenCalledTimes(2)
  })

  it('a card leg still running at the wait cap returns cards_running and starts NOTHING', async () => {
    // The consent is minutes old and the card leg is still spending against it.
    // Committing a second paid run on that basis would be the tool's decision,
    // not the user's — so leg 2 is not started and the model is told exactly
    // what to do instead (and told not to re-call this tool, which would
    // re-run the cards).
    tableData.prospect_list_entry = { data: [selected('e1')], error: null }
    stageRuns()
    hoisted.getRun.mockResolvedValue({
      ok: true,
      run: { ...RUN_ROW, id: 'run-cards', status: 'running' },
    })
    // Jump the wall clock past the 4-minute budget on the second read rather
    // than actually waiting four minutes.
    const realNow = Date.now
    let calls = 0
    vi.spyOn(Date, 'now').mockImplementation(() => {
      calls += 1
      return calls > 1 ? realNow() + 5 * 60 * 1000 : realNow()
    })

    try {
      const out = await run('find_prospects', {
        list_id: 'list-1',
        entry_ids: ['e1'],
        confirmed_with_user: true,
      })
      expect(out).toMatchObject({ success: true, phase: 'cards_running' })
      expect(out.people).toBeNull()
      expect(out.cards.run.run_id).toBe('run-cards')
      expect(out.message).toMatch(/do NOT call find_prospects again/i)
      expect(hoisted.createRun).toHaveBeenCalledTimes(1)
    } finally {
      vi.mocked(Date.now).mockRestore()
    }
  }, 20_000)

  it('RUN_ALREADY_LIVE on the card leg is a clear error, not a retry', async () => {
    tableData.prospect_list_entry = { data: [selected('e1')], error: null }
    hoisted.createRun.mockResolvedValue({
      ok: false,
      code: 'RUN_ALREADY_LIVE',
      error: 'This list already has a run in progress',
    })
    const out = await run('find_prospects', {
      list_id: 'list-1',
      entry_ids: ['e1'],
      confirmed_with_user: true,
    })
    expect(out).toMatchObject({
      success: false,
      code: 'RUN_ALREADY_LIVE',
      phase: 'cards_failed_to_start',
    })
    expect(out.error).toMatch(/do not start another/i)
  })

  it('RUN_ALREADY_LIVE on the PEOPLE leg still reports the cards that were run', async () => {
    // The cards already landed and are already paid for. "Nothing happened" is
    // the wrong story; "you paid for cards, the people search did not start" is
    // what actually occurred.
    tableData.prospect_list_entry = { data: [selected('e1')], error: null }
    hoisted.createRun
      .mockResolvedValueOnce({ ok: true, run: { ...RUN_ROW, id: 'run-cards', kind: 'account_card' } })
      .mockResolvedValueOnce({ ok: false, code: 'RUN_ALREADY_LIVE', error: 'live' })
    hoisted.getRun.mockResolvedValue({
      ok: true,
      run: { ...RUN_ROW, id: 'run-cards', status: 'completed', spent_dollars: 0.013 },
    })

    const out = await run('find_prospects', {
      list_id: 'list-1',
      entry_ids: ['e1'],
      confirmed_with_user: true,
    })
    expect(out).toMatchObject({ success: false, phase: 'people_failed_to_start' })
    expect(out.cards.run).toMatchObject({ run_id: 'run-cards', status: 'completed' })
  })

  it('reads both the list and the entries with the CONSTRUCTOR workspace', async () => {
    tableData.prospect_list_entry = { data: [carded('e1')], error: null }
    hoisted.createRun.mockResolvedValue({ ok: true, run: { ...RUN_ROW, kind: 'people' } })
    await run('find_prospects', {
      list_id: 'list-1',
      entry_ids: ['e1'],
      confirmed_with_user: true,
    })
    for (const q of [...readsOf('prospect_list'), ...readsOf('prospect_list_entry')]) {
      expect(q.filters).toContainEqual(['eq', 'workspace_id', WS])
    }
    // And the runs it created carried the constructor ids too.
    expect(hoisted.createRun.mock.calls[0][1]).toMatchObject({ workspaceId: WS, userId: USER })
  })

  it('a foreign list id is NOT_FOUND and nothing is created', async () => {
    tableData.prospect_list = { data: null, error: null }
    const out = await run('find_prospects', {
      list_id: 'list-in-other-ws',
      entry_ids: ['e1'],
      confirmed_with_user: true,
    })
    expect(out).toMatchObject({ success: false, code: 'NOT_FOUND' })
    expect(hoisted.createRun).not.toHaveBeenCalled()
  })

  it('carries list_id, list_name and the list url on the success shape', async () => {
    tableData.prospect_list_entry = { data: [carded('e1')], error: null }
    hoisted.createRun.mockResolvedValue({ ok: true, run: { ...RUN_ROW, kind: 'people' } })
    const out = await run('find_prospects', {
      list_id: 'list-1',
      entry_ids: ['e1'],
      confirmed_with_user: true,
    })
    expect(out).toMatchObject({ list_id: 'list-1', list_name: 'Series A fintechs' })
    expect(out.url).toContain('list-1')
  })
})

// ---------------------------------------------------------------------------
// Candidates and cancel
// ---------------------------------------------------------------------------

describe('get_prospecting_run_candidates / cancel_prospecting_run', () => {
  it('groups the ledger by suppression reason and caps the examples', async () => {
    hoisted.listRunCandidates.mockResolvedValue({
      ok: true,
      total: 30,
      run: { ...RUN_ROW, status: 'completed', counts: { crm: 12 } },
      groups: [
        {
          outcome: 'suppressed',
          reason: 'crm',
          count: 12,
          candidates: Array.from({ length: 12 }, (_, i) => ({
            display_name: `Co ${i}`,
            identity_key: `co-${i}`,
            discovery_angle: 'segment',
            link: { kind: 'company', id: `c-${i}` },
            raw: { huge: 'blob' },
          })),
        },
      ],
    })
    const out = await run('get_prospecting_run_candidates', { run_id: 'run-1' })
    expect(out.total).toBe(30)
    expect(out.groups[0]).toMatchObject({ outcome: 'suppressed', reason: 'crm', count: 12 })
    // Ten examples, and the `raw` blob is dropped.
    expect(out.groups[0].examples).toHaveLength(10)
    expect(out.groups[0].examples[0]).not.toHaveProperty('raw')
    expect(hoisted.listRunCandidates.mock.calls[0][1]).toEqual({ workspaceId: WS, runId: 'run-1' })
  })

  it('cancel says partial results are kept', async () => {
    hoisted.requestCancel.mockResolvedValue({
      ok: true,
      run: { ...RUN_ROW, status: 'canceling' },
    })
    const out = await run('cancel_prospecting_run', { run_id: 'run-1' })
    expect(out.success).toBe(true)
    expect(out.status).toBe('canceling')
    expect(out.message).toMatch(/kept/i)
  })

  it('cancel on a finished run is refused, not retried', async () => {
    hoisted.requestCancel.mockResolvedValue({
      ok: false,
      code: 'NOT_CANCELABLE',
      error: 'This run has already finished',
    })
    const out = await run('cancel_prospecting_run', { run_id: 'run-1' })
    expect(out).toMatchObject({ success: false, code: 'NOT_CANCELABLE' })
  })
})

// ---------------------------------------------------------------------------
// save / dismiss
// ---------------------------------------------------------------------------

describe('save_prospect_entries', () => {
  it('keeps the entries on the list — no promotion, no CRM — and reports per list', async () => {
    // Save is curation (migration 259): the list is what the user is
    // building, and the CRM sees none of it until publish_prospect_list.
    hoisted.saveEntriesToList.mockResolvedValue({
      ok: true,
      saved: [
        { entry_id: 'e-1', list_id: 'list-1', kind: 'company' },
        { entry_id: 'e-2', list_id: 'list-1', kind: 'person' },
      ],
      skipped: [{ entry_id: 'e-gone', list_id: '', reason: 'not_found' }],
    })
    const out = await run('save_prospect_entries', { entry_ids: ['e-1', 'e-2', 'e-gone'] })
    expect(out.success).toBe(true)
    expect(out.saved_count).toBe(2)
    expect(out.skipped_count).toBe(1)
    expect(out.list_ids).toEqual(['list-1'])
    expect(out.by_list).toEqual([
      {
        list_id: 'list-1',
        list_name: 'Series A fintechs',
        saved_companies: 1,
        saved_people: 1,
        needs_review: 0,
        skipped_other: 0,
      },
    ])
    expect(out.message).toMatch(/not in the CRM/i)
    expect(hoisted.saveEntriesToList.mock.calls[0][1]).toMatchObject({
      workspaceId: WS,
      userId: USER,
      entryIds: ['e-1', 'e-2', 'e-gone'],
    })
    expect(hoisted.promoteEntries).not.toHaveBeenCalled()
    expect(hoisted.publishEntries).not.toHaveBeenCalled()
    expect(hoisted.publishList).not.toHaveBeenCalled()
  })

  it('takes no include_unverified — the identity gate lives at publish time', () => {
    const schema = (tools.save_prospect_entries as unknown as { inputSchema: { shape: Record<string, unknown> } }).inputSchema
    expect(Object.keys(schema.shape)).toEqual(['entry_ids'])
  })
})

describe('publish_prospect_list', () => {
  const PUBLISHED = {
    ok: true,
    saved: [
      { entry_id: 'e-1', list_id: 'list-1', kind: 'company', company_id: 'co-1' },
      { entry_id: 'e-2', list_id: 'list-1', kind: 'person', contact_id: 'ct-1', email: 'ada@vanta.com' },
      // A person with no email cannot be enrolled — reported, not swallowed.
      { entry_id: 'e-3', list_id: 'list-1', kind: 'person', contact_id: 'ct-2', email: null },
    ],
    skipped: [{ entry_id: 'e-4', list_id: 'list-1', reason: 'needs_review' }],
    list_ids: ['list-1'],
    published_at: '2026-09-06T12:00:00.000Z',
    list_name: 'Series A fintechs',
  }

  it('refuses without the go-ahead and writes nothing', async () => {
    const out = await run('publish_prospect_list', { list_id: 'list-1', confirmed_with_user: false })
    expect(out.success).toBe(false)
    expect(out.needs_go_ahead).toBe(true)
    expect(hoisted.publishList).not.toHaveBeenCalled()
    expect(hoisted.publishEntries).not.toHaveBeenCalled()
  })

  it('publishes the whole list, reports per list, names it, and hands back the ids that can be sequenced', async () => {
    hoisted.publishList.mockResolvedValue(PUBLISHED)
    const out = await run('publish_prospect_list', { list_id: 'list-1', confirmed_with_user: true })
    expect(out.success).toBe(true)
    expect(out.published).toBe(true)
    expect(out.list_id).toBe('list-1')
    expect(out.list_name).toBe('Series A fintechs')
    expect(out.saved_count).toBe(3)
    expect(out.skipped_count).toBe(1)
    expect(out.published_at).toBe('2026-09-06T12:00:00.000Z')
    expect(out.by_list).toEqual([
      {
        list_id: 'list-1',
        list_name: 'Series A fintechs',
        saved_companies: 1,
        saved_people: 2,
        // The namesake gate is counted APART from every other skip: it is the
        // only one the user can act on, by confirming a person by name.
        needs_review: 1,
        skipped_other: 0,
      },
    ])
    expect(out.sequenceable_contact_ids).toEqual(['ct-1'])
    expect(out.url).toBeTruthy()
    expect(hoisted.publishList.mock.calls[0][1]).toMatchObject({ workspaceId: WS, userId: USER, listId: 'list-1' })
    expect(hoisted.publishEntries).not.toHaveBeenCalled()
  })

  it('publishes ONE confirmed person through entry_ids with include_unverified', async () => {
    hoisted.publishEntries.mockResolvedValue({ ...PUBLISHED, saved: [PUBLISHED.saved[1]], skipped: [] })
    const out = await run('publish_prospect_list', {
      list_id: 'list-1',
      entry_ids: ['e-4'],
      include_unverified: true,
      confirmed_with_user: true,
    })
    expect(out.success).toBe(true)
    expect(hoisted.publishEntries.mock.calls[0][1]).toMatchObject({
      entryIds: ['e-4'],
      includeUnverified: true,
    })
    expect(hoisted.publishList).not.toHaveBeenCalled()
  })

  it('refuses include_unverified over a batch, or without entry_ids at all', async () => {
    const batch = await run('publish_prospect_list', {
      list_id: 'list-1',
      entry_ids: ['e-1', 'e-2'],
      include_unverified: true,
      confirmed_with_user: true,
    })
    expect(batch.success).toBe(false)
    expect(batch.error).toMatch(/per-row override/i)
    const whole = await run('publish_prospect_list', {
      list_id: 'list-1',
      include_unverified: true,
      confirmed_with_user: true,
    })
    expect(whole.success).toBe(false)
    expect(hoisted.publishEntries).not.toHaveBeenCalled()
    expect(hoisted.publishList).not.toHaveBeenCalled()
  })

  it('says so when nothing was pending', async () => {
    hoisted.publishList.mockResolvedValue({ ...PUBLISHED, saved: [], skipped: [], published_at: null })
    const out = await run('publish_prospect_list', { list_id: 'list-1', confirmed_with_user: true })
    expect(out.success).toBe(true)
    expect(out.message).toMatch(/nothing new/i)
  })
})

describe('dismiss_prospect_entries', () => {
  it('refuses without an explicit user confirmation', async () => {
    const out = await run('dismiss_prospect_entries', {
      entry_ids: ['e-1'],
      reason: 'competitor',
      confirmed_with_user: false,
    })
    expect(out.success).toBe(false)
    expect(out.error).toMatch(/only when the user asks/i)
    expect(hoisted.updateEntryStage).not.toHaveBeenCalled()
  })

  it('says out loud when a reason suppresses workspace-wide', async () => {
    hoisted.updateEntryStage.mockResolvedValue({ ok: true, entry: { id: 'e-1' } })
    const out = await run('dismiss_prospect_entries', {
      entry_ids: ['e-1', 'e-2'],
      reason: 'competitor',
      confirmed_with_user: true,
    })
    expect(out.success).toBe(true)
    expect(out.updated).toBe(2)
    expect(out.suppresses_workspace_wide).toBe(true)
    expect(out.message).toMatch(/every list in this workspace/i)
    expect(hoisted.updateEntryStage.mock.calls[0][1]).toMatchObject({
      workspaceId: WS,
      userId: USER,
      stage: 'dismissed',
      dismissedReason: 'competitor',
    })
  })

  it('names the lists it actually changed, read from the rows it wrote', async () => {
    // From the UPDATED ROW, never from the request: an id that failed, or that
    // belongs to another workspace, contributes nothing. The list page watches
    // these to know whether a dismissal made in the chat was on the list it is
    // showing.
    hoisted.updateEntryStage
      .mockResolvedValueOnce({ ok: true, entry: { id: 'e-1', list_id: 'list-1' } })
      .mockResolvedValueOnce({ ok: true, entry: { id: 'e-2', list_id: 'list-2' } })
      .mockResolvedValueOnce({ ok: true, entry: { id: 'e-3', list_id: 'list-1' } })
      .mockResolvedValueOnce({ ok: false, code: 'NOT_FOUND', error: 'Entry not found' })
    const out = await run('dismiss_prospect_entries', {
      entry_ids: ['e-1', 'e-2', 'e-3', 'e-other-ws'],
      confirmed_with_user: true,
    })
    expect(out.list_ids).toEqual(['list-1', 'list-2'])
    expect(out.updated).toBe(3)
  })

  it('a list-relative reason does NOT claim workspace-wide suppression', async () => {
    hoisted.updateEntryStage.mockResolvedValue({ ok: true, entry: { id: 'e-1' } })
    const out = await run('dismiss_prospect_entries', {
      entry_ids: ['e-1'],
      reason: 'too_small',
      confirmed_with_user: true,
    })
    expect(out.suppresses_workspace_wide).toBe(false)
    expect(out.message).not.toMatch(/every list/i)
  })

  it('an undo passes no dismissal reason', async () => {
    hoisted.updateEntryStage.mockResolvedValue({ ok: true, entry: { id: 'e-1' } })
    await run('dismiss_prospect_entries', {
      entry_ids: ['e-1'],
      stage: 'discovered',
      reason: 'competitor',
      confirmed_with_user: true,
    })
    expect(hoisted.updateEntryStage.mock.calls[0][1]).toMatchObject({
      stage: 'discovered',
      dismissedReason: undefined,
    })
  })

  it('reports per-entry failures rather than one opaque error', async () => {
    hoisted.updateEntryStage
      .mockResolvedValueOnce({ ok: true, entry: { id: 'e-1' } })
      .mockResolvedValueOnce({ ok: false, code: 'NOT_FOUND', error: 'Entry not found' })
    const out = await run('dismiss_prospect_entries', {
      entry_ids: ['e-1', 'e-other-ws'],
      confirmed_with_user: true,
    })
    expect(out.success).toBe(false)
    expect(out.updated).toBe(1)
    expect(out.failed).toEqual([
      { entry_id: 'e-other-ws', ok: false, error: 'Entry not found' },
    ])
  })
})

// ---------------------------------------------------------------------------
// Shape guards
// ---------------------------------------------------------------------------

describe('the tool set as a whole', () => {
  it('exports exactly the contracted names', () => {
    expect(Object.keys(tools).sort()).toEqual(
      [
        'cancel_prospecting_run',
        'create_prospect_list',
        'dismiss_prospect_entries',
        'find_prospect_people',
        'find_prospects',
        'get_prospecting_run_candidates',
        'list_prospect_entries',
        'list_prospect_lists',
        'research_my_company',
        'research_prospect_companies',
        'publish_prospect_list',
        'run_prospect_discovery',
        'save_prospect_entries',
        'update_prospect_list',
        'wait_for_prospecting_run',
      ].sort(),
    )
  })

  it('EVERY list-bearing output carries list_id AND list_name — the chip needs a label', async () => {
    // The id is what the code needs; the name is the only part of it a person
    // can recognise. A chip that renders "Open list" for a list the user just
    // named themselves is the bug this pins.
    tableData.prospect_list = { data: { id: 'list-1', name: 'Series A fintechs' }, error: null }
    tableData.prospect_list_entry = { data: [], error: null }
    hoisted.createRun.mockResolvedValue({ ok: true, run: RUN_ROW })
    hoisted.getRun.mockResolvedValue({ ok: true, run: { ...RUN_ROW, status: 'completed' } })
    hoisted.requestCancel.mockResolvedValue({ ok: true, run: { ...RUN_ROW, status: 'canceling' } })
    hoisted.listRunCandidates.mockResolvedValue({
      ok: true,
      run: { list_id: 'list-1', status: 'completed', counts: {} },
      total: 0,
      groups: [],
    })
    hoisted.listEntries.mockResolvedValue({
      ok: true,
      entries: [],
      entry_counts: { total: 0, discovered: 0, shortlisted: 0, saved: 0, dismissed: 0, saved_people: 0 },
    })
    hoisted.createList.mockResolvedValue({ ok: true, list: { id: 'list-1', name: 'Series A fintechs' } })
    hoisted.publishList.mockResolvedValue({
      ok: true,
      saved: [],
      skipped: [],
      list_ids: ['list-1'],
      published_at: null,
      list_name: 'Series A fintechs',
    })
    hoisted.updateList.mockResolvedValue({
      ok: true,
      list: { id: 'list-1', name: 'Series A fintechs' },
      icp_version_bumped: false,
    })

    const calls: Array<[keyof typeof tools, unknown]> = [
      ['create_prospect_list', { name: 'Series A fintechs' }],
      ['update_prospect_list', { list_id: 'list-1', name: 'Series A fintechs' }],
      ['list_prospect_entries', { list_id: 'list-1' }],
      ['run_prospect_discovery', { list_id: 'list-1', confirmed_with_user: true }],
      ['research_prospect_companies', { list_id: 'list-1', entry_ids: ['e1'], confirmed_with_user: true }],
      ['find_prospect_people', { list_id: 'list-1', entry_ids: ['e1'], confirmed_with_user: true }],
      ['publish_prospect_list', { list_id: 'list-1', confirmed_with_user: true }],
      ['wait_for_prospecting_run', { run_id: 'run-1' }],
      ['get_prospecting_run_candidates', { run_id: 'run-1' }],
      ['cancel_prospecting_run', { run_id: 'run-1' }],
    ]
    for (const [name, input] of calls) {
      const out = await run(name, input)
      expect(out.list_id, name).toBe('list-1')
      expect(out.list_name, name).toBe('Series A fintechs')
    }
  })

  it('no tool takes a workspace_id, EXCEPT the one deliberate root create — tenancy is otherwise not model input', () => {
    // create_prospect_list is a ROOT create (see _shared.ts "CREATE-TIME
    // WORKSPACE ROUTING"): it alone takes an OPTIONAL workspace_id, resolved
    // through resolveCreateWorkspace, because a create has no existing row to
    // route BY. Every other tool still routes by an id it was already given
    // (list_id / run_id / entry_id) via resolveEntityWorkspace, so it takes no
    // workspace_id of its own. See routing.prospecting.test.ts for the routing
    // behavior itself.
    for (const [name, def] of Object.entries(tools)) {
      const schema = (def as { inputSchema?: { shape?: Record<string, unknown> } }).inputSchema
      const keys = Object.keys(schema?.shape ?? {})
      if (name === 'create_prospect_list') {
        expect(keys, name).toContain('workspace_id')
      } else {
        expect(keys, name).not.toContain('workspace_id')
      }
      expect(keys, name).not.toContain('user_id')
    }
  })

  it('every run tool says it needs the go-ahead', () => {
    for (const name of [
      'run_prospect_discovery',
      'research_prospect_companies',
      'find_prospect_people',
      'find_prospects',
      'publish_prospect_list',
    ] as const) {
      expect((tools[name] as { description: string }).description).toMatch(/needs the user's go-ahead/)
    }
  })

  it('no tool mentions money anywhere the model can read — description or schema', () => {
    // Liam's rule: the $20 month ceiling and the per-run caps exist in the
    // backend and the user never hears about them. A tool description is
    // read by the model and repeated to the user, so it counts.
    for (const [name, def] of Object.entries(tools)) {
      const d = def as { description: string; inputSchema?: { shape?: Record<string, { description?: string }> } }
      expect(d.description, `${name} description`).not.toMatch(MONEY)
      for (const [key, field] of Object.entries(d.inputSchema?.shape ?? {})) {
        expect(key, `${name}.${key}`).not.toMatch(/dollar|budget|spend|quote/i)
        expect(field?.description ?? '', `${name}.${key} description`).not.toMatch(MONEY)
      }
    }
  })
})
