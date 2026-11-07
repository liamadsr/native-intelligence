/**
 * Publish — the list becomes a group in the CRM (migration 259).
 *
 * `promoteEntries` is mocked: its own suite proves promotion. What this one
 * pins is everything Publish adds AROUND it — the `published_at` stamps on
 * the entries and the list, the CRM-row grouping through the SQL function,
 * the per-list fan-out, the pending set (companies first, people only under a
 * saved company), and the batching a big list needs — and that every write
 * is workspace-scoped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase, filterArgs, hasWorkspaceFilter, type Captured } from './fake-supabase'

const hoisted = vi.hoisted(() => ({ promoteEntries: vi.fn() }))
vi.mock('../lists', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lists')>()),
  promoteEntries: hoisted.promoteEntries,
}))

const { pendingPublishEntryIds, publishEntries, publishList } = await import('../publish')

const WS = 'ws-1'
const USER = 'user-1'
const LIST = 'list-1'

beforeEach(() => {
  hoisted.promoteEntries.mockReset()
})

describe('publishEntries', () => {
  const PROMOTED = {
    ok: true,
    saved: [
      { entry_id: 'c1', list_id: LIST, kind: 'company', company_id: 'co-1' },
      { entry_id: 'p1', list_id: LIST, kind: 'person', contact_id: 'ct-1', email: 'a@x.test' },
      { entry_id: 'c9', list_id: 'list-2', kind: 'company', company_id: 'co-9' },
    ],
    skipped: [{ entry_id: 'p2', list_id: LIST, reason: 'needs_review' }],
  }

  it('promotes, stamps the entries, files the CRM rows under each list, and stamps the lists', async () => {
    hoisted.promoteEntries.mockResolvedValue(PROMOTED)
    const { client, queries } = makeFakeSupabase(() => ({ data: null }))
    const out = await publishEntries(client, {
      workspaceId: WS,
      userId: USER,
      entryIds: ['c1', 'p1', 'c9', 'p2'],
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.saved).toEqual(PROMOTED.saved)
    expect(out.skipped).toEqual(PROMOTED.skipped)
    // First-seen order across the outcomes, the listless skip contributing nothing.
    expect(out.list_ids).toEqual([LIST, 'list-2'])
    expect(typeof out.published_at).toBe('string')
    expect(hoisted.promoteEntries.mock.calls[0][1]).toMatchObject({
      workspaceId: WS,
      userId: USER,
      entryIds: ['c1', 'p1', 'c9', 'p2'],
      includeUnverified: false,
    })

    // The entries that landed carry the stamp — only those.
    const stamp = queries.find((q) => q.table === 'prospect_list_entry' && q.op === 'update')!
    expect(stamp.payload).toEqual({ published_at: out.published_at })
    expect(filterArgs(stamp, 'in')).toEqual([['id', ['c1', 'p1', 'c9']]])
    expect(hasWorkspaceFilter(stamp, WS)).toBe(true)

    // The CRM rows join their list's group through the SQL function, per list.
    const marks = queries.filter((q) => q.table === 'rpc:prospect_list_mark_published')
    expect(marks.map((m) => m.payload)).toEqual([
      { p_workspace: WS, p_list: LIST, p_company_ids: ['co-1'], p_contact_ids: ['ct-1'] },
      { p_workspace: WS, p_list: 'list-2', p_company_ids: ['co-9'], p_contact_ids: [] },
    ])

    // And each list remembers when, and by whom.
    const lists = queries.filter((q) => q.table === 'prospect_list' && q.op === 'update')
    expect(lists).toHaveLength(2)
    expect(lists[0].payload).toEqual({ published_at: out.published_at, published_by: USER })
    expect(filterArgs(lists[0], 'eq')).toContainEqual(['id', LIST])
    expect(hasWorkspaceFilter(lists[0], WS)).toBe(true)
  })

  it('passes include_unverified through — the per-row confirm', async () => {
    hoisted.promoteEntries.mockResolvedValue({ ok: true, saved: [], skipped: [] })
    const { client } = makeFakeSupabase(() => ({ data: null }))
    await publishEntries(client, { workspaceId: WS, userId: USER, entryIds: ['p2'], includeUnverified: true })
    expect(hoisted.promoteEntries.mock.calls[0][1].includeUnverified).toBe(true)
  })

  it('writes nothing when nothing was promoted, and still names the lists it looked at', async () => {
    hoisted.promoteEntries.mockResolvedValue({
      ok: true,
      saved: [],
      skipped: [{ entry_id: 'p2', list_id: LIST, reason: 'needs_review' }],
    })
    const { client, queries } = makeFakeSupabase(() => ({ data: null }))
    const out = await publishEntries(client, { workspaceId: WS, userId: USER, entryIds: ['p2'] })
    expect(out).toMatchObject({ ok: true, saved: [], list_ids: [LIST], published_at: null })
    expect(queries).toHaveLength(0)
  })

  it('passes a promotion failure through untouched', async () => {
    hoisted.promoteEntries.mockResolvedValue({ ok: false, code: 'DB_ERROR', error: 'Failed to load entries' })
    const { client, queries } = makeFakeSupabase(() => ({ data: null }))
    const out = await publishEntries(client, { workspaceId: WS, userId: USER, entryIds: ['c1'] })
    expect(out).toEqual({ ok: false, code: 'DB_ERROR', error: 'Failed to load entries' })
    expect(queries).toHaveLength(0)
  })

  it('reports DB_ERROR when the CRM grouping fails — the rows are in, the group is not', async () => {
    hoisted.promoteEntries.mockResolvedValue({
      ok: true,
      saved: [{ entry_id: 'c1', list_id: LIST, kind: 'company', company_id: 'co-1' }],
      skipped: [],
    })
    const { client } = makeFakeSupabase((q: Captured) =>
      q.table.startsWith('rpc:') ? { error: { message: 'boom' } } : { data: null },
    )
    const out = await publishEntries(client, { workspaceId: WS, userId: USER, entryIds: ['c1'] })
    expect(out).toMatchObject({ ok: false, code: 'DB_ERROR' })
  })
})

describe('pendingPublishEntryIds', () => {
  const ROWS = [
    { id: 'c1', kind: 'company', stage: 'saved', parent_entry_id: null, published_at: null },
    { id: 'c2', kind: 'company', stage: 'saved', parent_entry_id: null, published_at: '2026-09-01T00:00:00Z' },
    // Pending: under a saved company (published or not — the COMPANY's stamp is
    // the company's; this person has none).
    { id: 'p1', kind: 'person', stage: 'saved', parent_entry_id: 'c1', published_at: null },
    { id: 'p2', kind: 'person', stage: 'saved', parent_entry_id: 'c2', published_at: null },
    // Out: the parent is not on the list — a dismissed company takes its
    // people out of the group with it, whatever their own stage says.
    { id: 'p3', kind: 'person', stage: 'saved', parent_entry_id: 'c-dismissed', published_at: null },
    // Out: already in the group.
    { id: 'p4', kind: 'person', stage: 'saved', parent_entry_id: 'c1', published_at: '2026-09-01T00:00:00Z' },
  ]

  it('is the saved, unpublished rows — companies first, people only under a saved company', async () => {
    const { client, queries } = makeFakeSupabase(() => ({ data: ROWS }))
    const out = await pendingPublishEntryIds(client, { workspaceId: WS, listId: LIST })
    expect(out).toEqual({ ok: true, entryIds: ['c1', 'p1', 'p2'] })
    // Only the saved rows are read, for THIS list, in THIS workspace.
    expect(filterArgs(queries[0], 'eq')).toEqual(
      expect.arrayContaining([
        ['workspace_id', WS],
        ['list_id', LIST],
        ['stage', 'saved'],
      ]),
    )
  })

  it('reports a failed read rather than publishing a partial set', async () => {
    const { client } = makeFakeSupabase(() => ({ error: { message: 'boom' } }))
    const out = await pendingPublishEntryIds(client, { workspaceId: WS, listId: LIST })
    expect(out).toMatchObject({ ok: false, code: 'DB_ERROR' })
  })
})

describe('publishList', () => {
  function world(opts: { list?: unknown; rows?: unknown[] }) {
    return makeFakeSupabase((q: Captured) => {
      if (q.table === 'prospect_list' && q.op === 'select') {
        return { data: opts.list === undefined ? { id: LIST, name: 'Q4 outbound', status: 'active' } : opts.list }
      }
      if (q.table === 'prospect_list_entry' && q.op === 'select') return { data: opts.rows ?? [] }
      return { data: null }
    })
  }

  it('404s a cross-workspace list and refuses an archived one, writing nothing', async () => {
    const missing = await publishList(world({ list: null }).client, { workspaceId: WS, userId: USER, listId: LIST })
    expect(missing).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    const archived = await publishList(
      world({ list: { id: LIST, name: 'Old', status: 'archived' } }).client,
      { workspaceId: WS, userId: USER, listId: LIST },
    )
    expect(archived).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    expect(hoisted.promoteEntries).not.toHaveBeenCalled()
  })

  it('publishes everything pending, in batches of 100, and names the list', async () => {
    const rows = Array.from({ length: 150 }, (_, i) => ({
      id: `c${i}`,
      kind: 'company',
      stage: 'saved',
      parent_entry_id: null,
      published_at: null,
    }))
    hoisted.promoteEntries.mockImplementation(async (_client: unknown, args: { entryIds: string[] }) => ({
      ok: true,
      saved: args.entryIds.map((id) => ({ entry_id: id, list_id: LIST, kind: 'company', company_id: `co-${id}` })),
      skipped: [],
    }))
    const out = await publishList(world({ rows }).client, { workspaceId: WS, userId: USER, listId: LIST })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.saved).toHaveLength(150)
    expect(out.list_ids).toEqual([LIST])
    expect(out.list_name).toBe('Q4 outbound')
    expect(typeof out.published_at).toBe('string')
    expect(hoisted.promoteEntries).toHaveBeenCalledTimes(2)
    expect(hoisted.promoteEntries.mock.calls[0][1].entryIds).toHaveLength(100)
    expect(hoisted.promoteEntries.mock.calls[1][1].entryIds).toHaveLength(50)
  })

  it('is a successful no-op when nothing is pending', async () => {
    const out = await publishList(world({ rows: [] }).client, { workspaceId: WS, userId: USER, listId: LIST })
    expect(out).toMatchObject({ ok: true, saved: [], skipped: [], list_ids: [LIST], published_at: null, list_name: 'Q4 outbound' })
    expect(hoisted.promoteEntries).not.toHaveBeenCalled()
  })
})
