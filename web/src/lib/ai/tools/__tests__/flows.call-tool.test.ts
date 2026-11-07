/**
 * create_flow / update_flow build call_tool steps and data passing (F4): the
 * connection by id or name (the owner's own), the tool and its templated
 * input checked against the tool's schema, a reference only to a step this
 * one chains off, a skill step's connections, the loop saved off and risky
 * (its switch-on is the person's card), and the summary naming the app.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import type { FlowAction } from '@/lib/flows/types'

const agentFlag = vi.hoisted(() => ({ on: false }))
// The verified cards a risky loop raises (F1, flow-approvals.ts → approvals.ts).
const approvals = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }))
vi.mock('@/lib/safety/approvals', () => ({
  createToolApproval: async (_client: unknown, approval: Record<string, unknown>) => {
    approvals.calls.push(approval)
    return { ok: true, approvalId: `appr-${approvals.calls.length}`, cardId: `card-${approvals.calls.length}` }
  },
}))

vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/flows/flow-bot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/flows/flow-bot')>()),
  defaultFlowBot: async () => ({ teammateId: 'bot-default', created: false }),
}))
vi.mock('@/lib/crypto/credentials', () => ({
  encryptCredentialOrNull: (v: string | null | undefined) => (v ? `enc:${v}` : null),
}))
vi.mock('@/lib/flows/run-agent', () => ({
  get RUN_AGENT_DISPATCH_ENABLED() {
    return agentFlag.on
  },
}))

import { createFlowTools } from '../flows'

const USER = 'user-1'
const WS = 'ws-1'
const SKILL_WS = '11111111-1111-4111-8111-111111111111'
const SKILL_SYS = '22222222-2222-4222-8222-222222222222'
const SKILL_OTHER_WS = '33333333-3333-4333-8333-333333333333'
const AGENT = '44444444-4444-4444-8444-444444444444'
const NOW = new Date('2026-10-14T12:00:00Z')

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
    member: [{ id: 'm-1', user_id: USER, workspace_id: WS, workspace: { id: WS, name: 'WS' } }],
    team: [
      { id: 'team-a', workspace_id: WS, created_at: '2024-01-01' },
      { id: 'team-b', workspace_id: WS, created_at: '2024-02-01' },
      { id: 'team-foreign', workspace_id: 'ws-foreign' },
    ],
    workflow_state: [
      { id: 'wf-done', team_id: 'team-b' },
      { id: 'wf-foreign', team_id: 'team-foreign' },
    ],
    recipe: [
      { id: SKILL_WS, slug: 'standup-prep', name: 'Standup prep (ours)', category: 'skill', workspace_id: WS, is_system: false },
      { id: SKILL_SYS, slug: 'standup-prep', name: 'Standup prep', category: 'skill', workspace_id: null, is_system: true },
      { id: SKILL_OTHER_WS, slug: 'weekly-groom', name: 'Weekly groom', category: 'skill', workspace_id: null, is_system: true },
      { id: AGENT, slug: 'coder', name: 'Coder', category: 'agent', workspace_id: WS, is_system: false },
    ],
    ...extra,
  })
}

type Result = Record<string, unknown>
const call = async (fn: { execute?: (a: never, o: typeof EXEC) => unknown }, args: Record<string, unknown>) =>
  (await fn.execute!(args as never, EXEC)) as Result

const hook = { url: 'https://example.com/hook' }
const schedule = { type: 'schedule', cadence: 'weekdays', time: '09:00', timezone: 'America/New_York' }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  agentFlag.on = false
  approvals.calls.length = 0
})
afterEach(() => {
  vi.useRealTimers()
})

const NOTION = '55555555-5555-4555-8555-555555555555'
const notion = {
  id: NOTION, user_id: USER, display_name: 'Notion', server_url: 'https://mcp.notion.com/mcp', is_enabled: true,
  disabled_tools: [], allowed_tools: null, require_approval_tools: [], approval_free_tools: [],
  tools_cache: [{ name: 'append_block', inputSchema: { type: 'object', properties: { page_id: { type: 'string' }, text: { type: 'string' } }, required: ['page_id', 'text'], additionalProperties: false } }],
}
const lensStep = { id: 'lens', type: 'run_skill', skill: 'standup-prep' }
const notionStep = (input: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id: 'log', type: 'call_tool', parent_id: 'lens', connection: 'notion', tool: 'append_block', tool_input: input, ...extra })

describe('create_flow: a call_tool step', () => {
  it('resolves the connection by name, keeps the templated input, saves it OFF and names the app', async () => {
    const { client, inserts } = seeded({ connected_mcp_server: [notion] })
    const res = await call(createFlowTools(USER, client, WS).create_flow, {
      name: 'Objections to Notion',
      trigger: { type: 'capture_processed' },
      actions: [lensStep, notionStep({ page_id: 'p-objections', text: 'From {{trigger.capture.title}}: {{steps.lens.output}}' })],
    })
    expect(res.success).not.toBe(false)
    const row = inserts.flow![0]
    expect(row.enabled).toBe(false)
    const actions = row.actions as FlowAction[]
    expect(actions[1]).toMatchObject({
      id: 'log', type: 'call_tool', parent_id: 'lens',
      config: { connection: NOTION, tool: 'append_block', input: { page_id: 'p-objections', text: 'From {{trigger.capture.title}}: {{steps.lens.output}}' } },
    })
    expect(String(res.summary)).toContain('call append_block on Notion')
  })

  it('refuses, naming the field: not the person\'s connection, an unknown token, a bad input, a step it does not chain off', async () => {
    const tools = () => createFlowTools(USER, seeded({ connected_mcp_server: [notion] }).client, WS)
    const base = { name: 'x', trigger: { type: 'capture_processed' } }
    expect(await call(tools().create_flow, { ...base, actions: [lensStep, notionStep({ page_id: 'p', text: 't' }, { connection: 'slack' })] })).toMatchObject({ success: false, field: 'actions[1].connection' })
    expect(await call(tools().create_flow, { ...base, actions: [lensStep, notionStep({ page_id: 'p', text: '{{secrets.key}}' })] })).toMatchObject({ success: false, field: 'actions[1].tool_input' })
    expect(await call(tools().create_flow, { ...base, actions: [lensStep, notionStep({ text: 'no page' })] })).toMatchObject({ success: false, field: 'actions[1].tool_input' })
    const sibling = await call(tools().create_flow, { ...base, actions: [lensStep, notionStep({ page_id: 'p', text: '{{steps.lens.output}}' }, { parent_id: null })] })
    expect(sibling).toMatchObject({ success: false })
    expect(String(sibling.error)).toContain('must chain off "lens"')
  })

  it('another person\'s connection with the same name is never theirs', async () => {
    const { client } = seeded({ connected_mcp_server: [{ ...notion, user_id: 'someone-else' }] })
    const res = await call(createFlowTools(USER, client, WS).create_flow, {
      name: 'x', trigger: { type: 'capture_processed' }, actions: [lensStep, notionStep({ page_id: 'p', text: 't' })],
    })
    expect(res).toMatchObject({ success: false, field: 'actions[1].connection' })
  })
})

describe('create_flow: a skill step with the person\'s connections', () => {
  it('resolves them to ids and says which apps it uses', async () => {
    const { client, inserts } = seeded({ connected_mcp_server: [notion] })
    const res = await call(createFlowTools(USER, client, WS).create_flow, {
      name: 'Research', trigger: schedule, actions: [{ type: 'run_skill', skill: 'standup-prep', mode: 'act', connections: ['Notion'] }],
    })
    expect(res.success).not.toBe(false)
    expect(((inserts.flow![0].actions as FlowAction[])[0].config as { connections?: string[] }).connections).toEqual([NOTION])
    expect(String(res.summary)).toContain('using Notion')
    void hook
  })
})

