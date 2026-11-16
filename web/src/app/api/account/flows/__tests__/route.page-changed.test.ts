/**
 * The REST routes build a page watch (page_changed) through the same
 * validator and the same save-time checks as chat's create_flow /
 * update_flow (page-changed-save.ts): a public page, tidied; due now while
 * on, no slot while off; a page that needs a browser refused at setup; the
 * per-person limit; switched on or pointed at a new page, it forgets its
 * baseline once the save lands; another member reads the loop without its
 * page. The page read and the reset are stand-ins: no network. Made-up pages.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'

type Row = Record<string, unknown>
const h = vi.hoisted(() => ({
  userId: 'user-1',
  tables: { flow: [] as Array<Record<string, unknown>> },
  probe: vi.fn(async (_url: string) => ({ ok: true as boolean, lineCount: 40, reason: '' })),
  reset: vi.fn(async (_s: unknown, _flowId: string) => {}),
}))
vi.mock('@/lib/flows/page-watch/changes', async (orig) => ({ ...(await orig<Record<string, unknown>>()), resetPageWatch: h.reset }))
vi.mock('@/lib/api-auth', async () => {
  const { memoryDb: db } = await import('@/test/memory-db')
  return { requireWorkspaceMember: async () => ({ supabase: db(h.tables), user: { id: h.userId }, workspaceId: 'ws-1' }) }
})
vi.mock('@/lib/supabase/service', async () => {
  const { memoryDb: db } = await import('@/test/memory-db')
  return { getServiceClient: () => db(h.tables) }
})
vi.mock('@/lib/flows/page-watch/probe', () => ({
  probeWatchPage: async (url: string) => {
    const r = await h.probe(url)
    return r.ok ? { ok: true, lineCount: r.lineCount } : { ok: false, reason: r.reason }
  },
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
const { PAGE_WATCH_MAX_PER_PERSON } = await import('@/lib/flows/page-watch/url')

const NOW = new Date('2026-11-16T15:00:00Z')
const req = (body: unknown) => new Request('http://localhost/api/account/flows', { method: 'POST', body: JSON.stringify(body) }) as unknown as NextRequest
const params = { params: Promise.resolve({ id: 'flow-1' }) }
const hook = { type: 'http_post', config: { method: 'POST', url: 'https://example.com/hook', headers: {}, body_template: '' } }
const KETTLE = { kind: 'page_changed', url: 'https://shop.example.com/kettle', look_for: 'when the price drops' }

function seedFlow(over: Row = {}) {
  h.tables.flow.push({
    id: 'flow-1',
    workspace_id: 'ws-1',
    team_id: null,
    name: 'Kettle price',
    enabled: true,
    trigger_type: 'page_changed',
    trigger_config: KETTLE,
    actions: [{ id: 'a-1', ...hook, enabled: true, condition: null, parent_id: null }],
    created_by: 'user-1',
    next_run_at: '2026-11-16T15:10:00.000Z',
    ...over,
  })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  h.userId = 'user-1'
  h.tables.flow = []
  h.probe.mockReset()
  h.reset.mockClear()
  h.probe.mockImplementation(async () => ({ ok: true, lineCount: 40, reason: '' }))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('POST: a page watch', () => {
  it('stores the page tidied, workspace-scoped, due now while on; the page read once', async () => {
    const res = await POST(req({ name: 'Kettle', trigger_type: 'page_changed', trigger_config: { url: 'Shop.example.com/kettle', look_for: ' when the price drops ' }, actions: [hook] }))
    expect(res.status).toBe(201)
    expect(h.tables.flow[0]).toMatchObject({ trigger_type: 'page_changed', trigger_config: KETTLE, team_id: null, enabled: true, next_run_at: NOW.toISOString(), created_by: 'user-1' })
    expect(h.probe.mock.calls.map(([u]) => u)).toEqual(['https://shop.example.com/kettle'])
    // A new loop has no baseline to forget.
    expect(h.reset).not.toHaveBeenCalled()
  })

  it('saved off: no slot, nothing read', async () => {
    const res = await POST(req({ name: 'Kettle', enabled: false, trigger_type: 'page_changed', trigger_config: KETTLE, actions: [hook] }))
    expect(res.status).toBe(201)
    expect(h.tables.flow[0]).toMatchObject({ enabled: false, next_run_at: null })
    expect(h.probe).not.toHaveBeenCalled()
  })

  it('refuses a private address, a page that needs a browser, and the watch past the limit', async () => {
    const local = await POST(req({ name: 'X', trigger_type: 'page_changed', trigger_config: { url: 'http://10.0.0.5/', look_for: 'x' }, actions: [hook] }))
    expect(local.status).toBe(400)
    expect((await local.json()).error).toMatch(/trigger_config\.url: .*private network/)

    h.probe.mockImplementation(async () => ({ ok: false, lineCount: 0, reason: 'This page shows its content only in a browser. Switch on \"Read it in my browser\" to watch it there.' }))
    const shell = await POST(req({ name: 'X', trigger_type: 'page_changed', trigger_config: { url: 'app.example.com', look_for: 'x' }, actions: [hook] }))
    expect(shell.status).toBe(400)
    const body = await shell.json()
    expect(body.error).toBe("That page can't be watched: This page shows its content only in a browser. Switch on \"Read it in my browser\" to watch it there.")
    expect(body.details).toEqual({ field: 'trigger.url', code: 'PAGE_UNREADABLE' })

    h.probe.mockImplementation(async () => ({ ok: true, lineCount: 40, reason: '' }))
    for (let i = 0; i < PAGE_WATCH_MAX_PER_PERSON; i++) h.tables.flow.push({ id: `w-${i}`, workspace_id: 'ws-1', created_by: 'user-1', enabled: true, trigger_type: 'page_changed' })
    const over = await POST(req({ name: 'X', trigger_type: 'page_changed', trigger_config: KETTLE, actions: [hook] }))
    expect(over.status).toBe(400)
    expect((await over.json()).details).toEqual({ field: 'enabled', code: 'PAGE_WATCH_LIMIT' })
    expect(h.tables.flow).toHaveLength(PAGE_WATCH_MAX_PER_PERSON)
  })
})

describe('PATCH: a page watch', () => {
  it('switched off: the slot cleared, nothing read; switched on: due now, the page read', async () => {
    seedFlow()
    const off = await PATCH(new Request('http://localhost', { method: 'PATCH', body: JSON.stringify({ enabled: false }) }) as unknown as NextRequest, params)
    expect(off.status).toBe(200)
    expect(h.tables.flow[0]).toMatchObject({ enabled: false, next_run_at: null })
    expect(h.probe).not.toHaveBeenCalled()
    expect(h.reset).not.toHaveBeenCalled()
    const on = await PATCH(new Request('http://localhost', { method: 'PATCH', body: JSON.stringify({ enabled: true }) }) as unknown as NextRequest, params)
    expect(on.status).toBe(200)
    expect(h.tables.flow[0]).toMatchObject({ enabled: true, next_run_at: NOW.toISOString() })
    expect(h.probe).toHaveBeenCalledOnce()
    expect(h.reset.mock.calls.map(([, id]) => id)).toEqual(['flow-1'])
  })

  it('a new address on a watch that is on is read; the same one re-saved from the editor is not', async () => {
    seedFlow()
    await PATCH(new Request('http://localhost', { method: 'PATCH', body: JSON.stringify({ trigger_type: 'page_changed', trigger_config: KETTLE }) }) as unknown as NextRequest, params)
    expect(h.probe).not.toHaveBeenCalled()
    expect(h.reset).not.toHaveBeenCalled()
    await PATCH(new Request('http://localhost', { method: 'PATCH', body: JSON.stringify({ trigger_type: 'page_changed', trigger_config: { ...KETTLE, url: 'shop.example.com/teapot' } }) }) as unknown as NextRequest, params)
    expect(h.probe.mock.calls.map(([u]) => u)).toEqual(['https://shop.example.com/teapot'])
    expect(h.reset.mock.calls.map(([, id]) => id)).toEqual(['flow-1'])
    expect(h.tables.flow[0].trigger_config).toEqual({ ...KETTLE, url: 'https://shop.example.com/teapot' })
  })

  it('switching on a page that can no longer be read is refused, and the loop stays off', async () => {
    seedFlow({ enabled: false, next_run_at: null })
    h.probe.mockImplementation(async () => ({ ok: false, lineCount: 0, reason: 'No website answers at that address.' }))
    const res = await PATCH(new Request('http://localhost', { method: 'PATCH', body: JSON.stringify({ enabled: true }) }) as unknown as NextRequest, params)
    expect(res.status).toBe(400)
    expect(h.tables.flow[0]).toMatchObject({ enabled: false, next_run_at: null })
    expect(h.reset).not.toHaveBeenCalled()
  })

  it('another member sees the loop without its page or what its owner asked about, in the list and on its own', async () => {
    seedFlow()
    h.userId = 'user-2'
    const one = (await (await GET(new Request('http://localhost') as unknown as NextRequest, params)).json()).flow
    expect(one.trigger_config).toEqual({ kind: 'page_changed', page: 'a page', owner_only: true })
    const list = (await (await LIST(new Request('http://localhost') as unknown as NextRequest)).json()).flows
    expect(list[0].trigger_config).toEqual({ kind: 'page_changed', page: 'a page', owner_only: true })
    expect(JSON.stringify(list)).not.toMatch(/shop\.example|price drops/)
  })
})
