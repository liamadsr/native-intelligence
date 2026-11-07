import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createCampaignTools } from '@/lib/ai/tools/campaigns'

/**
 * The campaign agent tools (src/lib/ai/tools/campaigns.ts).
 *
 * What is worth locking here is not "does insert call insert" but the three
 * properties the tool surface promises:
 *   - every read and write is fenced to the caller's workspace;
 *   - update is PARTIAL — a field you did not pass is never written, so a
 *     one-field edit cannot blank the rest of the row;
 *   - there is no delete (a campaign is an anchor other records point at).
 *
 * Supabase goes through a recording fake — same shape as sequences.test.ts.
 */

interface Captured {
  table: string
  op: 'select' | 'insert' | 'update' | 'delete'
  payload?: unknown
  filters: Array<{ method: string; args: unknown[] }>
}

interface FakeResult {
  data?: unknown
  error?: { message: string; code?: string } | null
}

function makeFakeSupabase(handler: (q: Captured) => FakeResult) {
  const queries: Captured[] = []
  function from(table: string) {
    const q: Captured = { table, op: 'select', filters: [] }
    queries.push(q)
    const b: Record<string, unknown> = {}
    const chain =
      (name: string) =>
      (...args: unknown[]) => {
        q.filters.push({ method: name, args })
        return b
      }
    Object.assign(b, {
      select: chain('select'),
      insert: (payload: unknown) => {
        q.op = 'insert'
        q.payload = payload
        return b
      },
      update: (payload: unknown) => {
        q.op = 'update'
        q.payload = payload
        return b
      },
      delete: () => {
        q.op = 'delete'
        return b
      },
      eq: chain('eq'),
      ilike: chain('ilike'),
      in: chain('in'),
      order: chain('order'),
      range: chain('range'),
      maybeSingle: async () => ({ error: null, data: null, ...handler(q) }),
      single: async () => ({ error: null, data: null, ...handler(q) }),
      then: (
        onFulfilled: (v: FakeResult) => unknown,
        onRejected?: (e: unknown) => unknown,
      ) =>
        Promise.resolve({ error: null, data: null, ...handler(q) }).then(
          onFulfilled,
          onRejected,
        ),
    })
    return b
  }
  return { client: { from } as unknown as SupabaseClient, queries }
}

/** Every query throws — for paths that must fail BEFORE any DB access. */
const throwingClient = {
  from() {
    throw new Error('validation must reject before any DB access')
  },
} as unknown as SupabaseClient

const ROW = {
  id: 'camp-1',
  name: 'Spring Launch',
  objective: 'Drive 200 demos',
  description: null,
  status: 'planned',
  channels: ['email'],
  starts_on: null,
  ends_on: null,
  owner_member_id: null,
  tags: [],
  metadata: {},
  created_at: '2026-03-01T00:00:00Z',
  updated_at: '2026-03-01T00:00:00Z',
}

const filterArgs = (q: Captured, method: string) =>
  q.filters.filter((f) => f.method === method).map((f) => f.args)

describe('campaign tool set', () => {
  it('exposes exactly list / create / update / launch — and no delete', () => {
    const tools = createCampaignTools(throwingClient, 'ws-1')
    expect(Object.keys(tools).sort()).toEqual([
      'create_campaign',
      'launch_campaign',
      'list_campaigns',
      'update_campaign',
    ])
    // A campaign is a knowledge ANCHOR: deleting one orphans the claims and
    // links that point at it, so retiring is `status: 'archived'` instead.
    for (const name of Object.keys(tools)) expect(name).not.toMatch(/delete|remove|archive/)
  })
})

describe('list_campaigns', () => {
  it('fences the query to the caller workspace and pages', async () => {
    const { client, queries } = makeFakeSupabase(() => ({ data: [ROW] }))
    const res = await createCampaignTools(client, 'ws-1').list_campaigns.execute!(
      { limit: 10, offset: 20 },
      {} as never,
    )
    expect(res).toMatchObject({ success: true, count: 1 })

    const q = queries[0]
    expect(q.table).toBe('campaign')
    expect(filterArgs(q, 'eq')).toContainEqual(['workspace_id', 'ws-1'])
    expect(filterArgs(q, 'range')).toEqual([[20, 29]])
  })

  it('caps the page size at 200 however big the model asks', async () => {
    const { client, queries } = makeFakeSupabase(() => ({ data: [] }))
    await createCampaignTools(client, 'ws-1').list_campaigns.execute!(
      { limit: 5000 },
      {} as never,
    )
    expect(filterArgs(queries[0], 'range')).toEqual([[0, 199]])
  })

  it('filters by status only when one is given', async () => {
    const { client, queries } = makeFakeSupabase(() => ({ data: [] }))
    const tools = createCampaignTools(client, 'ws-1')
    await tools.list_campaigns.execute!({ status: 'active', limit: 50 }, {} as never)
    expect(filterArgs(queries[0], 'eq')).toContainEqual(['status', 'active'])

    await tools.list_campaigns.execute!({ limit: 50 }, {} as never)
    expect(filterArgs(queries[1], 'eq').map((a) => a[0])).not.toContain('status')
  })

  it('escapes LIKE metacharacters so "50%" is a literal search', async () => {
    const { client, queries } = makeFakeSupabase(() => ({ data: [] }))
    await createCampaignTools(client, 'ws-1').list_campaigns.execute!(
      { search: '50% off', limit: 50 },
      {} as never,
    )
    expect(filterArgs(queries[0], 'ilike')).toEqual([['name', '%50\\% off%']])
  })

  it('surfaces a query error rather than pretending the list is empty', async () => {
    const { client } = makeFakeSupabase(() => ({ error: { message: 'boom' } }))
    const res = await createCampaignTools(client, 'ws-1').list_campaigns.execute!(
      { limit: 50 },
      {} as never,
    )
    expect(res).toMatchObject({ success: false, error: 'boom' })
  })
})

