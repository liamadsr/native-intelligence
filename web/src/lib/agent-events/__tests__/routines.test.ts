/**
 * Routines and flows through the agent's inbox (A6 slice 6).
 *
 * A routine (a flow / loop fire) is a tracked_job row the flow dispatcher
 * starts with the recorder (flow-functions.ts startFlowWork: kind
 * `flow_run`, actor 'loop', `source.flow_id`), so its finish and its failure
 * reach agent_event through the same recorder hook as every other work item
 * (agent-events/work.ts), and the router sorts them like the rest:
 *   • a routine that finished (silently: routine done pushes nothing) → one
 *     `work.done` row, notified false → quiet (it waits for "while you were
 *     away" and the digest);
 *   • a routine that left cards for review → `work.needs_review` → quiet, its
 *     notice recorded, never re-sent;
 *   • a routine that failed → `work.failed`, notified true → notify, recording
 *     the recorder's own `work_failed` notice (never a second one);
 *   • a quiet routine (deliver.notification = false) writes nothing.
 * Against the stateful ledger fake: the recorder writes the rows, the router
 * reads and routes them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const hoisted = vi.hoisted(() => ({
  pending: [] as Promise<unknown>[],
  send: vi.fn(async (..._args: unknown[]) => {}),
}))
vi.mock('@/lib/log/agent-log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/log/agent-log')>()),
  logWorkEvent: vi.fn(async () => true),
  memberUserId: vi.fn(async () => 'user-1'),
  deferLogWrite: (work: Promise<unknown>) => {
    hoisted.pending.push(work)
  },
}))
vi.mock('@/lib/notifications', () => ({ createNotification: vi.fn(async () => {}) }))
vi.mock('@/lib/work/notify', () => ({ notifyWorkNeedsYou: vi.fn(async () => true), notifyWorkFailed: vi.fn(async () => true) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: hoisted.send } }))

import { startWork } from '@/lib/work/recorder'
import { WORK_KINDS } from '@/lib/work/types'
import { routeAgentEvents, type RouterDeps } from '../router'

const routine = { workspaceId: 'w1', memberId: 'm1', kind: WORK_KINDS.flowRun, title: 'Weekly pipeline digest', actor: 'loop' as const, source: { flow_id: 'flow-1' } }

async function drain() {
  while (hoisted.pending.length) await hoisted.pending.shift()
}

function ledger() {
  // The table's defaults (migration 336): a new row, not routed yet.
  return makeFakeSupabase({ defaults: { agent_event: { state: 'new', outcome: null, notification_id: null, expires_at: null, priority: 1 } } })
}

function deps(over: Partial<RouterDeps> = {}): RouterDeps {
  return {
    isPaused: async () => false,
    isDormant: async () => false,
    isOverUsage: async () => false,
    decide: vi.fn(async () => ({ version: 'event-needs-person-v1', status: 'accepted' as const, pick: 'digest' as const, probability: 0.8, trusted: true })),
    sendMeetingNotice: vi.fn(async () => null),
    findNotice: vi.fn(async (_db, row) => (row.kind === 'work.failed' ? 'notice-failed-1' : row.kind === 'work.needs_review' ? 'notice-review-1' : null)),
    now: () => Date.now(),
    ...over,
  }
}

beforeEach(() => {
  hoisted.pending.length = 0
  hoisted.send.mockClear()
})

describe('a routine through the inbox and the router', () => {
  it('a routine that finished: one work.done row (no notice went out) → quiet', async () => {
    const fake = ledger()
    const run = await startWork(fake as never, routine)
    await run.finish({ summary: 'Sent the digest' })
    await drain()
    const rows = fake.rows('agent_event')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'work.done',
      source: 'work',
      user_id: 'user-1',
      ref_type: 'work_item',
      ref_id: run.id,
      facts: { title: 'Weekly pipeline digest', workKind: 'flow_run', notified: false },
      // One finish per routine per day (each fire is its own work item).
      dedupe_key: `work:flow:flow-1:done:${new Date().toISOString().slice(0, 10)}`,
    })
    expect(hoisted.send).toHaveBeenCalledWith(expect.objectContaining({ name: 'agent/event.created' }))

    const d = deps()
    const result = await routeAgentEvents(fake as never, { workspaceId: 'w1', userId: 'user-1' }, d)
    expect(result.outcomes).toEqual({ ignore: 0, quiet: 1, turn: 0, notify: 0 })
    expect(fake.rows('agent_event')[0]).toMatchObject({ state: 'routed', outcome: 'quiet', decided_by: 'rule' })
    expect(d.sendMeetingNotice).not.toHaveBeenCalled()
  })

  it('a routine that failed: work.failed, its notice recorded (never a second) → told in the home thread', async () => {
    const fake = ledger()
    const run = await startWork(fake as never, routine)
    await run.fail('The CRM sync timed out')
    await drain()
    expect(fake.rows('agent_event').map((r) => [r.kind, (r.facts as { notified?: boolean }).notified])).toEqual([['work.failed', true]])

    const d = deps()
    const result = await routeAgentEvents(fake as never, { workspaceId: 'w1', userId: 'user-1' }, d)
    expect(result.outcomes.turn).toBe(1)
    expect(fake.rows('agent_event')[0]).toMatchObject({ outcome: 'turn', notification_id: 'notice-failed-1' })
    expect(d.sendMeetingNotice).not.toHaveBeenCalled()
    // Forced by a rule: no shadow Jev call for it.
    expect(d.decide).not.toHaveBeenCalled()
  })

  it('a routine that left cards for review: needs_review → quiet, the review notice recorded', async () => {
    const fake = ledger()
    const run = await startWork(fake as never, routine)
    await run.finish({ summary: '2 cards', review: { kind: 'review', verb: 'review' } })
    await drain()
    const d = deps()
    await routeAgentEvents(fake as never, { workspaceId: 'w1', userId: 'user-1' }, d)
    expect(fake.rows('agent_event')[0]).toMatchObject({ kind: 'work.needs_review', outcome: 'quiet', notification_id: 'notice-review-1' })
  })

  it('a routine firing again the same day collapses into the one finish row', async () => {
    const fake = ledger()
    const first = await startWork(fake as never, routine)
    await first.finish({ summary: 'fire 1' })
    const second = await startWork(fake as never, { ...routine, runKey: 'fire-2' })
    await second.finish({ summary: 'fire 2' })
    await drain()
    expect(fake.rows('agent_event').filter((r) => r.kind === 'work.done')).toHaveLength(1)
  })

  it('autonomy off: a finished routine is routed quiet (shown once unpaused), a failure the recorder already notified stays recorded', async () => {
    const fake = ledger()
    const ok = await startWork(fake as never, routine)
    await ok.finish({ summary: 'done' })
    const bad = await startWork(fake as never, { ...routine, title: 'Nightly import' })
    await bad.fail('boom')
    await drain()
    await routeAgentEvents(fake as never, { workspaceId: 'w1', userId: 'user-1' }, deps({ isPaused: async () => true }))
    const byKind = Object.fromEntries(fake.rows('agent_event').map((r) => [r.kind, r.outcome]))
    expect(byKind).toEqual({ 'work.done': 'quiet', 'work.failed': 'quiet' })
    expect(fake.rows('agent_event').find((r) => r.kind === 'work.failed')).toMatchObject({ notification_id: 'notice-failed-1' })
  })

  it('a quiet routine (deliver.notification = false) writes nothing to the inbox', async () => {
    const fake = ledger()
    const run = await startWork(fake as never, { ...routine, quiet: true })
    await run.fail('boom')
    await drain()
    expect(fake.rows('agent_event')).toEqual([])
  })
})
