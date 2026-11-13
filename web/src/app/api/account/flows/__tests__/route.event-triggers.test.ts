/**
 * The REST routes build the owner's event triggers and the newer schedule
 * cadences through the same validators as chat's create_flow: a chat loop on
 * any channel only with mentions-only, on a named channel only when its owner
 * can read it (the owner, not whoever saves), a custom schedule held to every
 * 15 minutes, a one-time run never in the past (its stored time re-saved from
 * the editor is fine). A one-time loop's switch follows its time: a new time
 * ahead re-arms it, a passed time leaves it off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'

type Row = Record<string, unknown>
const db: { flow: Row[]; team: Row[]; updates: Row[]; inserts: Row[] } = { flow: [], team: [], updates: [], inserts: [] }

/** A tiny row-store double for the user client: eq filters, select/insert/update. */
function client() {
  return {
    from: (table: 'flow' | 'team') => {
      const preds: Array<(r: Row) => boolean> = []
      let mode: 'select' | 'update' | 'insert' = 'select'
      let payload: Row = {}
      const rows = () => (db[table] as Row[]).filter((r) => preds.every((p) => p(r)))
      const c: Record<string, unknown> = {}
      c.select = () => c
      c.eq = (col: string, v: unknown) => (preds.push((r) => r[col] === v), c)
      c.in = (col: string, vs: unknown[]) => (preds.push((r) => vs.includes(r[col])), c)
      c.or = () => c
      c.order = () => c
      c.update = (p: Row) => ((mode = 'update'), (payload = p), c)
      c.insert = (p: Row) => ((mode = 'insert'), (payload = p), c)
      const run = () => {
        if (mode === 'insert') {
          const row = { id: 'new-flow', ...payload }
          db.inserts.push(row)
          return row
        }
        if (mode === 'update') {
          db.updates.push(payload)
          const r = rows()[0]
          if (r) Object.assign(r, payload)
          return r ?? null
        }
        return rows()[0] ?? null
      }
      c.maybeSingle = async () => ({ data: run(), error: null })
      c.single = async () => {
        const data = run()
        return { data, error: data ? null : { message: 'no rows' } }
      }
      c.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve)
      return c
    },
  }
}

const auth = vi.hoisted(() => ({ userId: 'user-1' }))
const readable = vi.hoisted(() => ({ byUser: {} as Record<string, string[]> }))
vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: async () => ({ supabase: client(), user: { id: auth.userId }, workspaceId: 'ws-1' }),
}))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/knowledge/entity-fences', async (orig) => ({
  ...(await orig<typeof import('@/lib/knowledge/entity-fences')>()),
  visiblePrivateKindIds: async (_s: unknown, _kind: string, userId: string, ids: string[]) => new Set(ids.filter((id) => (readable.byUser[userId] ?? []).includes(id))),
}))
vi.mock('@/lib/posthog', () => ({ trackServerEvent: vi.fn() }))
vi.mock('@/lib/flows/flow-approvals', async (orig) => ({
  ...(await orig<typeof import('@/lib/flows/flow-approvals')>()),
  flowOwnership: async () => ({}),
}))
vi.mock('@/lib/crypto/credentials', () => ({ encryptCredentialOrNull: () => null }))
vi.mock('@/lib/flows/flow-bot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/flows/flow-bot')>()),
  defaultFlowBot: async () => ({ teammateId: 'bot-1', created: false }),
}))

const { GET: LIST, POST } = await import('../route')
const { GET, PATCH } = await import('../[id]/route')

const CH = '55555555-5555-4555-8555-555555555555'
const CH_OTHER = '66666666-6666-4666-8666-666666666666'
const req = (body: unknown) => new Request('http://localhost/api/account/flows', { method: 'POST', body: JSON.stringify(body) }) as unknown as NextRequest
const params = { params: Promise.resolve({ id: 'flow-1' }) }
const hook = { type: 'http_post', config: { method: 'POST', url: 'https://example.com/hook', headers: {}, body_template: '' } }
const NOW = new Date('2026-11-16T15:00:00Z')
const tz = 'America/New_York'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  db.flow = []
  db.team = []
  db.updates = []
  db.inserts = []
  auth.userId = 'user-1'
  readable.byUser = { 'user-1': [CH], 'user-2': [CH, CH_OTHER] }
})
afterEach(() => {
  vi.useRealTimers()
})

