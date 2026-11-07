/**
 * rename_bot, delete_bot and merge_bots (GEN-1168): a rename applies at once;
 * a delete or a merge only raises the person's card, and runs on the replay of
 * their Accept, and only while the agents are what the card showed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ToolExecutionOptions } from 'ai'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const h = vi.hoisted(() => ({
  db: null as unknown,
  approvals: [] as Array<Record<string, unknown>>,
}))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => h.db }))
vi.mock('@/lib/safety/approvals', () => ({
  createToolApproval: async (_client: unknown, approval: Record<string, unknown>) => {
    h.approvals.push(approval)
    return { ok: true, approvalId: `approval-${h.approvals.length}`, cardId: `card-${h.approvals.length}` }
  },
}))

import { createBotManageTools } from '../bot-manage'
import { WORK_BOT_ANCHOR_SLUG } from '@/lib/flows/flow-bot'
import type { ApprovedCall } from '@/lib/safety/approved-call'

const WS = 'ws-1'
const ME = 'user-me'
const EXEC = { toolCallId: 'c', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>
type Result = Record<string, unknown>

const mate = (id: string, over: Record<string, unknown>) => ({
  id,
  workspace_id: WS,
  team_id: 'team-open',
  is_system: false,
  system_key: null,
  fronts_only: true,
  role: null,
  bot_character: 'berry',
  agent_recipe_id: 'anchor',
  ...over,
})

function world(): FakeSupabase {
  const db = makeFakeSupabase({ project: true })
  db.seed('recipe', [{ id: 'anchor', slug: WORK_BOT_ANCHOR_SLUG, category: 'agent', workspace_id: null, is_system: false }])
  db.seed('member', [{ id: 'm-me', workspace_id: WS, user_id: ME, role: 'owner' }])
  db.seed('team', [{ id: 'team-open', workspace_id: WS, is_private: false }])
  db.seed('team_member', [{ team_id: 'team-open', member_id: 'm-me', team_role: 'member' }])
  db.seed('ai_team_member', [
    mate('tm-assistant', { name: 'Assistant', is_system: true, system_key: 'assistant', fronts_only: false, bot_character: 'chat', created_at: '2026-10-01T00:00:00Z' }),
    mate('berry-1', { name: 'Berry', created_at: '2026-10-03T00:00:01Z' }),
    mate('berry-2', { name: 'Berry', created_at: '2026-10-03T00:00:02Z' }),
    mate('sprout-1', { name: 'Sprout', bot_character: 'sprout', created_at: '2026-10-03T00:00:03Z' }),
    mate('sprout-2', { name: 'Sprout', bot_character: 'sprout', created_at: '2026-10-03T00:00:04Z' }),
  ])
  db.seed('flow', [{ id: 'loop-weekly', workspace_id: WS, name: 'Weekly report', ai_team_member_id: 'berry-2', created_by: ME, created_at: '2026-10-03T00:00:00Z' }])
  db.seed('tracked_job', [{ id: 'job-1', workspace_id: WS, ai_team_member_id: 'sprout-2', status: 'done' }])
  db.seed('chat_conversations', [{ id: 'chat-1', workspace_id: WS, user_id: ME, ai_team_member_id: 'sprout-1' }])
  return db
}

let db: FakeSupabase
const tools = (approvedCall?: ApprovedCall) =>
  createBotManageTools(ME, db as unknown as SupabaseClient, WS, false, { conversationId: 'conv-1', approvedCall }) as unknown as Record<
    string,
    { execute: (input: Record<string, unknown>, opts: typeof EXEC) => Promise<Result> }
  >
const run = (name: string, input: Record<string, unknown>, approvedCall?: ApprovedCall) => tools(approvedCall)[name].execute(input, EXEC)

/** The replay of the person's Accept on the last card: its stored input, with the card's own context. */
async function accept(name: string): Promise<Result> {
  const card = h.approvals[h.approvals.length - 1]
  const context = card.context as { bots: NonNullable<ApprovedCall['bots']> }
  return run(name, card.input as Record<string, unknown>, { approvalId: 'approval-x', tool: name, bots: context.bots })
}

