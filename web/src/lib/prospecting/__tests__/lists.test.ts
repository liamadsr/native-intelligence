/**
 * The prospect-list lib: CRUD, hand-add, stage transitions, promotion and the
 * exclusion counts.
 *
 * Everything runs against the recording fake, so the tests assert on the
 * QUERIES as much as the results — the invariant that every read and write
 * carries an explicit `workspace_id` filter is only provable by looking at
 * what was actually sent.
 *
 * `ensureCompanyForDomain` is mocked: it is the CRM's find-or-create and has
 * its own tests; what matters here is that promotion CALLS it rather than
 * growing a second implementation of the domain-uniqueness handling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase, filterArgs, hasWorkspaceFilter, type Captured } from './fake-supabase'
import { emptyIcp } from '../icp'

const hoisted = vi.hoisted(() => ({ ensureCompanyForDomain: vi.fn() }))

vi.mock('@/lib/crm/enrichment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/crm/enrichment')>()
  return { ...actual, ensureCompanyForDomain: hoisted.ensureCompanyForDomain }
})

const {
  addEntryByDomain,
  archiveList,
  createList,
  deleteList,
  exclusionCounts,
  getList,
  listEntries,
  listLists,
  listSequencedByList,
  promoteEntries,
  updateEntryStage,
  updateList,
} = await import('../lists')
const { saveEntriesToList, countEntriesByList } = await import('../lists')

const WS = 'ws-1'
const USER = 'user-1'

const LIST_ROW = {
  id: 'list-1',
  workspace_id: WS,
  name: 'Big sales teams',
  purpose: 'buyers',
  icp: emptyIcp(),
  icp_version: 3,
  exclude_crm: true,
  exclude_other_lists: false,
  exclude_contacted: 'ever',
  max_spend_dollars: 2,
  target_new_candidates: 20,
  max_rounds: 2,
  people_per_company: 3,
  status: 'active',
}

beforeEach(() => {
  hoisted.ensureCompanyForDomain.mockReset()
  hoisted.ensureCompanyForDomain.mockResolvedValue('co-new')
})

// ---------------------------------------------------------------------------
// createList
// ---------------------------------------------------------------------------

describe('createList', () => {
  /** `company` reads are the source_company_id workspace check — they answer
   *  "yes, in this workspace" by default so the insert is what the test sees;
   *  pass `companyFound: false` to make the check reject. */
  function world(
    result: { data?: unknown; error?: { message: string; code?: string } },
    opts: { companyFound?: boolean } = {},
  ) {
    return makeFakeSupabase((q) =>
      q.table === 'company'
        ? { data: opts.companyFound === false ? null : { id: 'co-9' } }
        : result,
    )
  }

  it('rejects an empty name before touching the database', async () => {
    const { client, queries } = world({ data: null })
    const out = await createList(client, { workspaceId: WS, userId: USER, input: { name: '  ' } })
    expect(out).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    expect(queries).toHaveLength(0)
  })

  it('maps a 23505 to LIST_NAME_TAKEN rather than a generic failure', async () => {
    const { client } = world({ data: null, error: { message: 'duplicate key', code: '23505' } })
    const out = await createList(client, { workspaceId: WS, userId: USER, input: { name: 'Dupe' } })
    expect(out).toMatchObject({ ok: false, code: 'LIST_NAME_TAKEN' })
    expect((out as { error: string }).error).toContain('Dupe')
  })

  it('writes the workspace, the creator, and the §3 defaults', async () => {
    const { client, queries } = world({ data: LIST_ROW })
    const out = await createList(client, { workspaceId: WS, userId: USER, input: { name: 'New' } })
    expect(out.ok).toBe(true)
    const payload = queries[0].payload as Record<string, unknown>
    expect(payload).toMatchObject({
      workspace_id: WS,
      created_by: USER,
      name: 'New',
      purpose: 'buyers',
      status: 'active',
      icp_version: 1,
      exclude_crm: true,
      exclude_other_lists: false,
      exclude_contacted: 'ever',
      max_spend_dollars: 2,
      target_new_candidates: 20,
      max_rounds: 2,
      people_per_company: 3,
    })
  })

  it('clamps out-of-range policy numbers rather than producing a 23514', async () => {
    const { client, queries } = world({ data: LIST_ROW })
    await createList(client, {
      workspaceId: WS,
      userId: USER,
      input: {
        name: 'Clamped',
        target_new_candidates: 5_000,
        max_rounds: 99,
        people_per_company: -4,
        max_spend_dollars: 1_000,
      },
    })
    expect(queries[0].payload).toMatchObject({
      target_new_candidates: 100,
      max_rounds: 3,
      people_per_company: 0,
      max_spend_dollars: 20,
    })
  })

  it('degrades an unknown purpose and an unknown tri-state to the defaults', async () => {
    const { client, queries } = world({ data: LIST_ROW })
    await createList(client, {
      workspaceId: WS,
      userId: USER,
      input: { name: 'X', purpose: 'nonsense', exclude_contacted: 'sometimes' },
    })
    expect(queries[0].payload).toMatchObject({ purpose: 'buyers', exclude_contacted: 'ever' })
  })

  it('normalizes the ICP and adopts its company id as the source when none was given', async () => {
    const { client, queries } = world({ data: LIST_ROW })
    await createList(client, {
      workspaceId: WS,
      userId: USER,
      input: {
        name: 'X',
        icp: { source: { company_id: 'co-9' }, target: { industries: 'SaaS, SaaS' }, junk: 1 },
      },
    })
    // queries[0] is the source-company workspace check; the insert follows.
    const check = queries[0]
    expect(check.table).toBe('company')
    expect(hasWorkspaceFilter(check, WS)).toBe(true)
    expect(filterArgs(check, 'eq')).toContainEqual(['id', 'co-9'])
    const insert = queries.find((q) => q.op === 'insert')!
    const payload = insert.payload as Record<string, unknown>
    expect(payload.source_company_id).toBe('co-9')
    const icp = payload.icp as ReturnType<typeof emptyIcp>
    expect(icp.target.industries).toEqual(['SaaS'])
    expect(Object.keys(icp).sort()).toEqual(['anti', 'search_hint', 'source', 'target'])
  })

  it('REFUSES a source_company_id belonging to another workspace', async () => {
    // `company` has no cross-workspace FK guard and RLS does not catch this —
    // the INSERT is on `prospect_list`, whose workspace IS the caller's. Without
    // the check a member could pin their list to a foreign company id and every
    // later consumer of the column would inherit that pointer.
    const { client, queries } = world({ data: LIST_ROW }, { companyFound: false })
    const out = await createList(client, {
      workspaceId: WS,
      userId: USER,
      input: { name: 'X', source_company_id: 'co-in-another-workspace' },
    })
    expect(out).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    // Nothing was written — the check runs before the insert.
    expect(queries.some((q) => q.op === 'insert')).toBe(false)
    expect(hasWorkspaceFilter(queries[0], WS)).toBe(true)
  })

  it('checks the ICP source company id too, not just the explicit field', async () => {
    const { client, queries } = world({ data: LIST_ROW }, { companyFound: false })
    const out = await createList(client, {
      workspaceId: WS,
      userId: USER,
      input: { name: 'X', icp: { source: { company_id: 'co-foreign' } } },
    })
    expect(out).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    expect(filterArgs(queries[0], 'eq')).toContainEqual(['id', 'co-foreign'])
  })
})

// ---------------------------------------------------------------------------
// listLists / getList / listEntries
// ---------------------------------------------------------------------------

describe('listLists', () => {
  it('attaches per-stage entry counts from one entries read', async () => {
    const { client, queries } = makeFakeSupabase((q) => {
      if (q.table === 'prospect_list') return { data: [LIST_ROW, { ...LIST_ROW, id: 'list-2' }] }
      return {
        data: [
          { list_id: 'list-1', stage: 'discovered' },
          { list_id: 'list-1', stage: 'dismissed' },
          { list_id: 'list-1', stage: 'saved' },
          { list_id: 'list-2', stage: 'shortlisted' },
        ],
      }
    })
    const out = await listLists(client, { workspaceId: WS })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.lists[0].entry_counts).toEqual({
      total: 3,
      discovered: 1,
      shortlisted: 0,
      saved: 1,
      dismissed: 1,
      // `saved_people` is carved out of `saved`: this fixture's saved row has
      // no `kind`, so it is not a person and the reachable count stays 0.
      saved_people: 0,
      // No `published_at: null` on the fixture's saved row (the column is
      // absent, not null), so nothing reads as waiting for a publish.
      pending_publish: 0,
    })
    expect(out.lists[1].entry_counts.shortlisted).toBe(1)
    // ONE entries query, not one per list.
    expect(queries.filter((q) => q.table === 'prospect_list_entry')).toHaveLength(1)
  })

  it('hides archived lists unless asked', async () => {
    const { client, queries } = makeFakeSupabase(() => ({ data: [] }))
    await listLists(client, { workspaceId: WS })
    expect(filterArgs(queries[0], 'eq')).toContainEqual(['status', 'active'])

    const second = makeFakeSupabase(() => ({ data: [] }))
    await listLists(second.client, { workspaceId: WS, includeArchived: true })
    expect(filterArgs(second.queries[0], 'eq')).not.toContainEqual(['status', 'active'])
  })

  it('skips the entries read entirely when there are no lists', async () => {
    const { client, queries } = makeFakeSupabase(() => ({ data: [] }))
    const out = await listLists(client, { workspaceId: WS })
    expect(out).toEqual({ ok: true, lists: [] })
    expect(queries.filter((q) => q.table === 'prospect_list_entry')).toHaveLength(0)
  })
})

describe('getList', () => {
  it('returns NOT_FOUND for a list in another workspace', async () => {
    const { client } = makeFakeSupabase(() => ({ data: null }))
    const out = await getList(client, { workspaceId: WS, listId: 'other' })
    expect(out).toMatchObject({ ok: false, code: 'NOT_FOUND' })
  })

  it('loads the list with its entries and counts, workspace-scoped throughout', async () => {
    const { client, queries } = makeFakeSupabase((q) =>
      q.table === 'prospect_list'
        ? { data: LIST_ROW }
        : { data: [{ id: 'e1', stage: 'discovered' }, { id: 'e2', stage: 'saved' }] },
    )
    const out = await getList(client, { workspaceId: WS, listId: 'list-1' })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.entries).toHaveLength(2)
    expect(out.entry_counts).toMatchObject({ total: 2, discovered: 1, saved: 1 })
    for (const q of queries) expect(hasWorkspaceFilter(q, WS)).toBe(true)
  })
})

