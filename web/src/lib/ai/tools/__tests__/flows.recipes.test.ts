/**
 * create_flow { recipe } (P9; src/lib/flows/recipes.ts): a recipe builds its
 * standard loop through the same validators as any loop, saved OFF (nothing
 * is on by default), with the person's options over its defaults; the call's
 * own fields win; the first setup of weekly posts makes the person's brief.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'

const canon = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>>, outcome: 'created' as 'created' | 'existing' }))
vi.mock('@/lib/documents/canon-create', () => ({
  createCanonDocument: async (_client: unknown, args: Record<string, unknown>) => {
    canon.calls.push(args)
    return { ok: true, outcome: canon.outcome, document: { id: 'brief-doc', title: 'X brief', canon_key: args.key }, missingSections: [] }
  },
}))
const briefDoc = vi.hoisted(() => ({ content: '## Audience\n\n## Themes\n\n## Voice\n\n## Never post\n\n## Cadence\n' }))
vi.mock('@/lib/documents/canon-doc', () => ({ resolveCanonDocument: async () => ({ ok: true, doc: { id: 'brief-doc', content: briefDoc.content } }) }))
vi.mock('@/lib/safety/approvals', () => ({ createToolApproval: async () => ({ ok: true, approvalId: 'a', cardId: 'c' }) }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/flows/flow-bot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/flows/flow-bot')>()),
  defaultFlowBot: async () => ({ teammateId: 'bot-default', created: false }),
}))
vi.mock('@/lib/crypto/credentials', () => ({ encryptCredentialOrNull: () => null }))

import { createFlowTools } from '../flows'
import { FLOW_RECIPES, recipeFlow } from '@/lib/flows/recipes'

const USER = 'user-1'
const WS = 'ws-1'
const WEEKLY = '80d160c4-1b4a-481d-8b76-aa7fc1609326'
const LENS = '8ef0cb7e-6c81-4da5-9deb-a967dc16aa30'
const MARKET = 'b0a0af26-be52-493a-a2e4-ea0cb5b6cbbb'
const NOW = new Date('2026-10-20T12:00:00Z')
const EXEC = { toolCallId: 'c', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>
type Row = Record<string, unknown>

function makeClient(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]))
  const inserts: Record<string, Row[]> = {}
  const from = (table: string) => {
    tables[table] ??= []
    const preds: Array<(r: Row) => boolean> = []
    let mode: 'select' | 'insert' | 'update' = 'select'
    let payload: Row = {}
    let proxy: Record<string, unknown>
    const run = () => {
      if (mode === 'insert') {
        const row = { id: `gen-${Math.random().toString(36).slice(2, 8)}`, ...payload }
        tables[table].push(row)
        ;(inserts[table] ??= []).push(row)
        return [row]
      }
      if (mode === 'update') {
        const rows = tables[table].filter((r) => preds.every((p) => p(r)))
        for (const r of rows) Object.assign(r, payload)
        return rows
      }
      return tables[table].filter((r) => preds.every((p) => p(r)))
    }
    const self: Record<string, unknown> = {
      eq: (c: string, v: unknown) => (preds.push((r) => r[c] === v), proxy),
      in: (c: string, vs: unknown[]) => (preds.push((r) => vs.includes(r[c])), proxy),
      or: () => proxy,
      order: () => proxy,
      limit: () => proxy,
      select: () => proxy,
      insert: (p: Row) => ((mode = 'insert'), (payload = p), proxy),
      update: (p: Row) => ((mode = 'update'), (payload = p), proxy),
      single: async () => ({ data: run()[0] ?? null, error: null }),
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: run(), error: null }).then(resolve),
    }
    proxy = new Proxy(self, { get: (t, p: string) => (p in t ? t[p] : () => proxy) })
    return proxy
  }
  return { client: { from } as never, inserts }
}

const seeded = () =>
  makeClient({
    member: [{ id: 'm-1', user_id: USER, workspace_id: WS, role: 'member', display_name: 'Liam', workspace: { id: WS, name: 'WS' } }],
    recipe: [
      { id: WEEKLY, slug: 'weekly-posts', name: 'Weekly posts', category: 'skill', workspace_id: null, is_system: true, agent_config: { material: 'post_week' } },
      { id: LENS, slug: 'content-lens', name: 'Content lens', category: 'skill', workspace_id: null, is_system: true, agent_config: { lens: 'content' } },
    ],
  })

const call = async (fn: { execute?: (a: never, o: typeof EXEC) => unknown }, args: Record<string, unknown>) => (await fn.execute!(args as never, EXEC)) as Record<string, unknown>

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  canon.calls.length = 0
  canon.outcome = 'created'
})
afterEach(() => vi.useRealTimers())

describe('recipeFlow (pure)', () => {
  it('weekly_posts: Monday 09:00, the weekly-posts skill to post_drafts, 3 slots, and the brief to make', () => {
    const r = recipeFlow('weekly_posts')
    expect(r).toMatchObject({
      name: 'Weekly X posts',
      trigger: { type: 'schedule', cadence: 'weekly', weekday: 1, time: '09:00' },
      actions: [{ id: 'posts', type: 'run_skill', skill: WEEKLY, deliver_to: 'post_drafts', post_surface: 'x', post_slots: 3 }],
      brief: 'content-brief:x',
    })
  })

  it('weekly_posts takes the person’s options, and refuses slots out of range', () => {
    expect(recipeFlow('weekly_posts', { surface: 'linkedin', slots: 1, weekday: 3, time: '07:30', timezone: 'Europe/London' })).toMatchObject({
      name: 'Weekly LinkedIn posts',
      trigger: { weekday: 3, time: '07:30', timezone: 'Europe/London' },
      actions: [{ post_surface: 'linkedin', post_slots: 1 }],
      brief: 'content-brief:linkedin',
    })
    expect(recipeFlow('weekly_posts', { slots: 7 })).toBeInstanceOf(Error)
    // A bad time or weekday falls back to the default rather than failing.
    expect(recipeFlow('weekly_posts', { time: '25:00', weekday: 9 })).toMatchObject({ trigger: { weekday: 1, time: '09:00' } })
  })

  it('call_moments: the content lens on each processed call, nothing else', () => {
    expect(recipeFlow('call_moments')).toMatchObject({ trigger: { type: 'capture_processed' }, actions: [{ type: 'run_skill', skill: LENS }] })
  })

  it('product_doc_from_calls: the marketing lens on each processed call', () => {
    expect(recipeFlow('product_doc_from_calls')).toMatchObject({ trigger: { type: 'capture_processed' }, actions: [{ type: 'run_skill', skill: MARKET }] })
  })

  it('you_asked_we_shipped: a project completing by default; a milestone, an action’s done state or a merged PR on asking; the launch kit as a second step', () => {
    expect(recipeFlow('you_asked_we_shipped')).toMatchObject({
      trigger: { type: 'entity_status_change', entity_type: 'project', to_status_id: 'completed' },
      actions: [{ id: 'notes', skill: '02c801d7-a5c9-4a4b-92b4-bb952ae7cd26', deliver_to: 'email_drafts' }],
    })
    expect(recipeFlow('you_asked_we_shipped', { entity_type: 'milestone' })).toMatchObject({ trigger: { entity_type: 'milestone', to_status_id: 'completed' } })
    expect(recipeFlow('you_asked_we_shipped', { entity_type: 'action' })).toBeInstanceOf(Error)
    expect(recipeFlow('you_asked_we_shipped', { entity_type: 'action', to_status_id: 'wf-done' })).toMatchObject({ trigger: { entity_type: 'action', to_status_id: 'wf-done' } })
    expect(recipeFlow('you_asked_we_shipped', { repo_full_name: 'acme/app' })).toMatchObject({ trigger: { type: 'pr_status_changed', repo_full_name: 'acme/app', pr_state: 'merged' } })
    const kit = recipeFlow('you_asked_we_shipped', { launch_kit: true })
    expect(kit instanceof Error ? null : kit.actions[1]).toMatchObject({ id: 'kit', skill: 'f67944ea-eb9e-4297-abbc-4da1afc3c031', deliver_to: 'document' })
  })

  it('no recipe sends, posts or switches anything on: only skills, and never an outward step', () => {
    for (const key of FLOW_RECIPES) {
      const r = recipeFlow(key, key === 'ci_fix_loop' ? { repo_full_name: 'acme/app' } : {})
      if (r instanceof Error) throw r
      for (const a of r.actions) {
        // The one exception (P10 F4): small_bug_draft_prs's marker step, which
        // runs nothing itself (it rides Triage's read; proactive.ts).
        if (key === 'small_bug_draft_prs') {
          expect(a).toEqual({ id: 'bugs', type: 'run_agent', use_triggering_action_context: true, attempt_small_bugs: true })
          continue
        }
        if (key === 'ci_fix_loop') {
          expect(a).toEqual({ id: 'ci', type: 'run_agent', use_triggering_action_context: true, fix_ci: true })
          continue
        }
        expect(a.type).toBe('run_skill')
        expect(JSON.stringify(a)).not.toMatch(/enabled|send|publish|mode/i)
      }
      expect(r).not.toHaveProperty('enabled')
    }
  })
})

describe('create_flow { recipe }', () => {
  it('builds weekly posts OFF through the shared validators, with the slots on the loop, and makes the brief', async () => {
    const { client, inserts } = seeded()
    const res = await call(createFlowTools(USER, client, WS, false, 'session', 'America/New_York').create_flow, { recipe: 'weekly_posts' })
    const row = inserts.flow![0]
    expect(row).toMatchObject({ name: 'Weekly X posts', enabled: false, trigger_type: 'schedule', trigger_config: { cadence: 'weekly', weekday: 1, time: '09:00', timezone: 'America/New_York' } })
    expect((row.actions as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 'posts',
      type: 'run_skill',
      config: { skill_id: WEEKLY, mode: 'report', deliver: { to: 'post_drafts', surface: 'x', slots: 3 } },
    })
    expect(res.awaiting_go_ahead).toBe(true)
    expect(canon.calls).toEqual([{ workspaceId: WS, userId: USER, key: 'content-brief:x' }])
    expect(res.recipe).toMatchObject({ key: 'weekly_posts', brief: { key: 'content-brief:x', document_id: 'brief-doc', outcome: 'created' } })
    // Nothing is filled before the yes (S11): create only makes the empty doc.
    expect((res.recipe as Record<string, unknown>).next).toBeUndefined()
    expect(res.next).toBeUndefined()
  })

  it('binds the system skill by its fixed id: a workspace skill of the same slug never takes the recipe over (S3)', async () => {
    const { client, inserts } = makeClient({
      member: [{ id: 'm-1', user_id: USER, workspace_id: WS, role: 'member', display_name: 'Liam', workspace: { id: WS, name: 'WS' } }],
      recipe: [
        { id: WEEKLY, slug: 'weekly-posts', name: 'Weekly posts', category: 'skill', workspace_id: null, is_system: true, agent_config: { material: 'post_week' } },
        { id: '99999999-9999-4999-8999-999999999999', slug: 'weekly-posts', name: 'Our own weekly posts', category: 'skill', workspace_id: WS, is_system: false, agent_config: {} },
      ],
    })
    await call(createFlowTools(USER, client, WS, false, 'session', 'UTC').create_flow, { recipe: 'weekly_posts' })
    expect((inserts.flow![0].actions as Array<{ config: { skill_id: string } }>)[0].config.skill_id).toBe(WEEKLY)
  })

  it('switching it on (the yes) is when the empty brief gets filled; a filled one is left alone (S11)', async () => {
    const { client, inserts } = seeded()
    const tools = createFlowTools(USER, client, WS, false, 'session', 'UTC')
    await call(tools.create_flow, { recipe: 'weekly_posts' })
    const flowId = inserts.flow![0].id as string
    const on = await call(tools.update_flow, { flow_id: flowId, enabled: true, confirmed_with_user: true })
    expect(on.flow).toMatchObject({ enabled: true })
    expect(String(on.next)).toContain('Fill it now by inference')
    // Off and on again with a brief they already wrote: no fill.
    await call(tools.update_flow, { flow_id: flowId, enabled: false })
    briefDoc.content = '## Audience\nFounders.\n'
    const again = await call(tools.update_flow, { flow_id: flowId, enabled: true, confirmed_with_user: true })
    expect(again.next).toBeUndefined()
    briefDoc.content = '## Audience\n\n## Themes\n\n## Voice\n\n## Never post\n\n## Cadence\n'
  })

  it('an existing brief is kept', async () => {
    canon.outcome = 'existing'
    const { client } = seeded()
    const res = await call(createFlowTools(USER, client, WS, false, 'session', 'UTC').create_flow, { recipe: 'weekly_posts' })
    expect(res.recipe).toMatchObject({ brief: { outcome: 'existing' } })
  })

  it('the call’s own fields win over the recipe’s (a name, a different trigger)', async () => {
    const { client, inserts } = seeded()
    await call(createFlowTools(USER, client, WS, false, 'session', 'UTC').create_flow, {
      recipe: 'weekly_posts',
      name: 'My posts',
      trigger: { type: 'schedule', cadence: 'weekly', weekday: 4, time: '17:00' },
    })
    expect(inserts.flow![0]).toMatchObject({ name: 'My posts', trigger_config: { weekday: 4, time: '17:00' } })
  })

  it('small_bug_draft_prs can’t even be built while this server doesn’t dispatch coding agents (P10 F4, off)', async () => {
    const { client, inserts } = seeded()
    const res = await call(createFlowTools(USER, client, WS).create_flow, { recipe: 'small_bug_draft_prs' })
    expect(JSON.stringify(res)).toContain('run_agent is switched off on this server')
    expect(inserts.flow).toBeUndefined()
  })

  it('ci_fix_loop builds the opt-in loop on the repo’s pull requests, even with run_agent dispatch off (P10 F7)', async () => {
    const { client, inserts } = seeded()
    const res = await call(createFlowTools(USER, client, WS).create_flow, { recipe: 'ci_fix_loop', recipe_options: { repo_full_name: 'acme/app' } })
    expect(res.error).toBeUndefined()
    const row = inserts.flow![0]
    expect(row).toMatchObject({ trigger_type: 'pr_status_changed', trigger_config: { repo_full_name: 'acme/app', to_state: 'open' } })
    expect((row.actions as Array<Record<string, unknown>>)[0]).toMatchObject({ type: 'run_agent', config: { fix_ci: true, agent_id: '', repo: '' } })
    const missing = await call(createFlowTools(USER, client, WS).create_flow, { recipe: 'ci_fix_loop' })
    expect(JSON.stringify(missing)).toContain('repo_full_name is required')
  })

  it('call_moments builds the content lens loop on capture_processed', async () => {
    const { client, inserts } = seeded()
    const res = await call(createFlowTools(USER, client, WS).create_flow, { recipe: 'call_moments' })
    expect(inserts.flow![0]).toMatchObject({ trigger_type: 'capture_processed', enabled: false })
    expect(canon.calls).toEqual([])
    expect(res.recipe).toEqual({ key: 'call_moments', note: expect.any(String) })
  })

  it('product_doc_from_calls: only an owner or admin may own it (the lens guard); a member is refused with the fix', async () => {
    const admin = makeClient({
      member: [{ id: 'm-1', user_id: USER, workspace_id: WS, role: 'admin', display_name: 'Liam', workspace: { id: WS, name: 'WS' } }],
      recipe: [{ id: MARKET, slug: 'marketing-lens', name: 'Marketing lens', category: 'skill', workspace_id: null, is_system: true, agent_config: { lens: 'marketing' } }],
    })
    await call(createFlowTools(USER, admin.client, WS).create_flow, { recipe: 'product_doc_from_calls' })
    expect(admin.inserts.flow![0]).toMatchObject({ name: 'Product doc from customer calls', trigger_type: 'capture_processed', enabled: false })
    const member = makeClient({
      member: [{ id: 'm-1', user_id: USER, workspace_id: WS, role: 'member', display_name: 'Liam', workspace: { id: WS, name: 'WS' } }],
      recipe: [{ id: MARKET, slug: 'marketing-lens', name: 'Marketing lens', category: 'skill', workspace_id: null, is_system: true, agent_config: { lens: 'marketing' } }],
    })
    expect(await call(createFlowTools(USER, member.client, WS).create_flow, { recipe: 'product_doc_from_calls' })).toMatchObject({ success: false, field: 'actions[0].skill' })
    expect(member.inserts.flow).toBeUndefined()
  })

  it('you_asked_we_shipped builds a project-completed loop OFF, drafting email to the people who asked', async () => {
    const SHIPPED = '02c801d7-a5c9-4a4b-92b4-bb952ae7cd26'
    const { client, inserts } = makeClient({
      member: [{ id: 'm-1', user_id: USER, workspace_id: WS, role: 'member', display_name: 'Liam', workspace: { id: WS, name: 'WS' } }],
      team: [{ id: 'team-a', workspace_id: WS, created_at: '2024-01-01' }],
      recipe: [{ id: SHIPPED, slug: 'shipped-note', name: 'You asked, we shipped', category: 'skill', workspace_id: null, is_system: true, agent_config: { material: 'asked_by' } }],
    })
    const res = await call(createFlowTools(USER, client, WS).create_flow, { recipe: 'you_asked_we_shipped' })
    expect(inserts.flow![0]).toMatchObject({ name: 'You asked, we shipped', enabled: false, trigger_type: 'entity_status_change', trigger_config: { entity_type: 'project', to_status_id: 'completed' } })
    expect((inserts.flow![0].actions as Array<Record<string, unknown>>)[0]).toMatchObject({ config: { skill_id: SHIPPED, mode: 'report', deliver: { to: 'email_drafts' } } })
    expect(res.awaiting_go_ahead).toBe(true)
  })

  it('refuses bad options with the field, and a loop with neither a recipe nor its own fields', async () => {
    const { client, inserts } = seeded()
    expect(await call(createFlowTools(USER, client, WS, false, 'session', 'UTC').create_flow, { recipe: 'weekly_posts', recipe_options: { slots: 9 } })).toMatchObject({ success: false, field: 'recipe_options' })
    expect(await call(createFlowTools(USER, client, WS).create_flow, { name: 'Empty' })).toMatchObject({ success: false, field: 'trigger' })
    expect(inserts.flow).toBeUndefined()
  })
})
