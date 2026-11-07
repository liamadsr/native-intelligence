/**
 * The trigger/action cross-check on the REST routes (A1b review L3): an
 * archive_capture needs a capture_processed trigger, through the shared
 * findTriggerActionMismatch that chat's create_flow / update_flow call too.
 * POST checks the new flow; PATCH checks the EFFECTIVE trigger against the
 * EFFECTIVE actions whichever side the write changes, and leaves writes that
 * touch neither alone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: async () => ({ supabase: client(), user: { id: 'user-1' }, workspaceId: 'ws-1' }),
}))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/posthog', () => ({ trackServerEvent: vi.fn() }))
vi.mock('@/lib/crypto/credentials', () => ({ encryptCredentialOrNull: () => null }))
vi.mock('@/lib/flows/flow-bot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/flows/flow-bot')>()),
  defaultFlowBot: async () => ({ teammateId: 'bot-1', created: false }),
}))

const { POST } = await import('../route')
const { PATCH } = await import('../[id]/route')

const req = (body: unknown) => new Request('http://localhost/api/account/flows', { method: 'POST', body: JSON.stringify(body) }) as unknown as NextRequest
const params = { params: Promise.resolve({ id: 'flow-1' }) }
const archive = { type: 'archive_capture', config: {} }
const hook = { type: 'http_post', config: { method: 'POST', url: 'https://example.com/hook', headers: {}, body_template: '' } }
const scheduleCfg = { cadence: 'daily', time: '09:00', timezone: 'America/New_York' }

beforeEach(() => {
  db.flow = []
  db.team = [{ id: 'team-1', workspace_id: 'ws-1' }]
  db.updates = []
  db.inserts = []
})

describe('POST /api/account/flows — archive_capture needs a capture trigger', () => {
  it('refuses an archive_capture on a schedule, naming the action', async () => {
    const res = await POST(req({ name: 'X', trigger_type: 'schedule', trigger_config: scheduleCfg, actions: [hook, archive] }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe(
      'action 2: archive_capture archives the capture that fired the flow, so it needs a capture_processed trigger',
    )
    expect(db.inserts).toEqual([])
  })

  it('creates it on a capture_processed trigger', async () => {
    const res = await POST(req({ name: 'Tidy', trigger_type: 'capture_processed', trigger_config: {}, actions: [archive] }))
    expect(res.status).toBe(201)
    expect(db.inserts).toHaveLength(1)
  })
})

describe('PATCH /api/account/flows/[id] — the effective trigger against the effective actions', () => {
  const captureFlow = (over: Row = {}) => ({
    id: 'flow-1',
    workspace_id: 'ws-1',
    team_id: null,
    name: 'Tidy',
    enabled: false,
    trigger_type: 'capture_processed',
    trigger_config: { kind: 'capture_processed' },
    actions: [{ id: 'a-1', ...archive, condition: null, parent_id: null, enabled: true }],
    // The caller owns it: only an owner changes a loop's trigger or steps (F1).
    created_by: 'user-1',
    ...over,
  })

  it('refuses a trigger change away from capture_processed while an archive_capture stays', async () => {
    db.flow = [captureFlow()]
    const res = await PATCH(req({ trigger_type: 'schedule', trigger_config: scheduleCfg }), params)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/^action 1: archive_capture .* capture_processed trigger$/)
    expect(db.updates).toEqual([])
  })

  it('refuses actions that add an archive_capture to a schedule flow', async () => {
    db.flow = [captureFlow({ trigger_type: 'schedule', trigger_config: { kind: 'schedule', ...scheduleCfg }, actions: [hook] })]
    const res = await PATCH(req({ actions: [hook, archive] }), params)
    expect(res.status).toBe(400)
    expect(db.updates).toEqual([])
  })

  it('allows the trigger change together with actions that drop it', async () => {
    db.flow = [captureFlow()]
    const res = await PATCH(req({ trigger_type: 'schedule', trigger_config: scheduleCfg, actions: [hook] }), params)
    expect(res.status).toBe(200)
    expect(db.updates).toHaveLength(1)
  })

  it('never refuses a write that touches neither side (a rename, on/off), even on a flow saved before the rule', async () => {
    db.flow = [captureFlow({ trigger_type: 'schedule', trigger_config: { kind: 'schedule', ...scheduleCfg } })]
    const res = await PATCH(req({ name: 'Renamed' }), params)
    expect(res.status).toBe(200)
    expect(db.updates).toEqual([{ name: 'Renamed' }])
  })
})