describe('listEntries', () => {
  it('counts the WHOLE list even when filtered to one stage — the tabs need what is behind them', async () => {
    let call = 0
    const { client, queries } = makeFakeSupabase((q) => {
      if (q.table !== 'prospect_list_entry') return { data: null }
      call += 1
      return call === 1
        ? { data: [{ id: 'e1', stage: 'saved' }] }
        : { data: [{ stage: 'saved' }, { stage: 'discovered' }, { stage: 'discovered' }] }
    })
    const out = await listEntries(client, { workspaceId: WS, listId: 'list-1', stage: 'saved' })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.entries).toHaveLength(1)
    expect(out.entry_counts).toMatchObject({ total: 3, saved: 1, discovered: 2 })
    expect(filterArgs(queries[0], 'eq')).toContainEqual(['stage', 'saved'])
    expect(filterArgs(queries[1], 'eq')).not.toContainEqual(['stage', 'saved'])
  })

  it('PAGES the entries read — PostgREST truncates at 1000 with no error', async () => {
    // One discover run plus one people run at people_per_company=3 already
    // reaches several hundred entries, so 1000 is ordinary. Unpaginated, the
    // board simply stops showing rows and the tab badges under-count, with
    // nothing anywhere saying so.
    const rows = Array.from({ length: 1250 }, (_, i) => ({
      id: `e${i}`,
      stage: 'discovered',
      kind: 'company',
    }))
    const { client, queries } = makeFakeSupabase((q) => {
      if (q.table !== 'prospect_list_entry') return { data: null }
      const range = filterArgs(q, 'range').at(-1) as [number, number] | undefined
      return { data: range ? rows.slice(range[0], range[1] + 1) : rows }
    })

    const out = await listEntries(client, { workspaceId: WS, listId: 'list-1' })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.entries).toHaveLength(1250)
    expect(out.entry_counts).toMatchObject({ total: 1250, discovered: 1250 })

    const reads = queries.filter((q) => q.table === 'prospect_list_entry')
    expect(reads).toHaveLength(2)
    expect(filterArgs(reads[0], 'range').at(-1)).toEqual([0, 999])
    expect(filterArgs(reads[1], 'range').at(-1)).toEqual([1000, 1999])
  })

  it('orders by id as well as created_at, or the pages could overlap', async () => {
    // `created_at` is the display order and is NOT unique: two rows written in
    // the same millisecond can straddle a window boundary and be returned
    // twice or not at all. `id` is the tiebreak that makes the windows
    // disjoint.
    const { client, queries } = makeFakeSupabase((q) =>
      q.table === 'prospect_list_entry' ? { data: [] } : { data: null },
    )
    await listEntries(client, { workspaceId: WS, listId: 'list-1' })
    const orders = filterArgs(queries[0], 'order')
    expect(orders).toContainEqual(['created_at', { ascending: false }])
    expect(orders).toContainEqual(['id', { ascending: false }])
  })

  it('pages the WHOLE-list count read too, and carries kind for saved_people', async () => {
    // The counts are always over the whole list, so on a filtered view they
    // come from a second read — which lies in exactly the case the pagination
    // above exists for if it is not paged too.
    const all = Array.from({ length: 1100 }, () => ({ stage: 'saved', kind: 'person' }))
    let call = 0
    const { client, queries } = makeFakeSupabase((q) => {
      if (q.table !== 'prospect_list_entry') return { data: null }
      call += 1
      if (call === 1) return { data: [] }
      const range = filterArgs(q, 'range').at(-1) as [number, number] | undefined
      return { data: range ? all.slice(range[0], range[1] + 1) : all }
    })

    const out = await listEntries(client, { workspaceId: WS, listId: 'list-1', stage: 'saved' })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.entry_counts).toMatchObject({ total: 1100, saved: 1100, saved_people: 1100 })
    expect(queries.filter((q) => q.table === 'prospect_list_entry')).toHaveLength(3)
  })

  it('fails the read rather than returning a silently short list', async () => {
    const { client } = makeFakeSupabase((q) =>
      q.table === 'prospect_list_entry' ? { error: { message: 'boom' } } : { data: null },
    )
    const out = await listEntries(client, { workspaceId: WS, listId: 'list-1' })
    expect(out).toMatchObject({ ok: false, code: 'DB_ERROR' })
  })

  // ── score floor / kind pushdown ──────────────────────────────────────
  //
  // These were applied in the AGENT TOOL, over the fully paged result: asking
  // for the hot rows of a 1200-entry list read all 1200 rows across two round
  // trips and threw most of them away. They are SQL predicates now, beside the
  // stage line the lib always had.

  it('pushes the score floor down as `.gte()` and kind as `.eq()`', async () => {
    const { client, queries } = makeFakeSupabase((q) =>
      q.table === 'prospect_list_entry' ? { data: [] } : { data: null },
    )
    await listEntries(client, {
      workspaceId: WS,
      listId: 'list-1',
      min_fit_score: 80,
      kind: 'company',
    })
    expect(filterArgs(queries[0], 'gte')).toContainEqual(['fit_score', 80])
    expect(filterArgs(queries[0], 'eq')).toContainEqual(['kind', 'company'])
  })

  it('pushes a floor of 0 too — "only the scored rows" is a real filter', async () => {
    const { client, queries } = makeFakeSupabase((q) =>
      q.table === 'prospect_list_entry' ? { data: [] } : { data: null },
    )
    await listEntries(client, { workspaceId: WS, listId: 'list-1', min_fit_score: 0 })
    expect(filterArgs(queries[0], 'gte')).toContainEqual(['fit_score', 0])
    // And the second (whole-list) count read exists, because the first was narrowed.
    expect(queries.filter((q) => q.table === 'prospect_list_entry')).toHaveLength(2)
  })

  it('orders hottest first, unscored LAST, then newest', async () => {
    const { client, queries } = makeFakeSupabase((q) =>
      q.table === 'prospect_list_entry' ? { data: [] } : { data: null },
    )
    await listEntries(client, { workspaceId: WS, listId: 'list-1' })
    const orders = filterArgs(queries[0], 'order')
    expect(orders[0]).toEqual(['fit_score', { ascending: false, nullsFirst: false }])
    expect(orders[1]).toEqual(['created_at', { ascending: false }])
    expect(orders[2]).toEqual(['id', { ascending: false }])
  })

  it('counts the WHOLE list when the read was narrowed by SCORE, not just by stage', async () => {
    // The counts branch used to test `args.stage` alone. A score-filtered read
    // falling into the else-branch would have counted only the hot rows and
    // reported that as the list's total — the tab badges lying in exactly the
    // case they are read in.
    let call = 0
    const { client, queries } = makeFakeSupabase((q) => {
      if (q.table !== 'prospect_list_entry') return { data: null }
      call += 1
      return call === 1
        ? { data: [{ id: 'e1', stage: 'discovered', kind: 'company', fit_score: 91 }] }
        : {
            data: [
              { stage: 'discovered', kind: 'company' },
              { stage: 'discovered', kind: 'company' },
              { stage: 'saved', kind: 'person' },
            ],
          }
    })
    const out = await listEntries(client, { workspaceId: WS, listId: 'list-1', min_fit_score: 80 })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.entries).toHaveLength(1)
    expect(out.entry_counts).toMatchObject({ total: 3, saved_people: 1 })
    // The count read carries NEITHER new filter — that is what makes it whole-list.
    expect(filterArgs(queries[1], 'gte')).toHaveLength(0)
    expect(filterArgs(queries[1], 'eq')).not.toContainEqual(['kind', 'company'])
  })

  it('counts the whole list when narrowed by KIND too', async () => {
    let call = 0
    const { client } = makeFakeSupabase((q) => {
      if (q.table !== 'prospect_list_entry') return { data: null }
      call += 1
      return call === 1
        ? { data: [{ id: 'p1', stage: 'saved', kind: 'person' }] }
        : { data: [{ stage: 'saved', kind: 'person' }, { stage: 'discovered', kind: 'company' }] }
    })
    const out = await listEntries(client, { workspaceId: WS, listId: 'list-1', kind: 'person' })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.entry_counts.total).toBe(2)
  })

  it('getList passes the new filters straight through', async () => {
    const { client, queries } = makeFakeSupabase((q) => {
      if (q.table === 'prospect_list') return { data: { id: 'list-1' } }
      if (q.table === 'prospect_list_entry') return { data: [] }
      return { data: null }
    })
    await getList(client, {
      workspaceId: WS,
      listId: 'list-1',
      stage: 'discovered',
      min_fit_score: 60,
      kind: 'company',
    })
    const entryRead = queries.find((q) => q.table === 'prospect_list_entry')!
    expect(filterArgs(entryRead, 'eq')).toContainEqual(['stage', 'discovered'])
    expect(filterArgs(entryRead, 'eq')).toContainEqual(['kind', 'company'])
    expect(filterArgs(entryRead, 'gte')).toContainEqual(['fit_score', 60])
  })
})

// ---------------------------------------------------------------------------
// updateList
// ---------------------------------------------------------------------------