beforeEach(() => {
  db = world()
  h.db = db
  h.approvals.length = 0
})

describe('rename_bot', () => {
  it('renames at once', async () => {
    const r = await run('rename_bot', { bot_id: 'berry-1', name: 'Daily brief' })
    expect(r).toMatchObject({ success: true, previous_name: 'Berry', name: 'Daily brief' })
    expect(db.rows('ai_team_member').find((m) => m.id === 'berry-1')!.name).toBe('Daily brief')
  })

  it('never renames the person’s own agent, and says where its name lives', async () => {
    const r = await run('rename_bot', { bot_id: 'tm-assistant', name: 'Jarvis' })
    expect(r).toMatchObject({ success: false, code: 'NOT_ALLOWED', error: expect.stringMatching(/Settings → Preferences/) })
  })

  it('answers an unknown id with where the ids are', async () => {
    expect(await run('rename_bot', { bot_id: 'ghost', name: 'X' })).toMatchObject({ code: 'NOT_FOUND', error: expect.stringMatching(/list_bot_work/) })
  })
})

describe('delete_bot', () => {
  it('refuses an agent a loop points at, naming the loops', async () => {
    const r = await run('delete_bot', { bot_id: 'berry-2' })
    expect(r).toMatchObject({ success: false, code: 'BOT_FRONTS_LOOPS', loops: [{ flow_id: 'loop-weekly', name: 'Weekly report' }] })
    expect(h.approvals).toHaveLength(0)
  })

  it('raises the person’s card first, and deletes only on the replay of their Accept', async () => {
    const r = await run('delete_bot', { bot_id: 'sprout-1' })
    expect(r).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED', approval_id: 'approval-1' })
    expect(h.approvals[0]).toMatchObject({
      door: 'chat',
      toolName: 'delete_bot',
      sideEffect: 'delete',
      conversationId: 'conv-1',
      input: { bot_id: 'sprout-1', deleted_with_it: '1 chat, 0 memories' },
      card: { title: 'Delete the agent “Sprout”?' },
      context: { bots: { kind: 'delete', bot_ids: ['sprout-1'] } },
    })
    expect(db.rows('ai_team_member').map((m) => m.id)).toContain('sprout-1')

    expect(await accept('delete_bot')).toMatchObject({ success: true, deleted_bot_id: 'sprout-1' })
    expect(db.rows('ai_team_member').map((m) => m.id)).not.toContain('sprout-1')
  })

  it('refuses the replay when the agent changed since the card', async () => {
    await run('delete_bot', { bot_id: 'sprout-1' })
    db.rows('ai_team_member').find((m) => m.id === 'sprout-1')!.name = 'Renamed'
    expect(await accept('delete_bot')).toMatchObject({ success: false, code: 'BOT_CHANGED' })
    expect(db.rows('ai_team_member').map((m) => m.id)).toContain('sprout-1')
  })

  it('an accepted card for one agent never deletes another', async () => {
    await run('delete_bot', { bot_id: 'sprout-1' })
    const card = h.approvals[0].context as { bots: NonNullable<ApprovedCall['bots']> }
    const r = await run('delete_bot', { bot_id: 'berry-1' }, { approvalId: 'a', tool: 'delete_bot', bots: card.bots })
    expect(r).toMatchObject({ code: 'APPROVAL_REQUIRED' })
    expect(db.rows('ai_team_member').map((m) => m.id)).toContain('berry-1')
  })
})

