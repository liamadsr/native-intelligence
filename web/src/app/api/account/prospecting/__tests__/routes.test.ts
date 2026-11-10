/**
 * Integration tests for the prospecting routes.
 *
 * Same tier as `src/app/api/account/contacts/__tests__/route.test.ts`: the
 * handler runs end to end from `new Request()` → `Response`, with `api-auth`
 * and the prospecting lib mocked. What is under test here is the ROUTE's own
 * job — parsing, validation, and the mapping from a lib result code to an HTTP
 * status — not the lib logic, which has its own tests.
 *
 * The mappings that matter and would otherwise be silent:
 *   - LIST_NAME_TAKEN → 409 (not 500): a fixable mistake
 *   - NOT_FOUND → 404 for every cross-workspace id (not 403)
 *   - hand-add collision → 200 {status:'exists'} (not an error)
 *   - save → 200 with per-entry outcomes even when NOTHING saved
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildRequest } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  createList: vi.fn(),
  listLists: vi.fn(),
  getList: vi.fn(),
  updateList: vi.fn(),
  archiveList: vi.fn(),
  deleteList: vi.fn(),
  addEntryByDomain: vi.fn(),
  createRun: vi.fn(),
  updateEntryStage: vi.fn(),
  promoteEntries: vi.fn(),
  saveEntriesToList: vi.fn(),
  publishEntries: vi.fn(),
  publishList: vi.fn(),
  listSequencedByList: vi.fn(),
  exclusionCounts: vi.fn(),
  resolveSourceCompany: vi.fn(),
  establishSourceCompany: vi.fn(),
  suggestedDomainFor: vi.fn(),
  fireIcpCard: vi.fn(),
  inngestSend: vi.fn(),
  hasPermanentFailure: vi.fn(),
  companyMaybeSingle: vi.fn(),
  companyUpdate: vi.fn(),
  listMaybeSingle: vi.fn(),
  entryMaybeSingle: vi.fn(),
  getServiceClient: vi.fn(),
}))

const WS = 'ws-1'
const USER = { id: 'user-1', email: 'ada@acme.test' }

/** The RLS-scoped client `requireWorkspace` hands the route. Only the two
 *  direct reads the routes do themselves need to answer. */
function tableMaybeSingle(table: string) {
  if (table === 'prospect_list') return hoisted.listMaybeSingle
  if (table === 'company') return hoisted.companyMaybeSingle
  return hoisted.entryMaybeSingle
}

const supabase = {
  from: (table: string) => ({
    select: () => ({
      eq: () => ({
        eq: () => ({
          maybeSingle: tableMaybeSingle(table),
        }),
      }),
    }),
    // The source route's own `enrichment_status: 'pending'` mark — the same
    // write the CRM's manual Enrich button makes.
    update: (payload: unknown) => ({
      eq: () => ({
        eq: async () => hoisted.companyUpdate(payload),
      }),
    }),
  }),
}

vi.mock('@/lib/api-auth', () => ({ requireWorkspace: hoisted.requireWorkspace }))
vi.mock('@/lib/admin', () => ({ getServiceClient: hoisted.getServiceClient }))
vi.mock('@/lib/prospecting/lists', () => ({
  createList: hoisted.createList,
  listLists: hoisted.listLists,
  getList: hoisted.getList,
  listEntries: vi.fn(),
  updateList: hoisted.updateList,
  archiveList: hoisted.archiveList,
  deleteList: hoisted.deleteList,
  addEntryByDomain: hoisted.addEntryByDomain,
  updateEntryStage: hoisted.updateEntryStage,
  promoteEntries: hoisted.promoteEntries,
  saveEntriesToList: hoisted.saveEntriesToList,
  listSequencedByList: hoisted.listSequencedByList,
  exclusionCounts: hoisted.exclusionCounts,
}))
vi.mock('@/lib/prospecting/source-company', () => ({
  resolveSourceCompany: hoisted.resolveSourceCompany,
  establishSourceCompany: hoisted.establishSourceCompany,
  suggestedDomainFor: hoisted.suggestedDomainFor,
}))
vi.mock('@/lib/prospecting/research', () => ({ fireIcpCard: hoisted.fireIcpCard }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: hoisted.inngestSend } }))
vi.mock('@/lib/prospecting/runs', () => ({ createRun: hoisted.createRun }))
vi.mock('@/lib/crm/enrichment', async () => ({
  // `normalizeDomain` is a pure string helper that icp.ts imports at module
  // load; keep the real one so the ICP seed behaves as it does in production,
  // and stub only the network-adjacent status check.
  ...(await vi.importActual<typeof import('@/lib/crm/enrichment')>('@/lib/crm/enrichment')),
  hasPermanentFailure: hoisted.hasPermanentFailure,
}))

const listsRoute = await import('@/app/api/account/prospecting/lists/route')
const listDetailRoute = await import('@/app/api/account/prospecting/lists/[id]/route')
const entriesRoute = await import('@/app/api/account/prospecting/lists/[id]/entries/route')
const entryRoute = await import('@/app/api/account/prospecting/entries/[id]/route')
vi.mock('@/lib/prospecting/publish', () => ({
  publishEntries: hoisted.publishEntries,
  publishList: hoisted.publishList,
}))

const saveRoute = await import('@/app/api/account/prospecting/entries/save/route')
const publishEntriesRoute = await import('@/app/api/account/prospecting/entries/publish/route')
const publishListRoute = await import('@/app/api/account/prospecting/lists/[id]/publish/route')
const sequencedRoute = await import('@/app/api/account/prospecting/lists/[id]/sequenced/route')
const sourceRoute = await import('@/app/api/account/prospecting/source/route')

const params = (id: string) => ({ params: Promise.resolve({ id }) })

/** Next's route handlers read `request.nextUrl`; a plain Request has none, so
 *  the search params are attached the way NextRequest exposes them. */
function nextRequest(url: string, init: Parameters<typeof buildRequest>[0] = {}) {
  const req = buildRequest({ ...init, url })
  Object.defineProperty(req, 'nextUrl', { value: new URL(url) })
  return req as never
}