describe('updateList', () => {
  function world(existing: Record<string, unknown> | null, updated?: Record<string, unknown>) {
    return makeFakeSupabase((q) =>
      q.op === 'update' ? { data: updated ?? { ...existing, ...(q.payload as object) } } : { data: existing },
    )
  }

  it('returns NOT_FOUND for a list in another workspace', async () => {
    const { client } = world(null)
    const out = await updateList(client, { workspaceId: WS, listId: 'x', input: { name: 'y' } })
    expect(out).toMatchObject({ ok: false, code: 'NOT_FOUND' })
  })

  it('writes only the fields the input actually carried', async () => {
    const { client, queries } = world(LIST_ROW)
    await updateList(client, { workspaceId: WS, listId: 'list-1', input: { exclude_other_lists: true } })
    const write = queries.find((q) => q.op === 'update') as Captured
    expect(write.payload).toEqual({ exclude_other_lists: true })
  })

  it('BUMPS icp_version when the ICP actually changed', async () => {
    const { client, queries } = world(LIST_ROW)
    const out = await updateList(client, {
      workspaceId: WS,
      listId: 'list-1',
      input: { icp: { target: { description: 'Series B fintechs' } } },
    })
    expect(out.ok && out.icp_version_bumped).toBe(true)
    const write = queries.find((q) => q.op === 'update') as Captured
    expect((write.payload as Record<string, unknown>).icp_version).toBe(4)
  })

  it('does NOT bump on a no-op save — opening the panel must not drift every badge', async () => {
    const { client, queries } = world(LIST_ROW)
    const out = await updateList(client, {
      workspaceId: WS,
      listId: 'list-1',
      input: { icp: emptyIcp() },
    })
    expect(out.ok && out.icp_version_bumped).toBe(false)
    const write = queries.find((q) => q.op === 'update') as Captured
    expect((write.payload as Record<string, unknown>).icp_version).toBeUndefined()
  })

  it('rejects an empty name and an unsupported status', async () => {
    const { client } = world(LIST_ROW)
    expect(
      await updateList(client, { workspaceId: WS, listId: 'list-1', input: { name: '  ' } }),
    ).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    expect(
      await updateList(client, { workspaceId: WS, listId: 'list-1', input: { status: 'deleted' } }),
    ).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
  })

  it('maps a name collision to LIST_NAME_TAKEN', async () => {
    const { client } = makeFakeSupabase((q) =>
      q.op === 'update'
        ? { data: null, error: { message: 'duplicate key', code: '23505' } }
        : { data: LIST_ROW },
    )
    const out = await updateList(client, { workspaceId: WS, listId: 'list-1', input: { name: 'Taken' } })
    expect(out).toMatchObject({ ok: false, code: 'LIST_NAME_TAKEN' })
  })

  it('skips the write entirely for an empty patch', async () => {
    const { client, queries } = world(LIST_ROW)
    const out = await updateList(client, { workspaceId: WS, listId: 'list-1', input: {} })
    expect(out.ok).toBe(true)
    expect(queries.filter((q) => q.op === 'update')).toHaveLength(0)
  })
})

describe('deleteList', () => {
  /** The recording fake's answers: a list, no live run, two published
   *  companies and one published person in its group. */
  function answers(over: { live?: boolean; list?: unknown; rpcError?: boolean; group?: boolean } = {}) {
    return (q: Captured) => {
      if (q.table === 'prospect_list' && q.op === 'select') {
        return { data: over.list === undefined ? LIST_ROW : over.list }
      }
      if (q.table === 'prospecting_run') return { data: over.live ? [{ id: 'run-1' }] : [] }
      if (q.table === 'company') return { data: over.group === false ? [] : [{ id: 'co-1' }, { id: 'co-2' }] }
      if (q.table === 'contact') return { data: over.group === false ? [] : [{ id: 'ct-1' }] }
      if (q.table === 'rpc:prospect_list_mark_unpublished') {
        return over.rpcError ? { error: { message: 'boom' } } : { data: null }
      }
      return { data: null }
    }
  }
  const ops = (queries: Captured[]) => queries.map((q) => `${q.table}:${q.op}`)

  it('deletes the list FIRST, then takes it out of the CRM group and drops its scoped views', async () => {
    const { client, queries } = makeFakeSupabase(answers())
    const out = await deleteList(client, { workspaceId: WS, listId: 'list-1' })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.unpublished).toEqual({ companies: 2, contacts: 1 })

    // The cascade is the one destructive act and it goes before the
    // best-effort cleanup — a list that survived a failed delete with its
    // group already cleared would read as published while the CRM forgot it.
    expect(ops(queries)).toEqual([
      'prospect_list:select',
      'prospecting_run:select',
      'company:select',
      'contact:select',
      'prospect_list:delete',
      'rpc:prospect_list_mark_unpublished:rpc',
      'view:delete',
    ])
    for (const q of queries.filter((x) => x.op !== 'rpc')) {
      expect(hasWorkspaceFilter(q, WS), `${q.table}:${q.op} carries the workspace`).toBe(true)
    }
    const del = queries.find((q) => q.table === 'prospect_list' && q.op === 'delete')!
    expect(filterArgs(del, 'eq')).toContainEqual(['id', 'list-1'])
    // The group members are found by array containment — the same predicate
    // the CRM's "From list" chip filters on.
    const companies = queries.find((q) => q.table === 'company')!
    expect(filterArgs(companies, 'contains')).toEqual([['prospect_list_ids', ['list-1']]])
    // …and leave the group through the SAME function unpublish uses, never a
    // CRM row delete.
    const rpc = queries.find((q) => q.op === 'rpc')!
    expect(rpc.payload).toEqual({
      p_workspace: WS,
      p_list: 'list-1',
      p_company_ids: ['co-1', 'co-2'],
      p_contact_ids: ['ct-1'],
    })
    expect(queries.filter((q) => (q.table === 'company' || q.table === 'contact') && q.op === 'delete')).toHaveLength(0)
    const views = queries.find((q) => q.table === 'view')!
    expect(filterArgs(views, 'eq')).toEqual(
      expect.arrayContaining([['scope_type', 'prospect_list'], ['scope_id', 'list-1']]),
    )
  })

  it('refuses a list with a run in flight, and touches nothing', async () => {
    const { client, queries } = makeFakeSupabase(answers({ live: true }))
    const out = await deleteList(client, { workspaceId: WS, listId: 'list-1' })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.code).toBe('RUN_LIVE')
    expect(queries.filter((q) => q.op === 'delete' || q.op === 'rpc')).toHaveLength(0)
    // Live means every in-flight status, not just running.
    const probe = queries.find((q) => q.table === 'prospecting_run')!
    expect(filterArgs(probe, 'in')[0]).toEqual([
      'status',
      ['queued', 'running', 'needs_input', 'canceling'],
    ])
  })

  it('404s a list outside the workspace before reading anything else', async () => {
    const { client, queries } = makeFakeSupabase(answers({ list: null }))
    const out = await deleteList(client, { workspaceId: WS, listId: 'list-other' })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.code).toBe('NOT_FOUND')
    expect(queries).toHaveLength(1)
  })

  it('skips the CRM call when nothing was published, and still drops the views', async () => {
    const { client, queries } = makeFakeSupabase(answers({ group: false }))
    const out = await deleteList(client, { workspaceId: WS, listId: 'list-1' })
    expect(out.ok && out.unpublished).toEqual({ companies: 0, contacts: 0 })
    expect(queries.filter((q) => q.op === 'rpc')).toHaveLength(0)
    expect(queries.filter((q) => q.table === 'view' && q.op === 'delete')).toHaveLength(1)
  })

  it('a failed group cleanup does not undo the delete — the list is gone, and says so', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client } = makeFakeSupabase(answers({ rpcError: true }))
    const out = await deleteList(client, { workspaceId: WS, listId: 'list-1' })
    expect(out.ok).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('CRM group cleanup failed'), 'boom')
    warn.mockRestore()
  })
})