describe('merge_bots', () => {
  it('“clean up my duplicate agents”: one card for every group, then the merge on Accept, no loop broken', async () => {
    const r = await run('merge_bots', {})
    expect(r).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED' })
    expect(h.approvals).toHaveLength(1)
    const card = h.approvals[0] as { input: Record<string, unknown>; card: { title: string }; context: { bots: { bot_ids: string[] } } }
    expect(card.card.title).toBe('Clean up 2 duplicate agents?')
    expect(card.input.groups).toEqual([
      { keep_id: 'berry-2', remove_ids: ['berry-1'] },
      { keep_id: 'sprout-2', remove_ids: ['sprout-1'] },
    ])
    expect(card.input.keep).toBe('Berry (1 loop: “Weekly report”; 0 runs)\nSprout (no loop; 1 run)')
    expect(card.input.remove).toBe('Berry → Berry (no loop; 0 runs)\nSprout → Sprout (no loop; 0 runs; 1 chat)')
    expect(card.context.bots.bot_ids).toEqual(['berry-1', 'berry-2', 'sprout-1', 'sprout-2'])
    expect(db.rows('ai_team_member')).toHaveLength(5)

    expect(await accept('merge_bots')).toMatchObject({ success: true, removed: 2 })
    expect(db.rows('ai_team_member').map((m) => m.id).sort()).toEqual(['berry-2', 'sprout-2', 'tm-assistant'])
    expect(db.rows('flow')[0].ai_team_member_id).toBe('berry-2')
  })

  it('a kept agent that takes a spare’s loop: the loop moves before the spare goes', async () => {
    const r = await run('merge_bots', { groups: [{ keep_id: 'berry-1', remove_ids: ['berry-2'] }] })
    expect(r).toMatchObject({ code: 'APPROVAL_REQUIRED' })
    expect((h.approvals[0].card as { title: string }).title).toBe('Merge 2 “Berry” agents into one?')
    expect(await accept('merge_bots')).toMatchObject({ success: true, removed: 1, moved_loops: 1 })
    expect(db.rows('flow')[0].ai_team_member_id).toBe('berry-1')
  })

  it('refuses the replay when a loop was pointed at a spare since', async () => {
    await run('merge_bots', { groups: [{ keep_id: 'sprout-2', remove_ids: ['sprout-1'] }] })
    db.seed('flow', [{ id: 'loop-new', workspace_id: WS, name: 'New', ai_team_member_id: 'sprout-1', created_by: ME, created_at: '2026-10-05T00:00:00Z' }])
    expect(await accept('merge_bots')).toMatchObject({ success: false, code: 'BOT_CHANGED' })
    expect(db.rows('ai_team_member').map((m) => m.id)).toContain('sprout-1')
  })

  it('refuses a built-in agent, an agent named twice, and says so before any card', async () => {
    expect(await run('merge_bots', { groups: [{ keep_id: 'berry-1', remove_ids: ['tm-assistant'] }] })).toMatchObject({ success: false, code: 'NOT_ALLOWED' })
    expect(await run('merge_bots', { groups: [{ keep_id: 'berry-1', remove_ids: ['sprout-1'] }, { keep_id: 'sprout-2', remove_ids: ['sprout-1'] }] })).toMatchObject({
      code: 'INPUT_INVALID',
    })
    expect(h.approvals).toHaveLength(0)
  })

  it('says there is nothing to merge when every agent has its own name', async () => {
    db.rows('ai_team_member').find((m) => m.id === 'berry-1')!.name = 'Ember'
    db.rows('ai_team_member').find((m) => m.id === 'sprout-1')!.name = 'Nova'
    expect(await run('merge_bots', {})).toMatchObject({ success: true, groups: [] })
    expect(h.approvals).toHaveLength(0)
  })
})

describe('a stale card is never handed back', () => {
  it('asking again after the agent changed raises a new card, not the pending one', async () => {
    await run('delete_bot', { bot_id: 'sprout-1' })
    db.rows('ai_team_member').find((m) => m.id === 'sprout-1')!.name = 'Renamed'
    await run('delete_bot', { bot_id: 'sprout-1' })
    const [first, second] = h.approvals.map((a) => (a.input as { state_hash: string }).state_hash)
    expect(first).not.toBe(second)
  })
})
