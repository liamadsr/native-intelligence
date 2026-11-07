/**
 * create_flow / update_flow build everything the Flows editor builds (A1b):
 * every trigger and action type through the REST route's validators, the
 * stored row in the REST route's shape, run_skill by slug, run_agent refused
 * while its dispatch is off, schedule next_run_at, and the asks-first gate
 * (plan §6): every loop the agent creates is saved off until confirmed_with_user.
 * Also: node fields kept by id (enabled, condition, parent_id), the condition
 * in the summary, run_skill resolving only skills the caller can see.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { computeNextRun } from '@/lib/flows/schedule'
import { SEED_KEYS, seedDefaultLoops } from '@/lib/flows/seed-default-loops'
import type { FlowAction, ScheduleTriggerConfig } from '@/lib/flows/types'

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

import { featureGatedRecipeExclusions, resolveWorkspaceEditionFromSettings } from '@/lib/editions'
import { offOverrides } from '@/test/editions'
import { createFlowTools, describeCondition } from '../flows'

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

describe('describeCondition', () => {
  it('reads a condition in words; none is empty', () => {
    expect(describeCondition(null)).toBe('')
    expect(describeCondition({ match: 'all', rules: [] })).toBe('')
    expect(
      describeCondition({
        match: 'all',
        rules: [
          { field: 'label', op: 'in', value: ['customer', 'vip'] },
          { field: 'priority', op: 'is', value: '1' },
        ],
      }),
    ).toBe('if label in customer, vip and priority is 1')
    expect(
      describeCondition({ match: 'any', rules: [{ field: 'from_status', op: 'is_not', value: 'wf-x' }, { field: 'assignee', op: 'is_set', value: null }] }),
    ).toBe('if from-status is not wf-x or assignee is set')
  })
})

describe('create_flow — each trigger and action type', () => {
  it('entity_status_change + http_post: saved off like every loop, team from the status, the REST row shape', async () => {
    const { client, inserts } = seeded()
    const res = await call(createFlowTools(USER, client, WS).create_flow, {
      name: 'Ping',
      trigger: { type: 'entity_status_change', to_status_id: 'wf-done' },
      actions: [{ ...hook, bearer_token: 'secret', body_template: '{"id":"{{entity.id}}"}' }],
    })
    const row = inserts.flow![0]
    expect(row).toMatchObject({
      workspace_id: WS,
      team_id: 'team-b',
      enabled: false,
      trigger_type: 'entity_status_change',
      trigger_config: { entity_type: 'action', from_status_id: null, to_status_id: 'wf-done' },
      next_run_at: null,
      ai_team_member_id: 'bot-default',
    })
    expect(row.actions).toEqual([
      {
        id: expect.any(String),
        type: 'http_post',
        config: { method: 'POST', url: 'https://example.com/hook', headers: {}, body_template: '{"id":"{{entity.id}}"}' },
        condition: null,
        parent_id: null,
        enabled: true,
        bearer_token_encrypted: 'enc:secret',
      },
    ])
    expect(res.awaiting_go_ahead).toBe(true)
    expect(res.summary).toBe('When action status moves to wf-done → POST https://example.com/hook')
  })

  it('schedule: saved off, workspace-scoped, next_run_at from computeNextRun, summary names the next run', async () => {
    const { client, inserts } = seeded()
    const res = await call(createFlowTools(USER, client, WS).create_flow, { name: 'Daily', trigger: schedule, actions: [hook] })
    const row = inserts.flow![0]
    const cfg: ScheduleTriggerConfig = { kind: 'schedule', cadence: 'weekdays', time: '09:00', timezone: 'America/New_York' }
    expect(row).toMatchObject({ team_id: null, enabled: false, trigger_type: 'schedule', trigger_config: cfg })
    expect(row.next_run_at).toBe(computeNextRun(cfg, NOW).toISOString())
    expect(res).toMatchObject({ enabled: false, awaiting_go_ahead: true, next_run_at: row.next_run_at })
    expect(res.summary).toMatch(/^Every weekday at 09:00 \(America\/New_York\) → POST https:\/\/example\.com\/hook\. next run Wed, Oct 14, 09:00$/)
    expect(res.note).toContain(`update_flow { flow_id: "${(res.flow as { id: string }).id}", enabled: true, confirmed_with_user: true }`)
  })

  it("schedule with no timezone takes the person's zone, else names trigger.timezone", async () => {
    const { client, inserts } = seeded()
    const trigger = { type: 'schedule', cadence: 'daily', time: '08:30' }
    await call(createFlowTools(USER, client, WS, false, 'session', 'Europe/London').create_flow, { name: 'A', trigger, actions: [hook] })
    expect(inserts.flow![0].trigger_config).toEqual({ kind: 'schedule', cadence: 'daily', time: '08:30', timezone: 'Europe/London' })

    const res = await call(createFlowTools(USER, seeded().client, WS).create_flow, { name: 'B', trigger, actions: [hook] })
    expect(res).toMatchObject({ success: false, field: 'trigger.timezone' })
    expect(res.error).toMatch(/^trigger\.timezone: .*IANA zone/)
  })

  it('schedule validation errors name the trigger field and the allowed values', async () => {
    const tools = createFlowTools(USER, seeded().client, WS)
    const bad = await call(tools.create_flow, { name: 'A', trigger: { ...schedule, cadence: 'monthly' }, actions: [hook] })
    expect(bad).toMatchObject({ success: false, field: 'trigger.cadence' })
    expect(bad.error).toBe('trigger.cadence must be one of: hourly, daily, weekdays, weekly')
    const noDay = await call(tools.create_flow, { name: 'A', trigger: { ...schedule, cadence: 'weekly' }, actions: [hook] })
    expect(noDay).toMatchObject({ field: 'trigger.weekday' })
    const tz = await call(tools.create_flow, { name: 'A', trigger: { ...schedule, timezone: 'Mars/Base' }, actions: [hook] })
    expect(tz).toMatchObject({ field: 'trigger.timezone' })
  })

  it('capture_processed + archive_capture: saved off, bare configs', async () => {
    const { client, inserts } = seeded()
    const res = await call(createFlowTools(USER, client, WS).create_flow, {
      name: 'Tidy',
      trigger: { type: 'capture_processed' },
      actions: [{ type: 'archive_capture' }],
    })
    expect(inserts.flow![0]).toMatchObject({
      team_id: null,
      enabled: false,
      trigger_type: 'capture_processed',
      trigger_config: { kind: 'capture_processed' },
      next_run_at: null,
    })
    expect((inserts.flow![0].actions as Row[])[0]).toMatchObject({ type: 'archive_capture', config: {} })
    expect(res.summary).toBe('When a meeting capture finishes processing → archive the capture')
  })

  it('pr_status_changed + run_skill (F1): workspace-scoped, saved off, the state as to_state', async () => {
    const { client, inserts } = seeded()
    const res = await call(createFlowTools(USER, client, WS).create_flow, {
      name: 'Merged',
      trigger: { type: 'pr_status_changed', repo_full_name: 'acme/web', pr_state: 'merged' },
      actions: [{ type: 'run_skill', skill: SKILL_WS }],
    })
    expect(inserts.flow![0]).toMatchObject({
      team_id: null,
      enabled: false,
      trigger_type: 'pr_status_changed',
      trigger_config: { kind: 'pr_status_changed', repo_full_name: 'acme/web', to_state: 'merged' },
      next_run_at: null,
    })
    expect(String(res.summary)).toMatch(/^When a pull request in acme\/web linked to an action merges → run skill/)
  })

  it('pr_status_changed without a repo names trigger.repo_full_name; a bad state names trigger.to_state', async () => {
    const { client, inserts } = seeded()
    const tools = createFlowTools(USER, client, WS)
    expect(await call(tools.create_flow, { name: 'X', trigger: { type: 'pr_status_changed' }, actions: [hook] })).toMatchObject({
      success: false,
      field: 'trigger.repo_full_name',
    })
    expect(
      await call(tools.create_flow, { name: 'X', trigger: { type: 'pr_status_changed', repo_full_name: 'acme/web', pr_state: 'approved' }, actions: [hook] }),
    ).toMatchObject({ success: false, field: 'trigger.to_state' })
    expect(inserts.flow).toBeUndefined()
  })

  it('archive_capture on another trigger is refused, naming actions[i].type', async () => {
    const { client, inserts } = seeded()
    const res = await call(createFlowTools(USER, client, WS).create_flow, {
      name: 'X',
      trigger: schedule,
      actions: [hook, { type: 'archive_capture' }],
    })
    expect(res).toMatchObject({ success: false, field: 'actions[1].type' })
    expect(res.error).toContain('capture_processed')
    expect(inserts.flow).toBeUndefined()
  })

  it('calendar_event + run_skill by slug: the workspace skill wins, report mode by default', async () => {
    const { client, inserts } = seeded()
    const res = await call(createFlowTools(USER, client, WS).create_flow, {
      name: 'Prep',
      trigger: { type: 'calendar_event', event_title: '  Standup ', offset_minutes: -15 },
      actions: [{ type: 'run_skill', skill: 'standup-prep', instructions: 'Keep it short' }],
    })
    const row = inserts.flow![0]
    expect(row).toMatchObject({
      enabled: false,
      team_id: null,
      trigger_type: 'calendar_event',
      trigger_config: { kind: 'calendar_event', event_title: 'Standup', offset_minutes: -15 },
      next_run_at: null,
    })
    expect((row.actions as Row[])[0]).toMatchObject({
      type: 'run_skill',
      config: { skill_id: SKILL_WS, mode: 'report', instructions: 'Keep it short' },
    })
    expect(res.summary).toBe('15 min before each "Standup" → run skill "Standup prep (ours)" (report: changes nothing)')
  })

  it('run_skill by id, act mode and deliver flags pass through validateRunSkillConfig', async () => {
    const { client, inserts } = seeded()
    await call(createFlowTools(USER, client, WS).create_flow, {
      name: 'Groom',
      trigger: schedule,
      actions: [{ type: 'run_skill', skill: SKILL_OTHER_WS, mode: 'act', deliver_document: false }],
    })
    expect((inserts.flow![0].actions as Row[])[0].config).toEqual({
      skill_id: SKILL_OTHER_WS,
      mode: 'act',
      deliver: { document: false },
    })
  })

  it('a run_skill on a status trigger is still saved off (an agent action)', async () => {
    const { client, inserts } = seeded()
    const res = await call(createFlowTools(USER, client, WS).create_flow, {
      name: 'Review',
      trigger: { type: 'entity_status_change', to_status_id: 'wf-done' },
      actions: [{ type: 'run_skill', skill: 'weekly-groom' }],
    })
    expect(inserts.flow![0].enabled).toBe(false)
    expect(res.awaiting_go_ahead).toBe(true)
  })

  it('an unknown skill names actions[i].skill and writes nothing', async () => {
    const { client, inserts } = seeded()
    const res = await call(createFlowTools(USER, client, WS).create_flow, {
      name: 'X',
      trigger: schedule,
      actions: [{ type: 'run_skill', skill: 'no-such-skill' }],
    })
    expect(res).toMatchObject({ success: false, field: 'actions[0].skill' })
    expect(res.error).toBe('actions[0].skill: no skill "no-such-skill" in this workspace. Call list_skills and pass one of its slugs or ids')
    expect(inserts.flow).toBeUndefined()
  })

  it('a missing skill or url names the field', async () => {
    const tools = createFlowTools(USER, seeded().client, WS)
    expect(await call(tools.create_flow, { name: 'X', trigger: schedule, actions: [{ type: 'run_skill' }] })).toMatchObject({
      field: 'actions[0].skill',
    })
    expect(await call(tools.create_flow, { name: 'X', trigger: schedule, actions: [{}] })).toMatchObject({ field: 'actions[0].url' })
    const priv = await call(tools.create_flow, { name: 'X', trigger: schedule, actions: [{ url: 'http://localhost:3000/x' }] })
    expect(priv).toMatchObject({ success: false, field: 'actions[0].url' })
    expect(priv.error).toContain('public host')
  })

  it('run_agent is refused while its dispatch is off', async () => {
    const { client, inserts } = seeded()
    const res = await call(createFlowTools(USER, client, WS).create_flow, {
      name: 'Code',
      trigger: schedule,
      actions: [{ type: 'run_agent', agent_id: AGENT, repo: 'acme/app', instructions: 'Fix lint' }],
    })
    expect(res).toMatchObject({ success: false, field: 'actions[0].type' })
    expect(res.error).toContain('run_agent is switched off')
    expect(inserts.flow).toBeUndefined()
  })

  it('run_agent, when enabled, validates through validateRunAgentConfig and is saved off', async () => {
    agentFlag.on = true
    const { client, inserts } = seeded()
    const tools = createFlowTools(USER, client, WS)
    const noRepo = await call(tools.create_flow, { name: 'Code', trigger: schedule, actions: [{ type: 'run_agent', agent_id: AGENT }] })
    expect(noRepo).toMatchObject({ success: false, field: 'actions[0].repo' })

    await call(tools.create_flow, {
      name: 'Code',
      trigger: schedule,
      actions: [{ type: 'run_agent', agent_id: AGENT, repo: 'acme/app', instructions: 'Fix lint' }],
    })
    expect(inserts.flow![0]).toMatchObject({ enabled: false })
    expect((inserts.flow![0].actions as Row[])[0]).toMatchObject({
      type: 'run_agent',
      config: { agent_id: AGENT, repo: 'acme/app', instructions: 'Fix lint' },
    })
  })
})

describe('create_flow — what the person asks for is on (Liam, 2026-10-20)', () => {
  it('a draft-only loop they asked for (enabled: true) is saved ON, with no card and no wait for a yes', async () => {
    const { client, inserts } = seeded()
    const res = await call(createFlowTools(USER, client, WS).create_flow, { name: 'A', trigger: schedule, actions: [{ type: 'run_skill', skill: SKILL_WS }], enabled: true })
    expect(inserts.flow![0].enabled).toBe(true)
    expect(res).toMatchObject({ enabled: true })
    expect(res.awaiting_go_ahead).toBeUndefined()
    expect(String(res.note)).toMatch(/ON, as they asked/)
    expect(approvals.calls).toEqual([])
  })

  it('an act-mode skill loop they asked for is on too: its writes are internal and undoable', async () => {
    const { client, inserts } = seeded()
    const res = await call(createFlowTools(USER, client, WS).create_flow, { name: 'A', trigger: schedule, actions: [{ type: 'run_skill', skill: SKILL_WS, mode: 'act' }], enabled: true })
    expect(inserts.flow![0].enabled).toBe(true)
    expect(res.awaiting_approval).toBeUndefined()
    expect(approvals.calls).toEqual([])
  })

  it("a webhook (http_post) loop is the one exception, Liam's decision: saved OFF and its switch-on card raised, whatever was said", async () => {
    const { client, inserts } = seeded()
    const res = await call(createFlowTools(USER, client, WS).create_flow, { name: 'A', trigger: schedule, actions: [hook], enabled: true })
    expect(inserts.flow![0].enabled).toBe(false)
    expect(res).toMatchObject({ enabled: false, awaiting_approval: true, approval_id: 'appr-1' })
    expect(res.awaiting_go_ahead).toBeUndefined()
    expect(approvals.calls[0]).toMatchObject({ door: 'chat', userId: USER, toolName: 'update_flow', input: { enabled: true, loop: 'A' } })
  })

  it('a loop the agent proposes on its own (enabled left out) is saved OFF and waits for the yes', async () => {
    for (const actions of [[{ type: 'run_skill', skill: SKILL_WS }], [hook]]) {
      const { client, inserts } = seeded()
      const res = await call(createFlowTools(USER, client, WS).create_flow, { name: 'A', trigger: schedule, actions })
      expect(inserts.flow![0].enabled).toBe(false)
      expect(res).toMatchObject({ enabled: false, awaiting_go_ahead: true })
      expect(String(res.note)).toContain('update_flow')
    }
    expect(approvals.calls).toEqual([])
  })

  it('a turn that read outside text (#835 S1): an asked-for loop is saved OFF, waits for the yes, and asks in the chat, with no card', async () => {
    const { client, inserts } = seeded()
    const res = await call(createFlowTools(USER, client, WS, false, 'session', undefined, { turnReadOutside: () => ['read_email'] }).create_flow, {
      name: 'A',
      trigger: schedule,
      actions: [{ type: 'run_skill', skill: SKILL_WS }],
      enabled: true,
    })
    expect(inserts.flow![0].enabled).toBe(false)
    expect(res).toMatchObject({ enabled: false, awaiting_go_ahead: true, saved_off_because: 'outside_text' })
    expect(String(res.note)).toMatch(/this turn read an outside email/)
    expect(String(res.note)).toMatch(/in your reply/)
    expect(approvals.calls).toEqual([])
    expect(inserts.attention_item).toBeUndefined()
  })

  it('a webhook loop asked for in such a turn is saved off with no card yet: the card comes with the yes', async () => {
    const { client, inserts } = seeded()
    const res = await call(createFlowTools(USER, client, WS, false, 'session', undefined, { turnReadOutside: () => ['get_email_summary'] }).create_flow, { name: 'A', trigger: schedule, actions: [hook], enabled: true })
    expect(inserts.flow![0].enabled).toBe(false)
    expect(res).toMatchObject({ awaiting_go_ahead: true, saved_off_because: 'outside_text' })
    expect(approvals.calls).toEqual([])
  })

  it('a turn that read nothing outside keeps the asked-for loop on', async () => {
    const { client, inserts } = seeded()
    await call(createFlowTools(USER, client, WS, false, 'session', undefined, { turnReadOutside: () => [] }).create_flow, { name: 'A', trigger: schedule, actions: [{ type: 'run_skill', skill: SKILL_WS }], enabled: true })
    expect(inserts.flow![0].enabled).toBe(true)
  })

  it('confirmed_with_user is no create_flow field: alone it switches nothing on', async () => {
    const { client, inserts } = seeded()
    const res = await call(createFlowTools(USER, client, WS).create_flow, { name: 'A', trigger: schedule, actions: [{ type: 'run_skill', skill: SKILL_WS }], confirmed_with_user: true })
    expect(inserts.flow![0].enabled).toBe(false)
    expect(res).toMatchObject({ awaiting_go_ahead: true })
  })
})

describe('create_flow — status trigger team and field errors', () => {
  it('a missing to_status_id names trigger.to_status_id', async () => {
    const res = await call(createFlowTools(USER, seeded().client, WS).create_flow, {
      name: 'A',
      trigger: { type: 'entity_status_change' },
      actions: [hook],
    })
    expect(res).toMatchObject({ success: false, field: 'trigger.to_status_id' })
  })

  it("a status from another workspace's team names trigger.to_status_id", async () => {
    const res = await call(createFlowTools(USER, seeded().client, WS).create_flow, {
      name: 'A',
      trigger: { type: 'entity_status_change', to_status_id: 'wf-foreign' },
      actions: [hook],
    })
    expect(res).toMatchObject({ success: false, field: 'trigger.to_status_id' })
    expect(res.error).toContain('list_workflow_states')
  })

  it("a team_id that isn't the status's team names team_id", async () => {
    const res = await call(createFlowTools(USER, seeded().client, WS).create_flow, {
      name: 'A',
      team_id: 'team-a',
      trigger: { type: 'entity_status_change', to_status_id: 'wf-done' },
      actions: [hook],
    })
    expect(res).toMatchObject({ success: false, field: 'team_id' })
  })

  it('a project loop with no team_id takes the first team; a bad status word lists the valid ones', async () => {
    const { client, inserts } = seeded()
    const tools = createFlowTools(USER, client, WS)
    await call(tools.create_flow, {
      name: 'A',
      trigger: { type: 'entity_status_change', entity_type: 'project', to_status_id: 'completed' },
      actions: [hook],
    })
    expect(inserts.flow![0]).toMatchObject({ team_id: 'team-a', enabled: false })

    const bad = await call(tools.create_flow, {
      name: 'A',
      trigger: { type: 'entity_status_change', entity_type: 'project', to_status_id: 'shipped' },
      actions: [hook],
    })
    expect(bad).toMatchObject({ success: false, field: 'trigger.to_status_id' })
    expect(bad.error).toContain('Valid:')
  })
})

describe('update_flow', () => {
  const scheduleCfg: ScheduleTriggerConfig = { kind: 'schedule', cadence: 'daily', time: '07:00', timezone: 'America/New_York' }
  function withFlow(over: Row = {}) {
    return seeded({
      flow: [
        {
          id: 'flow-1',
          workspace_id: WS,
          team_id: null,
          name: 'Morning',
          enabled: false,
          trigger_type: 'schedule',
          trigger_config: scheduleCfg,
          actions: [
            {
              id: 'act-1',
              type: 'http_post',
              config: { method: 'POST', url: 'https://example.com/a', headers: {}, body_template: '' },
              condition: null,
              parent_id: null,
              enabled: true,
              bearer_token_encrypted: 'enc:old',
            },
          ],
          created_by: USER,
          next_run_at: '2020-01-01T00:00:00.000Z',
          ...over,
        },
      ],
    })
  }
  const reportSkill = { id: 'rs-1', type: 'run_skill', config: { skill_id: SKILL_WS, mode: 'report' }, condition: null, parent_id: null, enabled: true }

  it('switching on a draft-only loop needs confirmed_with_user; with it next_run_at is recomputed', async () => {
    const { client, tables } = withFlow({ actions: [reportSkill] })
    const tools = createFlowTools(USER, client, WS)
    const refused = await call(tools.update_flow, { flow_id: 'flow-1', enabled: true })
    expect(refused).toMatchObject({ success: false, field: 'confirmed_with_user', needs_go_ahead: true })
    expect(tables.flow[0].enabled).toBe(false)

    const res = await call(tools.update_flow, { flow_id: 'flow-1', enabled: true, confirmed_with_user: true })
    expect(tables.flow[0].enabled).toBe(true)
    expect(tables.flow[0].next_run_at).toBe(computeNextRun(scheduleCfg, NOW).toISOString())
    expect(res).toMatchObject({ enabled: true, next_run_at: tables.flow[0].next_run_at })
  })

  it('switching on a risky loop (an HTTP call) with the yes leaves it off and raises its card; the slot is not moved', async () => {
    const { client, tables } = withFlow()
    const res = await call(createFlowTools(USER, client, WS).update_flow, { flow_id: 'flow-1', enabled: true, confirmed_with_user: true })
    expect(tables.flow[0].enabled).toBe(false)
    expect(tables.flow[0].next_run_at).toBe('2020-01-01T00:00:00.000Z')
    expect(res).toMatchObject({ enabled: false, awaiting_approval: true })
    expect(approvals.calls).toHaveLength(1)
  })

  it('switching off never needs a yes', async () => {
    const { client, tables } = withFlow({ enabled: true })
    await call(createFlowTools(USER, client, WS).update_flow, { flow_id: 'flow-1', enabled: false })
    expect(tables.flow[0].enabled).toBe(false)
  })

  it('changing an on status loop into a schedule needs a yes, or saves it off', async () => {
    const { client, tables } = withFlow({
      enabled: true,
      team_id: 'team-b',
      trigger_type: 'entity_status_change',
      trigger_config: { entity_type: 'action', from_status_id: null, to_status_id: 'wf-done' },
      next_run_at: null,
    })
    const tools = createFlowTools(USER, client, WS)
    const refused = await call(tools.update_flow, { flow_id: 'flow-1', trigger: schedule })
    expect(refused).toMatchObject({ field: 'confirmed_with_user' })

    const res = await call(tools.update_flow, { flow_id: 'flow-1', trigger: schedule, enabled: false })
    expect(tables.flow[0]).toMatchObject({ enabled: false, trigger_type: 'schedule', team_id: null, created_by: USER })
    expect(res.awaiting_go_ahead).toBe(true)
  })

  it('a same-type trigger edit keeps the fields it omits and moves next_run_at', async () => {
    const { client, tables } = withFlow()
    await call(createFlowTools(USER, client, WS).update_flow, { flow_id: 'flow-1', trigger: { type: 'schedule', time: '18:15' } })
    const cfg = { ...scheduleCfg, time: '18:15' }
    expect(tables.flow[0].trigger_config).toEqual(cfg)
    expect(tables.flow[0].next_run_at).toBe(computeNextRun(cfg, NOW).toISOString())
  })

  it('replacing actions runs the same validation (skill slugs, field errors) and keeps tokens by id', async () => {
    const { client, tables } = withFlow()
    const tools = createFlowTools(USER, client, WS)
    const bad = await call(tools.update_flow, { flow_id: 'flow-1', actions: [{ type: 'run_skill', skill: 'nope' }] })
    expect(bad).toMatchObject({ success: false, field: 'actions[0].skill' })

    await call(tools.update_flow, {
      flow_id: 'flow-1',
      actions: [{ id: 'act-1', url: 'https://example.com/b' }, { type: 'run_skill', skill: 'weekly-groom' }],
    })
    const actions = tables.flow[0].actions as Row[]
    expect(actions[0]).toMatchObject({ id: 'act-1', bearer_token_encrypted: 'enc:old', config: { url: 'https://example.com/b' } })
    expect(actions[1]).toMatchObject({ type: 'run_skill', config: { skill_id: SKILL_OTHER_WS, mode: 'report' } })
  })

  it('a trigger change away from capture_processed with a kept archive_capture names the action', async () => {
    const { client } = withFlow({
      trigger_type: 'capture_processed',
      trigger_config: { kind: 'capture_processed' },
      actions: [{ id: 'arch', type: 'archive_capture', config: {}, condition: null, parent_id: null, enabled: true }],
    })
    const res = await call(createFlowTools(USER, client, WS).update_flow, { flow_id: 'flow-1', trigger: schedule })
    expect(res).toMatchObject({ success: false, field: 'actions[0].type' })
  })

  it('team_id without a trigger names team_id', async () => {
    const res = await call(createFlowTools(USER, withFlow().client, WS).update_flow, { flow_id: 'flow-1', team_id: '55555555-5555-4555-8555-555555555555' })
    expect(res).toMatchObject({ success: false, field: 'team_id' })
  })
})

describe('update_flow — an action re-sent by id keeps what the call leaves out', () => {
  const TRIAGE = '66666666-6666-4666-8666-666666666666'
  const MODEL = 'claude-haiku-4-5-20251001'

  /** The seeded Triage loop's action, built by seedDefaultLoops itself. */
  async function seededTriageAction(): Promise<FlowAction> {
    let rows: Row[] = []
    const chain = (data: unknown) => {
      const c: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'not', 'in']) c[m] = () => c
      c.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve)
      return c
    }
    const service = {
      from: (table: string) => {
        if (table === 'recipe') return chain([{ id: TRIAGE, slug: 'triage' }])
        const c = chain([]) as Record<string, unknown>
        c.insert = (r: Row[]) => {
          rows = r
          return chain([])
        }
        return c
      },
    }
    await seedDefaultLoops(service as never, { workspaceId: WS, createdByUserId: USER })
    return (rows[0].actions as FlowAction[])[0]
  }

  function withActions(actions: Row[], over: Row = {}) {
    return seeded({
      recipe: [
        { id: TRIAGE, slug: 'triage', name: 'Triage', category: 'skill', workspace_id: null, is_system: true },
        { id: SKILL_SYS, slug: 'standup-prep', name: 'Standup prep', category: 'skill', workspace_id: null, is_system: true },
      ],
      flow: [
        {
          id: 'flow-1',
          workspace_id: WS,
          team_id: null,
          name: 'Triage after every capture',
          enabled: false,
          trigger_type: 'capture_processed',
          trigger_config: { kind: 'capture_processed' },
          actions,
          created_by: USER,
          next_run_at: null,
          ...over,
        },
      ],
    })
  }
  const stored = (tables: Record<string, Row[]>) => tables.flow[0].actions as Row[]

  it("editing the seeded Triage loop's action keeps its act mode, auto-apply trust and delivery", async () => {
    const triage = await seededTriageAction()
    expect(triage.config).toMatchObject({ mode: 'act', trust: { auto_apply: true }, deliver: { document: false } })
    const { client, tables } = withActions([triage as unknown as Row], { enabled: true, seed_key: SEED_KEYS.triage })
    const res = await call(createFlowTools(USER, client, WS).update_flow, {
      flow_id: 'flow-1',
      actions: [{ id: triage.id, skill: 'triage', instructions: 'Flag anything due this week.' }],
      confirmed_with_user: true,
    })
    expect(res.success).not.toBe(false)
    expect(stored(tables)).toEqual([
      { ...triage, config: { ...triage.config, instructions: 'Flag anything due this week.' }, bearer_token_encrypted: null },
    ])
  })

  it('keeps deliver.document_title, changes only what the call sets, and drops a stored model (the old pin)', async () => {
    const action = {
      id: 'rs-1',
      type: 'run_skill',
      config: {
        skill_id: SKILL_SYS,
        mode: 'act',
        instructions: 'old',
        deliver: { document: true, notification: true, document_title: 'Standup {date}' },
        trust: { auto_apply: true, min_confidence: 0.9, allow_external: false, max_cards_per_run: 5 },
        model: MODEL,
      },
      condition: null,
      parent_id: null,
      enabled: true,
      bearer_token_encrypted: null,
    }
    const { client, tables } = withActions([action])
    const tools = createFlowTools(USER, client, WS)
    await call(tools.update_flow, { flow_id: 'flow-1', actions: [{ id: 'rs-1', type: 'run_skill', deliver_notification: false, instructions: '' }] })
    expect(stored(tables)[0].config).toEqual({
      skill_id: SKILL_SYS,
      mode: 'act',
      deliver: { document: true, notification: false, document_title: 'Standup {date}' },
      trust: action.config.trust,
    })

    // The server picks the model per run: even an untouched re-send drops it.
    const { client: c2, tables: t2 } = withActions([action])
    await call(createFlowTools(USER, c2, WS).update_flow, { flow_id: 'flow-1', actions: [{ id: 'rs-1' }] })
    expect(stored(t2)[0].config).not.toHaveProperty('model')
    expect(stored(t2)[0].config).toMatchObject({ mode: 'act', trust: { auto_apply: true } })
  })

  it('never widens: report moved to act keeps the trust but not auto-apply; another skill drops mode and trust', async () => {
    const reportAction = {
      id: 'rs-1',
      type: 'run_skill',
      config: {
        skill_id: TRIAGE,
        mode: 'report',
        trust: { auto_apply: true, min_confidence: 0.85, allow_external: false, max_cards_per_run: 3 },
        deliver: { document: false },
      },
      condition: null,
      parent_id: null,
      enabled: true,
      bearer_token_encrypted: null,
    }
    const { client, tables } = withActions([reportAction])
    await call(createFlowTools(USER, client, WS).update_flow, { flow_id: 'flow-1', actions: [{ id: 'rs-1', mode: 'act' }] })
    expect(stored(tables)[0].config).toMatchObject({ mode: 'act', trust: { auto_apply: false, min_confidence: 0.85 } })

    const { client: c2, tables: t2 } = withActions([{ ...reportAction, config: { ...reportAction.config, mode: 'act' } }])
    await call(createFlowTools(USER, c2, WS).update_flow, { flow_id: 'flow-1', actions: [{ id: 'rs-1', skill: 'standup-prep' }] })
    // Another skill starts fresh: no mode, trust, delivery or instructions carried across.
    expect(stored(t2)[0].config).toEqual({ skill_id: SKILL_SYS, mode: 'report' })
  })

  it('another skill carries no instructions or delivery; the same skill keeps them (never a model)', async () => {
    const action = {
      id: 'rs-1',
      type: 'run_skill',
      config: { skill_id: TRIAGE, mode: 'report', instructions: 'Triage only', deliver: { document: false }, model: MODEL },
      condition: null,
      parent_id: null,
      enabled: true,
      bearer_token_encrypted: null,
    }
    const { client, tables } = withActions([action])
    await call(createFlowTools(USER, client, WS).update_flow, { flow_id: 'flow-1', actions: [{ id: 'rs-1', skill: 'standup-prep' }] })
    expect(stored(tables)[0].config).toEqual({ skill_id: SKILL_SYS, mode: 'report' })

    const { client: c2, tables: t2 } = withActions([action])
    await call(createFlowTools(USER, c2, WS).update_flow, { flow_id: 'flow-1', actions: [{ id: 'rs-1', skill: 'triage', deliver_notification: false }] })
    expect(stored(t2)[0].config).toEqual({
      skill_id: TRIAGE,
      mode: 'report',
      instructions: 'Triage only',
      deliver: { document: false, notification: false },
    })
  })

  it('a new run_skill action (no id, or an unknown id) gets the defaults', async () => {
    const triage = await seededTriageAction()
    const { client, tables } = withActions([triage as unknown as Row])
    await call(createFlowTools(USER, client, WS).update_flow, {
      flow_id: 'flow-1',
      actions: [
        { type: 'run_skill', skill: 'triage' },
        { id: 'not-stored', type: 'run_skill', skill: 'triage' },
      ],
    })
    const [a, b] = stored(tables)
    expect(a.config).toEqual({ skill_id: TRIAGE, mode: 'report' })
    expect(b).toMatchObject({ id: 'not-stored', config: { skill_id: TRIAGE, mode: 'report' } })
    expect(b.config).toEqual({ skill_id: TRIAGE, mode: 'report' })
  })

  it('a type change by id carries no fields across types', async () => {
    const triage = await seededTriageAction()
    const hookAction = {
      id: 'h-1',
      type: 'http_post',
      config: { method: 'PUT', url: 'https://example.com/a', headers: { 'X-Key': 'k' }, body_template: '{}' },
      condition: null,
      parent_id: null,
      enabled: true,
      bearer_token_encrypted: 'enc:old',
    }
    const { client, tables } = withActions([triage as unknown as Row, hookAction])
    const res = await call(createFlowTools(USER, client, WS).update_flow, {
      flow_id: 'flow-1',
      actions: [
        { id: triage.id, type: 'http_post' },
        { id: triage.id, type: 'http_post', url: 'https://example.com/new' },
      ],
    })
    expect(res).toMatchObject({ success: false, field: 'actions[0].url' })

    await call(createFlowTools(USER, client, WS).update_flow, {
      flow_id: 'flow-1',
      actions: [
        { id: triage.id, type: 'http_post', url: 'https://example.com/new' },
        { id: 'h-1', type: 'run_skill', skill: 'triage' },
      ],
    })
    const [a, b] = stored(tables)
    expect(a.config).toEqual({ method: 'POST', url: 'https://example.com/new', headers: {}, body_template: '' })
    expect(b.config).toEqual({ skill_id: TRIAGE, mode: 'report' })
  })

  it('an http_post by id keeps its method, headers, body and url; the bearer token rotates, clears or stays as before', async () => {
    const hook = (id: string) => ({
      id,
      type: 'http_post',
      config: { method: 'PUT', url: `https://example.com/${id}`, headers: { 'X-Key': 'k' }, body_template: '{"a":1}' },
      condition: null,
      parent_id: null,
      enabled: true,
      bearer_token_encrypted: `enc:${id}`,
    })
    const { client, tables } = withActions([hook('h-1'), hook('h-2'), hook('h-3')], {
      trigger_type: 'entity_status_change',
      trigger_config: { entity_type: 'action', from_status_id: null, to_status_id: 'wf-done' },
      team_id: 'team-b',
    })
    await call(createFlowTools(USER, client, WS).update_flow, {
      flow_id: 'flow-1',
      actions: [
        { id: 'h-1', body_template: '{"b":2}' },
        { id: 'h-2', bearer_token: 'fresh' },
        { id: 'h-3', bearer_token: null },
      ],
    })
    const [a, b, c] = stored(tables)
    expect(a).toMatchObject({
      config: { method: 'PUT', url: 'https://example.com/h-1', headers: { 'X-Key': 'k' }, body_template: '{"b":2}' },
      bearer_token_encrypted: 'enc:h-1',
    })
    expect(b.bearer_token_encrypted).toBe('enc:fresh')
    expect(c.bearer_token_encrypted).toBeNull()
  })
})

