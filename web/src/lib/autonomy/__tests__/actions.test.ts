/**
 * The agent's own actions (actions.ts, undo.ts; phase 3): scheduling, the run
 * at the end of the undo window (re-checked, then the card's own accept path,
 * as the person on their standing yes: Liam, 11-27, decision 1), and the Undo
 * (the card's Dismiss in the window), which demotes the kind (decision 4).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

vi.mock('server-only', () => ({}))
const mocks = vi.hoisted(() => ({ append: vi.fn(async () => ({ written: true })), approve: vi.fn() }))
vi.mock('@/lib/chat/home-message-writer', () => ({ appendHomeMessage: mocks.append }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => ({})) } }))
vi.mock('@/lib/safety/approvals', () => ({ approveToolCall: mocks.approve }))

import { autonomousCardWhy, autonomousHeldMessage, runAutonomousAction, scheduleAutonomousAction, AUTONOMY_ACTION_EVENT } from '../actions'
import { undoScheduledActions } from '../undo'
import { kindOfCall } from '../kind'

const WS = 'ws-1'
const USER = 'user-1'
const NOW = new Date('2026-11-27T12:00:00Z')
const call = { tool: 'create_calendar_event', input: { title: 'Sync', attendees: ['dana@example.com'] } }
const kind = kindOfCall(call)
let db: FakeSupabase
const yes = { env: { EARNED_AUTONOMY: 'graduate' }, paused: async () => false, known: (async (_d: unknown, a: { recipients: readonly string[] }) => new Set(a.recipients)) as never }

function world(actionStatus = 'scheduled', approvalStatus = 'pending', runAt = new Date(NOW.getTime() - 1000).toISOString()) {
  db.seed('tool_approval', [{ id: 'ap-1', workspace_id: WS, user_id: USER, tool: call.tool, input: call.input, context: {}, status: approvalStatus, card_id: 'card-1' }])
  db.seed('attention_item', [{ id: 'card-1', workspace_id: WS, status: 'pending' }])
  db.seed('autonomy_kind', [{ id: 'k1', workspace_id: WS, user_id: USER, kind_key: kind.key, level: 'tell', pinned_ask: false, granted_at: new Date(NOW.getTime() - 86_400_000 * 20).toISOString() }])
  db.seed('autonomy_action', [{ id: 'act-1', workspace_id: WS, user_id: USER, approval_id: 'ap-1', card_id: 'card-1', kind_key: kind.key, tool: call.tool, level: 'tell', status: actionStatus, run_at: runAt, title: 'Invite Dana to Sync', created_at: new Date(NOW.getTime() - 300_000).toISOString() }])
}

beforeEach(() => {
  db = makeFakeSupabase({ project: true, bulkUpsert: true })
  mocks.append.mockClear()
  mocks.approve.mockReset()
  mocks.approve.mockResolvedValue({ ok: true, status: 'executed', success: true, result: { success: true } })
})

describe('scheduleAutonomousAction', () => {
  const graduation = { run: true as const, level: 'tell' as const, kind, runAt: new Date(NOW.getTime() + 300_000).toISOString() }

  it('records the action with its card and wakes the runner at run_at', async () => {
    db.seed('tool_approval', [{ id: 'ap-1', card_id: 'card-1' }])
    const send = vi.fn(async () => ({}))
    expect(await scheduleAutonomousAction(db as never, { graduation, approvalId: 'ap-1', workspaceId: WS, userId: USER, title: 'Invite Dana' }, { send })).toBe(true)
    expect(db.rows('autonomy_action')[0]).toMatchObject({ approval_id: 'ap-1', card_id: 'card-1', kind_key: kind.key, level: 'tell', status: 'scheduled', run_at: graduation.runAt, recipients: ['dana@example.com'] })
    expect(send).toHaveBeenCalledWith({ name: AUTONOMY_ACTION_EVENT, data: { action_id: db.rows('autonomy_action')[0].id, run_at: graduation.runAt } })
  })

  it('a failed write is false (the card waits for the person); a reused approval is already scheduled', async () => {
    db.failNextInsert('autonomy_action', { message: 'relation does not exist' })
    expect(await scheduleAutonomousAction(db as never, { graduation, approvalId: 'ap-1', workspaceId: WS, userId: USER, title: 't' }, { send: vi.fn() })).toBe(false)
    db.failNextInsert('autonomy_action', { code: '23505', message: 'duplicate' })
    const send = vi.fn()
    expect(await scheduleAutonomousAction(db as never, { graduation, approvalId: 'ap-1', workspaceId: WS, userId: USER, title: 't' }, { send })).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })

  it("the card and the model both say it goes on its own in 5 minutes and how to stop it", () => {
    expect(autonomousCardWhy('Dana is outside the workspace.')).toBe('You said I can handle these myself, so this goes on its own in 5 minutes. Dismiss it to stop it. Dana is outside the workspace.')
    expect(autonomousHeldMessage('create_calendar_event')).toContain('runs on its own in 5 minutes unless they stop it')
  })
})

describe('runAutonomousAction', () => {
  it('re-checks, claims, and approves as the person on their standing yes; the card is accepted; the outcome is ran', async () => {
    world()
    expect(await runAutonomousAction(db as never, 'act-1', { ...yes, now: NOW })).toBe('ran')
    expect(mocks.approve).toHaveBeenCalledWith(db, { callerClass: 'person', userId: USER }, { workspace_id: WS, payload: { approval_id: 'ap-1' } }, { autonomousActionId: 'act-1' })
    expect(db.rows('autonomy_action')[0]).toMatchObject({ status: 'ran' })
    expect(db.rows('attention_item')[0]).toMatchObject({ status: 'accepted' })
    expect(db.rows('autonomy_outcome')).toEqual([expect.objectContaining({ source: 'autonomy_action', source_id: 'act-1', outcome: 'ran', kind_key: kind.key })])
  })

  it('not before its window ends', async () => {
    world('scheduled', 'pending', new Date(NOW.getTime() + 60_000).toISOString())
    expect(await runAutonomousAction(db as never, 'act-1', { ...yes, now: NOW })).toBe('not_due')
    expect(mocks.approve).not.toHaveBeenCalled()
  })

  it('undone, already run or gone: nothing runs', async () => {
    world('undone')
    expect(await runAutonomousAction(db as never, 'act-1', { ...yes, now: NOW })).toBe('gone')
    expect(await runAutonomousAction(db as never, 'missing', { ...yes, now: NOW })).toBe('gone')
    expect(mocks.approve).not.toHaveBeenCalled()
  })

  it('a card the person already answered, or that expired (the kill switch), cancels it quietly', async () => {
    world('scheduled', 'denied')
    expect(await runAutonomousAction(db as never, 'act-1', { ...yes, now: NOW })).toBe('cancelled')
    expect(mocks.approve).not.toHaveBeenCalled()
    expect(mocks.append).not.toHaveBeenCalled()
  })

  it('a revoke in the window sends it back to the card, and says so in the home thread', async () => {
    world()
    db.rows('autonomy_kind')[0].level = 'ask'
    expect(await runAutonomousAction(db as never, 'act-1', { ...yes, now: NOW })).toBe('cancelled')
    expect(mocks.approve).not.toHaveBeenCalled()
    expect(db.rows('autonomy_action')[0]).toMatchObject({ status: 'cancelled', reason: 'you took this kind back' })
    expect(db.rows('attention_item')[0]).toMatchObject({ status: 'pending' })
    expect(mocks.append).toHaveBeenCalledWith(db, expect.objectContaining({ parts: [{ type: 'text', text: expect.stringContaining('Its card is waiting for your yes') }] }))
  })

  it('graduation switched off in the window, the kill switch, or a recipient no longer known: the card', async () => {
    for (const d of [{ ...yes, env: {} }, { ...yes, paused: async () => true }, { ...yes, known: (async () => new Set()) as never }]) {
      db = makeFakeSupabase({ project: true, bulkUpsert: true })
      world()
      expect(await runAutonomousAction(db as never, 'act-1', { ...d, now: NOW })).toBe('cancelled')
    }
    expect(mocks.approve).not.toHaveBeenCalled()
  })

  it('an accept the re-checks refuse: failed, the card is settled, no clean outcome', async () => {
    world()
    mocks.approve.mockResolvedValue({ ok: false, status: 409, code: 'INPUT_CHANGED', error: 'changed' })
    expect(await runAutonomousAction(db as never, 'act-1', { ...yes, now: NOW })).toBe('failed')
    expect(db.rows('autonomy_action')[0]).toMatchObject({ status: 'failed', reason: 'changed' })
    expect(db.rows('autonomy_outcome')).toEqual([])
  })

  it('a second runner (a retry) never approves twice', async () => {
    world()
    await runAutonomousAction(db as never, 'act-1', { ...yes, now: NOW })
    await runAutonomousAction(db as never, 'act-1', { ...yes, now: NOW })
    expect(mocks.approve).toHaveBeenCalledTimes(1)
  })
})

describe('undoScheduledActions', () => {
  it('a Dismiss in the window: undone, recorded, and the kind is back to ask with its cooldown', async () => {
    world()
    expect(await undoScheduledActions(db as never, ['ap-1'])).toEqual(new Set(['ap-1']))
    expect(db.rows('autonomy_action')[0]).toMatchObject({ status: 'undone' })
    expect(db.rows('autonomy_outcome')).toEqual([expect.objectContaining({ outcome: 'undone', source: 'autonomy_action', source_id: 'act-1', channel: 'calendar', audience: 'one' })])
    expect(db.rows('autonomy_kind')[0]).toMatchObject({ level: 'ask' })
    expect(db.rows('autonomy_kind')[0].demoted_at).toBeTruthy()
  })

  it('an action that already ran is not undone (its card was already settled)', async () => {
    world('ran')
    expect(await undoScheduledActions(db as never, ['ap-1'])).toEqual(new Set())
    expect(db.rows('autonomy_kind')[0]).toMatchObject({ level: 'tell' })
  })
})