describe('POST /api/account/flows — the new triggers', () => {
  it('builds each owner event trigger, workspace-scoped with no clock', async () => {
    for (const [trigger_type, trigger_config, stored] of [
      ['email_received', { from: '@Acme.example' }, { kind: 'email_received', from: 'acme.example' }],
      ['chat_message', { channel_id: CH }, { kind: 'chat_message', channel_id: CH, mentions_only: false }],
      ['chat_message', { channel_id: null, mentions_only: true }, { kind: 'chat_message', channel_id: null, mentions_only: true }],
      ['document_created', {}, { kind: 'document_created' }],
    ] as const) {
      const res = await POST(req({ name: 'X', trigger_type, trigger_config, actions: [hook] }))
      expect(res.status).toBe(201)
      expect(db.inserts.at(-1)).toMatchObject({ trigger_type, trigger_config: stored, team_id: null, next_run_at: null })
    }
  })

  it('refuses a chat loop on every channel without mentions-only, or on a channel the owner cannot read', async () => {
    const all = await POST(req({ name: 'X', trigger_type: 'chat_message', trigger_config: { channel_id: null, mentions_only: false }, actions: [hook] }))
    expect(all.status).toBe(400)
    expect((await all.json()).error).toMatch(/channel_id is required unless mentions_only/)
    const hidden = await POST(req({ name: 'X', trigger_type: 'chat_message', trigger_config: { channel_id: CH_OTHER }, actions: [hook] }))
    expect(hidden.status).toBe(400)
    expect((await hidden.json()).error).toMatch(/owner can read/)
    expect(db.inserts).toEqual([])
  })

  it('schedules: monthly, custom and once; refuses a too-frequent custom one and a past one-time run', async () => {
    expect((await POST(req({ name: 'M', trigger_type: 'schedule', trigger_config: { cadence: 'monthly', day_of_month: 15, time: '09:00', timezone: tz }, actions: [hook] }))).status).toBe(201)
    expect(db.inserts.at(-1)?.next_run_at).toBe('2026-12-15T14:00:00.000Z')
    expect((await POST(req({ name: 'C', trigger_type: 'schedule', trigger_config: { cadence: 'cron', cron: '0 9 * * 1-5', timezone: tz }, actions: [hook] }))).status).toBe(201)
    expect(db.inserts.at(-1)?.next_run_at).toBe('2026-11-17T14:00:00.000Z')
    expect((await POST(req({ name: 'O', trigger_type: 'schedule', trigger_config: { cadence: 'once', run_at: '2026-11-18T10:00', timezone: tz }, actions: [hook] }))).status).toBe(201)
    expect(db.inserts.at(-1)?.next_run_at).toBe('2026-11-18T15:00:00.000Z')

    const often = await POST(req({ name: 'X', trigger_type: 'schedule', trigger_config: { cadence: 'cron', cron: '*/10 * * * *', timezone: tz }, actions: [hook] }))
    expect(often.status).toBe(400)
    const past = await POST(req({ name: 'X', trigger_type: 'schedule', trigger_config: { cadence: 'once', run_at: '2026-11-15T10:00', timezone: tz }, actions: [hook] }))
    expect(past.status).toBe(400)
    expect((await past.json()).error).toMatch(/run_at is in the past/)
  })
})