describe('update_flow — a matched action keeps its node fields (enabled, condition, parent_id)', () => {
  const COND = { match: 'all', rules: [{ field: 'label', op: 'in', value: ['customer'] }] }
  const node = (id: string, over: Row = {}): Row => ({
    id,
    type: 'http_post',
    config: { method: 'POST', url: `https://example.com/${id}`, headers: {}, body_template: '' },
    condition: null,
    parent_id: null,
    enabled: true,
    bearer_token_encrypted: null,
    ...over,
  })
  function withNodes(actions: Row[]) {
    return seeded({
      flow: [
        {
          id: 'flow-1',
          workspace_id: WS,
          team_id: 'team-b',
          name: 'Ping',
          enabled: false,
          trigger_type: 'entity_status_change',
          trigger_config: { entity_type: 'action', from_status_id: null, to_status_id: 'wf-done' },
          actions,
          created_by: USER,
          next_run_at: null,
        },
      ],
    })
  }
  const stored = (tables: Record<string, Row[]>) => tables.flow[0].actions as Row[]

  it('an omitted condition is kept, and the summary says it', async () => {
    const { client, tables } = withNodes([node('h-1', { condition: COND })])
    const res = await call(createFlowTools(USER, client, WS).update_flow, { flow_id: 'flow-1', actions: [{ id: 'h-1', url: 'https://example.com/new' }] })
    expect(stored(tables)[0]).toMatchObject({ condition: COND, config: { url: 'https://example.com/new' } })
    expect(res.summary).toBe('When action status moves to wf-done → POST https://example.com/new (if label in customer)')
  })

  it('an explicit null clears the condition and the parent', async () => {
    const { client, tables } = withNodes([node('root'), node('child', { condition: COND, parent_id: 'root' })])
    await call(createFlowTools(USER, client, WS).update_flow, {
      flow_id: 'flow-1',
      actions: [{ id: 'root' }, { id: 'child', condition: null, parent_id: null }],
    })
    expect(stored(tables)[1]).toMatchObject({ id: 'child', condition: null, parent_id: null })
  })

  it('a disabled action stays disabled when enabled is omitted; a new action defaults to enabled', async () => {
    const { client, tables } = withNodes([node('h-1', { enabled: false })])
    const res = await call(createFlowTools(USER, client, WS).update_flow, {
      flow_id: 'flow-1',
      actions: [{ id: 'h-1', body_template: '{}' }, { url: 'https://example.com/added' }],
    })
    expect(stored(tables)[0]).toMatchObject({ id: 'h-1', enabled: false })
    expect(stored(tables)[1]).toMatchObject({ enabled: true })
    expect(res.summary).toContain('POST https://example.com/h-1 [disabled]')
  })

  it('the parent is kept when omitted', async () => {
    const { client, tables } = withNodes([node('root'), node('child', { parent_id: 'root' })])
    await call(createFlowTools(USER, client, WS).update_flow, { flow_id: 'flow-1', actions: [{ id: 'root' }, { id: 'child', url: 'https://example.com/c2' }] })
    expect(stored(tables)[1]).toMatchObject({ id: 'child', parent_id: 'root', config: { url: 'https://example.com/c2' } })
  })

  it('a type change by id keeps the node fields (they belong to the node) but no config', async () => {
    const { client, tables } = withNodes([node('root'), node('child', { condition: COND, parent_id: 'root', enabled: false })])
    await call(createFlowTools(USER, client, WS).update_flow, {
      flow_id: 'flow-1',
      actions: [{ id: 'root' }, { id: 'child', type: 'run_skill', skill: 'weekly-groom' }],
    })
    expect(stored(tables)[1]).toEqual({
      id: 'child',
      type: 'run_skill',
      config: { skill_id: SKILL_OTHER_WS, mode: 'report' },
      condition: COND,
      parent_id: 'root',
      enabled: false,
      bearer_token_encrypted: null,
    })
  })
})

