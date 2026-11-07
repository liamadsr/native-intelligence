/**
 * The recorder's agent-inbox hook (A6, src/lib/agent-events/work.ts): beside
 * each log line, a won move into needs_input, needs_review, done or failed
 * writes ONE agent_event for the row's owner, saying whether that move's
 * notice went out (so the router records it and never resends). A lost CAS,
 * a start, a cancel, a quiet row and a delegated child write none; a row
 * written already failed says its notice did not go out.
 *
 * Against the stateful ledger fake, with the log writes deferred into a list
 * the test drains, and the router wake-up mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase } from './fake-supabase'

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
const notify = vi.hoisted(() => ({ needsYou: vi.fn(async () => true), failed: vi.fn(async () => true) }))
vi.mock('../notify', () => ({ notifyWorkNeedsYou: notify.needsYou, notifyWorkFailed: notify.failed }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: hoisted.send } }))

import { attachWork, startWork } from '../recorder'
import type { WorkItem } from '../types'

const base = { workspaceId: 'w1', memberId: 'm1', kind: 'work_run', title: 'Reply drafts', area: 'mail' as const }

async function drain() {
  while (hoisted.pending.length) await hoisted.pending.shift()
}

beforeEach(() => {
  hoisted.pending.length = 0
  hoisted.send.mockClear()
  notify.needsYou.mockClear().mockResolvedValue(true)
  notify.failed.mockClear().mockResolvedValue(true)
})

describe('recorder → agent_event', () => {
  it('writes one event per won move that matters, for the owner, with whether its notice went out', async () => {
    const fake = makeFakeSupabase()
    const work = await startWork(fake as never, base)
    await work.step('Reading')
    await work.needInput(['Which tone?'])
    await work.resume()
    await work.finish({ summary: '3 drafts', review: { kind: 'review', verb: 'review' } })
    await drain()
    const rows = fake.rows('agent_event')
    expect(rows.map((r) => r.kind)).toEqual(['work.needs_input', 'work.needs_review'])
    expect(rows[0]).toMatchObject({
      workspace_id: 'w1',
      user_id: 'user-1',
      source: 'work',
      ref_type: 'work_item',
      ref_id: work.id,
      facts: { title: 'Reply drafts', workKind: 'work_run', area: 'mail', notified: true },
    })
    expect(String(rows[0].dedupe_key)).toMatch(new RegExp(`^work:${work.id}:needs_input:\\d+$`))
    expect(rows[1].dedupe_key).toBe(`work:${work.id}:needs_review`)
    expect(hoisted.send).toHaveBeenCalledWith(expect.objectContaining({ name: 'agent/event.created', data: { workspaceId: 'w1', userId: 'user-1', personKey: 'w1:user-1' } }))
  })

  it('a failure says its notice went out; a muted finish and a lost CAS write nothing extra', async () => {
    const fake = makeFakeSupabase()
    const work = await startWork(fake as never, base)
    await work.fail('Model timed out')
    await work.fail('again') // lost CAS: already failed
    await drain()
    expect(fake.rows('agent_event').map((r) => [r.kind, (r.facts as { notified?: boolean }).notified])).toEqual([['work.failed', true]])

    const quietFinish = await startWork(fake as never, { ...base, title: 'Quiet one' })
    await quietFinish.finish({ review: { kind: 'review', verb: 'review' }, quiet: true })
    await drain()
    const last = fake.rows('agent_event').at(-1)!
    expect(last).toMatchObject({ kind: 'work.needs_review', facts: { title: 'Quiet one', notified: false } })
  })

  it('writes nothing for a quiet row or a delegated child, and a one-shot failed row says no notice went out', async () => {
    const fake = makeFakeSupabase()
    const quiet = await startWork(fake as never, { ...base, quiet: true })
    await quiet.finish({ review: { kind: 'review', verb: 'review' } })
    const child = await startWork(fake as never, { ...base, parentId: 'parent-1', depth: 1 })
    await child.fail('x')
    await drain()
    expect(fake.rows('agent_event')).toEqual([])

    await startWork(fake as never, { ...base, kind: 'sweep', status: 'failed', errorMessage: 'boom' })
    await drain()
    expect(fake.rows('agent_event').map((r) => [r.kind, (r.facts as { notified?: boolean }).notified])).toEqual([['work.failed', false]])
  })

  it('a handle attached to an existing row writes its moves too', async () => {
    const fake = makeFakeSupabase()
    const started = await startWork(fake as never, base)
    const row = fake.rows('tracked_job')[0] as unknown as WorkItem
    await attachWork(fake as never, row).finish({ summary: 'done' })
    await drain()
    expect(fake.rows('agent_event').map((r) => [r.kind, r.ref_id])).toEqual([['work.done', started.id]])
  })
})

describe('notified comes from the real result (A6 review)', () => {
  it('a failure folded into the day\'s grouped notice (no push went out) says notified: false, so the router never claims one', async () => {
    notify.failed.mockResolvedValueOnce(false)
    const fake = makeFakeSupabase()
    const work = await startWork(fake as never, base)
    await work.fail('Model timed out')
    await drain()
    expect(notify.failed).toHaveBeenCalledOnce()
    expect(fake.rows('agent_event').map((r) => [r.kind, (r.facts as { notified?: boolean }).notified])).toEqual([['work.failed', false]])
  })

  it('a question whose push failed says notified: false', async () => {
    notify.needsYou.mockResolvedValueOnce(false)
    const fake = makeFakeSupabase()
    const work = await startWork(fake as never, base)
    await work.needInput(['Which tone?'])
    await drain()
    expect((fake.rows('agent_event')[0].facts as { notified?: boolean }).notified).toBe(false)
  })
})
