/**
 * F1, "full control with safe edges" (docs/plans/flows-connectors.md §2.5),
 * as Liam settled it on 2026-10-20 (what the person asks for is on):
 *   - a loop with a webhook (http_post) or run_agent step switches on, or
 *     takes a change to what it runs while on, only from the person's verified
 *     card (needsSwitchOnCard, the one exception); the card states what it
 *     does, its skills' tools and who it runs as; the accepted replay switches
 *     it on only while the loop is unchanged; any other loop of their own,
 *     act-mode or with connected apps, takes the chat yes alone;
 *   - someone else's loop that reaches outside Native Intelligence or acts on its own is
 *     its owner's card;
 *   - trust: lowered freely, a raise only ever behind a card; the report title
 *     is settable;
 *   - the owner is fixed: no re-stamp, only the owner changes what runs, and
 *     transfer_flow_owner is a card the NEW owner accepts;
 *   - delete_flow is a card that says how many runs go with it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import type { ApprovedCall } from '@/lib/safety/approved-call'

vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/flows/flow-bot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/flows/flow-bot')>()),
  defaultFlowBot: async () => ({ teammateId: 'bot-default', created: false }),
}))
vi.mock('@/lib/crypto/credentials', () => ({
  encryptCredentialOrNull: (v: string | null | undefined) => (v ? `enc:${v}` : null),
}))
const approvals = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }))
vi.mock('@/lib/safety/approvals', () => ({
  createToolApproval: async (_client: unknown, approval: Record<string, unknown>) => {
    approvals.calls.push(approval)
    return { ok: true, approvalId: `appr-${approvals.calls.length}`, cardId: `card-${approvals.calls.length}` }
  },
}))

import { createFlowTools } from '../flows'

const USER = 'user-1'
const OTHER = 'user-2'
const ADMIN = 'user-3'
const WS = 'ws-1'
const SKILL = '11111111-1111-4111-8111-111111111111'
const AGENT_SKILL = '22222222-2222-4222-8222-222222222222'
const EXEC = { toolCallId: 'c', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>
type Row = Record<string, unknown>

function makeClient(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]))
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
        return row
      }
      if (mode === 'update') {
        const rows = matching()
        for (const r of rows) Object.assign(r, payload)
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
      eq: (col: string, val: unknown) => ((preds.push((r) => r[col] === val)), proxy),
      in: (col: string, vals: unknown[]) => ((preds.push((r) => vals.includes(r[col]))), proxy),
      insert: (p: Row) => ((mode = 'insert'), (payload = p), proxy),
      update: (p: Row) => ((mode = 'update'), (payload = p), proxy),
      delete: () => ((mode = 'delete'), proxy),
      single: async () => {
        const r = run()
        const row = Array.isArray(r) ? r[0] : r
        return { data: row ?? null, error: row ? null : { message: 'no rows' } }
      },
      maybeSingle: async () => {
        const r = run()
        return { data: (Array.isArray(r) ? r[0] : r) ?? null, error: null }
      },
      then: (resolve: (v: unknown) => unknown) => {
        const r = run()
        return Promise.resolve({ data: Array.isArray(r) ? r : r ? [r] : [], error: null }).then(resolve)
      },
    }
    proxy = new Proxy(self, { get: (t, p: string) => (p in t ? t[p] : () => proxy) })
    return proxy
  })
  return { client: { from } as never, tables }
}

const schedule = { kind: 'schedule', cadence: 'daily', time: '07:00', timezone: 'America/New_York' }
const httpStep = { id: 'h-1', type: 'http_post', config: { method: 'POST', url: 'https://example.com/a', headers: {}, body_template: '' }, condition: null, parent_id: null, enabled: true, bearer_token_encrypted: null }
const actStep = (trust?: Row, deliver?: Row) => ({
  id: 's-1',
  type: 'run_skill',
  config: { skill_id: SKILL, mode: 'act', ...(deliver ? { deliver } : {}), ...(trust ? { trust } : {}) },
  condition: null,
  parent_id: null,
  enabled: true,
})
const TRUST_ON = { auto_apply: true, min_confidence: 0.9, allow_external: false, max_cards_per_run: 3 }

function world(flow: Row = {}, extra: Record<string, Row[]> = {}) {
  return makeClient({
    member: [
      { id: 'm-1', user_id: USER, workspace_id: WS, role: 'member', display_name: 'Liam', workspace: { id: WS, name: 'WS' } },
      { id: 'm-2', user_id: OTHER, workspace_id: WS, role: 'member', display_name: 'Sam' },
      { id: 'm-3', user_id: ADMIN, workspace_id: WS, role: 'admin', display_name: 'Ada' },
    ],
    recipe: [
      { id: SKILL, slug: 'triage', name: 'Triage', category: 'skill', workspace_id: WS, is_system: false, visibility: 'workspace', created_by: USER, agent_config: { enabled_tools: ['emails'] } },
      { id: AGENT_SKILL, slug: 'brief', name: 'Brief', category: 'skill', workspace_id: WS, is_system: false, visibility: 'workspace', created_by: USER, agent_config: { authored_by: 'agent' } },
    ],
    flow: [
      {
        id: 'flow-1',
        workspace_id: WS,
        team_id: null,
        name: 'Nightly',
        enabled: false,
        trigger_type: 'schedule',
        trigger_config: schedule,
        // A webhook: the one step whose loop switches on only from the card (needsSwitchOnCard).
        actions: [actStep(), httpStep],
        created_by: USER,
        next_run_at: null,
        ...flow,
      },
    ],
    flow_run: [
      { id: 'r-1', flow_id: 'flow-1' },
      { id: 'r-2', flow_id: 'flow-1' },
    ],
    ...extra,
  })
}

const call = async (fn: { execute?: (a: never, o: typeof EXEC) => unknown }, args: Record<string, unknown>) =>
  (await fn.execute!(args as never, EXEC)) as Row
const tools = (client: never, user = USER, approvedCall?: ApprovedCall) =>
  createFlowTools(user, client, WS, false, 'session', undefined, { conversationId: 'conv-1', ...(approvedCall ? { approvedCall } : {}) })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-19T12:00:00Z'))
  approvals.calls.length = 0
})
afterEach(() => vi.useRealTimers())

describe('a risky loop switches on only from the verified card', () => {
  it('the card says what it does, what its skill may use and who it runs as; the loop stays off', async () => {
    const { client, tables } = world()
    const res = await call(tools(client).update_flow, { flow_id: 'flow-1', enabled: true, confirmed_with_user: true })
    expect(tables.flow[0].enabled).toBe(false)
    expect(res).toMatchObject({ awaiting_approval: true, approval_id: 'appr-1', owner: { user_id: USER, name: 'Liam' } })
    const card = approvals.calls[0]
    expect(card).toMatchObject({ door: 'chat', userId: USER, workspaceId: WS, toolName: 'update_flow', conversationId: 'conv-1', sideEffect: 'automation-write' })
    expect(card.input).toMatchObject({
      flow_id: 'flow-1',
      enabled: true,
      loop: 'Nightly',
      when: 'Every day at 07:00 (America/New_York)',
      runs_as: 'Liam',
      skill_tools: '"Triage": Emails (plus the core action tools)',
    })
    expect(String((card.input as Row).steps)).toContain('run skill "Triage" (act: may change records)')
    expect((card.card as Row).title).toBe('Switch on the loop "Nightly"?')
    expect((card.context as Row).flow).toMatchObject({ kind: 'enable', flow_id: 'flow-1', definition_hash: expect.stringMatching(/^[0-9a-f]{64}$/) })
  })

  it('without the chat yes it is still refused (every existing refusal stands)', async () => {
    const { client } = world()
    expect(await call(tools(client).update_flow, { flow_id: 'flow-1', enabled: true })).toMatchObject({ field: 'confirmed_with_user', needs_go_ahead: true })
    expect(approvals.calls).toEqual([])
  })

  it('the accepted replay switches it on while the loop is unchanged', async () => {
    const { client, tables } = world()
    await call(tools(client).update_flow, { flow_id: 'flow-1', enabled: true, confirmed_with_user: true })
    const flow = (approvals.calls[0].context as { flow: ApprovedCall['flow'] }).flow
    const replay = tools(client, USER, { approvalId: 'appr-1', tool: 'update_flow', flow })
    const res = await call(replay.update_flow, { flow_id: 'flow-1', enabled: true })
    expect(res).toMatchObject({ success: true })
    expect(tables.flow[0].enabled).toBe(true)
    expect(tables.flow[0].next_run_at).toEqual(expect.any(String))
  })

  it('a loop re-aimed after the card was made is NOT switched on by it', async () => {
    const { client, tables } = world()
    await call(tools(client).update_flow, { flow_id: 'flow-1', enabled: true, confirmed_with_user: true })
    const flow = (approvals.calls[0].context as { flow: ApprovedCall['flow'] }).flow
    // Re-aimed while off (allowed without a yes): an HTTP step to somewhere else.
    await call(tools(client).update_flow, { flow_id: 'flow-1', actions: [{ id: 's-1' }, { type: 'http_post', url: 'https://evil.example.com/x' }] })
    const res = await call(tools(client, USER, { approvalId: 'appr-1', tool: 'update_flow', flow }).update_flow, { flow_id: 'flow-1', enabled: true })
    expect(res).toMatchObject({ success: false, code: 'FLOW_CHANGED' })
    expect(tables.flow[0].enabled).toBe(false)
  })

  it("a skill whose tools widened since the card also counts as changed", async () => {
    const { client, tables } = world()
    await call(tools(client).update_flow, { flow_id: 'flow-1', enabled: true, confirmed_with_user: true })
    const flow = (approvals.calls[0].context as { flow: ApprovedCall['flow'] }).flow
    tables.recipe[0].agent_config = { enabled_tools: ['emails', 'actions'] }
    expect(await call(tools(client, USER, { approvalId: 'a', tool: 'update_flow', flow }).update_flow, { flow_id: 'flow-1', enabled: true })).toMatchObject({ code: 'FLOW_CHANGED' })
  })

  it('an approvedCall for another tool, kind or loop is not a switch-on', async () => {
    const { client, tables } = world()
    const flow = { kind: 'delete' as const, flow_id: 'flow-1', definition_hash: 'x' }
    const res = await call(tools(client, USER, { approvalId: 'a', tool: 'update_flow', flow }).update_flow, { flow_id: 'flow-1', enabled: true, confirmed_with_user: true })
    expect(res).toMatchObject({ awaiting_approval: true })
    expect(tables.flow[0].enabled).toBe(false)
  })

  it('an agent-made skill with no categories: the card says reads and drafts only', async () => {
    const { client } = world({ actions: [{ ...actStep(), config: { skill_id: AGENT_SKILL, mode: 'act' } }, httpStep] })
    await call(tools(client).update_flow, { flow_id: 'flow-1', enabled: true, confirmed_with_user: true })
    expect((approvals.calls[0].input as Row).skill_tools).toBe('"Brief": reads and drafts only')
  })

  it('a draft-only loop (report mode) keeps the chat yes: on at once, no card', async () => {
    const { client, tables } = world({ actions: [{ ...actStep(), config: { skill_id: SKILL, mode: 'report' } }] })
    await call(tools(client).update_flow, { flow_id: 'flow-1', enabled: true, confirmed_with_user: true })
    expect(tables.flow[0].enabled).toBe(true)
    expect(approvals.calls).toEqual([])
  })
})

describe('F1 review: the card shows what will run, and goes to the owner', () => {
  it('the card input carries the HTTP body and header NAMES (never values), instructions, and the definition hash', async () => {
    const hook = {
      ...httpStep,
      config: { method: 'POST', url: 'https://example.com/a', headers: { 'X-Api-Key': 's3cret-value' }, body_template: '{"id":"{{entity.id}}"}' },
      bearer_token_encrypted: 'enc:tok',
    }
    const skillStep = { ...actStep(), config: { skill_id: SKILL, mode: 'act', instructions: 'Only my items' } }
    const { client } = world({ actions: [hook, skillStep] })
    await call(tools(client).update_flow, { flow_id: 'flow-1', enabled: true, confirmed_with_user: true })
    const input = approvals.calls[0].input as Row
    expect(input.step_details).toBe(
      'Step 1: POST https://example.com/a; headers: X-Api-Key; a bearer token is set; body: {"id":"{{entity.id}}"}\nStep 2 instructions: Only my items',
    )
    expect(JSON.stringify(input)).not.toContain('s3cret-value')
    expect(JSON.stringify(input)).not.toContain('enc:tok')
    expect(input.definition_hash).toBe(((approvals.calls[0].context as Row).flow as Row).definition_hash)
  })

  it('a loop changed after its card gets a NEW card (a different input), never the stale one reused', async () => {
    const { client } = world()
    await call(tools(client).update_flow, { flow_id: 'flow-1', enabled: true, confirmed_with_user: true })
    await call(tools(client).update_flow, { flow_id: 'flow-1', actions: [{ id: 's-1', instructions: 'changed' }, { id: 'h-1' }] })
    await call(tools(client).update_flow, { flow_id: 'flow-1', enabled: true, confirmed_with_user: true })
    expect((approvals.calls[0].input as Row).definition_hash).not.toBe((approvals.calls[1].input as Row).definition_hash)
  })

  it("someone else's act-mode loop with no webhook is still its OWNER's card (a permission boundary: it runs as them), while its owner switches it on with the yes alone", async () => {
    const other = world({ actions: [actStep()] })
    expect(await call(tools(other.client, OTHER).update_flow, { flow_id: 'flow-1', enabled: true, confirmed_with_user: true })).toMatchObject({ awaiting_approval: true, card_for: 'Liam' })
    expect(other.tables.flow[0].enabled).toBe(false)
    const own = world({ actions: [actStep()] })
    await call(tools(own.client).update_flow, { flow_id: 'flow-1', enabled: true, confirmed_with_user: true })
    expect(own.tables.flow[0].enabled).toBe(true)
    expect(approvals.calls).toHaveLength(1)
  })

  it('a loop with no creator runs as the workspace owner: a member switching on its act step gets the owner\'s card, never the yes alone', async () => {
    const { client, tables } = world({ created_by: null, actions: [actStep()] }, {
      member: [
        { id: 'm-1', user_id: USER, workspace_id: WS, role: 'owner', display_name: 'Liam', workspace: { id: WS, name: 'WS' } },
        { id: 'm-2', user_id: OTHER, workspace_id: WS, role: 'member', display_name: 'Sam' },
      ],
    })
    const res = await call(tools(client, OTHER).update_flow, { flow_id: 'flow-1', enabled: true, confirmed_with_user: true })
    expect(tables.flow[0].enabled).toBe(false)
    expect(approvals.calls[0]).toMatchObject({ userId: USER, conversationId: null, input: { requested_by: 'Sam' } })
    expect(res).toMatchObject({ awaiting_approval: true, card_for: 'Liam' })
  })

  it("a non-owner's switch-on of a risky loop is the OWNER's card, saying who asked", async () => {
    const { client, tables } = world()
    const res = await call(tools(client, OTHER).update_flow, { flow_id: 'flow-1', enabled: true, confirmed_with_user: true })
    expect(tables.flow[0].enabled).toBe(false)
    expect(approvals.calls[0]).toMatchObject({ userId: USER, conversationId: null, input: { requested_by: 'Sam' }, context: { flow: { kind: 'enable', requested_by: OTHER } } })
    expect(String((approvals.calls[0].card as Row).why)).toContain('Sam asks to switch on your loop')
    expect(res).toMatchObject({ awaiting_approval: true, card_for: 'Liam' })
    // The owner's Accept replays it as the owner, and the loop goes on.
    const flow = (approvals.calls[0].context as { flow: ApprovedCall['flow'] }).flow
    await call(tools(client, USER, { approvalId: 'a', tool: 'update_flow', flow }).update_flow, { flow_id: 'flow-1', enabled: true })
    expect(tables.flow[0].enabled).toBe(true)
  })

  it('a step stored without `enabled` reads as enabled on the card', async () => {
    const legacy = { ...actStep() } as Row
    delete legacy.enabled
    const { client } = world({ actions: [legacy, httpStep] })
    await call(tools(client).update_flow, { flow_id: 'flow-1', enabled: true, confirmed_with_user: true })
    expect(String((approvals.calls[0].input as Row).steps)).not.toContain('[disabled]')
  })
})

describe('trust and the report title (F1 item 6)', () => {
  it('the title is settable and kept; null resets it', async () => {
    const { client, tables } = world()
    await call(tools(client).update_flow, { flow_id: 'flow-1', actions: [{ id: 's-1', document_title: 'Nightly — {date}' }] })
    expect((tables.flow[0].actions as Row[])[0]).toMatchObject({ config: { deliver: { document_title: 'Nightly — {date}' } } })
    await call(tools(client).update_flow, { flow_id: 'flow-1', actions: [{ id: 's-1', instructions: 'x' }] })
    expect((tables.flow[0].actions as Row[])[0]).toMatchObject({ config: { deliver: { document_title: 'Nightly — {date}' }, instructions: 'x' } })
    await call(tools(client).update_flow, { flow_id: 'flow-1', actions: [{ id: 's-1', document_title: null }] })
    expect(((tables.flow[0].actions as Row[])[0].config as Row).deliver).not.toHaveProperty('document_title')
  })

  it('lowering trust on an ON loop needs no yes and no card; the loop stays on', async () => {
    const { client, tables } = world({ enabled: true, actions: [actStep(TRUST_ON)] })
    const res = await call(tools(client).update_flow, { flow_id: 'flow-1', actions: [{ id: 's-1', trust: { auto_apply: false } }] })
    expect(res.success).not.toBe(false)
    expect(tables.flow[0].enabled).toBe(true)
    expect(((tables.flow[0].actions as Row[])[0].config as Row).trust).toMatchObject({ auto_apply: false })
    expect(approvals.calls).toEqual([])
  })

  it("the seeded Triage loop's shape (act, trust, delivery) lowers trust without going off", async () => {
    const triage = {
      id: 's-1',
      type: 'run_skill',
      config: { skill_id: SKILL, mode: 'act', trust: { auto_apply: true, min_confidence: 0.85, allow_external: false, max_cards_per_run: 3 }, deliver: { document: false, notification: true } },
      condition: null,
      parent_id: null,
      enabled: true,
    }
    const { client, tables } = world({ enabled: true, trigger_type: 'capture_processed', trigger_config: { kind: 'capture_processed' }, actions: [triage] })
    await call(tools(client).update_flow, { flow_id: 'flow-1', actions: [{ id: 's-1', trust: { auto_apply: false } }] })
    expect(tables.flow[0].enabled).toBe(true)
    expect(approvals.calls).toEqual([])
  })

  it('a higher confidence bar is a lowering too', async () => {
    const { client, tables } = world({ enabled: true, actions: [actStep(TRUST_ON)] })
    await call(tools(client).update_flow, { flow_id: 'flow-1', actions: [{ id: 's-1', trust: { min_confidence: 0.95 } }] })
    expect(tables.flow[0].enabled).toBe(true)
    expect(approvals.calls).toEqual([])
  })

  it('raising trust on an ON act loop of their own takes the yes, and stays on: its writes are internal and undoable', async () => {
    const { client, tables } = world({ enabled: true, actions: [actStep()] })
    const refused = await call(tools(client).update_flow, { flow_id: 'flow-1', actions: [{ id: 's-1', trust: { auto_apply: true } }] })
    expect(refused).toMatchObject({ field: 'confirmed_with_user' })
    const res = await call(tools(client).update_flow, { flow_id: 'flow-1', actions: [{ id: 's-1', trust: { auto_apply: true } }], confirmed_with_user: true })
    expect(tables.flow[0].enabled).toBe(true)
    expect(res.awaiting_approval).toBeUndefined()
    expect(approvals.calls).toHaveLength(0)
  })

  it('raising trust on an ON act loop with a webhook takes the yes, then the card: the loop goes off until it', async () => {
    const { client, tables } = world({ enabled: true, actions: [actStep(), httpStep] })
    const refused = await call(tools(client).update_flow, { flow_id: 'flow-1', actions: [{ id: 's-1', trust: { auto_apply: true } }] })
    expect(refused).toMatchObject({ field: 'confirmed_with_user' })
    const res = await call(tools(client).update_flow, { flow_id: 'flow-1', actions: [{ id: 's-1', trust: { auto_apply: true } }, { id: 'h-1' }], confirmed_with_user: true })
    expect(tables.flow[0].enabled).toBe(false)
    expect(res).toMatchObject({ awaiting_approval: true })
    expect(String((approvals.calls[0].input as Row).steps)).toContain('auto-applying accepts at 85%+ confidence')
  })

  it("a cosmetic edit (the title) of an ON risky loop keeps today's yes but never a card", async () => {
    const { client, tables } = world({ enabled: true })
    expect(await call(tools(client).update_flow, { flow_id: 'flow-1', actions: [{ id: 's-1', document_title: 'T' }] })).toMatchObject({ field: 'confirmed_with_user' })
    await call(tools(client).update_flow, { flow_id: 'flow-1', actions: [{ id: 's-1', document_title: 'T' }], confirmed_with_user: true })
    expect(tables.flow[0].enabled).toBe(true)
    expect(approvals.calls).toEqual([])
  })
})

describe('the owner is fixed (F1 item 3)', () => {
  it("list_flows shows each loop's owner", async () => {
    const { client } = world()
    const res = await call(tools(client).list_flows, {})
    expect((res.flows as Row[])[0]).toMatchObject({ id: 'flow-1', owner: { user_id: USER, name: 'Liam' } })
  })

  it("an owner's edit never re-stamps; a non-owner can't change what runs", async () => {
    const { client, tables } = world()
    await call(tools(client).update_flow, { flow_id: 'flow-1', trigger: { type: 'schedule', time: '08:00' } })
    expect(tables.flow[0].created_by).toBe(USER)
    const refused = await call(tools(client, OTHER).update_flow, { flow_id: 'flow-1', trigger: { type: 'schedule', time: '09:00' } })
    expect(refused).toMatchObject({ success: false, code: 'NOT_FLOW_OWNER' })
    expect(String(refused.error)).toContain('Liam')
    expect((tables.flow[0].trigger_config as Row).time).toBe('08:00')
    expect(tables.flow[0].created_by).toBe(USER)
  })

  it('a non-owner may still rename it or switch it off', async () => {
    const { client, tables } = world({ enabled: true })
    await call(tools(client, OTHER).update_flow, { flow_id: 'flow-1', name: 'Renamed' })
    await call(tools(client, OTHER).update_flow, { flow_id: 'flow-1', enabled: false })
    expect(tables.flow[0]).toMatchObject({ name: 'Renamed', enabled: false, created_by: USER })
  })
})

describe('transfer_flow_owner: a card the NEW owner accepts', () => {
  it("the owner asks: the new owner gets the card, nothing changes until they accept", async () => {
    const { client, tables } = world()
    const res = await call(tools(client).transfer_flow_owner, { flow_id: 'flow-1', new_owner: 'm-2' })
    expect(res).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED', approval_id: 'appr-1' })
    expect(tables.flow[0].created_by).toBe(USER)
    expect(approvals.calls[0]).toMatchObject({
      userId: OTHER,
      toolName: 'transfer_flow_owner',
      conversationId: null,
      input: { flow_id: 'flow-1', new_owner: OTHER, runs_as_now: 'Liam', runs_as_after: 'Sam', loop: 'Nightly' },
      context: { flow: { kind: 'transfer', flow_id: 'flow-1', requested_by: USER, new_owner: OTHER } },
    })
    expect(String((approvals.calls[0].card as Row).why)).toContain('Liam asks you to own "Nightly"')
  })

  it('the new owner accepting it hands it over', async () => {
    const { client, tables } = world()
    await call(tools(client).transfer_flow_owner, { flow_id: 'flow-1', new_owner: OTHER })
    const flow = (approvals.calls[0].context as { flow: ApprovedCall['flow'] }).flow
    const res = await call(tools(client, OTHER, { approvalId: 'appr-1', tool: 'transfer_flow_owner', flow }).transfer_flow_owner, { flow_id: 'flow-1', new_owner: OTHER })
    expect(res).toMatchObject({ success: true, owner: { user_id: OTHER, name: 'Sam' } })
    expect(tables.flow[0].created_by).toBe(OTHER)
  })

  it("the card is the new owner's alone, and a loop changed since is not handed over", async () => {
    const { client, tables } = world()
    await call(tools(client).transfer_flow_owner, { flow_id: 'flow-1', new_owner: OTHER })
    const flow = (approvals.calls[0].context as { flow: ApprovedCall['flow'] }).flow
    expect(await call(tools(client, ADMIN, { approvalId: 'a', tool: 'transfer_flow_owner', flow }).transfer_flow_owner, { flow_id: 'flow-1', new_owner: OTHER })).toMatchObject({ code: 'APPROVAL_MISMATCH' })
    tables.flow[0].trigger_config = { ...schedule, time: '23:00' }
    expect(await call(tools(client, OTHER, { approvalId: 'a', tool: 'transfer_flow_owner', flow }).transfer_flow_owner, { flow_id: 'flow-1', new_owner: OTHER })).toMatchObject({ code: 'FLOW_CHANGED' })
    expect(tables.flow[0].created_by).toBe(USER)
  })

  it('only the owner or an admin can ask; the new owner must be a member and not the owner already', async () => {
    const { client } = world()
    expect(await call(tools(client, OTHER).transfer_flow_owner, { flow_id: 'flow-1', new_owner: OTHER })).toMatchObject({ code: 'NOT_ALLOWED' })
    expect(await call(tools(client, ADMIN).transfer_flow_owner, { flow_id: 'flow-1', new_owner: OTHER })).toMatchObject({ code: 'APPROVAL_REQUIRED' })
    expect(await call(tools(client).transfer_flow_owner, { flow_id: 'flow-1', new_owner: 'nobody' })).toMatchObject({ field: 'new_owner' })
    expect(await call(tools(client).transfer_flow_owner, { flow_id: 'flow-1', new_owner: USER })).toMatchObject({ field: 'new_owner' })
  })
})

describe('request_flow_takeover: the reverse of a transfer, the CURRENT owner decides', () => {
  it("a non-owner asks: the card is the owner's, saying who wants it; nothing changes until they accept", async () => {
    const { client, tables } = world()
    const res = await call(tools(client, OTHER).request_flow_takeover, { flow_id: 'flow-1' })
    expect(res).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED', requested: true })
    expect(tables.flow[0].created_by).toBe(USER)
    expect(approvals.calls[0]).toMatchObject({
      userId: USER,
      toolName: 'request_flow_takeover',
      conversationId: null,
      input: { flow_id: 'flow-1', runs_as_now: 'Liam', runs_as_after: 'Sam', requested_by: 'Sam' },
      context: { flow: { kind: 'takeover', flow_id: 'flow-1', requested_by: OTHER, new_owner: OTHER } },
    })
    expect((approvals.calls[0].card as Row).title).toBe('Sam wants to take over "Nightly"')
    // Ownership wording only: never the switch-on card's "as <owner>" or "stays off".
    const why = String((approvals.calls[0].card as Row).why)
    expect(why).toMatch(/^Accept and "Nightly" runs as Sam instead of you, with their data and connections/)
    expect(why).not.toContain('stays off')
  })

  it("the owner's Accept hands it to the asker", async () => {
    const { client, tables } = world()
    await call(tools(client, OTHER).request_flow_takeover, { flow_id: 'flow-1' })
    const flow = (approvals.calls[0].context as { flow: ApprovedCall['flow'] }).flow
    const res = await call(tools(client, USER, { approvalId: 'a', tool: 'request_flow_takeover', flow }).request_flow_takeover, { flow_id: 'flow-1' })
    expect(res).toMatchObject({ success: true, owner: { user_id: OTHER, name: 'Sam' } })
    expect(tables.flow[0].created_by).toBe(OTHER)
  })

  it('the Accept re-checks: a changed loop, an accepter who is not the owner, an asker who left', async () => {
    const { client, tables } = world()
    await call(tools(client, OTHER).request_flow_takeover, { flow_id: 'flow-1' })
    const flow = (approvals.calls[0].context as { flow: ApprovedCall['flow'] }).flow
    const replay = (user: string) => tools(client, user, { approvalId: 'a', tool: 'request_flow_takeover', flow }).request_flow_takeover
    // An admin while the owner is still a member: not theirs to accept.
    expect(await call(replay(ADMIN), { flow_id: 'flow-1' })).toMatchObject({ code: 'NOT_ALLOWED' })
    // The asker left the workspace.
    const sam = tables.member.findIndex((m) => m.user_id === OTHER)
    const [left] = tables.member.splice(sam, 1)
    expect(await call(replay(USER), { flow_id: 'flow-1' })).toMatchObject({ code: 'NOT_ALLOWED' })
    tables.member.push(left)
    // The loop changed after the card.
    tables.flow[0].trigger_config = { ...schedule, time: '23:00' }
    expect(await call(replay(USER), { flow_id: 'flow-1' })).toMatchObject({ code: 'FLOW_CHANGED' })
    expect(tables.flow[0].created_by).toBe(USER)
  })

  it("with the owner gone, the workspace's owners and admins get the card, and an admin's Accept counts", async () => {
    const { client, tables } = world({ created_by: 'user-gone' })
    await call(tools(client, OTHER).request_flow_takeover, { flow_id: 'flow-1' })
    expect(approvals.calls.map((c) => c.userId)).toEqual([ADMIN])
    const flow = (approvals.calls[0].context as { flow: ApprovedCall['flow'] }).flow
    expect(await call(tools(client, ADMIN, { approvalId: 'a', tool: 'request_flow_takeover', flow }).request_flow_takeover, { flow_id: 'flow-1' })).toMatchObject({
      success: true,
    })
    expect(tables.flow[0].created_by).toBe(OTHER)
  })

  it('the owner asking for their own loop is refused', async () => {
    const { client } = world()
    expect(await call(tools(client).request_flow_takeover, { flow_id: 'flow-1' })).toMatchObject({ success: false, field: 'flow_id' })
    expect(approvals.calls).toEqual([])
  })
})

describe('delete_flow: a card that says what goes (F1 item 4)', () => {
  it('raises the card with the run count; nothing is deleted', async () => {
    const { client, tables } = world({ enabled: true })
    const res = await call(tools(client).delete_flow, { flow_id: 'flow-1' })
    expect(res).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED', runs_to_erase: 2 })
    expect(tables.flow).toHaveLength(1)
    expect(approvals.calls[0]).toMatchObject({
      toolName: 'delete_flow',
      sideEffect: 'delete',
      input: { flow_id: 'flow-1', loop: 'Nightly', run_history_erased: '2 runs', was_on: true },
      context: { flow: { kind: 'delete', flow_id: 'flow-1' } },
    })
    expect((approvals.calls[0].card as Row).why).toContain('with 2 runs of history')
  })

  it('the accepted replay deletes the loop the card showed; a loop changed since is kept', async () => {
    const { client, tables } = world()
    await call(tools(client).delete_flow, { flow_id: 'flow-1' })
    const flow = (approvals.calls[0].context as { flow: ApprovedCall['flow'] }).flow
    expect((approvals.calls[0].input as Row).definition_hash).toBe(flow!.definition_hash)
    const stale = await call(tools(client, USER, { approvalId: 'a', tool: 'delete_flow', flow: { ...flow!, definition_hash: 'old' } }).delete_flow, { flow_id: 'flow-1' })
    expect(stale).toMatchObject({ success: false, code: 'FLOW_CHANGED' })
    expect(tables.flow).toHaveLength(1)
    const res = await call(tools(client, USER, { approvalId: 'a', tool: 'delete_flow', flow }).delete_flow, { flow_id: 'flow-1' })
    expect(res).toMatchObject({ ok: true })
    expect(tables.flow).toHaveLength(0)
  })
})

describe('create_flow on a webhook loop (the one exception)', () => {
  it('asked for, it is created off and runs as the creator, and its switch-on card is raised at once', async () => {
    const { client, tables } = world()
    const res = await call(tools(client).create_flow, {
      name: 'Hook',
      trigger: { type: 'schedule', cadence: 'daily', time: '09:00', timezone: 'UTC' },
      actions: [{ url: 'https://example.com/h' }],
      enabled: true,
    })
    const created = tables.flow.find((f) => f.name === 'Hook')!
    expect(created).toMatchObject({ enabled: false, created_by: USER })
    expect(res).toMatchObject({ awaiting_approval: true, owner: { user_id: USER } })
    expect(res.awaiting_go_ahead).toBeUndefined()
    expect(approvals.calls[0]).toMatchObject({ toolName: 'update_flow', input: { flow_id: created.id, enabled: true } })
  })

  it('an act-mode loop of their own, asked for, is created on with no card', async () => {
    const { client, tables } = world()
    await call(tools(client).create_flow, { name: 'Act', trigger: { type: 'schedule', cadence: 'daily', time: '09:00', timezone: 'UTC' }, actions: [{ type: 'run_skill', skill: SKILL, mode: 'act' }], enabled: true })
    expect(tables.flow.find((f) => f.name === 'Act')).toMatchObject({ enabled: true })
    expect(approvals.calls).toHaveLength(0)
  })
})

describe('create_flow with a job on the person’s Mac (L5, run_local_agent)', () => {
  const FOLDER = '66666666-6666-4666-8666-666666666666'
  const NOTES = '77777777-7777-4777-8777-777777777777'
  const macWorld = () => world({}, {
    device_folder: [
      { id: FOLDER, user_id: USER, device_id: 'd-1', grant_id: 'g1', label: 'native-intelligence', path: '/Users/l/code/native-intelligence', mode: 'edit', is_git: true, revoked_at: null },
      { id: NOTES, user_id: USER, device_id: 'd-1', grant_id: 'g2', label: 'notes', path: '/Users/l/notes', mode: 'read', is_git: false, revoked_at: null },
      { id: '88888888-8888-4888-8888-888888888888', user_id: OTHER, device_id: 'd-2', grant_id: 'g3', label: 'theirs', path: '/x', mode: 'edit', is_git: true, revoked_at: null },
    ],
  })
  const trigger = { type: 'schedule', cadence: 'daily', time: '09:00', timezone: 'UTC' }

  it('asked for, it is created off and switches on only from the person’s card, which says what runs on the Mac', async () => {
    const { client, tables } = macWorld()
    const res = await call(tools(client).create_flow, {
      name: 'CI watch', trigger, enabled: true,
      actions: [{ type: 'run_local_agent', folder_id: FOLDER, instructions: 'Look at why the nightly build failed', edits: true }],
    })
    const created = tables.flow.find((f) => f.name === 'CI watch')!
    expect(created).toMatchObject({ enabled: false, created_by: USER })
    expect((created.actions as Row[])[0]).toMatchObject({ type: 'run_local_agent', config: { folder_id: FOLDER, request: 'Look at why the nightly build failed', mode: 'edit' } })
    expect(res).toMatchObject({ awaiting_approval: true })
    const card = approvals.calls[0]
    expect(card).toMatchObject({ toolName: 'update_flow', input: { flow_id: created.id, enabled: true } })
    expect(String((card.input as Row).steps)).toContain('on your Mac')
  })

  it('only a folder this person shares on their Mac; edits only where the Mac allows them; a request is required', async () => {
    const { client, tables } = macWorld()
    const make = (action: Row) => call(tools(client).create_flow, { name: 'X', trigger, actions: [{ type: 'run_local_agent', ...action }] })
    expect(await make({ folder_id: '88888888-8888-4888-8888-888888888888', instructions: 'x' })).toMatchObject({ success: false, field: 'actions[0].folder_id' })
    expect(await make({ instructions: 'x' })).toMatchObject({ success: false, field: 'actions[0].folder_id' })
    expect(await make({ folder_id: NOTES, instructions: 'x', edits: true })).toMatchObject({ success: false, field: 'actions[0].edits' })
    expect(await make({ folder_id: NOTES })).toMatchObject({ success: false, field: 'actions[0].instructions' })
    expect(tables.flow.filter((f) => f.name === 'X')).toHaveLength(0)
  })
})
