import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * GET /api/account/search — the composer menu's search (docs/plans/slash-search.md).
 *
 * What matters: every kind asked for answers in one response, scoped to the
 * caller's workspace and read with the caller's own client (RLS), ranked best
 * first; captures keep the private-to-creator rule explicit; companies go
 * through the RPC with the caller as p_user_id; one kind failing leaves the
 * rest answering.
 */

type Call = { method: string; args: unknown[] }
type Resolver = (table: string, calls: Call[]) => { data: unknown; error: unknown }

const hoisted = vi.hoisted(() => ({
  auth: null as unknown,
  resolve: (() => ({ data: [], error: null })) as Resolver,
  builders: [] as { table: string; calls: Call[] }[],
  rpc: vi.fn(),
  /** The caller's own client's RPCs (team_chat_search, migration 561). */
  userRpc: vi.fn(),
  /** The caller's member row's role (the Studio's guest gate), and the workspace's settings. */
  role: 'member' as string | null,
  settings: {} as Record<string, unknown>,
  /** Tables read through the service client. */
  serviceTables: [] as string[],
}))

function fakeClient(service = false) {
  return {
    rpc: hoisted.userRpc,
    from: (table: string) => {
      if (service) hoisted.serviceTables.push(table)
      const record = { table, calls: [] as Call[] }
      hoisted.builders.push(record)
      const builder: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'neq', 'not', 'is', 'or', 'in', 'ilike', 'textSearch', 'order', 'limit']) {
        builder[m] = (...args: unknown[]) => {
          record.calls.push({ method: m, args })
          return builder
        }
      }
      builder.maybeSingle = async () =>
        table === 'member'
          ? { data: hoisted.role === null ? null : { role: hoisted.role }, error: null }
          : { data: { settings: hoisted.settings }, error: null }
      builder.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
        Promise.resolve(hoisted.resolve(table, record.calls)).then(onFulfilled, onRejected)
      return builder
    },
  }
}

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: vi.fn(async () => hoisted.auth),
}))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({ rpc: hoisted.rpc, from: fakeClient(true).from }),
}))

import { GET } from '@/app/api/account/search/route'
import { forgetStudioMissing, STUDIO_MISSING_RECHECK_MS } from '@/app/api/account/search/menu-queries'

function req(qs: string) {
  return new NextRequest(`http://localhost/api/account/search?${qs}`)
}

const builderFor = (table: string) => hoisted.builders.filter((b) => b.table === table)
const has = (calls: Call[], method: string, ...args: unknown[]) =>
  calls.some((c) => c.method === method && args.every((a, i) => JSON.stringify(c.args[i]) === JSON.stringify(a)))

beforeEach(() => {
  hoisted.builders = []
  hoisted.auth = { supabase: fakeClient(), user: { id: 'user-1' }, workspaceId: 'ws-1' }
  hoisted.resolve = () => ({ data: [], error: null })
  hoisted.rpc.mockReset()
  hoisted.rpc.mockResolvedValue({ data: [], error: null })
  hoisted.userRpc.mockReset()
  hoisted.userRpc.mockResolvedValue({ data: [], error: null })
  hoisted.role = 'member'
  hoisted.settings = {}
  hoisted.serviceTables = []
})

