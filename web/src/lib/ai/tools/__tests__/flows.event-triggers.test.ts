/**
 * create_flow / update_flow build the owner's event triggers (email_received,
 * chat_message, document_created) and the schedule's newer cadences (monthly,
 * cron, once) through the REST validators: a sender filter normalized, a chat
 * loop on any channel only with mentions-only and on a named channel only
 * when its owner can read it, a custom schedule held to every 15 minutes, and
 * a one-time run never in the past. Made-up people and companies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { memoryDb } from '@/test/memory-db'

const svc = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => svc.db }))
vi.mock('@/lib/flows/flow-bot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/flows/flow-bot')>()),
  defaultFlowBot: async () => ({ teammateId: 'bot-default', created: false }),
}))
vi.mock('@/lib/crypto/credentials', () => ({ encryptCredentialOrNull: () => null }))
vi.mock('@/lib/safety/approvals', () => ({ createToolApproval: async () => ({ ok: true, approvalId: 'appr-1', cardId: 'card-1' }) }))

import { createFlowTools } from '../flows'

const USER = 'user-ana'
const WS = 'ws-1'
const SKILL = '11111111-1111-4111-8111-111111111111'
const CH_TEAM = '55555555-5555-4555-8555-555555555555'
const CH_OTHER_TEAM = '66666666-6666-4666-8666-666666666666'
const NOW = new Date('2026-11-16T15:00:00Z')
const EXEC = { toolCallId: 'c', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

type Row = Record<string, unknown>

/** Row-store double (same shape as routing.flows.test.ts); `.or()` is a no-op. */
function makeClient(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]))
  const inserts: Record<string, Row[]> = {}
  const updates: Record<string, Row[]> = {}

  const from = vi.fn((table: string) => {
    tables[table] ??= []
    const preds: Array<(r: Row) => boolean> = []
    let mode: 'select' | 'update' | 'delete' | 'insert' = 'select'
    let payload: Row = {}
    let proxy: Record<string, unknown>
    const matching = () => tables[table].filter((r) => preds.every((p) => p(r)))

    const run = (): Row | Row[] | null => {
      if (mode === 'insert') {
        const row = { id: `gen-${Math.random().toString(36).slice(2, 8)}`, ...payload }
        tables[table].push(row)
        ;(inserts[table] ??= []).push(row)
        return row
      }
      if (mode === 'update') {
        const rows = matching()
        for (const r of rows) Object.assign(r, payload)
        ;(updates[table] ??= []).push(payload)
        return rows
      }
      if (mode === 'delete') {
        const rows = matching()
        tables[table] = tables[table].filter((r) => !rows.includes(r))
        return rows
      }
      return matching()
    }

    const self: Record<string, unknown> = {
      eq: (col: string, val: unknown) => { preds.push((r) => r[col] === val); return proxy },
      in: (col: string, vals: unknown[]) => { preds.push((r) => vals.includes(r[col])); return proxy },
      or: () => proxy,
      order: () => proxy,
      limit: () => proxy,
      select: () => proxy,
      insert: (p: Row) => { mode = 'insert'; payload = p; return proxy },
      update: (p: Row) => { mode = 'update'; payload = p; return proxy },
      delete: () => { mode = 'delete'; return proxy },
      single: async () => {
        const r = run()
        const row = Array.isArray(r) ? r[0] : r
        return { data: row ?? null, error: row ? null : { message: 'no rows' } }
      },
      maybeSingle: async () => {
        const r = run()
        const row = Array.isArray(r) ? r[0] : r
        return { data: row ?? null, error: null }
      },
      then: (resolve: (v: unknown) => unknown) => {
        const r = run()
        const data = Array.isArray(r) ? r : r ? [r] : []
        return Promise.resolve({ data, error: null }).then(resolve)
      },
    }
    proxy = new Proxy(self, { get: (t, p: string) => (p in t ? t[p] : () => proxy) })
    return proxy
  })

  return { client: { from } as never, tables, inserts, updates }
}

function seeded(extra: Record<string, Row[]> = {}) {
  return makeClient({
    member: [{ id: 'm-ana', user_id: USER, workspace_id: WS, workspace: { id: WS, name: 'WS' } }],
    recipe: [{ id: SKILL, slug: 'triage-mail', name: 'Triage mail', category: 'skill', workspace_id: WS, is_system: false }],
    ...extra,
  })
}