beforeEach(() => {
  for (const fn of Object.values(hoisted)) fn.mockReset()
  hoisted.requireWorkspace.mockResolvedValue({ supabase, user: USER, workspaceId: WS })
  hoisted.getServiceClient.mockReturnValue(supabase)
  // The source route's own defaults: an un-enriched company, no permanent
  // failure marker, a successful pending mark. Individual tests override.
  hoisted.companyMaybeSingle.mockResolvedValue({
    data: { id: 'co-1', enrichment_status: null, metadata: null },
    error: null,
  })
  hoisted.companyUpdate.mockResolvedValue({ error: null })
  hoisted.hasPermanentFailure.mockReturnValue(false)
  hoisted.inngestSend.mockResolvedValue(undefined)
  hoisted.suggestedDomainFor.mockImplementation((email: string | null | undefined) =>
    email && email.endsWith('@acme.test') ? 'acme.test' : null,
  )
})

// ---------------------------------------------------------------------------
// /lists
// ---------------------------------------------------------------------------

describe('GET /api/account/prospecting/lists', () => {
  it('returns the workspace lists', async () => {
    hoisted.listLists.mockResolvedValue({ ok: true, lists: [{ id: 'list-1' }] })
    const res = await listsRoute.GET(nextRequest('https://nativeintelligence.dev/api/account/prospecting/lists'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ lists: [{ id: 'list-1' }] })
    expect(hoisted.listLists).toHaveBeenCalledWith(supabase, { workspaceId: WS, includeArchived: false })
  })

  it('passes include_archived through', async () => {
    hoisted.listLists.mockResolvedValue({ ok: true, lists: [] })
    await listsRoute.GET(
      nextRequest('https://nativeintelligence.dev/api/account/prospecting/lists?include_archived=true'),
    )
    expect(hoisted.listLists).toHaveBeenCalledWith(supabase, { workspaceId: WS, includeArchived: true })
  })

  it('propagates the auth Response untouched', async () => {
    hoisted.requireWorkspace.mockResolvedValue(new Response('nope', { status: 401 }))
    const res = await listsRoute.GET(nextRequest('https://nativeintelligence.dev/api/account/prospecting/lists'))
    expect(res.status).toBe(401)
    expect(hoisted.listLists).not.toHaveBeenCalled()
  })
})