describe('asks first: every loop, on create and on change', () => {
  const statusLoop = (over: Row = {}) =>
    seeded({
      flow: [
        {
          id: 'flow-1',
          workspace_id: WS,
          team_id: 'team-b',
          name: 'Ping',
          enabled: true,
          trigger_type: 'entity_status_change',
          trigger_config: { entity_type: 'action', from_status_id: null, to_status_id: 'wf-done' },
          actions: [
            { id: 'h-1', type: 'http_post', config: { method: 'POST', url: 'https://example.com/a', headers: {}, body_template: '' }, condition: null, parent_id: null, enabled: true },
          ],
          created_by: USER,
          next_run_at: null,
          ...over,
        },
      ],
    })

  it('a status loop of HTTP calls the person asked for is saved off behind its card; one the agent proposes waits for the yes', async () => {
    const trigger = { type: 'entity_status_change', to_status_id: 'wf-done' }
    const asked = seeded()
    const res = await call(createFlowTools(USER, asked.client, WS).create_flow, { name: 'A', trigger, actions: [hook], enabled: true })
    expect(asked.inserts.flow![0].enabled).toBe(false)
    expect(res).toMatchObject({ enabled: false, awaiting_approval: true })
    expect(approvals.calls).toHaveLength(1)
    const proposed = seeded()
    const off = await call(createFlowTools(USER, proposed.client, WS).create_flow, { name: 'A', trigger, actions: [hook] })
    expect(proposed.inserts.flow![0].enabled).toBe(false)
    expect(off).toMatchObject({ enabled: false, awaiting_go_ahead: true })
    expect(approvals.calls).toHaveLength(1)
  })

  it("re-aiming an on status loop's HTTP action needs the yes, and then the card: the loop goes off until it", async () => {
    const { client, tables } = statusLoop()
    const tools = createFlowTools(USER, client, WS)
    const refused = await call(tools.update_flow, { flow_id: 'flow-1', actions: [{ id: 'h-1', url: 'https://evil.example.com/x' }] })
    expect(refused).toMatchObject({ success: false, field: 'confirmed_with_user', needs_go_ahead: true })
    expect((tables.flow[0].actions as Row[])[0]).toMatchObject({ config: { url: 'https://example.com/a' } })
    const res = await call(tools.update_flow, { flow_id: 'flow-1', actions: [{ id: 'h-1', url: 'https://example.com/b' }], confirmed_with_user: true })
    expect((tables.flow[0].actions as Row[])[0]).toMatchObject({ config: { url: 'https://example.com/b' } })
    expect(tables.flow[0].enabled).toBe(false)
    expect(res).toMatchObject({ awaiting_approval: true })
    expect(String(res.note)).toContain('It was on: it is off until they accept')
    expect((approvals.calls[0].input as Row).steps).toContain('https://example.com/b')
  })

  it('switching off, or renaming, never asks and never reports awaiting_go_ahead', async () => {
    const { client, tables } = statusLoop()
    const tools = createFlowTools(USER, client, WS)
    const off = await call(tools.update_flow, { flow_id: 'flow-1', enabled: false })
    expect(tables.flow[0].enabled).toBe(false)
    expect(off.awaiting_go_ahead).toBeUndefined()
    const renamed = await call(tools.update_flow, { flow_id: 'flow-1', name: 'Pong' })
    expect(renamed.awaiting_go_ahead).toBeUndefined()
  })

  it('an off loop whose actions this call changed reports awaiting_go_ahead', async () => {
    const { client } = statusLoop({ enabled: false })
    const res = await call(createFlowTools(USER, client, WS).update_flow, { flow_id: 'flow-1', actions: [{ id: 'h-1', url: 'https://example.com/b' }] })
    expect(res).toMatchObject({ enabled: false, awaiting_go_ahead: true })
  })
})