type Result = Record<string, unknown>
const call = async (fn: { execute?: (a: never, o: typeof EXEC) => unknown }, args: Record<string, unknown>) =>
  (await fn.execute!(args as never, EXEC)) as Result
const skill = { type: 'run_skill', skill: 'triage-mail', instructions: 'Read {{trigger.email_thread_id}} with read_email' }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  // The service client the channel check reads: Ana is on team-a only.
  svc.db = memoryDb({
    member: [{ id: 'm-ana', user_id: USER, workspace_id: WS }],
    team_chat_channel: [
      { id: CH_TEAM, workspace_id: WS, team_id: 'team-a', kind: 'channel', name: 'launch' },
      { id: CH_OTHER_TEAM, workspace_id: WS, team_id: 'team-b', kind: 'channel', name: 'finance' },
    ],
    team_member: [{ team_id: 'team-a', member_id: 'm-ana' }],
    team_chat_member: [],
  })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('create_flow — the owner\'s event triggers', () => {
  it('email_received: the sender filter normalized, workspace-scoped, no clock', async () => {
    const { client, inserts } = seeded()
    const res = await call(createFlowTools(USER, client, WS).create_flow, { name: 'Acme mail', trigger: { type: 'email_received', email_from: '@Acme.example' }, actions: [skill] })
    expect(inserts.flow![0]).toMatchObject({ team_id: null, trigger_type: 'email_received', trigger_config: { kind: 'email_received', from: 'acme.example' }, next_run_at: null, created_by: USER })
    expect(res.summary).toMatch(/^When new mail arrives in your inbox from acme\.example/)
    const bad = await call(createFlowTools(USER, seeded().client, WS).create_flow, { name: 'X', trigger: { type: 'email_received', email_from: 'not an address' }, actions: [skill] })
    expect(bad).toMatchObject({ success: false, field: 'trigger.from' })
  })

  it('chat_message: a channel the owner reads; any channel only with mentions_only', async () => {
    const { client, inserts } = seeded()
    const tools = createFlowTools(USER, client, WS)
    await call(tools.create_flow, { name: 'Launch', trigger: { type: 'chat_message', channel_id: CH_TEAM }, actions: [skill] })
    expect(inserts.flow![0].trigger_config).toEqual({ kind: 'chat_message', channel_id: CH_TEAM, mentions_only: false })

    const anyNoMentions = await call(tools.create_flow, { name: 'All', trigger: { type: 'chat_message', channel_id: null }, actions: [skill] })
    expect(anyNoMentions).toMatchObject({ success: false, field: 'trigger.channel_id' })
    const anyMentions = await call(tools.create_flow, { name: 'Mentions', trigger: { type: 'chat_message', channel_id: null, mentions_only: true }, actions: [skill] })
    expect(anyMentions.success).not.toBe(false)

    const unreadable = await call(tools.create_flow, { name: 'Finance', trigger: { type: 'chat_message', channel_id: CH_OTHER_TEAM }, actions: [skill] })
    expect(unreadable).toMatchObject({ success: false, field: 'trigger.channel_id' })
    expect(unreadable.error).toMatch(/owner can read/)
    expect(inserts.flow).toHaveLength(2)
  })

  it('document_created: the bare config', async () => {
    const { client, inserts } = seeded()
    const res = await call(createFlowTools(USER, client, WS).create_flow, { name: 'New docs', trigger: { type: 'document_created' }, actions: [skill] })
    expect(inserts.flow![0]).toMatchObject({ trigger_type: 'document_created', trigger_config: { kind: 'document_created' }, next_run_at: null })
    expect(res.summary).toMatch(/^When someone creates a document you can see/)
  })
})