describe('POST /api/account/prospecting/lists', () => {
  it('creates and returns 201', async () => {
    hoisted.createList.mockResolvedValue({ ok: true, list: { id: 'list-1' } })
    const res = await listsRoute.POST(
      nextRequest('https://nativeintelligence.dev/x', { body: { name: 'Big sales teams', purpose: 'buyers' } }),
    )
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ list: { id: 'list-1' } })
    expect(hoisted.createList.mock.calls[0][1].input).toMatchObject({
      name: 'Big sales teams',
      purpose: 'buyers',
    })
  })

  it('maps LIST_NAME_TAKEN to 409, not 500', async () => {
    hoisted.createList.mockResolvedValue({
      ok: false,
      code: 'LIST_NAME_TAKEN',
      error: 'A list called "Dupe" already exists in this workspace',
    })
    const res = await listsRoute.POST(nextRequest('https://nativeintelligence.dev/x', { body: { name: 'Dupe' } }))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'LIST_NAME_TAKEN' })
  })

  it('maps INVALID_INPUT to 400 and a DB error to 500', async () => {
    hoisted.createList.mockResolvedValue({ ok: false, code: 'INVALID_INPUT', error: 'name is required' })
    expect((await listsRoute.POST(nextRequest('https://nativeintelligence.dev/x', { body: {} }))).status).toBe(400)

    hoisted.createList.mockResolvedValue({ ok: false, code: 'DB_ERROR', error: 'boom' })
    expect((await listsRoute.POST(nextRequest('https://nativeintelligence.dev/x', { body: { name: 'X' } }))).status).toBe(500)
  })

  it('rejects an unparseable body before calling the lib', async () => {
    const res = await listsRoute.POST(nextRequest('https://nativeintelligence.dev/x', { body: '{oops', raw: true }))
    expect(res.status).toBe(400)
    expect(hoisted.createList).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// /lists/[id]
// ---------------------------------------------------------------------------

describe('/api/account/prospecting/lists/[id]', () => {
  it('GET returns the list, entries and counts', async () => {
    hoisted.getList.mockResolvedValue({
      ok: true,
      list: { id: 'list-1' },
      entries: [{ id: 'e1' }],
      entry_counts: { total: 1 },
    })
    const res = await listDetailRoute.GET(
      nextRequest('https://nativeintelligence.dev/api/account/prospecting/lists/list-1'),
      params('list-1'),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      list: { id: 'list-1' },
      entries: [{ id: 'e1' }],
      entry_counts: { total: 1 },
    })
  })

  it('GET passes a valid ?stage through and ignores an invalid one', async () => {
    hoisted.getList.mockResolvedValue({ ok: true, list: {}, entries: [], entry_counts: {} })
    await listDetailRoute.GET(nextRequest('https://nativeintelligence.dev/x?stage=saved'), params('list-1'))
    expect(hoisted.getList.mock.calls[0][1].stage).toBe('saved')

    await listDetailRoute.GET(nextRequest('https://nativeintelligence.dev/x?stage=bogus'), params('list-1'))
    expect(hoisted.getList.mock.calls[1][1].stage).toBeUndefined()
  })

  it('GET pushes the score floor and kind through to the lib', async () => {
    // The filters are SQL predicates in `listEntries` now, so what the route
    // owes is the whitelist: whatever it forwards reaches a `.gte()`/`.eq()`
    // with no further validation.
    hoisted.getList.mockResolvedValue({ ok: true, list: {}, entries: [], entry_counts: {} })
    await listDetailRoute.GET(
      nextRequest('https://nativeintelligence.dev/x?min_fit_score=80&kind=company'),
      params('list-1'),
    )
    expect(hoisted.getList.mock.calls[0][1]).toMatchObject({
      min_fit_score: 80,
      kind: 'company',
    })

    await listDetailRoute.GET(nextRequest('https://nativeintelligence.dev/x?min_fit_score=0'), params('list-1'))
    expect(hoisted.getList.mock.calls[1][1].min_fit_score).toBe(0)
  })

  it('GET DROPS an unknown score floor or kind rather than passing it to a query', async () => {
    hoisted.getList.mockResolvedValue({ ok: true, list: {}, entries: [], entry_counts: {} })
    await listDetailRoute.GET(
      nextRequest('https://nativeintelligence.dev/x?min_fit_score=hot&kind=robot'),
      params('list-1'),
    )
    const args = hoisted.getList.mock.calls[0][1]
    expect(args.min_fit_score).toBeUndefined()
    expect(args.kind).toBeUndefined()
  })

  it('GET returns 404 for a cross-workspace id — never 403', async () => {
    hoisted.getList.mockResolvedValue({ ok: false, code: 'NOT_FOUND', error: 'List not found' })
    const res = await listDetailRoute.GET(nextRequest('https://nativeintelligence.dev/x'), params('other-ws'))
    expect(res.status).toBe(404)
  })

  it('PATCH surfaces whether the ICP version was bumped', async () => {
    hoisted.updateList.mockResolvedValue({
      ok: true,
      list: { id: 'list-1', icp_version: 4 },
      icp_version_bumped: true,
    })
    const res = await listDetailRoute.PATCH(
      nextRequest('https://nativeintelligence.dev/x', { method: 'PATCH', body: { icp: {} } }),
      params('list-1'),
    )
    expect(await res.json()).toMatchObject({ icp_version_bumped: true })
  })

  it('PATCH maps NOT_FOUND to 404 and LIST_NAME_TAKEN to 409', async () => {
    hoisted.updateList.mockResolvedValue({ ok: false, code: 'NOT_FOUND', error: 'x' })
    expect(
      (
        await listDetailRoute.PATCH(
          nextRequest('https://nativeintelligence.dev/x', { method: 'PATCH', body: {} }),
          params('list-1'),
        )
      ).status,
    ).toBe(404)

    hoisted.updateList.mockResolvedValue({ ok: false, code: 'LIST_NAME_TAKEN', error: 'x' })
    expect(
      (
        await listDetailRoute.PATCH(
          nextRequest('https://nativeintelligence.dev/x', { method: 'PATCH', body: {} }),
          params('list-1'),
        )
      ).status,
    ).toBe(409)
  })

  it('DELETE deletes the list and reports what left the CRM group', async () => {
    // Liam, 2026-09-06: "add a way to delete a list". The route used to
    // archive on the user's behalf; now the trade (dismissals stop
    // suppressing) is stated in the dialog and the delete is real.
    hoisted.deleteList.mockResolvedValue({
      ok: true,
      list: { id: 'list-1', name: 'Big sales teams' },
      unpublished: { companies: 2, contacts: 5 },
    })
    const res = await listDetailRoute.DELETE(
      nextRequest('https://nativeintelligence.dev/x', { method: 'DELETE' }),
      params('list-1'),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      deleted: true,
      list: { id: 'list-1' },
      unpublished: { companies: 2, contacts: 5 },
    })
    expect(hoisted.deleteList).toHaveBeenCalledWith(supabase, { workspaceId: WS, listId: 'list-1' })
    expect(hoisted.archiveList).not.toHaveBeenCalled()
  })

  it('DELETE refuses a list with a run in flight — 409, with the reason', async () => {
    hoisted.deleteList.mockResolvedValue({
      ok: false,
      code: 'RUN_LIVE',
      error: 'A run is still going on this list — stop it before deleting',
    })
    const res = await listDetailRoute.DELETE(
      nextRequest('https://nativeintelligence.dev/x', { method: 'DELETE' }),
      params('list-1'),
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'RUN_LIVE', error: expect.stringContaining('stop it') })
  })

  it('DELETE 404s a list the caller cannot see', async () => {
    hoisted.deleteList.mockResolvedValue({ ok: false, code: 'NOT_FOUND', error: 'List not found' })
    const res = await listDetailRoute.DELETE(
      nextRequest('https://nativeintelligence.dev/x', { method: 'DELETE' }),
      params('list-other'),
    )
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// /lists/[id]/entries
// ---------------------------------------------------------------------------

describe('/api/account/prospecting/lists/[id]/entries', () => {
  it('GET returns 404 for a list the caller cannot see, rather than an empty array', async () => {
    hoisted.getList.mockResolvedValue({ ok: false, code: 'NOT_FOUND', error: 'x' })
    const res = await entriesRoute.GET(nextRequest('https://nativeintelligence.dev/x'), params('other-ws'))
    expect(res.status).toBe(404)
  })

  it('GET parses the SAME filters the detail route does', async () => {
    // Two hand-rolled copies of the whitelist is how one route ends up
    // accepting a filter the other silently ignores; both go through
    // `parseEntryFilters`.
    hoisted.getList.mockResolvedValue({ ok: true, list: {}, entries: [], entry_counts: {} })
    await entriesRoute.GET(
      nextRequest('https://nativeintelligence.dev/x?stage=saved&min_fit_score=60&kind=person'),
      params('list-1'),
    )
    expect(hoisted.getList.mock.calls[0][1]).toMatchObject({
      stage: 'saved',
      min_fit_score: 60,
      kind: 'person',
    })
  })

  it('POST checks the list exists in THIS workspace before inserting', async () => {
    hoisted.listMaybeSingle.mockResolvedValue({ data: null, error: null })
    const res = await entriesRoute.POST(
      nextRequest('https://nativeintelligence.dev/x', { body: { domain: 'acme.test' } }),
      params('other-ws'),
    )
    expect(res.status).toBe(404)
    expect(hoisted.addEntryByDomain).not.toHaveBeenCalled()
  })

  it("POST returns 201 for a created entry and passes the list's icp_version", async () => {
    hoisted.listMaybeSingle.mockResolvedValue({ data: { id: 'list-1', icp_version: 3 }, error: null })
    hoisted.addEntryByDomain.mockResolvedValue({ ok: true, status: 'created', entry: { id: 'e1' } })
    hoisted.createRun.mockResolvedValue({ ok: true, run: { id: 'run-auto' } })
    const res = await entriesRoute.POST(
      nextRequest('https://nativeintelligence.dev/x', { body: { domain: 'acme.test', name: 'Acme' } }),
      params('list-1'),
    )
    expect(res.status).toBe(201)
    expect(hoisted.addEntryByDomain.mock.calls[0][1]).toMatchObject({
      workspaceId: WS,
      listId: 'list-1',
      domain: 'acme.test',
      name: 'Acme',
      icpVersion: 3,
    })
  })

  it('POST profiles a hand-added company by itself — the same automatic score a discovered one gets', async () => {
    hoisted.listMaybeSingle.mockResolvedValue({ data: { id: 'list-1', icp_version: 3 }, error: null })
    hoisted.addEntryByDomain.mockResolvedValue({ ok: true, status: 'created', entry: { id: 'e1' } })
    hoisted.createRun.mockResolvedValue({ ok: true, run: { id: 'run-auto' } })
    const res = await entriesRoute.POST(
      nextRequest('https://nativeintelligence.dev/x', { body: { domain: 'acme.test' } }),
      params('list-1'),
    )
    expect(hoisted.createRun.mock.calls[0][1]).toEqual({
      workspaceId: WS,
      userId: USER.id,
      listId: 'list-1',
      kind: 'account_card',
      entryIds: ['e1'],
    })
    expect(await res.json()).toMatchObject({ status: 'created', auto_profile_run_id: 'run-auto' })
  })

  it('POST still 201s when another run holds the list — the add never fails on the profile', async () => {
    hoisted.listMaybeSingle.mockResolvedValue({ data: { id: 'list-1', icp_version: 3 }, error: null })
    hoisted.addEntryByDomain.mockResolvedValue({ ok: true, status: 'created', entry: { id: 'e1' } })
    hoisted.createRun.mockResolvedValue({ ok: false, code: 'RUN_ALREADY_LIVE', error: 'busy' })
    const res = await entriesRoute.POST(
      nextRequest('https://nativeintelligence.dev/x', { body: { domain: 'acme.test' } }),
      params('list-1'),
    )
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ status: 'created', auto_profile_run_id: null })
  })

  it("POST returns 200 {status:'exists'} on a dedup collision — not an error", async () => {
    hoisted.listMaybeSingle.mockResolvedValue({ data: { id: 'list-1', icp_version: 1 }, error: null })
    hoisted.addEntryByDomain.mockResolvedValue({
      ok: true,
      status: 'exists',
      entry: { id: 'e-existing' },
    })
    const res = await entriesRoute.POST(
      nextRequest('https://nativeintelligence.dev/x', { body: { domain: 'acme.test' } }),
      params('list-1'),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      entry: { id: 'e-existing' },
      status: 'exists',
      // Nothing was created, so nothing is profiled.
      auto_profile_run_id: null,
    })
    expect(hoisted.createRun).not.toHaveBeenCalled()
  })

  it('POST 400s a missing domain and a personal one, with a distinguishable code', async () => {
    const res = await entriesRoute.POST(nextRequest('https://nativeintelligence.dev/x', { body: {} }), params('list-1'))
    expect(res.status).toBe(400)
    expect(hoisted.addEntryByDomain).not.toHaveBeenCalled()

    hoisted.listMaybeSingle.mockResolvedValue({ data: { id: 'list-1', icp_version: 1 }, error: null })
    hoisted.addEntryByDomain.mockResolvedValue({
      ok: false,
      code: 'PERSONAL_DOMAIN',
      error: 'That is a personal email domain, not a company',
    })
    const personal = await entriesRoute.POST(
      nextRequest('https://nativeintelligence.dev/x', { body: { domain: 'gmail.com' } }),
      params('list-1'),
    )
    expect(personal.status).toBe(400)
    // The ENVELOPE's own `code` (@/lib/api-errors), not `details.code`:
    // badRequest's second argument is `details`, which would have left `code`
    // as the generic 'BAD_REQUEST' and made the client's parse depend on a
    // shape no other route uses.
    expect(await personal.json()).toMatchObject({ code: 'PERSONAL_DOMAIN' })
  })
})