describe('GET /api/account/search', () => {
  it('passes an auth or workspace failure straight through', async () => {
    hoisted.auth = new Response(null, { status: 401 })
    const res = await GET(req('q=x'))
    expect(res.status).toBe(401)
  })

  it('answers every kind by default, and only the kinds asked for (junk dropped)', async () => {
    const all = await (await GET(req('q=pricing'))).json()
    expect(Object.keys(all.results).sort()).toEqual(
      ['action', 'agent', 'capture', 'company', 'contact', 'deal', 'document', 'flow', 'initiative', 'project', 'studio_project', 'studio_video', 'team_chat_message'].sort(),
    )
    const some = await (await GET(req('q=pricing&types=action,claim,document'))).json()
    expect(Object.keys(some.results)).toEqual(['action', 'document'])
  })

  it('finds Studio videos and Studio projects by title for a member, on the service client, never one in the trash', async () => {
    hoisted.resolve = (table) =>
      table === 'studio_video'
        ? { data: [{ id: 'v-1', title: 'Launch teaser', status: 'review' }, { id: 'v-2', title: 'Pricing launch recap', status: 'draft' }], error: null }
        : table === 'studio_project'
          ? { data: [{ id: 'p-1', title: 'Spring launch' }], error: null }
          : { data: [], error: null }
    const res = await (await GET(req('q=launch&types=studio_video,studio_project'))).json()
    expect(res.results.studio_video).toEqual([
      { kind: 'studio_video', id: 'v-1', title: 'Launch teaser', status: 'review', score: 0.85 },
      { kind: 'studio_video', id: 'v-2', title: 'Pricing launch recap', status: 'draft', score: 0.7 },
    ])
    expect(res.results.studio_project).toEqual([{ kind: 'studio_project', id: 'p-1', title: 'Spring launch', status: null, score: 0.7 }])
    // Read on the service client (the Studio's tables have no member policies), fenced to the workspace and the trash.
    expect(hoisted.serviceTables).toEqual(expect.arrayContaining(['member', 'studio_video', 'studio_project']))
    for (const table of ['studio_video', 'studio_project']) {
      const [b] = builderFor(table)
      expect(has(b.calls, 'eq', 'workspace_id', 'ws-1'), table).toBe(true)
      expect(has(b.calls, 'is', 'archived_at', null), table).toBe(true)
      expect(has(b.calls, 'ilike', 'title', '%launch%'), table).toBe(true)
    }
  })

  it('finds nothing in the Studio for a workspace guest, a non-member, or where the studio feature is off', async () => {
    hoisted.resolve = () => ({ data: [{ id: 'v-1', title: 'Launch teaser', status: 'draft' }], error: null })
    for (const role of ['guest', null]) {
      hoisted.role = role
      hoisted.builders = []
      const res = await (await GET(req('q=launch&types=studio_video,studio_project'))).json()
      expect(res.results, String(role)).toEqual({ studio_video: [], studio_project: [] })
      expect(builderFor('studio_video'), String(role)).toHaveLength(0)
    }
    hoisted.role = 'member'
    hoisted.builders = []
    hoisted.settings = { feature_overrides: { studio: 'off' } }
    const off = await (await GET(req('q=launch&types=studio_video'))).json()
    expect(off.results).toEqual({ studio_video: [] })
    expect(builderFor('studio_video')).toHaveLength(0)
  })

  it('answers the Studio kinds empty without a log line where the Studio’s tables are not in the database, and looks again a minute later', async () => {
    forgetStudioMissing()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    hoisted.resolve = (table) =>
      table.startsWith('studio_') ? { data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` } } : { data: [], error: null }
    const first = await (await GET(req('q=launch&types=studio_video,studio_project,document'))).json()
    expect(first.results).toEqual({ studio_video: [], studio_project: [], document: [] })
    expect(logged).not.toHaveBeenCalled()
    // Remembered: the next searches do not ask.
    hoisted.builders = []
    await GET(req('q=launch&types=studio_video'))
    expect(builderFor('studio_video')).toHaveLength(0)
    // A minute on (the migration may be applied by then), it asks again, and finds.
    const later = Date.now() + STUDIO_MISSING_RECHECK_MS + 1
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later)
    hoisted.resolve = () => ({ data: [{ id: 'v-1', title: 'Launch teaser', status: 'draft' }], error: null })
    const healed = await (await GET(req('q=launch&types=studio_video'))).json()
    expect(healed.results.studio_video).toMatchObject([{ id: 'v-1', title: 'Launch teaser' }])
    clock.mockRestore()
    logged.mockRestore()
  })

  it('finds team chat messages through team_chat_search as the caller (the function fences what they may read), each opening team chat on it', async () => {
    hoisted.userRpc.mockResolvedValue({
      data: [{ id: 'm-1', channel_id: 'ch-1', thread_root_id: null, place: '#launch', author_name: 'Ben Ortiz', snippet: 'the  launch\nplan', created_at: '2026-11-10T10:00:00Z' }],
      error: null,
    })
    const res = await (await GET(req('q=launch%20plan&types=team_chat_message'))).json()
    expect(hoisted.userRpc).toHaveBeenCalledWith('team_chat_search', { ws: 'ws-1', q: 'launch plan', lim: 8 })
    // Never the service client: the caller's own may only find what they may read.
    expect(hoisted.rpc).not.toHaveBeenCalled()
    expect(res.results.team_chat_message).toEqual([
      { kind: 'team_chat_message', id: 'm-1', title: 'the launch plan', place: '#launch', author: 'Ben Ortiz', channelId: 'ch-1', threadRootId: null, createdAt: '2026-11-10T10:00:00Z', score: 0.3 },
    ])
    // Nothing typed (or one letter): no search at all.
    hoisted.userRpc.mockClear()
    await GET(req('q=&types=team_chat_message'))
    await GET(req('q=l&types=team_chat_message'))
    expect(hoisted.userRpc).not.toHaveBeenCalled()
  })

  it('scopes every table read to the caller workspace', async () => {
    await GET(req('q=pricing&types=action,document,project,initiative,capture,contact'))
    for (const table of ['actions', 'document', 'projects', 'initiative', 'captures', 'contact']) {
      const reads = builderFor(table)
      expect(reads.length).toBeGreaterThan(0)
      for (const b of reads) expect(has(b.calls, 'eq', 'workspace_id', 'ws-1')).toBe(true)
    }
  })

  it('never lists the person’s Now file (kind now, migration 440), with a query or without', async () => {
    for (const q of ['q=pricing&types=document', 'q=&types=document']) {
      hoisted.builders.length = 0
      await GET(req(q))
      const reads = builderFor('document')
      expect(reads.length).toBeGreaterThan(0)
      for (const b of reads) expect(has(b.calls, 'neq', 'kind', 'now')).toBe(true)
    }
  })

  it('matches each typed word in names, and bodies by full text', async () => {
    await GET(req('q=pricing%20acme&types=action'))
    const [title, body] = builderFor('actions')
    expect(has(title.calls, 'ilike', 'title', '%pricing%')).toBe(true)
    expect(has(title.calls, 'ilike', 'title', '%acme%')).toBe(true)
    expect(has(title.calls, 'not', 'is_dismissed', 'is', true)).toBe(true)
    expect(body.calls.some((c) => c.method === 'textSearch' && c.args[0] === 'fts')).toBe(true)
  })

  it('takes PostgREST grammar out of what is typed', async () => {
    await GET(req(`q=${encodeURIComponent('maya,(chen)')}&types=contact`))
    const [contact] = builderFor('contact')
    const ors = contact.calls.filter((c) => c.method === 'or').map((c) => String(c.args[0]))
    expect(ors).toEqual(['full_name.ilike.%maya%,email.ilike.%maya%', 'full_name.ilike.%chen%,email.ilike.%chen%'])
    expect(has(contact.calls, 'is', 'merged_into_contact_id', null)).toBe(true)
  })

  it('ranks the best title first and finds an action by its identifier', async () => {
    hoisted.resolve = (table, calls) => {
      if (table !== 'actions') return { data: [], error: null }
      if (calls.some((c) => c.method === 'or')) {
        return { data: [{ id: 'a42', title: 'Something else', identifier: 'GEN-42', previous_identifier: null, workflow_state: { name: 'Todo' } }], error: null }
      }
      return { data: [], error: null }
    }
    const byId = await (await GET(req('q=GEN-42&types=action'))).json()
    expect(byId.results.action[0]).toMatchObject({ id: 'a42', identifier: 'GEN-42', status: 'Todo' })
    expect(byId.results.action[0].score).toBeGreaterThan(1)

    hoisted.resolve = (table, calls) =>
      table === 'actions' && calls.some((c) => c.method === 'ilike')
        ? {
            data: [
              { id: 'a1', title: 'Send pricing to Acme', identifier: 'GEN-1', previous_identifier: null, workflow_state: null },
              { id: 'a2', title: 'Pricing', identifier: 'GEN-2', previous_identifier: null, workflow_state: null },
            ],
            error: null,
          }
        : { data: [], error: null }
    const byTitle = await (await GET(req('q=pricing&types=action'))).json()
    expect(byTitle.results.action.map((r: { id: string }) => r.id)).toEqual(['a2', 'a1'])
  })

  it('keeps private captures to their creator, and lists your own recent ones with nothing typed', async () => {
    await GET(req('q=pricing&types=capture'))
    for (const b of builderFor('captures')) {
      expect(has(b.calls, 'or', 'visibility.eq.workspace,user_id.eq.user-1')).toBe(true)
      expect(has(b.calls, 'neq', 'is_eval', true)).toBe(true)
    }
    hoisted.builders = []
    await GET(req('q=&types=capture'))
    const [recent] = builderFor('captures')
    expect(has(recent.calls, 'eq', 'user_id', 'user-1')).toBe(true)
    expect(recent.calls.some((c) => c.method === 'ilike')).toBe(false)
  })

  it('reads companies through the RPC with the caller as the requester', async () => {
    hoisted.rpc.mockResolvedValue({
      data: [{ id: 'co1', name: 'Acme', domain: 'acme.com', logo_url: null, industry: null, contact_count: 2 }],
      error: null,
    })
    const body = await (await GET(req('q=acme&types=company'))).json()
    expect(hoisted.rpc).toHaveBeenCalledWith(
      'list_companies_with_stats',
      expect.objectContaining({ p_workspace_id: 'ws-1', p_user_id: 'user-1', p_search: 'acme' }),
    )
    expect(body.results.company[0]).toMatchObject({ kind: 'company', company: { id: 'co1', name: 'Acme', contact_count: 2 } })
  })

  it('answers the other kinds when one fails', async () => {
    hoisted.resolve = (table) =>
      table === 'actions'
        ? { data: null, error: { message: 'boom' } }
        : table === 'document'
          ? { data: [{ id: 'd1', title: 'Pricing v3', updated_at: null }], error: null }
          : { data: [], error: null }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await GET(req('q=pricing&types=action,document'))
    spy.mockRestore()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results.action).toEqual([])
    expect(body.results.document[0]).toMatchObject({ kind: 'document', id: 'd1', title: 'Pricing v3' })
  })

  it('caps the rows per kind', async () => {
    await GET(req('q=&types=project&limit=500'))
    const [project] = builderFor('projects')
    expect(has(project.calls, 'limit', 25)).toBe(true)
  })
})