describe('create_flow — monthly, custom and one-time schedules', () => {
  const tz = 'America/New_York'

  it('monthly: a day and a time', async () => {
    const { client, inserts } = seeded()
    await call(createFlowTools(USER, client, WS).create_flow, { name: 'Invoices', trigger: { type: 'schedule', cadence: 'monthly', day_of_month: 1, time: '08:00', timezone: tz }, actions: [skill] })
    expect(inserts.flow![0]).toMatchObject({ trigger_config: { kind: 'schedule', cadence: 'monthly', day_of_month: 1, time: '08:00', timezone: tz }, next_run_at: '2026-12-01T13:00:00.000Z' })
    const bad = await call(createFlowTools(USER, seeded().client, WS).create_flow, { name: 'X', trigger: { type: 'schedule', cadence: 'monthly', day_of_month: 31, time: '08:00', timezone: tz }, actions: [skill] })
    expect(bad).toMatchObject({ success: false, field: 'trigger.day_of_month' })
  })

  it('cron: kept normalized; too frequent is refused on trigger.cron', async () => {
    const { client, inserts } = seeded()
    await call(createFlowTools(USER, client, WS).create_flow, { name: 'Twice', trigger: { type: 'schedule', cadence: 'cron', cron: '30 8 1,15 * *', timezone: tz }, actions: [skill] })
    expect(inserts.flow![0]).toMatchObject({ trigger_config: { kind: 'schedule', cadence: 'cron', cron: '30 8 1,15 * *', timezone: tz }, next_run_at: '2026-12-01T13:30:00.000Z' })
    const often = await call(createFlowTools(USER, seeded().client, WS).create_flow, { name: 'X', trigger: { type: 'schedule', cadence: 'cron', cron: '*/5 * * * *', timezone: tz }, actions: [skill] })
    expect(often).toMatchObject({ success: false, field: 'trigger.cron' })
    expect(often.error).toMatch(/at most every 15 minutes/)
  })

  it('once: next_run_at is its time; a past time is refused', async () => {
    const { client, inserts } = seeded()
    const res = await call(createFlowTools(USER, client, WS).create_flow, { name: 'Tomorrow', trigger: { type: 'schedule', cadence: 'once', run_at: '2026-11-17T15:00', timezone: tz }, actions: [skill] })
    expect(inserts.flow![0]).toMatchObject({ trigger_config: { kind: 'schedule', cadence: 'once', run_at: '2026-11-17T15:00', timezone: tz }, next_run_at: '2026-11-17T20:00:00.000Z' })
    expect(res.summary).toMatch(/^Once, at 2026-11-17 15:00 \(America\/New_York\), then it switches off/)
    const past = await call(createFlowTools(USER, seeded().client, WS).create_flow, { name: 'X', trigger: { type: 'schedule', cadence: 'once', run_at: '2026-11-16T09:00', timezone: tz }, actions: [skill] })
    expect(past).toMatchObject({ success: false, field: 'trigger.run_at' })
  })
})

describe('update_flow — the new triggers', () => {
  const onceCfg = { kind: 'schedule', cadence: 'once', run_at: '2026-11-10T09:00', timezone: 'America/New_York' }
  const withFlow = (over: Row = {}) =>
    seeded({
      flow: [
        {
          id: 'flow-1',
          workspace_id: WS,
          team_id: null,
          name: 'Once',
          enabled: false,
          trigger_type: 'schedule',
          trigger_config: onceCfg,
          actions: [{ id: 'act-1', type: 'run_skill', config: { skill_id: SKILL, mode: 'report' }, condition: null, parent_id: null, enabled: true }],
          created_by: USER,
          next_run_at: null,
          ...over,
        },
      ],
    })

  it('a finished one-time loop: a new past time is refused, its stored one is not', async () => {
    const { client, tables } = withFlow()
    const tools = createFlowTools(USER, client, WS)
    const past = await call(tools.update_flow, { flow_id: 'flow-1', trigger: { type: 'schedule', run_at: '2026-11-12T09:00' } })
    expect(past).toMatchObject({ success: false, field: 'trigger.run_at' })
    const same = await call(tools.update_flow, { flow_id: 'flow-1', trigger: { type: 'schedule', run_at: '2026-11-10T09:00' } })
    expect(same.success).not.toBe(false)
    expect(tables.flow[0].next_run_at).toBeNull()
    const future = await call(tools.update_flow, { flow_id: 'flow-1', trigger: { type: 'schedule', run_at: '2026-11-20T09:00' } })
    expect(future.success).not.toBe(false)
    expect(tables.flow[0].next_run_at).toBe('2026-11-20T14:00:00.000Z')
  })

  it("switching a loop to chat checks the channel against the OWNER's access", async () => {
    const { client } = withFlow()
    const res = await call(createFlowTools(USER, client, WS).update_flow, { flow_id: 'flow-1', trigger: { type: 'chat_message', channel_id: CH_OTHER_TEAM } })
    expect(res).toMatchObject({ success: false, field: 'trigger.channel_id' })
  })
})
