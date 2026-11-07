/**
 * F1 item 5: test_flow (a dry run, kill-switch gated, routed to the loop's
 * own workspace), get_flow_run (one run in full, membership-checked), and
 * list_flow_runs routed by flow_id like the other flow tools.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'

const h = vi.hoisted(() => ({
  paused: false,
  dry: [] as Array<Record<string, unknown>>,
}))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/work/agent-paused', () => ({ AGENT_PAUSED_CODE: 'AGENT_PAUSED', checkAgentPaused: async () => h.paused }))
vi.mock('@/lib/flows/test-fire', () => ({
  runDryTestFire: async (args: Record<string, unknown>) => {
    h.dry.push(args)
    return {
      ok: true,
      status: 'success',
      sample: 'synthetic',
      trigger: { type: 'schedule' },
      action_results: [
        { action_id: 'h-1', skipped: false, disabled: false, incomplete: false, status: 'success', response_body_preview: 'Test: not sent. It would POST https://example.com/a', error_message: null },
        { action_id: 's-1', skipped: true, disabled: true, incomplete: false, status: 'success', response_body_preview: null, error_message: null },
      ],
    }
  },
}))

import { createFlowTools } from '../flows'

const USER = 'user-1'
const WS = 'ws-session'
const WS_OTHER = 'ws-other'
const EXEC = { toolCallId: 'c', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>
type Row = Record<string, unknown>

function makeClient(seed: Record<string, Row[]>) {
  const filters: Array<{ table: string; col: string; val: unknown }> = []
  const from = (table: string) => {
    const preds: Array<(r: Row) => boolean> = []
    let proxy: Record<string, unknown>
    const rows = () => (seed[table] ?? []).filter((r) => preds.every((p) => p(r)))
    const self: Record<string, unknown> = {
      eq: (col: string, val: unknown) => {
        filters.push({ table, col, val })
        // flow_run reads filter on the embedded flow's workspace: honour it.
        if (col === 'flow.workspace_id') preds.push((r) => (r.flow as Row | undefined)?.workspace_id === val)
        else preds.push((r) => r[col] === val)
        return proxy
      },
      in: (col: string, vals: unknown[]) => ((preds.push((r) => vals.includes(r[col]))), proxy),
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      single: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve),
    }
    proxy = new Proxy(self, { get: (t, p: string) => (p in t ? t[p] : () => proxy) })
    return proxy
  }
  return { client: { from } as never, filters }
}

const flowRow = (ws: string) => ({
  id: 'flow-1',
  workspace_id: ws,
  name: 'Nightly',
  trigger_type: 'schedule',
  trigger_config: { kind: 'schedule', cadence: 'daily', time: '07:00', timezone: 'UTC' },
  actions: [
    { id: 'h-1', type: 'http_post', config: { method: 'POST', url: 'https://example.com/a', headers: {}, body_template: '' }, condition: null, parent_id: null, enabled: true },
    { id: 's-1', type: 'run_skill', config: { skill_id: '11111111-1111-4111-8111-111111111111', mode: 'report' }, condition: null, parent_id: null, enabled: false },
  ],
  created_by: USER,
})
const run = (ws: string) => ({
  id: '99999999-9999-4999-8999-999999999999',
  flow_id: 'flow-1',
  status: 'success',
  action_results: [{ action_id: 'h-1', status: 'success', response_status_code: 200 }],
  flow: { workspace_id: ws, name: 'Nightly', actions: flowRow(ws).actions },
})

const call = async (fn: { execute?: (a: never, o: typeof EXEC) => unknown }, args: Row) => (await fn.execute!(args as never, EXEC)) as Row

beforeEach(() => {
  h.paused = false
  h.dry.length = 0
})

describe('test_flow', () => {
  it('dry-runs the loop as the caller and says what each step did or would do', async () => {
    const { client } = makeClient({ flow: [flowRow(WS)], member: [{ id: 'm', user_id: USER, workspace_id: WS }] })
    const res = await call(createFlowTools(USER, client, WS).test_flow, { flow_id: 'flow-1' })
    expect(h.dry[0]).toMatchObject({ userId: USER, budgetMs: 300_000, startedAt: expect.any(Number), flow: { id: 'flow-1', workspace_id: WS, trigger_type: 'schedule' } })
    expect(res).toMatchObject({ success: true, dry_run: true, status: 'success', sample: 'synthetic' })
    expect(res.steps).toEqual([
      { action_id: 'h-1', step: 'POST https://example.com/a', ran: true, status: 'success', output: 'Test: not sent. It would POST https://example.com/a' },
      expect.objectContaining({ action_id: 's-1', ran: false, skipped: 'disabled' }),
    ])
  })

  it('routes to a foreign-but-member loop, and the kill switch refuses it', async () => {
    const { client } = makeClient({ flow: [flowRow(WS_OTHER)], member: [{ id: 'm', user_id: USER, workspace_id: WS_OTHER }] })
    await call(createFlowTools(USER, client, WS).test_flow, { flow_id: 'flow-1', sample: { entity_id: '22222222-2222-4222-8222-222222222222' } })
    expect(h.dry[0]).toMatchObject({ flow: { workspace_id: WS_OTHER }, sample: { entity_id: '22222222-2222-4222-8222-222222222222' } })
    h.paused = true
    expect(await call(createFlowTools(USER, client, WS).test_flow, { flow_id: 'flow-1' })).toMatchObject({ success: false, code: 'AGENT_PAUSED' })
    expect(h.dry).toHaveLength(1)
  })

  it('a loop in a workspace the caller is not in is not found', async () => {
    const { client } = makeClient({ flow: [flowRow('ws-stranger')], member: [] })
    expect(await call(createFlowTools(USER, client, WS).test_flow, { flow_id: 'flow-1' })).toMatchObject({ success: false, error: 'Flow not found' })
  })
})

describe('get_flow_run', () => {
  it('reads one run with each result beside its step', async () => {
    const { client } = makeClient({ flow_run: [run(WS)] })
    const res = await call(createFlowTools(USER, client, WS).get_flow_run, { run_id: run(WS).id })
    expect(res).toMatchObject({ success: true, run: { id: run(WS).id, flow_name: 'Nightly', workspace_id: WS } })
    expect(((res.run as Row).action_results as Row[])[0]).toMatchObject({ action_id: 'h-1', step: 'POST https://example.com/a' })
  })

  it("another workspace's run: read when the caller is a member, not found otherwise or when fenced", async () => {
    const member = makeClient({ flow_run: [run(WS_OTHER)], member: [{ id: 'm', user_id: USER, workspace_id: WS_OTHER }] })
    expect(await call(createFlowTools(USER, member.client, WS).get_flow_run, { run_id: run(WS).id })).toMatchObject({ success: true })
    expect(await call(createFlowTools(USER, member.client, WS, true).get_flow_run, { run_id: run(WS).id })).toMatchObject({ error: 'Run not found' })
    const stranger = makeClient({ flow_run: [run(WS_OTHER)], member: [] })
    expect(await call(createFlowTools(USER, stranger.client, WS).get_flow_run, { run_id: run(WS).id })).toMatchObject({ error: 'Run not found' })
  })
})

describe('list_flow_runs routing', () => {
  it("a flow_id lists that loop's runs in its own workspace", async () => {
    const { client } = makeClient({ flow: [flowRow(WS_OTHER)], member: [{ id: 'm', user_id: USER, workspace_id: WS_OTHER }], flow_run: [run(WS_OTHER)] })
    const res = await call(createFlowTools(USER, client, WS).list_flow_runs, { flow_id: 'flow-1' })
    expect(res).toMatchObject({ count: 1, workspace_id: WS_OTHER })
  })

  it('without one it is the session workspace; a fenced run never leaves it', async () => {
    const { client } = makeClient({ flow: [flowRow(WS_OTHER)], member: [{ id: 'm', user_id: USER, workspace_id: WS_OTHER }], flow_run: [run(WS_OTHER)] })
    expect(await call(createFlowTools(USER, client, WS).list_flow_runs, {})).toMatchObject({ count: 0 })
    expect(await call(createFlowTools(USER, client, WS, true).list_flow_runs, { flow_id: 'flow-1' })).toEqual({ error: 'Flow not found' })
  })
})