describe('PATCH /api/account/flows/[id] — the new triggers', () => {
  const onceFlow = (over: Row = {}) => ({
    id: 'flow-1',
    workspace_id: 'ws-1',
    team_id: null,
    name: 'Once',
    enabled: false,
    trigger_type: 'schedule',
    trigger_config: { kind: 'schedule', cadence: 'once', run_at: '2026-11-10T09:00', timezone: tz },
    actions: [{ id: 'a-1', ...hook, condition: null, parent_id: null, enabled: true }],
    created_by: 'user-2',
    next_run_at: null,
    ...over,
  })

  it('the editor re-saving a finished one-time loop (its stored time, unchanged) is fine; a new past time is refused', async () => {
    auth.userId = 'user-2'
    db.flow = [onceFlow()]
    const same = await PATCH(req({ name: 'Renamed', trigger_type: 'schedule', trigger_config: { cadence: 'once', run_at: '2026-11-10T09:00', timezone: tz } }), params)
    expect(same.status).toBe(200)
    const moved = await PATCH(req({ trigger_type: 'schedule', trigger_config: { cadence: 'once', run_at: '2026-11-12T09:00', timezone: tz } }), params)
    expect(moved.status).toBe(400)
  })

  it('switching on a finished one-time loop leaves it off, with next_run_at NULL', async () => {
    auth.userId = 'user-2'
    db.flow = [onceFlow()]
    const res = await PATCH(req({ enabled: true }), params)
    expect(res.status).toBe(200)
    expect(db.updates.at(-1)).toMatchObject({ enabled: false, next_run_at: null })
    expect((await res.json()).flow).toMatchObject({ enabled: false })
  })

  it('saving a NEW time ahead re-arms a finished one-time loop: on, due then (whatever enabled the editor sent)', async () => {
    auth.userId = 'user-2'
    for (const sent of [undefined, false, true]) {
      db.flow = [onceFlow()]
      const res = await PATCH(req({ ...(sent === undefined ? {} : { enabled: sent }), trigger_type: 'schedule', trigger_config: { cadence: 'once', run_at: '2026-11-18T10:00', timezone: tz } }), params)
      expect(res.status).toBe(200)
      expect(db.updates.at(-1)).toMatchObject({ enabled: true, next_run_at: '2026-11-18T15:00:00.000Z' })
      expect((await res.json()).flow).toMatchObject({ enabled: true })
    }
  })

  it('a stale editor re-sending enabled: true with the passed time leaves the loop finished: off, no next run', async () => {
    auth.userId = 'user-2'
    db.flow = [onceFlow({ enabled: true, next_run_at: '2026-11-10T14:00:00.000Z' })]
    const res = await PATCH(req({ enabled: true, trigger_type: 'schedule', trigger_config: { cadence: 'once', run_at: '2026-11-10T09:00', timezone: tz } }), params)
    expect(res.status).toBe(200)
    expect(db.updates.at(-1)).toMatchObject({ enabled: false, next_run_at: null })
  })

  it('the saved time, still ahead, keeps the switch as sent (switching it off sticks)', async () => {
    auth.userId = 'user-2'
    db.flow = [onceFlow({ enabled: true, trigger_config: { kind: 'schedule', cadence: 'once', run_at: '2026-11-18T10:00', timezone: tz }, next_run_at: '2026-11-18T15:00:00.000Z' })]
    const res = await PATCH(req({ enabled: false, trigger_type: 'schedule', trigger_config: { cadence: 'once', run_at: '2026-11-18T10:00', timezone: tz } }), params)
    expect(res.status).toBe(200)
    expect(db.updates.at(-1)).toMatchObject({ enabled: false, next_run_at: '2026-11-18T15:00:00.000Z' })
  })

  it("a chat channel is checked against the loop OWNER's access", async () => {
    auth.userId = 'user-2'
    db.flow = [onceFlow({ created_by: 'user-2' })]
    expect((await PATCH(req({ trigger_type: 'chat_message', trigger_config: { channel_id: CH_OTHER } }), params)).status).toBe(200)
    // Owned by user-1, who can't read CH_OTHER: refused even though it is user-1 saving.
    auth.userId = 'user-1'
    db.flow = [onceFlow({ created_by: 'user-1' })]
    const res = await PATCH(req({ trigger_type: 'chat_message', trigger_config: { channel_id: CH_OTHER } }), params)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/owner can read/)
  })
})

describe("GET /api/account/flows (and [id]): another member's mail and chat loops", () => {
  const row = (id: string, trigger_type: string, trigger_config: Row) => ({
    id, workspace_id: 'ws-1', team_id: null, name: id, enabled: true, trigger_type, trigger_config, actions: [], created_by: 'user-2', created_at: 'x', updated_at: 'x',
  })
  beforeEach(() => {
    db.flow = [
      row('flow-1', 'email_received', { kind: 'email_received', from: 'billing@vendor.example' }),
      row('flow-2', 'chat_message', { kind: 'chat_message', channel_id: CH, mentions_only: true }),
      row('flow-3', 'schedule', { kind: 'schedule', cadence: 'daily', time: '09:00', timezone: tz }),
    ]
  })

  it('a non-owner reads them without the sender filter or the channel; a schedule as stored', async () => {
    auth.userId = 'user-1'
    const body = (await (await LIST(req({}))).json()) as { flows: Array<{ id: string; trigger_config: Row }> }
    const by = new Map(body.flows.map((f) => [f.id, f.trigger_config]))
    expect(by.get('flow-1')).toEqual({ kind: 'email_received', owner_only: true })
    expect(by.get('flow-2')).toEqual({ kind: 'chat_message', mentions_only: true, channel: 'a channel', owner_only: true })
    expect(by.get('flow-3')).toEqual(db.flow[2].trigger_config)
    expect(JSON.stringify(body)).not.toContain('vendor.example')
    expect(JSON.stringify(body)).not.toContain(CH)
    const one = (await (await GET(req({}), params)).json()) as { flow: { trigger_config: Row } }
    expect(one.flow.trigger_config).toEqual({ kind: 'email_received', owner_only: true })
  })

  it('a non-owner renaming it gets the redacted row back too', async () => {
    auth.userId = 'user-1'
    const res = await PATCH(req({ name: 'Renamed' }), params)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { flow: { trigger_config: Row } }).flow.trigger_config).toEqual({ kind: 'email_received', owner_only: true })
  })

  it('the owner reads them as stored', async () => {
    auth.userId = 'user-2'
    const body = (await (await LIST(req({}))).json()) as { flows: Array<{ id: string; trigger_config: Row }> }
    expect(body.flows.find((f) => f.id === 'flow-1')?.trigger_config).toEqual(db.flow[0].trigger_config)
  })
})
