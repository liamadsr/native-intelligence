/**
 * create_flow / update_flow build a page watch (page_changed) through the
 * REST validators and the shared save-time checks (page-changed-save.ts): a
 * public page tidied, what to look for required, workspace-scoped, due now
 * while on and with no slot while off, a page that needs a browser refused at
 * setup, the per-person limit, and a read again only when the address changes
 * or it is switched on, and the watch's baseline forgotten after a save that
 * switches it on or points it at a new page. How a page loop is described
 * back to the person, and to someone else. The page read and the reset are
 * stand-ins: no network. Made-up pages.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { memoryDb } from '@/test/memory-db'

const svc = vi.hoisted(() => ({ db: null as unknown }))
const probe = vi.hoisted(() => ({ fn: vi.fn(async (_url: string) => ({ ok: true as boolean, lineCount: 40, reason: '' })) }))
const reset = vi.hoisted(() => ({ fn: vi.fn(async (_s: unknown, _flowId: string) => {}) }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => svc.db }))
vi.mock('@/lib/flows/page-watch/changes', async (orig) => ({ ...(await orig<Record<string, unknown>>()), resetPageWatch: reset.fn }))
vi.mock('@/lib/flows/page-watch/probe', () => ({
  probeWatchPage: async (url: string) => {
    const r = await probe.fn(url)
    return r.ok ? { ok: true, lineCount: r.lineCount } : { ok: false, reason: r.reason }
  },
}))
const browser = vi.hoisted(() => ({ reads: [] as Array<{ userId: string; workspaceId: string; url: string }>, finished: 0 }))
vi.mock('@/lib/flows/page-watch/read-browser', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  browserWatchSession: (ref: { userId: string; workspaceId: string }) => ({
    read: async (url: string) => { browser.reads.push({ ...ref, url }); return { ok: true, lines: ['Orders', 'Open: 4', 'Order 1041', 'Order 1042', 'Order 1043'] } },
    finish: async () => { browser.finished += 1 },
  }),
}))
vi.mock('@/lib/flows/flow-bot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/flows/flow-bot')>()),
  defaultFlowBot: async () => ({ teammateId: 'bot-default', created: false }),
}))
vi.mock('@/lib/crypto/credentials', () => ({ encryptCredentialOrNull: () => null }))
vi.mock('@/lib/safety/approvals', () => ({ createToolApproval: async () => ({ ok: true, approvalId: 'appr-1', cardId: 'card-1' }) }))

import { createFlowTools, describeTrigger } from '../flows'
import { PAGE_WATCH_MAX_PER_PERSON } from '@/lib/flows/page-watch/url'
import type { FlowTriggerConfig } from '@/lib/flows/types'

const USER = 'user-ana'
const WS = 'ws-1'
const SKILL = '11111111-1111-4111-8111-111111111111'
const NOW = new Date('2026-11-16T15:00:00Z')
const EXEC = { toolCallId: 'c', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

type Row = Record<string, unknown>
type Result = Record<string, unknown>

const call = async (fn: { execute?: (a: never, o: typeof EXEC) => unknown }, args: Record<string, unknown>) => (await fn.execute!(args as never, EXEC)) as Result
const pageSkill = { type: 'run_skill', skill: 'triage-mail', instructions: 'Read {{trigger.page_change_id}} with get_page_change and tell me' }
const STEP = { id: 'act-1', type: 'run_skill', config: { skill_id: SKILL, mode: 'report' }, condition: null, parent_id: null, enabled: true }

/** The user client: the member, the skill and the loops, as a memory store. */
function userDb(flows: Row[] = []) {
  const tables: Record<string, Row[]> = {
    member: [{ id: 'm-ana', user_id: USER, workspace_id: WS, workspace: { id: WS, name: 'WS' } }],
    recipe: [{ id: SKILL, slug: 'triage-mail', name: 'Triage mail', category: 'skill', workspace_id: WS, is_system: false }],
    flow: flows,
  }
  return { client: memoryDb(tables) as never, tables }
}