describe('create_campaign', () => {
  it('stamps the workspace and defaults status to planned', async () => {
    const { client, queries } = makeFakeSupabase(() => ({ data: ROW }))
    const res = await createCampaignTools(client, 'ws-1').create_campaign.execute!(
      { name: '  Spring Launch  ', objective: 'Drive 200 demos' },
      {} as never,
    )
    expect(res).toMatchObject({ success: true })

    const payload = queries[0].payload as Record<string, unknown>
    expect(payload.workspace_id).toBe('ws-1')
    expect(payload.name).toBe('Spring Launch')
    expect(payload.status).toBe('planned')
    // Absent optionals become explicit empties/nulls, never `undefined`.
    expect(payload.channels).toEqual([])
    expect(payload.tags).toEqual([])
    expect(payload.starts_on).toBeNull()
    expect(payload.owner_member_id).toBeNull()
  })

  it('honours an explicit status', async () => {
    const { client, queries } = makeFakeSupabase(() => ({ data: ROW }))
    await createCampaignTools(client, 'ws-1').create_campaign.execute!(
      { name: 'Q3', status: 'active' },
      {} as never,
    )
    expect((queries[0].payload as Record<string, unknown>).status).toBe('active')
  })

  it('surfaces an insert error', async () => {
    const { client } = makeFakeSupabase(() => ({ error: { message: 'nope' } }))
    const res = await createCampaignTools(client, 'ws-1').create_campaign.execute!(
      { name: 'Q3' },
      {} as never,
    )
    expect(res).toMatchObject({ success: false, error: 'nope' })
  })
})

describe('update_campaign', () => {
  it('refuses an empty patch before touching the DB', async () => {
    const res = await createCampaignTools(throwingClient, 'ws-1').update_campaign.execute!(
      { campaign_id: 'camp-1' },
      {} as never,
    )
    expect(res).toMatchObject({ success: false, error: 'Pass at least one field to change' })
  })

  it('writes ONLY the fields passed — a partial edit never blanks the rest', async () => {
    const { client, queries } = makeFakeSupabase(() => ({ data: ROW }))
    const res = await createCampaignTools(client, 'ws-1').update_campaign.execute!(
      { campaign_id: 'camp-1', status: 'paused' },
      {} as never,
    )
    // queries[0] is the workspace-routing resolve (resolveEntityWorkspace's
    // fast-path SELECT); the update itself is queries[1] — see
    // routing.campaigns.test.ts for the routing behavior itself.
    const payload = queries[1].payload as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual(['status', 'updated_at'])
    expect(res).toMatchObject({ success: true, updated_fields: ['status'] })
  })

  it('fences the update to the id AND the workspace', async () => {
    const { client, queries } = makeFakeSupabase(() => ({ data: ROW }))
    await createCampaignTools(client, 'ws-1').update_campaign.execute!(
      { campaign_id: 'camp-1', name: 'Renamed' },
      {} as never,
    )
    const eqs = filterArgs(queries[1], 'eq')
    expect(eqs).toContainEqual(['id', 'camp-1'])
    expect(eqs).toContainEqual(['workspace_id', 'ws-1'])
  })

  it("reports not-found rather than success when the row isn't the caller's", async () => {
    // RLS + the workspace fence make "someone else's campaign" and "no such
    // campaign" the same zero-row answer, which is the right one to give.
    const { client } = makeFakeSupabase(() => ({ data: null }))
    const res = await createCampaignTools(client, 'ws-1').update_campaign.execute!(
      { campaign_id: 'other-ws-campaign', name: 'Renamed' },
      {} as never,
    )
    expect(res).toMatchObject({ success: false, error: 'Campaign not found' })
  })

  it('trims strings and clears one emptied to whitespace', async () => {
    const { client, queries } = makeFakeSupabase(() => ({ data: ROW }))
    await createCampaignTools(client, 'ws-1').update_campaign.execute!(
      { campaign_id: 'camp-1', objective: '   ' },
      {} as never,
    )
    expect((queries[1].payload as Record<string, unknown>).objective).toBeNull()
  })
})
