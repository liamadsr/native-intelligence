/**
 * The canvas editor matches chat on ownership (F1, Liam 2026-10-19): the UI
 * PATCH no longer re-stamps created_by, only the owner changes a loop's
 * trigger or steps (NOT_FLOW_OWNER), a non-owner may still rename it, change
 * its agent or switch it off, and a non-owner switching a RISKY loop on gets
 * it saved off with the owner's switch-on card (through update_flow).
 * GET tells the editor who owns it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'

type Row = Record<string, unknown>
const db: { flow: Row[]; member: Row[]; tool_approval: Row[]; updates: Row[] } = { flow: [], member: [], tool_approval: [], updates: [] }
const viewer = vi.hoisted(() => ({ id: 'user-1' }))
const tool = vi.hoisted(() => ({ calls: [] as Array<{ user: string; input: Row }> }))

function client() {
  return {
    from: (table: keyof typeof db) => {
      const preds: Array<(r: Row) => boolean> = []
      let mode: 'select' | 'update' = 'select'
      let payload: Row = {}
      const rows = () => ((db[table] ?? []) as Row[]).filter((r) => preds.every((p) => p(r)))
      const c: Record<string, unknown> = {}
      for (const m of ['select', 'or', 'order', 'gt', 'limit', 'contains', 'in']) c[m] = () => c
      c.eq = (col: string, v: unknown) => (preds.push((r) => r[col] === v), c)
      c.update = (p: Row) => ((mode = 'update'), (payload = p), c)
      const run = () => {
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
  requireWorkspaceMember: async () => ({ supabase: client(), user: { id: viewer.id }, workspaceId: 'ws-1' }),
}))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => client() }))
vi.mock('@/lib/crypto/credentials', () => ({ encryptCredentialOrNull: () => null }))
vi.mock('@/lib/ai/tools/flows', () => ({
  createFlowTools: (user: string) => ({
    update_flow: {
      execute: async (input: Row) => {
        tool.calls.push({ user, input })
        return { awaiting_approval: true, card_for: 'Liam' }
      },
    },
  }),
}))

const { GET, PATCH } = await import('../[id]/route')

const req = (body: unknown) => new Request('http://localhost/api/account/flows/flow-1', { method: 'PATCH', body: JSON.stringify(body) }) as unknown as NextRequest
const params = { params: Promise.resolve({ id: 'flow-1' }) }
const hook = { id: 'h-1', type: 'http_post', config: { method: 'POST', url: 'https://example.com/hook', headers: {}, body_template: '' }, condition: null, parent_id: null, enabled: true }
const skill = { id: 's-1', type: 'run_skill', config: { skill_id: '11111111-1111-4111-8111-111111111111', mode: 'report' }, condition: null, parent_id: null, enabled: true }
const scheduleCfg = { kind: 'schedule', cadence: 'daily', time: '09:00', timezone: 'America/New_York' }

function loop(over: Row = {}): Row {
  return {
    id: 'flow-1',
    workspace_id: 'ws-1',
    team_id: null,
    name: 'Nightly',
    enabled: false,
    trigger_type: 'schedule',
    trigger_config: scheduleCfg,
    actions: [hook],
    created_by: 'user-1',
    ...over,
  }
}

beforeEach(() => {
  viewer.id = 'user-1'
  db.flow = [loop()]
  db.member = [
    { user_id: 'user-1', workspace_id: 'ws-1', display_name: 'Liam', role: 'owner' },
    { user_id: 'user-2', workspace_id: 'ws-1', display_name: 'Sam', role: 'member' },
  ]
  db.tool_approval = []
  db.updates = []
  tool.calls.length = 0
})

describe('PATCH: the owner is fixed', () => {
  it("the owner's edit of the steps saves and never re-stamps created_by", async () => {
    const res = await PATCH(req({ actions: [{ ...hook, config: { ...hook.config, url: 'https://example.com/b' } }] }), params)
    expect(res.status).toBe(200)
    expect(db.updates[0]).not.toHaveProperty('created_by')
    expect(db.flow[0].created_by).toBe('user-1')
  })

  it("a non-owner changing the steps or the trigger is refused NOT_FLOW_OWNER, nothing written", async () => {
    viewer.id = 'user-2'
    const steps = await PATCH(req({ actions: [{ ...hook, config: { ...hook.config, url: 'https://evil.example.com/x' } }] }), params)
    expect(steps.status).toBe(403)
    expect((await steps.json()).code).toBe('NOT_FLOW_OWNER')
    const trigger = await PATCH(req({ trigger_type: 'schedule', trigger_config: { ...scheduleCfg, time: '23:00' } }), params)
    expect(trigger.status).toBe(403)
    expect(db.updates).toEqual([])
  })

  it('a non-owner may rename it, re-send the same trigger and steps, or switch it off', async () => {
    db.flow = [loop({ enabled: true })]
    viewer.id = 'user-2'
    const res = await PATCH(req({ name: 'Renamed', trigger_type: 'schedule', trigger_config: scheduleCfg, actions: [hook], enabled: false }), params)
    expect(res.status).toBe(200)
    expect(db.flow[0]).toMatchObject({ name: 'Renamed', enabled: false, created_by: 'user-1' })
  })

  it("a non-owner switching a RISKY loop on: saved off, and the owner's card raised through update_flow", async () => {
    viewer.id = 'user-2'
    const res = await PATCH(req({ enabled: true }), params)
    expect(res.status).toBe(200)
    expect(db.flow[0].enabled).toBe(false)
    expect(tool.calls).toEqual([{ user: 'user-2', input: { flow_id: 'flow-1', enabled: true, confirmed_with_user: true } }])
    expect((await res.json()).awaiting_owner).toBe('Liam')
  })

  it('a non-owner switching a draft-only loop on: on at once (the click is the yes)', async () => {
    db.flow = [loop({ actions: [skill] })]
    viewer.id = 'user-2'
    await PATCH(req({ enabled: true }), params)
    expect(db.flow[0].enabled).toBe(true)
    expect(tool.calls).toEqual([])
  })
})

describe('GET: the editor learns who owns it', () => {
  it("the owner sees it as theirs; anyone else sees whose it is", async () => {
    const own = await (await GET(req({}), params)).json()
    expect(own.flow).toMatchObject({ viewer_is_owner: true, owner: { user_id: 'user-1', name: 'Liam' }, takeover_pending: false })
    viewer.id = 'user-2'
    const theirs = await (await GET(req({}), params)).json()
    expect(theirs.flow).toMatchObject({ viewer_is_owner: false, owner: { name: 'Liam' } })
  })
})