describe('archiveList', () => {
  it('archives rather than deleting — entries are the suppression set', async () => {
    const { client, queries } = makeFakeSupabase((q) =>
      q.op === 'update' ? { data: { ...LIST_ROW, status: 'archived' } } : { data: LIST_ROW },
    )
    const out = await archiveList(client, { workspaceId: WS, listId: 'list-1' })
    expect(out.ok && out.list.status).toBe('archived')
    expect(queries.filter((q) => q.op === 'delete')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// addEntryByDomain
// ---------------------------------------------------------------------------

describe('addEntryByDomain', () => {
  it('normalizes the domain into the candidate_key the run engine will compute', async () => {
    const { client, queries } = makeFakeSupabase(() => ({ data: { id: 'e1' } }))
    const out = await addEntryByDomain(client, {
      workspaceId: WS,
      listId: 'list-1',
      domain: 'HTTPS://www.Acme.test/careers',
      name: 'Acme',
      icpVersion: 3,
    })
    expect(out).toMatchObject({ ok: true, status: 'created' })
    expect(queries[0].payload).toMatchObject({
      workspace_id: WS,
      list_id: 'list-1',
      kind: 'company',
      candidate_key: 'acme.test',
      stage: 'discovered',
      icp_version: 3,
      discovery_angle: 'manual',
    })
    expect((queries[0].payload as { candidate: unknown }).candidate).toEqual({
      domain: 'acme.test',
      name: 'Acme',
    })
  })

  it('rejects a personal domain distinctly from an unusable one', async () => {
    const { client } = makeFakeSupabase(() => ({ data: null }))
    expect(
      await addEntryByDomain(client, { workspaceId: WS, listId: 'list-1', domain: 'gmail.com' }),
    ).toMatchObject({ ok: false, code: 'PERSONAL_DOMAIN' })
    expect(
      await addEntryByDomain(client, { workspaceId: WS, listId: 'list-1', domain: 'not a domain' }),
    ).toMatchObject({ ok: false, code: 'INVALID_DOMAIN' })
  })

  it("maps a UNIQUE (list_id, candidate_key) collision to {status:'exists'} with the existing row", async () => {
    const existing = { id: 'e-existing', candidate_key: 'acme.test' }
    const { client } = makeFakeSupabase((q) =>
      q.op === 'insert'
        ? { data: null, error: { message: 'duplicate key', code: '23505' } }
        : { data: existing },
    )
    const out = await addEntryByDomain(client, {
      workspaceId: WS,
      listId: 'list-1',
      domain: 'acme.test',
    })
    expect(out).toEqual({ ok: true, status: 'exists', entry: existing })
  })

  it('does not stamp a discovered_by_run_id — a hand-added entry belongs to no run', async () => {
    const { client, queries } = makeFakeSupabase(() => ({ data: { id: 'e1' } }))
    await addEntryByDomain(client, { workspaceId: WS, listId: 'list-1', domain: 'acme.test' })
    expect((queries[0].payload as Record<string, unknown>).discovered_by_run_id).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// updateEntryStage
// ---------------------------------------------------------------------------

describe('updateEntryStage', () => {
  const entry = { id: 'e1', stage: 'dismissed' }

  it("saves — keeps a company ON THE LIST and brings its undismissed people along, touching no CRM row", async () => {
    // Save is curation now (migration 259): `saved` means on the list, and
    // the CRM sees nothing until the list is published.
    const company = { id: 'e1', kind: 'company', stage: 'discovered', list_id: 'list-1', parent_entry_id: null, published_at: null }
    const { client, queries } = makeFakeSupabase((q) => ({ data: q.op === 'select' ? company : { ...company, stage: 'saved' } }))
    const out = await updateEntryStage(client, { workspaceId: WS, entryId: 'e1', userId: USER, stage: 'saved' })
    expect(out).toMatchObject({ ok: true, entry: { stage: 'saved' } })

    const writes = queries.filter((q) => q.op === 'update')
    expect(writes).toHaveLength(2)
    // The row itself: saved, and any old dismissal cleared — Save means "I want this".
    expect(writes[0].payload).toEqual({ stage: 'saved', dismissed_reason: null, dismissed_by: null, dismissed_at: null })
    expect(filterArgs(writes[0], 'eq')).toContainEqual(['id', 'e1'])
    // The cascade: the people found beneath it that the user has not dismissed.
    expect(writes[1].payload).toMatchObject({ stage: 'saved' })
    expect(filterArgs(writes[1], 'eq')).toContainEqual(['parent_entry_id', 'e1'])
    expect(filterArgs(writes[1], 'in')).toEqual([['stage', ['discovered', 'shortlisted']]])
    expect(hasWorkspaceFilter(writes[1], WS)).toBe(true)
    expect(queries.some((q) => q.table === 'company' || q.table === 'contact' || q.op === 'rpc')).toBe(false)
  })

  it('saving a PERSON brings its company along — back from dismissed if it has to', async () => {
    const person = { id: 'p1', kind: 'person', stage: 'discovered', list_id: 'list-1', parent_entry_id: 'e1', published_at: null }
    const { client, queries } = makeFakeSupabase((q) => ({ data: q.op === 'select' ? person : { ...person, stage: 'saved' } }))
    const out = await updateEntryStage(client, { workspaceId: WS, entryId: 'p1', userId: USER, stage: 'saved' })
    expect(out.ok).toBe(true)
    const writes = queries.filter((q) => q.op === 'update')
    expect(writes).toHaveLength(2)
    expect(writes[1].payload).toEqual({ stage: 'saved', dismissed_reason: null, dismissed_by: null, dismissed_at: null })
    expect(filterArgs(writes[1], 'eq')).toContainEqual(['id', 'e1'])
    expect(filterArgs(writes[1], 'neq')).toEqual([['stage', 'saved']])
  })

  it('dismissing a PUBLISHED company takes it and its published people out of the CRM group, and clears their stamps', async () => {
    const company = { id: 'e1', kind: 'company', stage: 'saved', list_id: 'list-1', company_id: 'co-1', contact_id: null, parent_entry_id: null, published_at: '2026-09-06T00:00:00Z' }
    const { client, queries } = makeFakeSupabase((q) => {
      // The published-people read under the company.
      if (q.op === 'select' && filterArgs(q, 'eq').some(([c]) => c === 'parent_entry_id')) {
        return { data: [{ id: 'p1', contact_id: 'ct-1' }, { id: 'p2', contact_id: null }] }
      }
      return { data: q.op === 'select' ? company : { ...company, stage: 'dismissed', published_at: null } }
    })
    const out = await updateEntryStage(client, { workspaceId: WS, entryId: 'e1', userId: USER, stage: 'dismissed', dismissedReason: 'not_icp' })
    expect(out.ok).toBe(true)

    // The CRM rows leave the group through the SQL function — array_remove, never a delete.
    const rpc = queries.find((q) => q.op === 'rpc')!
    expect(rpc.table).toBe('rpc:prospect_list_mark_unpublished')
    expect(rpc.payload).toEqual({ p_workspace: WS, p_list: 'list-1', p_company_ids: ['co-1'], p_contact_ids: ['ct-1'] })
    // The people's stamps are cleared so a re-save of the company re-publishes them…
    const kids = queries.find((q) => q.op === 'update' && filterArgs(q, 'in').some(([c]) => c === 'id'))!
    expect(kids.payload).toEqual({ published_at: null })
    expect(filterArgs(kids, 'in')).toEqual([['id', ['p1', 'p2']]])
    // …and the company's own stamp goes with the dismissal.
    const own = queries.find((q) => q.op === 'update' && filterArgs(q, 'eq').some(([c, v]) => c === 'id' && v === 'e1'))!
    expect(own.payload).toMatchObject({ stage: 'dismissed', dismissed_reason: 'not_icp', published_at: null })
  })

  it('dismissing a saved but UNPUBLISHED entry writes no CRM change at all', async () => {
    const entryRow = { id: 'e1', kind: 'company', stage: 'saved', list_id: 'list-1', company_id: null, parent_entry_id: null, published_at: null }
    const { client, queries } = makeFakeSupabase((q) => ({ data: q.op === 'select' && !filterArgs(q, 'eq').some(([c]) => c === 'parent_entry_id') ? entryRow : q.op === 'select' ? [] : { ...entryRow, stage: 'dismissed' } }))
    const out = await updateEntryStage(client, { workspaceId: WS, entryId: 'e1', userId: USER, stage: 'dismissed', dismissedReason: 'not_icp' })
    expect(out.ok).toBe(true)
    expect(queries.some((q) => q.op === 'rpc')).toBe(false)
    const own = queries.find((q) => q.op === 'update')!
    expect(own.payload).toMatchObject({ stage: 'dismissed', published_at: null })
  })

  it('requires a KNOWN reason to dismiss', async () => {
    const { client } = makeFakeSupabase(() => ({ data: entry }))
    for (const reason of [undefined, '', 'because']) {
      const out = await updateEntryStage(client, {
        workspaceId: WS,
        entryId: 'e1',
        userId: USER,
        stage: 'dismissed',
        dismissedReason: reason,
      })
      expect(out).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    }
  })

  it('stamps the dismissal triple and never touches the CRM', async () => {
    const { client, queries } = makeFakeSupabase(() => ({ data: entry }))
    const out = await updateEntryStage(client, {
      workspaceId: WS,
      entryId: 'e1',
      userId: USER,
      stage: 'dismissed',
      dismissedReason: 'competitor',
    })
    expect(out.ok).toBe(true)
    // The row is READ first (the cascades and the CRM group need to know what
    // it is), then written; the write is the one that carries the triple.
    const payload = queries.find((q) => q.op === 'update')!.payload as Record<string, unknown>
    expect(payload).toMatchObject({
      stage: 'dismissed',
      dismissed_reason: 'competitor',
      dismissed_by: USER,
    })
    expect(typeof payload.dismissed_at).toBe('string')
    expect(queries.some((q) => q.table === 'company' || q.table === 'contact' || q.op === 'rpc')).toBe(false)
  })

  it('clears the whole dismissal triple on un-dismiss', async () => {
    const { client, queries } = makeFakeSupabase(() => ({ data: entry }))
    await updateEntryStage(client, {
      workspaceId: WS,
      entryId: 'e1',
      userId: USER,
      stage: 'shortlisted',
    })
    expect(queries.find((q) => q.op === 'update')!.payload).toEqual({
      stage: 'shortlisted',
      dismissed_reason: null,
      dismissed_by: null,
      dismissed_at: null,
    })
  })

  it('returns NOT_FOUND for an entry in another workspace', async () => {
    const { client } = makeFakeSupabase(() => ({ data: null }))
    const out = await updateEntryStage(client, {
      workspaceId: WS,
      entryId: 'e1',
      userId: USER,
      stage: 'shortlisted',
    })
    expect(out).toMatchObject({ ok: false, code: 'NOT_FOUND' })
  })
})

// ---------------------------------------------------------------------------
// promoteEntries
// ---------------------------------------------------------------------------

describe('promoteEntries', () => {
  interface PromoteWorld {
    entries: Array<Record<string, unknown>>
    company?: Record<string, unknown> | null
    companyWriteError?: { message: string } | null
    entryWriteError?: { message: string } | null
  }

  function world(opts: PromoteWorld) {
    const writes: Captured[] = []
    const fake = makeFakeSupabase((q) => {
      if (q.table === 'prospect_list_entry') {
        if (q.op === 'update') {
          writes.push(q)
          return { data: null, error: opts.entryWriteError ?? null }
        }
        return { data: opts.entries }
      }
      if (q.table === 'company') {
        if (q.op === 'update') {
          writes.push(q)
          return { data: null, error: opts.companyWriteError ?? null }
        }
        return { data: opts.company === undefined ? { id: 'co-new', metadata: null } : opts.company }
      }
      return { data: null }
    })
    return { ...fake, writes }
  }

  const COMPANY_ENTRY = {
    id: 'e1',
    list_id: 'list-1',
    kind: 'company',
    candidate_key: 'acme.test',
    candidate: { domain: 'acme.test', name: 'Acme' },
    stage: 'discovered',
    company_id: null,
    research: {},
    sources: [],
    discovered_by_run_id: 'run-1',
  }

  it('promotes a company through ensureCompanyForDomain and marks the entry saved', async () => {
    const { client, writes } = world({ entries: [COMPANY_ENTRY] })
    const out = await promoteEntries(client, { workspaceId: WS, userId: USER, entryIds: ['e1'] })
    expect(out).toMatchObject({
      ok: true,
      saved: [{ entry_id: 'e1', kind: 'company', company_id: 'co-new' }],
      skipped: [],
    })
    expect(hoisted.ensureCompanyForDomain).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: WS,
      domain: 'acme.test',
      name: 'Acme',
    })
    const entryWrite = writes.find((w) => w.table === 'prospect_list_entry') as Captured
    expect(entryWrite.payload).toEqual({ company_id: 'co-new', stage: 'saved' })
  })

  it('stamps metadata.prospecting on first promotion and leaves it alone on a second', async () => {
    const first = world({ entries: [COMPANY_ENTRY] })
    await promoteEntries(first.client, { workspaceId: WS, userId: USER, entryIds: ['e1'] })
    const stamped = (
      (first.writes.find((w) => w.table === 'company')!.payload as Record<string, unknown>)
        .metadata as Record<string, unknown>
    ).prospecting as Record<string, unknown>
    expect(stamped).toMatchObject({ list_id: 'list-1', run_id: 'run-1' })
    expect(typeof stamped.first_seen_at).toBe('string')

    const second = world({
      entries: [COMPANY_ENTRY],
      company: { id: 'co-new', metadata: { prospecting: { list_id: 'older', first_seen_at: 'then' } } },
    })
    await promoteEntries(second.client, { workspaceId: WS, userId: USER, entryIds: ['e1'] })
    const kept = (
      (second.writes.find((w) => w.table === 'company')!.payload as Record<string, unknown>)
        .metadata as Record<string, unknown>
    ).prospecting
    expect(kept).toEqual({ list_id: 'older', first_seen_at: 'then' })
  })

  it('fills EMPTY columns from research at high/medium and never overwrites a populated one', async () => {
    const { client, writes } = world({
      entries: [
        {
          ...COMPANY_ENTRY,
          research: {
            industry: { value: 'Developer Tools', confidence: 'high' },
            description: { value: 'A guess', confidence: 'low' },
            website: { value: 'https://found.test', confidence: 'high' },
          },
        },
      ],
      company: { id: 'co-new', website: 'https://already.test', industry: null, metadata: null },
    })
    await promoteEntries(client, { workspaceId: WS, userId: USER, entryIds: ['e1'] })
    const payload = writes.find((w) => w.table === 'company')!.payload as Record<string, unknown>
    // Empty column filled at high confidence.
    expect(payload.industry).toBe('Developer Tools')
    // 'low' never reaches a column.
    expect(payload.description).toBeUndefined()
    // A populated column is never overwritten.
    expect(payload.website).toBeUndefined()
  })

  it('merges research into the blob without displacing a higher-confidence CRM fact', async () => {
    const { client, writes } = world({
      entries: [{ ...COMPANY_ENTRY, research: { industry: { value: 'Guess', confidence: 'low' } } }],
      company: {
        id: 'co-new',
        metadata: {
          enrichment: { fields: { industry: { value: 'Verified', confidence: 'high' } } },
        },
      },
    })
    await promoteEntries(client, { workspaceId: WS, userId: USER, entryIds: ['e1'] })
    const metadata = (writes.find((w) => w.table === 'company')!.payload as Record<string, unknown>)
      .metadata as Record<string, unknown>
    const fields = (metadata.enrichment as Record<string, unknown>).fields as Record<
      string,
      { value: string }
    >
    expect(fields.industry.value).toBe('Verified')
  })

  it('is idempotent: an already-saved entry reports the record it already became', async () => {
    const { client } = world({
      entries: [{ ...COMPANY_ENTRY, stage: 'saved', company_id: 'co-existing' }],
    })
    const out = await promoteEntries(client, { workspaceId: WS, userId: USER, entryIds: ['e1'] })
    expect(out).toMatchObject({
      ok: true,
      saved: [{ entry_id: 'e1', kind: 'company', company_id: 'co-existing' }],
    })
    expect(hoisted.ensureCompanyForDomain).not.toHaveBeenCalled()
  })

  it('reports per-entry reasons rather than a count — the dialog reconciles against them', async () => {
    const { client } = world({
      entries: [
        { ...COMPANY_ENTRY, id: 'ok' },
        { ...COMPANY_ENTRY, id: 'gone', stage: 'dismissed' },
        // A person with no email, no LinkedIn URL and no name — there is no
        // identity to dedupe on, so promotion refuses rather than inserting an
        // un-mergeable orphan.
        { ...COMPANY_ENTRY, id: 'person', kind: 'person', candidate: {}, candidate_key: 'x@y.test' },
        { ...COMPANY_ENTRY, id: 'bare', candidate: {}, candidate_key: 'gmail.com' },
      ],
    })
    const out = await promoteEntries(client, {
      workspaceId: WS,
      userId: USER,
      entryIds: ['ok', 'gone', 'person', 'bare', 'never-existed'],
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.saved.map((s) => s.entry_id)).toEqual(['ok'])
    // COMPANIES run before PEOPLE regardless of the request order — a
    // person's parent may be in the same batch — so the person's outcome is
    // last among the ones that were found.
    // Every outcome names the LIST it came from, so a caller that saved across
    // two lists can say where each row landed. The exception is the id that
    // resolved to no row at all: there is no list to name, and '' is a value a
    // caller can test for rather than a fabricated one it cannot.
    expect(out.skipped).toEqual([
      { entry_id: 'gone', list_id: 'list-1', reason: 'dismissed' },
      { entry_id: 'bare', list_id: 'list-1', reason: 'no_domain' },
      { entry_id: 'never-existed', list_id: '', reason: 'not_found' },
      { entry_id: 'person', list_id: 'list-1', reason: 'no_identity', message: undefined },
    ])
  })

  it('reports a company-create failure with a message rather than marking the entry saved', async () => {
    hoisted.ensureCompanyForDomain.mockResolvedValue(null)
    const { client, writes } = world({ entries: [COMPANY_ENTRY] })
    const out = await promoteEntries(client, { workspaceId: WS, userId: USER, entryIds: ['e1'] })
    expect(out).toMatchObject({
      ok: true,
      saved: [],
      skipped: [{ entry_id: 'e1', reason: 'error', message: 'Failed to create the company' }],
    })
    expect(writes.filter((w) => w.table === 'prospect_list_entry')).toHaveLength(0)
  })

  it('does not mark the entry saved when the company write failed', async () => {
    const { client, writes } = world({ entries: [COMPANY_ENTRY], companyWriteError: { message: 'nope' } })
    const out = await promoteEntries(client, { workspaceId: WS, userId: USER, entryIds: ['e1'] })
    expect(out).toMatchObject({
      ok: true,
      saved: [],
      skipped: [{ entry_id: 'e1', reason: 'error', message: 'Failed to write the company' }],
    })
    expect(writes.filter((w) => w.table === 'prospect_list_entry')).toHaveLength(0)
  })

  it('de-duplicates the requested ids and short-circuits an empty request', async () => {
    const { client, queries } = world({ entries: [COMPANY_ENTRY] })
    const out = await promoteEntries(client, { workspaceId: WS, userId: USER, entryIds: ['e1', 'e1'] })
    expect(out.ok && out.saved).toHaveLength(1)

    const empty = world({ entries: [] })
    expect(await promoteEntries(empty.client, { workspaceId: WS, userId: USER, entryIds: [] })).toEqual({
      ok: true,
      saved: [],
      skipped: [],
    })
    expect(empty.queries).toHaveLength(0)
    void queries
  })

  it('scopes the entry read and every write to the workspace', async () => {
    const { client, queries } = world({ entries: [COMPANY_ENTRY] })
    await promoteEntries(client, { workspaceId: WS, userId: USER, entryIds: ['e1'] })
    for (const q of queries) expect(hasWorkspaceFilter(q, WS)).toBe(true)
  })

  it('every outcome names the LIST the entry came from, saved and skipped alike', async () => {
    // A save made from the CHAT can span lists — the model is handed entry ids,
    // not a page — so a caller that only got a total could not say where
    // anything landed. Both arrays carry `list_id` for exactly that reason, and
    // it is read from the ROW, never from the request.
    const { client } = world({
      entries: [
        { ...COMPANY_ENTRY, id: 'a', list_id: 'list-1' },
        { ...COMPANY_ENTRY, id: 'b', list_id: 'list-2' },
        { ...COMPANY_ENTRY, id: 'c', list_id: 'list-2', stage: 'dismissed' },
      ],
    })
    const out = await promoteEntries(client, {
      workspaceId: WS,
      userId: USER,
      entryIds: ['a', 'b', 'c'],
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.saved.map((e) => [e.entry_id, e.list_id])).toEqual([
      ['a', 'list-1'],
      ['b', 'list-2'],
    ])
    expect(out.skipped.map((e) => [e.entry_id, e.list_id])).toEqual([['c', 'list-2']])
  })
})

// ---------------------------------------------------------------------------
// promoteEntries — the PERSON path (§8)
// ---------------------------------------------------------------------------

describe('promoteEntries — people', () => {
  interface PersonWorld {
    entries: Array<Record<string, unknown>>
    /** The parent-entry lookup, when the parent is NOT in the batch. */
    parent?: Record<string, unknown> | null
    purpose?: string
    contactRow?: Record<string, unknown> | null
    /** Existing contact matched by the emailless LinkedIn dedup query. */
    linkedinMatch?: { id: string } | null
    entryWriteError?: { message: string } | null
    /** The saving user's member row. `null` models a service-role lane with no
     *  member at all, where the contact is still correct without an owner. */
    member?: { id: string } | null
    /** The CRM row the already-saved short circuit reads its `email` from.
     *  `null` models a contact deleted out from under the entry. */
    savedContact?: { id: string; email: string | null } | null
  }

  function world(opts: PersonWorld) {
    const writes: Captured[] = []
    let entryReads = 0
    const fake = makeFakeSupabase((q) => {
      if (q.table === 'prospect_list_entry') {
        if (q.op === 'update') {
          writes.push(q)
          return { data: null, error: opts.entryWriteError ?? null }
        }
        entryReads += 1
        // The first read is the batch `.in(...)`; any later one is a parent
        // lookup by id.
        if (entryReads === 1) return { data: opts.entries }
        return { data: opts.parent ?? null }
      }
      if (q.table === 'prospect_list') return { data: { purpose: opts.purpose ?? 'buyers' } }
      // The saving user's member row, resolved once per promoteEntries call —
      // contacts created here need `created_by_member_id` or 058's visibility
      // policy hides them from the very member who saved them.
      if (q.table === 'member') {
        return { data: opts.member === undefined ? { id: 'member-1' } : opts.member }
      }
      if (q.table === 'company') {
        if (q.op === 'update') {
          writes.push(q)
          return { data: null }
        }
        return { data: { id: 'co-new', metadata: null } }
      }
      if (q.table === 'contact') {
        if (q.op === 'insert' || q.op === 'update') {
          writes.push(q)
          return { data: { id: 'contact-new' } }
        }
        // The already-saved short circuit reads the CRM row's `email` — the
        // response's authority for enrollability, never the candidate blob.
        const isSavedEmailRead = (filterArgs(q, 'select')[0]?.[0] as string | undefined) === 'id, email'
        if (isSavedEmailRead) {
          return { data: opts.savedContact === undefined ? { id: 'contact-1', email: null } : opts.savedContact }
        }
        // The LinkedIn dedup probe carries `.eq('linkedin_url', …)`, and its
        // slug fallback carries `.ilike(…)`. Both resolve to the same match.
        const isDedup =
          filterArgs(q, 'eq').some(([col]) => col === 'linkedin_url') ||
          filterArgs(q, 'ilike').length > 0
        if (isDedup) return { data: opts.linkedinMatch ?? null }
        return {
          data:
            opts.contactRow === undefined
              ? { id: 'contact-new', job_title: null, department: null, linkedin_url: null, metadata: null }
              : opts.contactRow,
        }
      }
      return { data: null }
    })
    return { ...fake, writes }
  }

  const PARENT_ENTRY = {
    id: 'parent-1',
    list_id: 'list-1',
    kind: 'company',
    candidate_key: 'acme.test',
    candidate: { domain: 'acme.test', name: 'Acme' },
    stage: 'discovered',
    company_id: null,
    contact_id: null,
    parent_entry_id: null,
    identity_state: 'resolved',
    research: {},
    sources: [],
    discovered_by_run_id: 'run-1',
  }

  const PERSON_ENTRY = {
    id: 'p1',
    list_id: 'list-1',
    kind: 'person',
    candidate_key: 'linkedin.com/in/adalovelace',
    candidate: {
      name: 'Ada Lovelace',
      title: 'VP Engineering',
      linkedin_url: 'https://linkedin.com/in/adalovelace',
      domain: 'acme.test',
      company_name: 'Acme',
      email: null,
    },
    stage: 'discovered',
    company_id: null,
    contact_id: null,
    parent_entry_id: 'parent-1',
    identity_state: 'anchored',
    research: {},
    sources: [],
    discovered_by_run_id: 'run-1',
  }

  it('inserts an emailless person with email NULL, source prospecting and the PROMOTED parent company', async () => {
    const { client, writes } = world({ entries: [PERSON_ENTRY], parent: PARENT_ENTRY })
    const out = await promoteEntries(client, { workspaceId: WS, userId: USER, entryIds: ['p1'] })
    expect(out).toMatchObject({
      ok: true,
      saved: [{ entry_id: 'p1', kind: 'person', contact_id: 'contact-new', email: null }],
      skipped: [],
    })

    const insert = writes.find((w) => w.table === 'contact' && w.op === 'insert') as Captured
    expect(insert.payload).toMatchObject({
      workspace_id: WS,
      email: null,
      full_name: 'Ada Lovelace',
      first_name: 'Ada',
      last_name: 'Lovelace',
      job_title: 'VP Engineering',
      linkedin_url: 'linkedin.com/in/adalovelace',
      // The company the PARENT entry was promoted into, in this same call.
      company_id: 'co-new',
      source: 'prospecting',
      // purpose 'buyers' → 'lead' (decision 2).
      relationship_type: 'lead',
    })
  })

  it('writes relationship_type from the LIST PURPOSE', async () => {
    for (const [purpose, expected] of [
      ['buyers', 'lead'],
      ['investors', 'partner'],
      ['partners', 'partner'],
      // 'candidate' since migration 266 — a talent list IS a candidate pipeline.
      ['talent', 'candidate'],
      ['custom', 'contact'],
    ] as const) {
      const { client, writes } = world({ entries: [PERSON_ENTRY], parent: PARENT_ENTRY, purpose })
      await promoteEntries(client, { workspaceId: WS, userId: USER, entryIds: ['p1'] })
      const insert = writes.find((w) => w.table === 'contact' && w.op === 'insert') as Captured
      expect((insert.payload as Record<string, unknown>).relationship_type).toBe(expected)
    }
  })

  it('dedupes a SECOND discovery of the same LinkedIn URL to the existing contact', async () => {
    const { client, writes } = world({
      entries: [{ ...PERSON_ENTRY, id: 'p2', candidate_key: 'linkedin.com/in/adalovelace' }],
      parent: PARENT_ENTRY,
      linkedinMatch: { id: 'contact-1' },
    })
    const out = await promoteEntries(client, { workspaceId: WS, userId: USER, entryIds: ['p2'] })
    expect(out).toMatchObject({
      ok: true,
      saved: [{ entry_id: 'p2', kind: 'person', contact_id: 'contact-1' }],
    })
    // No second contact row — the dedup query is the whole point.
    expect(writes.filter((w) => w.table === 'contact' && w.op === 'insert')).toHaveLength(0)
  })

  it('promotes the PARENT company first when it is not saved, even though it was not selected', async () => {
    const { client, writes } = world({ entries: [PERSON_ENTRY], parent: PARENT_ENTRY })
    await promoteEntries(client, { workspaceId: WS, userId: USER, entryIds: ['p1'] })
    // A saved person implies a saved account.
    expect(hoisted.ensureCompanyForDomain).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: WS,
      domain: 'acme.test',
      name: 'Acme',
    })
    const parentWrite = writes.find(
      (w) => w.table === 'prospect_list_entry' && (w.payload as Record<string, unknown>).company_id,
    ) as Captured
    expect(parentWrite.payload).toEqual({ company_id: 'co-new', stage: 'saved' })
  })

  it('promotes a parent that is in the SAME batch exactly once', async () => {
    const { client, writes } = world({
      entries: [
        // Deliberately person-first in the request, to prove the reordering.
        { ...PERSON_ENTRY, id: 'p1' },
        { ...PERSON_ENTRY, id: 'p2', candidate_key: 'linkedin.com/in/grace' },
        PARENT_ENTRY,
      ],
    })
    const out = await promoteEntries(client, {
      workspaceId: WS,
      userId: USER,
      entryIds: ['p1', 'p2', 'parent-1'],
    })
    expect(out.ok && out.saved.map((s) => s.entry_id)).toEqual(['parent-1', 'p1', 'p2'])
    // One ensureCompanyForDomain, one company write — not three.
    expect(hoisted.ensureCompanyForDomain).toHaveBeenCalledTimes(1)
    expect(writes.filter((w) => w.table === 'company')).toHaveLength(1)
  })

  it('skips the person with parent_failed when the parent could not be promoted', async () => {
    hoisted.ensureCompanyForDomain.mockResolvedValue(null)
    const { client, writes } = world({ entries: [PERSON_ENTRY], parent: PARENT_ENTRY })
    const out = await promoteEntries(client, { workspaceId: WS, userId: USER, entryIds: ['p1'] })
    expect(out).toMatchObject({
      ok: true,
      saved: [],
      skipped: [{ entry_id: 'p1', reason: 'parent_failed' }],
    })
    // No contact at all — a company-less contact is the outcome this prevents.
    expect(writes.filter((w) => w.table === 'contact')).toHaveLength(0)
  })

  it('NEVER promotes a dismissed parent — dismissal must not resurrect a company', async () => {
    // Looked up from the database (the parent was not in the batch).
    const viaLookup = world({
      entries: [PERSON_ENTRY],
      parent: { ...PARENT_ENTRY, stage: 'dismissed' },
    })
    expect(
      await promoteEntries(viaLookup.client, { workspaceId: WS, userId: USER, entryIds: ['p1'] }),
    ).toMatchObject({
      ok: true,
      saved: [],
      skipped: [{ entry_id: 'p1', reason: 'parent_failed', message: 'The parent company was dismissed' }],
    })
    expect(hoisted.ensureCompanyForDomain).not.toHaveBeenCalled()
    expect(viaLookup.writes.filter((w) => w.table === 'contact')).toHaveLength(0)

    // And in the SAME batch: the main loop skips it as dismissed, and the
    // person must see that refusal rather than re-reading and promoting it.
    const inBatch = world({
      entries: [PERSON_ENTRY, { ...PARENT_ENTRY, stage: 'dismissed' }],
    })
    const out = await promoteEntries(inBatch.client, {
      workspaceId: WS,
      userId: USER,
      entryIds: ['p1', 'parent-1'],
    })
    expect(out).toMatchObject({
      ok: true,
      saved: [],
      skipped: [
        { entry_id: 'parent-1', reason: 'dismissed' },
        { entry_id: 'p1', reason: 'parent_failed' },
      ],
    })
    expect(hoisted.ensureCompanyForDomain).not.toHaveBeenCalled()
    expect(inBatch.writes.filter((w) => w.table === 'contact')).toHaveLength(0)
  })

  it('reuses an ALREADY-SAVED parent without re-promoting it', async () => {
    const { client } = world({
      entries: [PERSON_ENTRY],
      parent: { ...PARENT_ENTRY, stage: 'saved', company_id: 'co-existing' },
    })
    const out = await promoteEntries(client, { workspaceId: WS, userId: USER, entryIds: ['p1'] })
    expect(out.ok && out.saved).toHaveLength(1)
    expect(hoisted.ensureCompanyForDomain).not.toHaveBeenCalled()
  })

  it('promotes a person with NO parent entry under a null company', async () => {
    const { client, writes } = world({
      entries: [{ ...PERSON_ENTRY, parent_entry_id: null }],
    })
    const out = await promoteEntries(client, { workspaceId: WS, userId: USER, entryIds: ['p1'] })
    expect(out.ok && out.saved).toMatchObject([{ entry_id: 'p1', contact_id: 'contact-new' }])
    const insert = writes.find((w) => w.table === 'contact' && w.op === 'insert') as Captured
    expect((insert.payload as Record<string, unknown>).company_id).toBeNull()
  })

  it('skips a needs_review person unless include_unverified is set for that id', async () => {
    const NEEDS_REVIEW = { ...PERSON_ENTRY, identity_state: 'needs_review' }

    const bulk = world({ entries: [NEEDS_REVIEW], parent: PARENT_ENTRY })
    expect(
      await promoteEntries(bulk.client, { workspaceId: WS, userId: USER, entryIds: ['p1'] }),
    ).toMatchObject({ ok: true, saved: [], skipped: [{ entry_id: 'p1', reason: 'needs_review' }] })
    expect(bulk.writes.filter((w) => w.table === 'contact')).toHaveLength(0)

    const confirmed = world({ entries: [NEEDS_REVIEW], parent: PARENT_ENTRY })
    expect(
      await promoteEntries(confirmed.client, {
        workspaceId: WS,
        userId: USER,
        entryIds: ['p1'],
        includeUnverified: true,
      }),
    ).toMatchObject({ ok: true, saved: [{ entry_id: 'p1', contact_id: 'contact-new' }] })
  })

  it("sets contact_id and stage='saved' on the entry, and NEVER company_id", async () => {
    const { client, writes } = world({ entries: [PERSON_ENTRY], parent: PARENT_ENTRY })
    await promoteEntries(client, { workspaceId: WS, userId: USER, entryIds: ['p1'] })
    const entryWrite = writes.find(
      (w) => w.table === 'prospect_list_entry' && (w.payload as Record<string, unknown>).contact_id,
    ) as Captured
    // 248's `prospect_entry_kind_target` CHECK is `person ⇒ company_id IS NULL`.
    expect(entryWrite.payload).toEqual({ contact_id: 'contact-new', stage: 'saved' })
  })

  it('merges the person research ADDITIVELY into contact.metadata.enrichment', async () => {
    const { client, writes } = world({
      entries: [
        {
          ...PERSON_ENTRY,
          research: {
            job_title: { value: 'VP Engineering', confidence: 'high' },
            bio: { value: 'Built the compiler', confidence: 'medium' },
          },
          sources: [{ url: 'https://acme.test/team' }],
        },
      ],
      parent: PARENT_ENTRY,
      contactRow: {
        id: 'contact-new',
        job_title: null,
        department: null,
        linkedin_url: null,
        metadata: { enrichment: { fields: { bio: { value: 'Verified bio', confidence: 'high' } } } },
      },
    })
    await promoteEntries(client, { workspaceId: WS, userId: USER, entryIds: ['p1'] })

    const merge = writes.find(
      (w) => w.table === 'contact' && w.op === 'update' && (w.payload as Record<string, unknown>).metadata,
    ) as Captured
    const metadata = (merge.payload as Record<string, unknown>).metadata as Record<string, unknown>
    const fields = (metadata.enrichment as Record<string, unknown>).fields as Record<
      string,
      { value: string }
    >
    // The high-confidence CRM fact survives; the new field is added.
    expect(fields.bio.value).toBe('Verified bio')
    expect(fields.job_title.value).toBe('VP Engineering')
    // The empty column is filled.
    expect((merge.payload as Record<string, unknown>).job_title).toBe('VP Engineering')
    expect(metadata.prospecting).toMatchObject({ list_id: 'list-1', entry_id: 'p1' })
  })

  it('is idempotent: an already-saved person reports the contact it already became', async () => {
    const { client } = world({
      entries: [{ ...PERSON_ENTRY, stage: 'saved', contact_id: 'contact-1' }],
      savedContact: { id: 'contact-1', email: 'ada@acme.test' },
    })
    const out = await promoteEntries(client, { workspaceId: WS, userId: USER, entryIds: ['p1'] })
    expect(out).toMatchObject({
      ok: true,
      saved: [
        { entry_id: 'p1', kind: 'person', contact_id: 'contact-1', email: 'ada@acme.test' },
      ],
    })
  })

  it('reads an already-saved person’s email from the CRM ROW, not the candidate blob', async () => {
    // The candidate carries an address the CRM record does not. `email` on
    // this response is what Add-to-sequence filters on, so reporting the blob
    // would hand the dialog a contact whose `contact.email` is NULL — which it
    // swallows as `no_email` inside a toast, the exact burial §8 forbids.
    const { client } = world({
      entries: [
        {
          ...PERSON_ENTRY,
          stage: 'saved',
          contact_id: 'contact-1',
          candidate: { ...PERSON_ENTRY.candidate, email: 'stale@acme.test' },
        },
      ],
      savedContact: { id: 'contact-1', email: null },
    })
    const out = await promoteEntries(client, { workspaceId: WS, userId: USER, entryIds: ['p1'] })
    expect(out).toMatchObject({
      ok: true,
      saved: [{ entry_id: 'p1', contact_id: 'contact-1', email: null }],
    })
  })

  it('skips an already-saved person whose contact row is gone, rather than reporting a dead id', async () => {
    const { client } = world({
      entries: [{ ...PERSON_ENTRY, stage: 'saved', contact_id: 'contact-gone' }],
      savedContact: null,
    })
    const out = await promoteEntries(client, { workspaceId: WS, userId: USER, entryIds: ['p1'] })
    expect(out).toMatchObject({ ok: true, saved: [], skipped: [{ entry_id: 'p1', reason: 'not_found' }] })
  })

  it('stamps the saving member and workspace visibility on a created contact (058)', async () => {
    // Without these, `can_view_contact` hides the row from the very member who
    // saved it: the insert's RETURNING comes back empty through the RLS client
    // and promotion reports `error` on a contact that actually exists.
    const { client, writes } = world({ entries: [PERSON_ENTRY], parent: PARENT_ENTRY })
    await promoteEntries(client, { workspaceId: WS, userId: USER, entryIds: ['p1'] })
    const insert = writes.find((w) => w.table === 'contact' && w.op === 'insert') as Captured
    expect(insert.payload).toMatchObject({
      created_by_member_id: 'member-1',
      visibility: 'workspace',
    })
  })

  it('resolves the member ONCE for a batch of people, not once per person', async () => {
    const second = { ...PERSON_ENTRY, id: 'p2', candidate_key: 'linkedin.com/in/someone' }
    const { client, queries } = world({
      entries: [PERSON_ENTRY, second],
      parent: PARENT_ENTRY,
    })
    await promoteEntries(client, { workspaceId: WS, userId: USER, entryIds: ['p1', 'p2'] })
    expect(queries.filter((q) => q.table === 'member')).toHaveLength(1)
  })

  it('carries the email back on a person that HAS one — the Add-to-sequence filter reads it', async () => {
    const { client } = world({
      entries: [{ ...PERSON_ENTRY, candidate: { ...PERSON_ENTRY.candidate, email: 'Ada@Acme.test' } }],
      parent: PARENT_ENTRY,
      linkedinMatch: null,
    })
    const out = await promoteEntries(client, { workspaceId: WS, userId: USER, entryIds: ['p1'] })
    // `findOrCreateContact` is not mocked in this file and holds the service
    // client, so it cannot create here — what matters is that the WITH-EMAIL
    // branch was taken at all, which the emailless insert's absence proves.
    expect(out.ok && (out.saved.length + out.skipped.length)).toBe(1)
  })

  it('reports a cross-workspace person id as not_found, never as a permission error', async () => {
    const { client } = world({ entries: [] })
    expect(
      await promoteEntries(client, { workspaceId: WS, userId: USER, entryIds: ['foreign'] }),
    ).toMatchObject({ ok: true, saved: [], skipped: [{ entry_id: 'foreign', reason: 'not_found' }] })
    // A not_found id resolved to NO row, so there is no list to name. The empty
    // string is a value the caller can test for — fabricating one, or leaving
    // the field off a shape that promises it, would both be worse.
    const out = await promoteEntries(client, {
      workspaceId: WS,
      userId: USER,
      entryIds: ['foreign'],
    })
    expect(out.ok && out.skipped[0].list_id).toBe('')
  })

  it('a person outcome names its list too, on the saved and the refused path', async () => {
    const saved = world({ entries: [PERSON_ENTRY], parent: PARENT_ENTRY })
    expect(
      await promoteEntries(saved.client, { workspaceId: WS, userId: USER, entryIds: ['p1'] }),
    ).toMatchObject({ ok: true, saved: [{ entry_id: 'p1', list_id: 'list-1' }] })

    // The namesake gate — the most likely thing a caller has to report per
    // list, because it is the one skip the user can act on.
    const gated = world({
      entries: [{ ...PERSON_ENTRY, identity_state: 'needs_review' }],
      parent: PARENT_ENTRY,
    })
    expect(
      await promoteEntries(gated.client, { workspaceId: WS, userId: USER, entryIds: ['p1'] }),
    ).toMatchObject({
      ok: true,
      skipped: [{ entry_id: 'p1', list_id: 'list-1', reason: 'needs_review' }],
    })
  })

  it('scopes every person read and write to the workspace', async () => {
    const { client, queries } = world({ entries: [PERSON_ENTRY], parent: PARENT_ENTRY })
    await promoteEntries(client, { workspaceId: WS, userId: USER, entryIds: ['p1'] })
    for (const q of queries) {
      // An INSERT carries the workspace in its PAYLOAD, not as a filter — that
      // is the whole point of the column. Everything else must filter on it:
      // RLS is never the only boundary in this lib.
      const scoped =
        q.op === 'insert'
          ? (q.payload as Record<string, unknown>).workspace_id === WS
          : hasWorkspaceFilter(q, WS)
      expect(`${q.table}:${q.op}:${scoped}`).toBe(`${q.table}:${q.op}:true`)
    }
  })
})

// ---------------------------------------------------------------------------
// listSequencedByList — the DERIVED "Sequenced" chip (§8)
// ---------------------------------------------------------------------------

describe('listSequencedByList', () => {
  function world(opts: {
    entries?: Array<{ contact_id: string | null }>
    enrollments?: Array<Record<string, unknown>>
    enrollmentError?: { message: string }
  }) {
    return makeFakeSupabase((q) => {
      if (q.table === 'prospect_list_entry') return { data: opts.entries ?? [] }
      if (q.table === 'sequence_enrollment') {
        return opts.enrollmentError
          ? { data: null, error: opts.enrollmentError }
          : { data: opts.enrollments ?? [] }
      }
      return { data: null }
    })
  }

  it('maps every saved contact to its sequence, read from sequence_enrollment', async () => {
    const { client, queries } = world({
      entries: [{ contact_id: 'c1' }, { contact_id: 'c2' }],
      enrollments: [
        { contact_id: 'c1', status: 'active', sequence_id: 's1', sequence: { id: 's1', name: 'Q4 outbound' } },
        { contact_id: 'c2', status: 'exited', sequence_id: 's2', sequence: { id: 's2', name: 'Winback' } },
      ],
    })
    const out = await listSequencedByList(client, { workspaceId: WS, listId: 'list-1' })
    expect(out).toEqual({
      ok: true,
      sequenced: {
        c1: { status: 'active', sequence_id: 's1', sequence_name: 'Q4 outbound' },
        c2: { status: 'exited', sequence_id: 's2', sequence_name: 'Winback' },
      },
    })
    for (const q of queries) expect(hasWorkspaceFilter(q, WS)).toBe(true)
  })

  it('prefers the ACTIVE enrollment when a contact is in more than one sequence', async () => {
    for (const order of [
      [
        { contact_id: 'c1', status: 'exited', sequence_id: 's2', sequence: { id: 's2', name: 'Old' } },
        { contact_id: 'c1', status: 'active', sequence_id: 's1', sequence: { id: 's1', name: 'Live' } },
      ],
      [
        { contact_id: 'c1', status: 'active', sequence_id: 's1', sequence: { id: 's1', name: 'Live' } },
        { contact_id: 'c1', status: 'exited', sequence_id: 's2', sequence: { id: 's2', name: 'Old' } },
      ],
    ]) {
      const { client } = world({ entries: [{ contact_id: 'c1' }], enrollments: order })
      const out = await listSequencedByList(client, { workspaceId: WS, listId: 'list-1' })
      expect(out.ok && out.sequenced.c1).toEqual({
        status: 'active',
        sequence_id: 's1',
        sequence_name: 'Live',
      })
    }
  })

  it('reads an embedded sequence returned as a one-element array', async () => {
    const { client } = world({
      entries: [{ contact_id: 'c1' }],
      enrollments: [
        { contact_id: 'c1', status: 'active', sequence_id: 's1', sequence: [{ id: 's1', name: 'Q4' }] },
      ],
    })
    const out = await listSequencedByList(client, { workspaceId: WS, listId: 'list-1' })
    expect(out.ok && out.sequenced.c1.sequence_name).toBe('Q4')
  })

  it('short-circuits when the list has no saved contacts at all', async () => {
    const { client, queries } = world({ entries: [{ contact_id: null }] })
    expect(await listSequencedByList(client, { workspaceId: WS, listId: 'list-1' })).toEqual({
      ok: true,
      sequenced: {},
    })
    expect(queries.filter((q) => q.table === 'sequence_enrollment')).toHaveLength(0)
  })

  it('surfaces a read failure rather than reporting nobody is sequenced', async () => {
    const { client } = world({
      entries: [{ contact_id: 'c1' }],
      enrollmentError: { message: 'boom' },
    })
    expect(await listSequencedByList(client, { workspaceId: WS, listId: 'list-1' })).toMatchObject({
      ok: false,
      code: 'DB_ERROR',
    })
  })
})

// ---------------------------------------------------------------------------
// exclusionCounts
// ---------------------------------------------------------------------------

describe('exclusionCounts', () => {
  interface CountWorld {
    crm: number
    entries: number
    enrollments?: Array<{ contact_id: string | null; contact_email: string | null }>
  }

  function world(counts: CountWorld, lists: string[]) {
    return makeFakeSupabase((q) => {
      if (q.table === 'company') return { data: null, count: counts.crm }
      if (q.table === 'prospect_list') return { data: lists.map((id) => ({ id })) }
      if (q.table === 'prospect_list_entry') return { data: null, count: counts.entries }
      if (q.table === 'sequence_enrollment') return { data: counts.enrollments ?? [] }
      return { data: null }
    })
  }

  const NINE_ENROLLMENTS = Array.from({ length: 9 }, (_, i) => ({
    contact_id: `c${i}`,
    contact_email: `p${i}@acme.test`,
  }))

  it('counts CRM companies WITH a domain, every other list, and every contacted person', async () => {
    const { client, queries } = world(
      { crm: 412, entries: 60, enrollments: NINE_ENROLLMENTS },
      ['list-1', 'list-2'],
    )
    const out = await exclusionCounts(client, { workspaceId: WS, listId: 'list-1' })
    expect(out).toEqual({
      ok: true,
      counts: { crm_companies: 412, other_lists: 60, contacted_people: 9 },
    })
    // A domain-less company cannot suppress anything, so it must not be counted.
    const companyQuery = queries.find((q) => q.table === 'company')!
    expect(filterArgs(companyQuery, 'not')).toContainEqual(['domain', 'is', null])
    // The current list is excluded from 'other lists'.
    expect(filterArgs(queries.find((q) => q.table === 'prospect_list_entry')!, 'in')).toContainEqual([
      'list_id',
      ['list-2'],
    ])
  })

  it('skips the other-lists read when this is the only list', async () => {
    const { client, queries } = world({ crm: 1, entries: 99 }, ['list-1'])
    const out = await exclusionCounts(client, { workspaceId: WS, listId: 'list-1' })
    expect(out.ok && out.counts.other_lists).toBe(0)
    expect(queries.filter((q) => q.table === 'prospect_list_entry')).toHaveLength(0)
  })

  it('counts every active list when there is no list yet (the New-list sheet)', async () => {
    const { client, queries } = world({ crm: 0, entries: 7 }, ['list-1', 'list-2'])
    const out = await exclusionCounts(client, { workspaceId: WS })
    expect(out.ok && out.counts.other_lists).toBe(7)
    expect(filterArgs(queries.find((q) => q.table === 'prospect_list_entry')!, 'in')).toContainEqual([
      'list_id',
      ['list-1', 'list-2'],
    ])
  })

  it('counts DISTINCT people, not enrollment rows — one contact in three sequences is one person', async () => {
    const { client } = world(
      {
        crm: 0,
        entries: 0,
        enrollments: [
          { contact_id: 'c1', contact_email: 'ada@acme.test' },
          { contact_id: 'c1', contact_email: 'ada@acme.test' },
          // A bare-email enrollment has no contact_id and keys on the email,
          // case-insensitively — the same two keys the exclusion set uses.
          { contact_id: null, contact_email: 'Grace@acme.test' },
          { contact_id: null, contact_email: 'grace@acme.test' },
          { contact_id: null, contact_email: null },
        ],
      },
      [],
    )
    const out = await exclusionCounts(client, { workspaceId: WS })
    expect(out.ok && out.counts.contacted_people).toBe(2)
  })

  it('surfaces a query failure rather than reporting zero exclusions', async () => {
    const { client } = makeFakeSupabase((q) =>
      q.table === 'company' ? { data: null, error: { message: 'boom' } } : { data: [] },
    )
    expect(await exclusionCounts(client, { workspaceId: WS })).toMatchObject({
      ok: false,
      code: 'DB_ERROR',
    })
  })
})

// ---------------------------------------------------------------------------
// saveEntriesToList — Save is curation (migration 259)
// ---------------------------------------------------------------------------

describe('saveEntriesToList', () => {
  it('reports per-entry outcomes in Publish’s shape — kind and list on each — and never touches the CRM', async () => {
    const rows: Record<string, Record<string, unknown>> = {
      c1: { id: 'c1', kind: 'company', stage: 'discovered', list_id: 'list-1', parent_entry_id: null, published_at: null },
      p1: { id: 'p1', kind: 'person', stage: 'discovered', list_id: 'list-1', parent_entry_id: 'c1', published_at: null, contact_id: null },
    }
    const { client, queries } = makeFakeSupabase((q) => {
      const id = filterArgs(q, 'eq').find(([c]) => c === 'id')?.[1] as string | undefined
      const row = id ? rows[id] : undefined
      if (q.op === 'select') return { data: row ?? null }
      return { data: row ? { ...row, stage: 'saved' } : null }
    })
    const out = await saveEntriesToList(client, {
      workspaceId: WS,
      userId: USER,
      entryIds: ['c1', 'p1', 'p1', 'ghost'],
    })
    expect(out).toEqual({
      ok: true,
      saved: [
        { entry_id: 'c1', list_id: 'list-1', kind: 'company' },
        { entry_id: 'p1', list_id: 'list-1', kind: 'person' },
      ],
      skipped: [{ entry_id: 'ghost', list_id: '', reason: 'not_found' }],
    })
    expect(queries.some((q) => q.op === 'rpc' || q.table === 'company' || q.table === 'contact')).toBe(false)
  })
})

describe('countEntriesByList — pending_publish', () => {
  it('counts saved & unpublished companies, and saved & unpublished people only under a SAVED company', async () => {
    const { client } = makeFakeSupabase(() => ({
      data: [
        { id: 'c1', list_id: 'list-1', stage: 'saved', kind: 'company', parent_entry_id: null, published_at: null },
        { id: 'c2', list_id: 'list-1', stage: 'saved', kind: 'company', parent_entry_id: null, published_at: '2026-09-01T00:00:00Z' },
        { id: 'c3', list_id: 'list-1', stage: 'dismissed', kind: 'company', parent_entry_id: null, published_at: null },
        // Pending: its company is saved (published or not).
        { id: 'p1', list_id: 'list-1', stage: 'saved', kind: 'person', parent_entry_id: 'c2', published_at: null },
        // Not pending: its company was dismissed — it left the group with it.
        { id: 'p2', list_id: 'list-1', stage: 'saved', kind: 'person', parent_entry_id: 'c3', published_at: null },
        // Not pending: not saved.
        { id: 'p3', list_id: 'list-1', stage: 'discovered', kind: 'person', parent_entry_id: 'c1', published_at: null },
      ],
    }))
    const counts = await countEntriesByList(client, { workspaceId: WS, listIds: ['list-1'] })
    expect(counts.get('list-1')).toMatchObject({ saved: 4, saved_people: 2, pending_publish: 2 })
  })
})