// ---------------------------------------------------------------------------
// /entries/[id]
// ---------------------------------------------------------------------------

describe('/api/account/prospecting/entries/[id]', () => {
  it('GET returns 404 for an entry in another workspace', async () => {
    hoisted.entryMaybeSingle.mockResolvedValue({ data: null, error: null })
    const res = await entryRoute.GET(nextRequest('https://nativeintelligence.dev/x'), params('e1'))
    expect(res.status).toBe(404)
  })

  it('PATCH forwards the stage and reason with the caller as dismisser', async () => {
    hoisted.updateEntryStage.mockResolvedValue({ ok: true, entry: { id: 'e1', stage: 'dismissed' } })
    const res = await entryRoute.PATCH(
      nextRequest('https://nativeintelligence.dev/x', {
        method: 'PATCH',
        body: { stage: 'dismissed', dismissed_reason: 'competitor' },
      }),
      params('e1'),
    )
    expect(res.status).toBe(200)
    expect(hoisted.updateEntryStage.mock.calls[0][1]).toEqual({
      workspaceId: WS,
      entryId: 'e1',
      userId: USER.id,
      stage: 'dismissed',
      dismissedReason: 'competitor',
    })
  })

  it('PATCH 400s a missing stage before calling the lib', async () => {
    const res = await entryRoute.PATCH(
      nextRequest('https://nativeintelligence.dev/x', { method: 'PATCH', body: {} }),
      params('e1'),
    )
    expect(res.status).toBe(400)
    expect(hoisted.updateEntryStage).not.toHaveBeenCalled()
  })

  it("PATCH surfaces the lib's refusal of stage='saved' as a 400", async () => {
    hoisted.updateEntryStage.mockResolvedValue({
      ok: false,
      code: 'INVALID_INPUT',
      error: "'saved' is set by saving to the CRM, not by a stage edit",
    })
    const res = await entryRoute.PATCH(
      nextRequest('https://nativeintelligence.dev/x', { method: 'PATCH', body: { stage: 'saved' } }),
      params('e1'),
    )
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// /entries/save
// ---------------------------------------------------------------------------

describe('POST /api/account/prospecting/entries/save', () => {
  it('keeps the entries ON THE LIST — per-entry outcomes, and no promotion', async () => {
    // Save is curation (migration 259): the route marks the rows saved and
    // never touches the CRM. Same outcome shape as Publish, so the page's one
    // reconciliation loop serves both.
    hoisted.saveEntriesToList.mockResolvedValue({
      ok: true,
      saved: [{ entry_id: 'e1', list_id: 'l1', kind: 'company' }],
      skipped: [{ entry_id: 'e2', list_id: '', reason: 'not_found' }],
    })
    const res = await saveRoute.POST(
      nextRequest('https://nativeintelligence.dev/x', { body: { entry_ids: ['e1', 'e2'] } }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      saved: [{ entry_id: 'e1', list_id: 'l1', kind: 'company' }],
      skipped: [{ entry_id: 'e2', list_id: '', reason: 'not_found' }],
    })
    expect(hoisted.saveEntriesToList.mock.calls[0][1]).toMatchObject({ entryIds: ['e1', 'e2'] })
    expect(hoisted.promoteEntries).not.toHaveBeenCalled()
    expect(hoisted.publishEntries).not.toHaveBeenCalled()
  })

  it('ignores include_unverified — the identity gate lives at publish time now', async () => {
    hoisted.saveEntriesToList.mockResolvedValue({ ok: true, saved: [], skipped: [] })
    await saveRoute.POST(
      nextRequest('https://nativeintelligence.dev/x', { body: { entry_ids: ['e1'], include_unverified: true } }),
    )
    expect(hoisted.saveEntriesToList.mock.calls[0][1]).not.toHaveProperty('includeUnverified')
  })

  it('400s a non-array, an empty selection, and an over-cap batch', async () => {
    for (const entry_ids of [undefined, 'e1', [], ['', null]]) {
      const res = await saveRoute.POST(nextRequest('https://nativeintelligence.dev/x', { body: { entry_ids } }))
      expect(res.status).toBe(400)
    }
    const tooMany = await saveRoute.POST(
      nextRequest('https://nativeintelligence.dev/x', {
        body: { entry_ids: Array.from({ length: 101 }, (_, i) => `e${i}`) },
      }),
    )
    expect(tooMany.status).toBe(400)
    expect(await tooMany.json()).toMatchObject({ code: 'TOO_MANY_ENTRIES' })
    expect(hoisted.saveEntriesToList).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// /entries/publish — promotion, for specific entries (migration 259)
// ---------------------------------------------------------------------------

describe('POST /api/account/prospecting/entries/publish', () => {
  it('returns per-entry outcomes, not a count — with kind and email on each, plus the lists and the stamp', async () => {
    hoisted.publishEntries.mockResolvedValue({
      ok: true,
      saved: [
        { entry_id: 'e1', list_id: 'l1', kind: 'company', company_id: 'co-1' },
        // `email` is the ONLY authority on whether the Add-to-sequence dialog
        // may include this row; a null one is the `no_email` case and must
        // survive the route verbatim rather than being dropped as falsy.
        { entry_id: 'e3', list_id: 'l1', kind: 'person', contact_id: 'ct-1', email: null },
      ],
      skipped: [{ entry_id: 'e2', list_id: 'l1', reason: 'dismissed' }],
      list_ids: ['l1'],
      published_at: '2026-09-06T00:00:00.000Z',
    })
    const res = await publishEntriesRoute.POST(
      nextRequest('https://nativeintelligence.dev/x', { body: { entry_ids: ['e1', 'e2', 'e3'] } }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      saved: [
        { entry_id: 'e1', list_id: 'l1', kind: 'company', company_id: 'co-1' },
        { entry_id: 'e3', list_id: 'l1', kind: 'person', contact_id: 'ct-1', email: null },
      ],
      skipped: [{ entry_id: 'e2', list_id: 'l1', reason: 'dismissed' }],
      list_ids: ['l1'],
      published_at: '2026-09-06T00:00:00.000Z',
    })
  })

  it('is a 200 even when NOTHING published — the reasons are the answer', async () => {
    hoisted.publishEntries.mockResolvedValue({
      ok: true,
      saved: [],
      skipped: [{ entry_id: 'e1', list_id: 'l1', reason: 'needs_review' }],
      list_ids: ['l1'],
      published_at: null,
    })
    const res = await publishEntriesRoute.POST(
      nextRequest('https://nativeintelligence.dev/x', { body: { entry_ids: ['e1'] } }),
    )
    expect(res.status).toBe(200)
    expect((await res.json()).skipped).toHaveLength(1)
  })

  it('defaults include_unverified to FALSE — a bulk publish never overrides the identity gate', async () => {
    hoisted.publishEntries.mockResolvedValue({ ok: true, saved: [], skipped: [], list_ids: [], published_at: null })
    await publishEntriesRoute.POST(nextRequest('https://nativeintelligence.dev/x', { body: { entry_ids: ['e1'] } }))
    expect(hoisted.publishEntries.mock.calls[0][1].includeUnverified).toBe(false)

    // Only an explicit `true` opts in; a truthy string does not.
    for (const raw of ['true', 1, null]) {
      hoisted.publishEntries.mockClear()
      await publishEntriesRoute.POST(
        nextRequest('https://nativeintelligence.dev/x', { body: { entry_ids: ['e1'], include_unverified: raw } }),
      )
      expect(hoisted.publishEntries.mock.calls[0][1].includeUnverified).toBe(false)
    }
  })

  it('passes include_unverified through for the per-row confirm', async () => {
    hoisted.publishEntries.mockResolvedValue({ ok: true, saved: [], skipped: [], list_ids: [], published_at: null })
    await publishEntriesRoute.POST(
      nextRequest('https://nativeintelligence.dev/x', {
        body: { entry_ids: ['e1'], include_unverified: true },
      }),
    )
    expect(hoisted.publishEntries.mock.calls[0][1]).toMatchObject({
      entryIds: ['e1'],
      includeUnverified: true,
    })
  })

  it('400s a non-array, an empty selection, and an over-cap batch', async () => {
    for (const entry_ids of [undefined, 'e1', [], ['', null]]) {
      const res = await publishEntriesRoute.POST(nextRequest('https://nativeintelligence.dev/x', { body: { entry_ids } }))
      expect(res.status).toBe(400)
    }
    const tooMany = await publishEntriesRoute.POST(
      nextRequest('https://nativeintelligence.dev/x', {
        body: { entry_ids: Array.from({ length: 101 }, (_, i) => `e${i}`) },
      }),
    )
    expect(tooMany.status).toBe(400)
    expect(await tooMany.json()).toMatchObject({ code: 'TOO_MANY_ENTRIES' })
    expect(hoisted.publishEntries).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// /lists/[id]/publish — the list becomes its group in the CRM
// ---------------------------------------------------------------------------

describe('POST /api/account/prospecting/lists/[id]/publish', () => {
  it('publishes everything pending on the list and names it', async () => {
    hoisted.publishList.mockResolvedValue({
      ok: true,
      saved: [{ entry_id: 'e1', list_id: 'list-1', kind: 'company', company_id: 'co-1' }],
      skipped: [],
      list_ids: ['list-1'],
      published_at: '2026-09-06T00:00:00.000Z',
      list_name: 'Q4 outbound',
    })
    const res = await publishListRoute.POST(nextRequest('https://nativeintelligence.dev/x', { method: 'POST' }), params('list-1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      saved: [{ entry_id: 'e1', list_id: 'list-1', kind: 'company', company_id: 'co-1' }],
      skipped: [],
      list_ids: ['list-1'],
      published_at: '2026-09-06T00:00:00.000Z',
      list_name: 'Q4 outbound',
    })
    expect(hoisted.publishList.mock.calls[0][1]).toMatchObject({ listId: 'list-1' })
  })

  it('404s a cross-workspace list, 400s an archived one, and 500s a DB error', async () => {
    hoisted.publishList.mockResolvedValue({ ok: false, code: 'NOT_FOUND', error: 'List not found' })
    expect((await publishListRoute.POST(nextRequest('https://nativeintelligence.dev/x', { method: 'POST' }), params('list-9'))).status).toBe(404)
    hoisted.publishList.mockResolvedValue({ ok: false, code: 'INVALID_INPUT', error: 'This list is archived' })
    expect((await publishListRoute.POST(nextRequest('https://nativeintelligence.dev/x', { method: 'POST' }), params('list-1'))).status).toBe(400)
    hoisted.publishList.mockResolvedValue({ ok: false, code: 'DB_ERROR', error: 'boom' })
    expect((await publishListRoute.POST(nextRequest('https://nativeintelligence.dev/x', { method: 'POST' }), params('list-1'))).status).toBe(500)
  })
})

// ---------------------------------------------------------------------------
// /lists/[id]/sequenced
// ---------------------------------------------------------------------------

describe('GET /api/account/prospecting/lists/[id]/sequenced', () => {
  it('returns the derived contact_id → sequence map', async () => {
    hoisted.listSequencedByList.mockResolvedValue({
      ok: true,
      sequenced: { c1: { status: 'active', sequence_id: 's1', sequence_name: 'Q4 outbound' } },
    })
    const res = await sequencedRoute.GET(nextRequest('https://nativeintelligence.dev/x'), params('list-1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      sequenced: { c1: { status: 'active', sequence_id: 's1', sequence_name: 'Q4 outbound' } },
    })
    expect(hoisted.listSequencedByList.mock.calls[0][1]).toEqual({
      workspaceId: WS,
      listId: 'list-1',
    })
  })

  it('is an EMPTY map for a list with nothing sequenced, not a 404', async () => {
    hoisted.listSequencedByList.mockResolvedValue({ ok: true, sequenced: {} })
    const res = await sequencedRoute.GET(nextRequest('https://nativeintelligence.dev/x'), params('foreign'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sequenced: {} })
  })

  it('maps a lib DB_ERROR to a 500', async () => {
    hoisted.listSequencedByList.mockResolvedValue({ ok: false, code: 'DB_ERROR', error: 'boom' })
    const res = await sequencedRoute.GET(nextRequest('https://nativeintelligence.dev/x'), params('list-1'))
    expect(res.status).toBe(500)
  })
})

// ---------------------------------------------------------------------------
// /source
// ---------------------------------------------------------------------------

describe('/api/account/prospecting/source', () => {
  const SOURCE = { id: 'co-1', workspace_id: WS, name: 'Acme', domain: 'acme.test', metadata: null }

  /** POST's body is optional — these two shapes are the only two the UI sends. */
  const post = (body?: unknown) =>
    sourceRoute.POST(
      body === undefined
        ? (new Request('https://nativeintelligence.dev/x', { method: 'POST' }) as never)
        : nextRequest('https://nativeintelligence.dev/x', { body }),
    )

  it('GET returns the source, how it resolved, a draft per purpose, and the counts', async () => {
    hoisted.resolveSourceCompany.mockResolvedValue({
      company: SOURCE,
      resolved_by: 'is_workspace_company',
    })
    hoisted.exclusionCounts.mockResolvedValue({
      ok: true,
      counts: { crm_companies: 412, other_lists: 0, contacted_people: 9 },
    })
    const res = await sourceRoute.GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.source).toEqual(SOURCE)
    expect(body.resolved_by).toBe('is_workspace_company')
    expect(Object.keys(body.icp_draft_by_purpose).sort()).toEqual([
      'buyers',
      'custom',
      'investors',
      'partners',
      'talent',
    ])
    expect(body.icp_draft_by_purpose.buyers.icp.source.domain).toBe('acme.test')
    expect(body.icp_draft_by_purpose.investors.icp.target.buyer_titles).toEqual([
      'Partner',
      'Principal',
    ])
    expect(body.counts).toEqual({ crm_companies: 412, other_lists: 0, contacted_people: 9 })
  })

  it('GET resolves the source on the SERVICE client — company SELECT is visibility-filtered', async () => {
    hoisted.resolveSourceCompany.mockResolvedValue({ company: null, resolved_by: 'none' })
    hoisted.exclusionCounts.mockResolvedValue({ ok: true, counts: {} })
    await sourceRoute.GET()
    expect(hoisted.getServiceClient).toHaveBeenCalled()
    expect(hoisted.resolveSourceCompany.mock.calls[0][1]).toEqual({
      workspaceId: WS,
      userId: USER.id,
      userEmail: USER.email,
    })
  })

  it('GET still returns usable drafts when there is no source company (§4 step 4)', async () => {
    hoisted.resolveSourceCompany.mockResolvedValue({ company: null, resolved_by: 'none' })
    hoisted.exclusionCounts.mockResolvedValue({ ok: true, counts: {} })
    const body = await (await sourceRoute.GET()).json()
    expect(body.source).toBeNull()
    expect(body.icp_draft_by_purpose.buyers.icp.target.buyer_titles).toEqual([
      'Head of Sales',
      'VP Sales',
      'Founder',
    ])
  })

  it("GET hands back the caller's own email domain to pre-fill when nothing resolved", async () => {
    // The production bug: liam@dial8.ai signed in, saw "We don't know your
    // company yet", and had no way to type a domain. The UI can now pre-fill
    // the field from the address he already signed in with.
    hoisted.resolveSourceCompany.mockResolvedValue({ company: null, resolved_by: 'none' })
    hoisted.exclusionCounts.mockResolvedValue({ ok: true, counts: {} })
    const body = await (await sourceRoute.GET()).json()
    expect(body.suggested_domain).toBe('acme.test')
  })

  it('GET suggests nothing for a webmail signup — there is nothing to guess', async () => {
    hoisted.requireWorkspace.mockResolvedValue({
      supabase,
      user: { id: 'user-1', email: 'ada@gmail.com' },
      workspaceId: WS,
    })
    hoisted.resolveSourceCompany.mockResolvedValue({ company: null, resolved_by: 'none' })
    hoisted.exclusionCounts.mockResolvedValue({ ok: true, counts: {} })
    const body = await (await sourceRoute.GET()).json()
    expect(body.suggested_domain).toBeNull()
  })

  it('GET suggests nothing once the company IS known — a hint there invites a wrong correction', async () => {
    hoisted.resolveSourceCompany.mockResolvedValue({ company: SOURCE, resolved_by: 'self_contact' })
    hoisted.exclusionCounts.mockResolvedValue({ ok: true, counts: {} })
    const body = await (await sourceRoute.GET()).json()
    expect(body.suggested_domain).toBeNull()
  })

  it('POST fires the ICP card once and re-reads the source afterwards', async () => {
    hoisted.resolveSourceCompany
      .mockResolvedValueOnce({ company: SOURCE, resolved_by: 'self_contact' })
      .mockResolvedValueOnce({
        company: {
          ...SOURCE,
          metadata: {
            enrichment: { fields: { target_customer: { value: 'B2B sales teams', confidence: 'high' } } },
          },
        },
        resolved_by: 'self_contact',
      })
    hoisted.fireIcpCard.mockResolvedValue({ status: 'fired', fields: ['target_customer'], cost: 0.012 })
    hoisted.exclusionCounts.mockResolvedValue({ ok: true, counts: {} })

    const res = await post()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(hoisted.fireIcpCard).toHaveBeenCalledTimes(1)
    expect(hoisted.fireIcpCard.mock.calls[0][1]).toMatchObject({ workspaceId: WS, companyId: 'co-1' })
    expect(body.icp_card).toMatchObject({ status: 'fired' })
    expect(body.established).toBe(false)
    // The drafts seed from the row AS IT NOW STANDS.
    expect(body.icp_draft_by_purpose.buyers.icp.target.description).toBe('B2B sales teams')
  })

  it('POST reports an idempotent skip rather than pretending it searched', async () => {
    hoisted.resolveSourceCompany.mockResolvedValue({ company: SOURCE, resolved_by: 'self_contact' })
    hoisted.fireIcpCard.mockResolvedValue({ status: 'skipped', reason: 'already_present', cost: 0 })
    hoisted.exclusionCounts.mockResolvedValue({ ok: true, counts: {} })
    const body = await (await post()).json()
    expect(body.icp_card).toEqual({ status: 'skipped', reason: 'already_present', cost: 0 })
  })

  // ── §4 step 4: establishing the company ────────────────────────────────

  it('POST with no company and a business email CREATES it, enriches it, and cards it', async () => {
    // The whole production bug in one test. Before this, POST answered 200 with
    // a null source and the button did nothing.
    hoisted.resolveSourceCompany
      .mockResolvedValueOnce({ company: null, resolved_by: 'none' })
      .mockResolvedValueOnce({ company: SOURCE, resolved_by: 'is_workspace_company' })
    hoisted.establishSourceCompany.mockResolvedValue({
      ok: true,
      companyId: 'co-1',
      domain: 'acme.test',
      created: true,
      contactLinked: true,
    })
    hoisted.fireIcpCard.mockResolvedValue({ status: 'fired', fields: [], cost: 0.012 })
    hoisted.exclusionCounts.mockResolvedValue({ ok: true, counts: {} })

    const res = await post()
    expect(res.status).toBe(200)
    const body = await res.json()

    // Established from the caller's own email domain, on the service client.
    expect(hoisted.establishSourceCompany.mock.calls[0][1]).toEqual({
      workspaceId: WS,
      userId: USER.id,
      domain: 'acme.test',
    })
    // The FULL enrichment — the same mark-pending + interactive-lane event the
    // CRM's Sparkles button sends. This is what fills "what we sell".
    expect(hoisted.companyUpdate).toHaveBeenCalledWith({ enrichment_status: 'pending' })
    expect(hoisted.inngestSend).toHaveBeenCalledWith({
      name: 'crm/enrich-company.manual',
      data: { companyId: 'co-1', workspaceId: WS, userId: USER.id },
    })
    expect(hoisted.fireIcpCard).toHaveBeenCalledTimes(1)

    expect(body.established).toBe(true)
    expect(body.enrichment).toBe('started')
    expect(body.source).toEqual(SOURCE)
  })

  it('POST with an explicit domain establishes THAT one, whatever the email says', async () => {
    hoisted.resolveSourceCompany
      .mockResolvedValueOnce({ company: null, resolved_by: 'none' })
      .mockResolvedValueOnce({ company: SOURCE, resolved_by: 'is_workspace_company' })
    hoisted.establishSourceCompany.mockResolvedValue({
      ok: true,
      companyId: 'co-1',
      domain: 'dial8.ai',
      created: true,
      contactLinked: false,
    })
    hoisted.fireIcpCard.mockResolvedValue({ status: 'fired', fields: [], cost: 0.012 })
    hoisted.exclusionCounts.mockResolvedValue({ ok: true, counts: {} })

    const body = await (await post({ domain: 'dial8.ai' })).json()
    expect(hoisted.establishSourceCompany.mock.calls[0][1].domain).toBe('dial8.ai')
    expect(body.established).toBe(true)
  })

  it('POST with a domain RE-POINTS an already-resolved workspace — the "Not your company?" path', async () => {
    hoisted.resolveSourceCompany
      .mockResolvedValueOnce({ company: SOURCE, resolved_by: 'is_workspace_company' })
      .mockResolvedValueOnce({
        company: { ...SOURCE, id: 'co-2', domain: 'dial8.ai' },
        resolved_by: 'is_workspace_company',
      })
    hoisted.establishSourceCompany.mockResolvedValue({
      ok: true,
      companyId: 'co-2',
      domain: 'dial8.ai',
      created: true,
      contactLinked: false,
    })
    hoisted.companyMaybeSingle.mockResolvedValue({
      data: { id: 'co-2', enrichment_status: null, metadata: null },
      error: null,
    })
    hoisted.fireIcpCard.mockResolvedValue({ status: 'fired', fields: [], cost: 0.012 })
    hoisted.exclusionCounts.mockResolvedValue({ ok: true, counts: {} })

    const body = await (await post({ domain: 'dial8.ai' })).json()
    // Establish ran even though a company already resolved, and everything
    // downstream targets the NEW row.
    expect(hoisted.establishSourceCompany).toHaveBeenCalledTimes(1)
    expect(hoisted.fireIcpCard.mock.calls[0][1].companyId).toBe('co-2')
    expect(body.source.domain).toBe('dial8.ai')
    expect(body.established).toBe(true)
  })

  it('POST on a personal email with no domain asks for one — 400 NEEDS_DOMAIN', async () => {
    hoisted.requireWorkspace.mockResolvedValue({
      supabase,
      user: { id: 'user-1', email: 'ada@gmail.com' },
      workspaceId: WS,
    })
    hoisted.resolveSourceCompany.mockResolvedValue({ company: null, resolved_by: 'none' })

    const res = await post()
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      code: 'NEEDS_DOMAIN',
      error: "Tell us your company's website",
    })
    // Nothing was created and nothing was billed.
    expect(hoisted.establishSourceCompany).not.toHaveBeenCalled()
    expect(hoisted.fireIcpCard).not.toHaveBeenCalled()
  })

  it('POST maps a webmail domain to 400 PERSONAL_DOMAIN and an unparseable one to 400 INVALID_DOMAIN', async () => {
    hoisted.resolveSourceCompany.mockResolvedValue({ company: null, resolved_by: 'none' })

    hoisted.establishSourceCompany.mockResolvedValue({
      ok: false,
      code: 'PERSONAL_DOMAIN',
      error: 'That is a personal email provider, not a company website',
    })
    const personal = await post({ domain: 'gmail.com' })
    expect(personal.status).toBe(400)
    expect(await personal.json()).toMatchObject({ code: 'PERSONAL_DOMAIN' })

    hoisted.establishSourceCompany.mockResolvedValue({
      ok: false,
      code: 'INVALID_DOMAIN',
      error: "That doesn't look like a website",
    })
    const invalid = await post({ domain: 'nope' })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ code: 'INVALID_DOMAIN' })

    expect(hoisted.fireIcpCard).not.toHaveBeenCalled()
  })

  it('POST maps a failed create to 500, not a cheerful 200', async () => {
    hoisted.resolveSourceCompany.mockResolvedValue({ company: null, resolved_by: 'none' })
    hoisted.establishSourceCompany.mockResolvedValue({
      ok: false,
      code: 'CREATE_FAILED',
      error: 'Could not create the company',
    })
    const res = await post({ domain: 'dial8.ai' })
    expect(res.status).toBe(500)
  })

  // ── Enrichment kick ────────────────────────────────────────────────────

  it('POST enriches a resolved-but-never-enriched company so "what we sell" fills', async () => {
    hoisted.resolveSourceCompany.mockResolvedValue({ company: SOURCE, resolved_by: 'self_contact' })
    hoisted.fireIcpCard.mockResolvedValue({ status: 'fired', fields: [], cost: 0.012 })
    hoisted.exclusionCounts.mockResolvedValue({ ok: true, counts: {} })

    const body = await (await post()).json()
    expect(body.enrichment).toBe('started')
    expect(hoisted.inngestSend).toHaveBeenCalledTimes(1)
  })

  it('POST does not re-bill an already-enriched or already-pending company', async () => {
    hoisted.resolveSourceCompany.mockResolvedValue({ company: SOURCE, resolved_by: 'self_contact' })
    hoisted.fireIcpCard.mockResolvedValue({ status: 'skipped', reason: 'already_present', cost: 0 })
    hoisted.exclusionCounts.mockResolvedValue({ ok: true, counts: {} })

    hoisted.companyMaybeSingle.mockResolvedValue({
      data: { id: 'co-1', enrichment_status: 'enriched', metadata: null },
      error: null,
    })
    expect((await (await post()).json()).enrichment).toBe('already')

    hoisted.companyMaybeSingle.mockResolvedValue({
      data: { id: 'co-1', enrichment_status: 'pending', metadata: null },
      error: null,
    })
    expect((await (await post()).json()).enrichment).toBe('already')

    expect(hoisted.inngestSend).not.toHaveBeenCalled()
    expect(hoisted.companyUpdate).not.toHaveBeenCalled()
  })

  it('POST refuses to re-run a permanently-failed enrichment but still cards and answers 200', async () => {
    hoisted.resolveSourceCompany.mockResolvedValue({ company: SOURCE, resolved_by: 'self_contact' })
    hoisted.hasPermanentFailure.mockReturnValue(true)
    hoisted.fireIcpCard.mockResolvedValue({ status: 'fired', fields: [], cost: 0.012 })
    hoisted.exclusionCounts.mockResolvedValue({ ok: true, counts: {} })

    const res = await post()
    expect(res.status).toBe(200)
    expect((await res.json()).enrichment).toBe('skipped')
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
    // The $0.012 side-search is unrelated to the failed full pipeline.
    expect(hoisted.fireIcpCard).toHaveBeenCalledTimes(1)
  })

  it('POST propagates the auth Response untouched', async () => {
    hoisted.requireWorkspace.mockResolvedValue(new Response('nope', { status: 401 }))
    const res = await post({ domain: 'dial8.ai' })
    expect(res.status).toBe(401)
    expect(hoisted.establishSourceCompany).not.toHaveBeenCalled()
  })
})