describe('run_skill names only a skill the caller can see', () => {
  const MINE = '77777777-7777-4777-8777-777777777777'
  const THEIRS = '88888888-8888-4888-8888-888888888888'
  const SHARED = '99999999-9999-4999-8999-999999999999'
  const SYS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  /** This workspace has Evals switched off (every feature is on by default). */
  const SETTINGS = { feature_overrides: offOverrides(['evals']) }
  /** A system recipe that workspace hides. */
  const GATED = featureGatedRecipeExclusions(resolveWorkspaceEditionFromSettings(SETTINGS))[0]

  const skillRows = (): Row[] => [
    { id: MINE, slug: 'brief', name: 'My brief', category: 'skill', workspace_id: WS, is_system: false, visibility: 'personal', created_by: USER },
    { id: THEIRS, slug: 'secret', name: 'Their brief', category: 'skill', workspace_id: WS, is_system: false, visibility: 'personal', created_by: 'user-2' },
    { id: SHARED, slug: 'brief', name: 'Team brief', category: 'skill', workspace_id: WS, is_system: false, visibility: 'workspace', created_by: 'user-2' },
    { id: SYS, slug: 'brief', name: 'System brief', category: 'skill', workspace_id: null, is_system: true, visibility: 'workspace', created_by: null },
    { id: GATED, slug: 'gated-recipe', name: 'Gated', category: 'skill', workspace_id: null, is_system: true, visibility: 'workspace', created_by: null },
  ]
  const create = (skill: string, rows = skillRows()) => {
    const { client, inserts } = seeded({ recipe: rows, workspace: [{ id: WS, settings: SETTINGS }] })
    return call(createFlowTools(USER, client, WS).create_flow, { name: 'X', trigger: schedule, actions: [{ type: 'run_skill', skill }] }).then((res) => ({ res, inserts }))
  }
  const skillOf = (inserts: Record<string, Row[]>) => ((inserts.flow![0].actions as Row[])[0].config as { skill_id: string }).skill_id

  it('a workspace with Evals off gates at least one system recipe (the fixture is real)', () => {
    expect(typeof GATED).toBe('string')
  })

  it("another member's personal skill is not found, by slug or by id", async () => {
    for (const key of ['secret', THEIRS]) {
      const { res, inserts } = await create(key)
      expect(res).toMatchObject({ success: false, field: 'actions[0].skill' })
      expect(inserts.flow).toBeUndefined()
    }
  })

  it('a feature-gated system recipe is not found', async () => {
    for (const key of ['gated-recipe', GATED]) {
      const { res } = await create(key)
      expect(res).toMatchObject({ success: false, field: 'actions[0].skill' })
    }
  })

  it("a slug clash resolves to the person's own, then the workspace's, then the system's", async () => {
    expect(skillOf((await create('brief')).inserts)).toBe(MINE)
    const noMine = skillRows().filter((r) => r.id !== MINE)
    expect(skillOf((await create('brief', noMine)).inserts)).toBe(SHARED)
    const sysOnly = noMine.filter((r) => r.id !== SHARED)
    expect(skillOf((await create('brief', sysOnly)).inserts)).toBe(SYS)
  })

  it("a kept skill the caller can't see is refused on an actions edit", async () => {
    const { client, tables } = seeded({
      recipe: skillRows(),
      flow: [
        {
          id: 'flow-1',
          workspace_id: WS,
          team_id: null,
          name: 'Theirs',
          enabled: false,
          trigger_type: 'schedule',
          trigger_config: { kind: 'schedule', cadence: 'daily', time: '07:00', timezone: 'America/New_York' },
          actions: [{ id: 'rs-1', type: 'run_skill', config: { skill_id: THEIRS, mode: 'report' }, condition: null, parent_id: null, enabled: true }],
          created_by: 'user-2',
          next_run_at: null,
        },
      ],
    })
    const res = await call(createFlowTools(USER, client, WS).update_flow, { flow_id: 'flow-1', actions: [{ id: 'rs-1', instructions: 'mine now' }] })
    expect(res).toMatchObject({ success: false, field: 'actions' })
    expect(res.error).toContain(THEIRS)
    expect(tables.flow[0].created_by).toBe('user-2')
  })
})
