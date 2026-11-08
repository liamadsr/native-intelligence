/**
 * The router's real dependencies (src/lib/agent-events/router-deps.ts).
 *
 * Pinned: the meeting notice speaks through the face (the Calendar face,
 * bot keys and its sentence around a clipped title), targets the capture,
 * and goes out once per event (its group key); the recorder's notice is found
 * by its work item, a mention's is its own; the usage gate is a boolean
 * (over the limit → true, an infra error → false); Jev runs in shadow mode;
 * the proven kinds come from this version's recent answers, cached per process.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NonRetriableError } from 'inngest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const hoisted = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  guard: vi.fn(async (_userId: string): Promise<{ chatgptPlan: boolean }> => ({ chatgptPlan: false })),
  runDecision: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ status: 'accepted', value: { pick: 'now', probability: 0.95, trusted: true } })),
}))

vi.mock('@/lib/notifications', () => ({
  createNotification: vi.fn(async (p: Record<string, unknown>) => {
    hoisted.db.seed('notification', [
      { id: `n-${hoisted.db.rows('notification').length + 1}`, recipient_id: p.recipientId, type: p.type, title: p.title, body: p.body, target_type: p.targetType ?? null, target_id: p.targetId ?? null, group_key: p.groupKey, metadata: p.metadata, created_at: new Date().toISOString() },
    ])
  }),
}))
vi.mock('@/lib/work/system-teammates', () => ({ areaTeammateId: vi.fn(async () => 'face-calendar') }))
vi.mock('@/lib/bots/bot-notice', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bots/bot-notice')>()),
  noticeTeammateName: vi.fn(async () => 'Dial'),
}))
vi.mock('@/lib/inngest/usage-guard', () => ({ guardBackgroundUsageOnPlan: hoisted.guard }))
vi.mock('@/lib/inngest/flow-functions', () => ({ workspaceIsDormant: vi.fn(async () => false) }))
vi.mock('@/lib/ai/decisions/run-decision', () => ({ runDecision: hoisted.runDecision }))

import { JEV_PROVEN_CACHE_MS, decideEventNeedsPersonShadow, eventTurnRequestId, findExistingNotice, isOverBackgroundUsage, jevProvenKinds, meetingNoticeCopy, requestEventTurn, resetJevProvenCache, sendMeetingNotice } from '../router-deps'
import { EVENT_NEEDS_PERSON_VERSION, JEV_PROVEN_MIN_CASES } from '../router'
import type { AgentEventRow } from '../types'

const NOW = Date.parse('2026-10-14T12:00:00.000Z')

const meetingRow = (over: Partial<AgentEventRow> = {}): AgentEventRow => ({
  id: '7',
  workspace_id: 'w1',
  user_id: 'u1',
  source: 'meeting',
  kind: 'meeting.soon',
  priority: 2,
  occurs_at: new Date(NOW + 20 * 60_000).toISOString(),
  expires_at: null,
  ref_type: 'capture',
  ref_id: 'cap-1',
  facts: { title: 'Acme <sync>', prepReady: true },
  dedupe_key: 'meeting:capture:cap-1:x',
  state: 'new',
  outcome: null,
  notification_id: null,
  created_at: new Date(NOW).toISOString(),
  ...over,
})

beforeEach(() => {
  hoisted.db = makeFakeSupabase()
  hoisted.db.seed('member', [{ id: 'm1', workspace_id: 'w1', user_id: 'u1' }])
  hoisted.guard.mockReset()
  hoisted.runDecision.mockClear()
})

describe('meeting notice', () => {
  it('Native Intelligence’s sentence around a clipped title; "prep is ready" only when it is', () => {
    expect(meetingNoticeCopy(meetingRow(), NOW)).toEqual({
      title: '“Acme ‹sync›” starts in 20 min',
      sentence: '“Acme ‹sync›” starts in 20 minutes. Your prep is ready.',
      body: 'Your prep is ready.',
    })
    expect(meetingNoticeCopy(meetingRow({ facts: { title: 'Acme <sync>', prepReady: false } }), NOW)).toEqual({
      title: '“Acme ‹sync›” starts in 20 min',
      sentence: '“Acme ‹sync›” starts in 20 minutes.',
      body: 'Starts in 20 minutes.',
    })
  })

  it('a plain heads-up (no prep) goes out too, without saying prep is ready', async () => {
    await sendMeetingNotice(hoisted.db as never, meetingRow({ id: '8', facts: { title: 'Acme', prepReady: false } }), NOW)
    const [notice] = hoisted.db.rows('notification')
    expect(notice).toMatchObject({ type: 'meeting_starting_soon', metadata: expect.objectContaining({ agent_event_id: '8', prep_ready: false }) })
    expect(JSON.stringify(notice)).not.toContain('prep is ready')
  })

  it('goes out once per event, through the Calendar face, targeting the capture', async () => {
    const id = await sendMeetingNotice(hoisted.db as never, meetingRow(), NOW)
    expect(id).toBe('n-1')
    const [notice] = hoisted.db.rows('notification')
    expect(notice).toMatchObject({
      recipient_id: 'm1',
      type: 'meeting_starting_soon',
      title: 'Dial',
      body: '“Acme ‹sync›” starts in 20 minutes. Your prep is ready.',
      target_type: 'capture',
      target_id: 'cap-1',
      group_key: 'agent_event:7',
      metadata: { agent_event_id: '7', teammate_id: 'face-calendar', area: 'calendar', capture_id: 'cap-1', prep_ready: true },
    })
    expect(await sendMeetingNotice(hoisted.db as never, meetingRow(), NOW)).toBe('n-1')
    expect(hoisted.db.rows('notification')).toHaveLength(1)
    // No member in the workspace: nothing goes out.
    expect(await sendMeetingNotice(hoisted.db as never, meetingRow({ user_id: 'stranger', id: '8' }), NOW)).toBeNull()
  })
})

describe('findExistingNotice', () => {
  it('finds the recorder’s notice by its work item; a notice’s event’s is its own ref', async () => {
    hoisted.db.seed('notification', [
      { id: 'old', recipient_id: 'm1', type: 'work_needs_you', target_type: 'work_item', target_id: 'job-1', created_at: '2026-10-14T10:00:00.000Z' },
      { id: 'new', recipient_id: 'm1', type: 'work_needs_you', target_type: 'work_item', target_id: 'job-1', created_at: '2026-10-14T11:00:00.000Z' },
      { id: 'other', recipient_id: 'm1', type: 'comment_added', target_type: 'work_item', target_id: 'job-1', created_at: '2026-10-14T11:30:00.000Z' },
    ])
    expect(await findExistingNotice(hoisted.db as never, meetingRow({ kind: 'work.needs_input', ref_type: 'work_item', ref_id: 'job-1' }))).toBe('new')
    expect(await findExistingNotice(hoisted.db as never, meetingRow({ kind: 'mention', ref_type: 'notification', ref_id: 'n-9' }))).toBe('n-9')
    for (const kind of ['activity', 'reminder.due', 'contact.followup_due', 'sequence.failed'] as const) {
      expect(await findExistingNotice(hoisted.db as never, meetingRow({ kind, ref_type: 'notification', ref_id: 'n-10' }))).toBe('n-10')
    }
    expect(await findExistingNotice(hoisted.db as never, meetingRow({ kind: 'work.failed', ref_type: 'work_item', ref_id: 'job-2' }))).toBeNull()
  })
})

describe('gates and Jev', () => {
  it('the usage gate is a boolean: over the limit is true, an infra error is false', async () => {
    hoisted.guard.mockRejectedValueOnce(new NonRetriableError('Usage limit reached'))
    expect(await isOverBackgroundUsage('u1')).toBe(true)
    hoisted.guard.mockRejectedValueOnce(new Error('network'))
    expect(await isOverBackgroundUsage('u1')).toBe(false)
    expect(await isOverBackgroundUsage('u1')).toBe(false)
  })

  it('opts in to the ChatGPT plan: a person on their own plan is not over it', async () => {
    hoisted.guard.mockResolvedValueOnce({ chatgptPlan: true })
    expect(await isOverBackgroundUsage('u1')).toBe(false)
    expect(hoisted.guard).toHaveBeenLastCalledWith('u1')
  })

  it('asks event.needs_person in shadow mode and stores its answer', async () => {
    const input = { kind: 'email.drafted' as const, priority: 1, startsInMinutes: null, facts: { title: 'Re: x' } }
    const out = await decideEventNeedsPersonShadow(input, { userId: 'u1', workspaceId: 'w1', runId: 'agent_event:1' })
    expect(hoisted.runDecision).toHaveBeenCalledWith('event.needs_person', input, { userId: 'u1', workspaceId: 'w1', runId: 'agent_event:1', mode: 'shadow' })
    expect(out).toMatchObject({ status: 'accepted', pick: 'now', trusted: true })
  })
})

describe('requestEventTurn (one home turn for a pass\'s turn rows)', () => {
  it('sends ONE home/turn.requested, reason event, to the person\'s home thread, keyed per thread and set of rows', async () => {
    const db = makeFakeSupabase()
    db.seed('chat_conversations', [
      { id: 'side', user_id: 'u1', workspace_id: 'w1', is_home: null },
      { id: 'home', user_id: 'u1', workspace_id: 'w1', is_home: true },
    ])
    const send = vi.fn(async () => ({}))
    expect(await requestEventTurn(db as never, { workspaceId: 'w1', userId: 'u1' }, ['12', '4', 'junk'], { send })).toBe(true)
    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith({
      id: eventTurnRequestId('home', ['12', '4']),
      name: 'home/turn.requested',
      data: { conversationId: 'home', userId: 'u1', workspaceId: 'w1', workItemIds: [], reason: 'event', eventIds: ['12', '4'] },
    })
    // The same rows again are the same Inngest event (a retried pass sends nothing twice).
    expect(eventTurnRequestId('home', ['4', '12'])).toBe(eventTurnRequestId('home', ['12', '4']))
  })

  it('no home thread: nothing is sent, and the rows wait for the away section and the digest', async () => {
    const db = makeFakeSupabase()
    const send = vi.fn(async () => ({}))
    expect(await requestEventTurn(db as never, { workspaceId: 'w1', userId: 'u1' }, ['1'], { send })).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('jevProvenKinds', () => {
  const answerRow = (i: number, kind: string, over: Record<string, unknown> = {}) => ({
    id: `p-${kind}-${i}`, workspace_id: `w${i % 3}`, user_id: `u${i % 5}`, kind, state: 'routed', outcome: 'quiet', decided_by: 'rule',
    routed_at: new Date(NOW - 60_000 * (i + 1)).toISOString(), created_at: new Date(NOW - 60_000 * (i + 2)).toISOString(), dedupe_key: `p-${kind}-${i}`,
    jev_shadow: { version: EVENT_NEEDS_PERSON_VERSION, status: 'accepted', pick: 'digest', probability: 0.95, trusted: true, rule_outcome: 'quiet', rule: 'quiet' },
    ...over,
  })

  beforeEach(() => resetJevProvenCache())

  it('reads this version’s recent answers across everyone and returns the proven kinds; caches them for a while', async () => {
    const db = makeFakeSupabase()
    db.seed('agent_event', [
      ...Array.from({ length: JEV_PROVEN_MIN_CASES }, (_, i) => answerRow(i, 'email.drafted')),
      ...Array.from({ length: JEV_PROVEN_MIN_CASES - 1 }, (_, i) => answerRow(i, 'capture.processed')),
      // Another version, and an answer older than the window, never count.
      ...Array.from({ length: JEV_PROVEN_MIN_CASES }, (_, i) => answerRow(i, 'meeting.soon', { jev_shadow: { version: 'event-needs-person-v1', status: 'accepted', pick: 'digest', trusted: true, rule_outcome: 'quiet' } })),
      ...Array.from({ length: JEV_PROVEN_MIN_CASES }, (_, i) => answerRow(i, 'email.needs_reply', { routed_at: new Date(NOW - 40 * 24 * 60 * 60_000).toISOString() })),
    ])
    expect([...(await jevProvenKinds(db as never, NOW))]).toEqual([['email.drafted', { lower: false, raise: true }]])
    // Cached: a new row inside the cache window changes nothing until it lapses.
    db.seed('agent_event', [answerRow(99, 'capture.processed')])
    expect([...(await jevProvenKinds(db as never, NOW + 1000)).keys()]).toEqual(['email.drafted'])
    expect([...(await jevProvenKinds(db as never, NOW + JEV_PROVEN_CACHE_MS + 1)).keys()].sort()).toEqual(['capture.processed', 'email.drafted'])
  })

  it('throws on a failed read (the router then leaves every row to the rules) and caches nothing', async () => {
    const broken = { from: () => ({ select: () => ({ eq: () => ({ in: () => ({ gte: () => ({ order: () => ({ limit: async () => ({ data: null, error: { message: 'boom' } }) }) }) }) }) }) }) }
    await expect(jevProvenKinds(broken as never, NOW)).rejects.toThrow('boom')
    const db = makeFakeSupabase()
    db.seed('agent_event', Array.from({ length: JEV_PROVEN_MIN_CASES }, (_, i) => answerRow(i, 'email.drafted')))
    expect([...(await jevProvenKinds(db as never, NOW)).keys()]).toEqual(['email.drafted'])
  })
})