const pageFlow = (over: Row = {}): Row => ({
  id: 'flow-p',
  workspace_id: WS,
  team_id: null,
  name: 'Kettle price',
  enabled: true,
  trigger_type: 'page_changed',
  trigger_config: { kind: 'page_changed', url: 'https://shop.example.com/kettle', look_for: 'when the price drops' },
  actions: [STEP],
  created_by: USER,
  next_run_at: '2026-11-16T15:10:00.000Z',
  ...over,
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  svc.db = memoryDb({ flow: [], member: [{ id: 'm-ana', user_id: USER, workspace_id: WS }] })
  probe.fn.mockReset()
  reset.fn.mockClear()
  browser.reads = []
  browser.finished = 0
  probe.fn.mockImplementation(async () => ({ ok: true, lineCount: 40, reason: '' }))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('create_flow: a page watch', () => {
  it('the page tidied, what to look for trimmed, workspace-scoped, due now while on, the page read once', async () => {
    const { client, tables } = userDb()
    const res = await call(createFlowTools(USER, client, WS).create_flow, {
      name: 'Kettle price',
      trigger: { type: 'page_changed', url: 'Shop.example.com/kettle#top', look_for: '  when the price drops ' },
      actions: [pageSkill],
      enabled: true,
    })
    expect(res.success).not.toBe(false)
    expect(tables.flow[0]).toMatchObject({
      trigger_type: 'page_changed',
      trigger_config: { kind: 'page_changed', url: 'https://shop.example.com/kettle', look_for: 'when the price drops' },
      team_id: null,
      enabled: true,
      created_by: USER,
      next_run_at: NOW.toISOString(),
    })
    expect(probe.fn.mock.calls.map(([u]) => u)).toEqual(['https://shop.example.com/kettle'])
    // A new loop has no baseline to forget.
    expect(reset.fn).not.toHaveBeenCalled()
    expect(res.summary).toMatch(/^When https:\/\/shop\.example\.com\/kettle changes: when the price drops \(checked every 15 minutes\)/)
  })

  it('a loop it proposes on its own is saved off: no slot, and the page is not read until it is switched on', async () => {
    const { client, tables } = userDb()
    await call(createFlowTools(USER, client, WS).create_flow, { name: 'Jobs', trigger: { type: 'page_changed', url: 'jobs.example.com', look_for: 'a new job in Berlin' }, actions: [pageSkill] })
    expect(tables.flow[0]).toMatchObject({ enabled: false, next_run_at: null })
    expect(probe.fn).not.toHaveBeenCalled()
  })

  it('refuses a private address and a missing look_for on their fields, before anything is read or saved', async () => {
    const { client, tables } = userDb()
    const tools = createFlowTools(USER, client, WS)
    const local = await call(tools.create_flow, { name: 'X', trigger: { type: 'page_changed', url: 'http://localhost', look_for: 'x' }, actions: [pageSkill], enabled: true })
    expect(local).toMatchObject({ success: false, field: 'trigger.url' })
    expect(local.error).toMatch(/private network/)
    const noLook = await call(tools.create_flow, { name: 'X', trigger: { type: 'page_changed', url: 'example.com' }, actions: [pageSkill], enabled: true })
    expect(noLook).toMatchObject({ success: false, field: 'trigger.look_for' })
    expect(tables.flow).toHaveLength(0)
    expect(probe.fn).not.toHaveBeenCalled()
  })

  it('refuses a page that needs a browser with the reason, and saves nothing', async () => {
    probe.fn.mockImplementation(async () => ({ ok: false, lineCount: 0, reason: 'This page shows its content only in a browser. Switch on \"Read it in my browser\" to watch it there.' }))
    const { client, tables } = userDb()
    const out = await call(createFlowTools(USER, client, WS).create_flow, { name: 'X', trigger: { type: 'page_changed', url: 'app.example.com', look_for: 'x' }, actions: [pageSkill], enabled: true })
    expect(out).toMatchObject({ success: false, code: 'PAGE_UNREADABLE', field: 'trigger.url' })
    expect(out.error).toMatch(/^That page can't be watched: This page shows its content only in a browser/)
    expect(tables.flow).toHaveLength(0)
  })

  it(`refuses a person's ${PAGE_WATCH_MAX_PER_PERSON + 1}th watch switched on`, async () => {
    svc.db = memoryDb({ flow: Array.from({ length: PAGE_WATCH_MAX_PER_PERSON }, (_, i) => ({ id: `w-${i}`, workspace_id: WS, created_by: USER, enabled: true, trigger_type: 'page_changed' })) })
    const { client, tables } = userDb()
    const out = await call(createFlowTools(USER, client, WS).create_flow, { name: 'X', trigger: { type: 'page_changed', url: 'example.com', look_for: 'x' }, actions: [pageSkill], enabled: true })
    expect(out).toMatchObject({ success: false, code: 'PAGE_WATCH_LIMIT', field: 'enabled' })
    expect(tables.flow).toHaveLength(0)
    expect(probe.fn).not.toHaveBeenCalled()
  })
})

describe('update_flow: a page watch', () => {
  it('a new address is read again; only what to look for changed is not; the stored fields stay when the call leaves them out; either change starts the watch over', async () => {
    const { client, tables } = userDb([pageFlow()])
    const tools = createFlowTools(USER, client, WS)
    const look = await call(tools.update_flow, { flow_id: 'flow-p', trigger: { type: 'page_changed', look_for: 'a new colour' }, confirmed_with_user: true })
    expect(look.success).not.toBe(false)
    expect(tables.flow[0].trigger_config).toEqual({ kind: 'page_changed', url: 'https://shop.example.com/kettle', look_for: 'a new colour' })
    expect(probe.fn).not.toHaveBeenCalled()
    // What to look for changed: the page is not read again, but the watch starts over.
    expect(reset.fn.mock.calls).toEqual([[svc.db, 'flow-p']])
    reset.fn.mockClear()
    await call(tools.update_flow, { flow_id: 'flow-p', trigger: { type: 'page_changed', url: 'shop.example.com/teapot' }, confirmed_with_user: true })
    expect(tables.flow[0].trigger_config).toMatchObject({ url: 'https://shop.example.com/teapot', look_for: 'a new colour' })
    expect(probe.fn.mock.calls.map(([u]) => u)).toEqual(['https://shop.example.com/teapot'])
    expect(tables.flow[0].next_run_at).toBe(NOW.toISOString())
    // A new address: a fresh baseline, with the service client.
    expect(reset.fn.mock.calls).toEqual([[svc.db, 'flow-p']])
  })

  it('switched off it holds no slot and nothing is read; switched on it is due now and its page is read', async () => {
    const { client, tables } = userDb([pageFlow()])
    const tools = createFlowTools(USER, client, WS)
    await call(tools.update_flow, { flow_id: 'flow-p', enabled: false })
    expect(tables.flow[0]).toMatchObject({ enabled: false, next_run_at: null })
    expect(probe.fn).not.toHaveBeenCalled()
    expect(reset.fn).not.toHaveBeenCalled()
    await call(tools.update_flow, { flow_id: 'flow-p', enabled: true, confirmed_with_user: true })
    expect(tables.flow[0]).toMatchObject({ enabled: true, next_run_at: NOW.toISOString() })
    expect(probe.fn).toHaveBeenCalledOnce()
    // Switched back on: it forgets what it saw before it was off.
    expect(reset.fn.mock.calls).toEqual([[svc.db, 'flow-p']])
  })

  it('switching on a page that can no longer be read is refused, and the loop stays off', async () => {
    probe.fn.mockImplementation(async () => ({ ok: false, lineCount: 0, reason: 'No website answers at that address.' }))
    const { client, tables } = userDb([pageFlow({ enabled: false, next_run_at: null })])
    const out = await call(createFlowTools(USER, client, WS).update_flow, { flow_id: 'flow-p', enabled: true, confirmed_with_user: true })
    expect(out).toMatchObject({ success: false, code: 'PAGE_UNREADABLE' })
    expect(tables.flow[0]).toMatchObject({ enabled: false, next_run_at: null })
    // A refused save keeps its baseline.
    expect(reset.fn).not.toHaveBeenCalled()
  })

  it('a loop moved onto a page watch forgets any old baseline', async () => {
    const { client } = userDb([pageFlow({ trigger_type: 'document_created', trigger_config: { kind: 'document_created' }, next_run_at: null })])
    const out = await call(createFlowTools(USER, client, WS).update_flow, { flow_id: 'flow-p', trigger: { type: 'page_changed', url: 'shop.example.com/kettle', look_for: 'x' }, confirmed_with_user: true })
    expect(out.success).not.toBe(false)
    expect(reset.fn.mock.calls).toEqual([[svc.db, 'flow-p']])
  })

  it('moving a loop off a page watch clears its slot, as any trigger change away does', async () => {
    const { client, tables } = userDb([pageFlow()])
    await call(createFlowTools(USER, client, WS).update_flow, { flow_id: 'flow-p', trigger: { type: 'document_created' }, confirmed_with_user: true })
    expect(tables.flow[0]).toMatchObject({ trigger_type: 'document_created', next_run_at: null })
  })
})

describe('describeTrigger: a page watch', () => {
  const cfg = { kind: 'page_changed', url: 'https://shop.example.com/kettle', look_for: 'when the price drops' } as FlowTriggerConfig
  it('names the page and what was asked to its owner, and neither to anyone else', () => {
    expect(describeTrigger('page_changed', cfg)).toBe('When https://shop.example.com/kettle changes: when the price drops (checked every 15 minutes)')
    expect(describeTrigger('page_changed', cfg, false)).toBe('When a page its owner watches changes (checked every 15 minutes)')
  })
})

describe('a page read in the person\'s browser', () => {
  const ORDERS = 'https://app.example.com/orders'

  it('create_flow stores read_with, reads the page once in the owner\'s browser (never by a fetch), and says how often', async () => {
    const { client, tables } = userDb()
    const res = await call(createFlowTools(USER, client, WS).create_flow, {
      name: 'New orders', trigger: { type: 'page_changed', url: 'app.example.com/orders', look_for: 'a new order', read_with: 'browser' }, actions: [pageSkill], enabled: true,
    })
    expect(res.error ?? null).toBeNull()
    expect(tables.flow[0].trigger_config).toEqual({ kind: 'page_changed', url: ORDERS, look_for: 'a new order', read_with: 'browser' })
    expect(browser.reads).toEqual([{ userId: USER, workspaceId: WS, url: ORDERS }])
    expect(browser.finished).toBe(1)
    expect(probe.fn).not.toHaveBeenCalled()
    expect(res.summary).toMatch(/^When https:\/\/app\.example\.com\/orders changes: a new order \(checked every 30 minutes, read in your browser\)/)
  })

  it('refuses a social network\'s signed-in pages on the address, before anything is read or saved', async () => {
    const { client, tables } = userDb()
    const res = await call(createFlowTools(USER, client, WS).create_flow, {
      name: 'Messages', trigger: { type: 'page_changed', url: 'https://www.linkedin.com/messaging/', look_for: 'a new message', read_with: 'browser' }, actions: [pageSkill], enabled: true,
    })
    expect(res).toMatchObject({ success: false, field: 'trigger.url' })
    expect(res.error).toMatch(/does not allow its signed-in pages to be read automatically/)
    expect(tables.flow).toHaveLength(0)
    expect(browser.reads).toEqual([])
  })

  it('update_flow keeps a stored read_with when the trigger is re-sent without it, and "fetch" moves the watch back to a plain read with a fresh baseline', async () => {
    const stored = pageFlow({ trigger_config: { kind: 'page_changed', url: ORDERS, look_for: 'a new order', read_with: 'browser' } })
    const { client, tables } = userDb([stored])
    svc.db = memoryDb({ flow: tables.flow, member: [{ id: 'm-ana', user_id: USER, workspace_id: WS }] })
    const tools = createFlowTools(USER, client, WS)
    const kept = await call(tools.update_flow, { flow_id: 'flow-p', trigger: { type: 'page_changed', look_for: 'a new or cancelled order' }, confirmed_with_user: true })
    expect(kept.error ?? null).toBeNull()
    expect(tables.flow[0].trigger_config).toEqual({ kind: 'page_changed', url: ORDERS, look_for: 'a new or cancelled order', read_with: 'browser' })
    // The same page read the same way: not read again.
    expect(browser.reads).toEqual([])

    reset.fn.mockClear()
    const plain = await call(tools.update_flow, { flow_id: 'flow-p', trigger: { type: 'page_changed', read_with: 'fetch' }, confirmed_with_user: true })
    expect(plain.success).not.toBe(false)
    expect(tables.flow[0].trigger_config).toEqual({ kind: 'page_changed', url: ORDERS, look_for: 'a new or cancelled order' })
    expect(probe.fn.mock.calls.map(([u]) => u)).toEqual([ORDERS])
    expect(reset.fn).toHaveBeenCalledTimes(1)
  })
})
