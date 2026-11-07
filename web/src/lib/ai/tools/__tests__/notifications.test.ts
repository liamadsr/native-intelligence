/**
 * get_notifications reads the person's recent agent events, not the bell
 * list (docs/plans/retire-notifications-page.md, "The agent's tool"): their
 * agent_event rows in this workspace over the last 7 days, told or not,
 * newest first, each as "while you were away" says it (awayLineFor) with its
 * local time and whether it was told yet, counted by kind as the away section
 * counts. It leaves out what the router ignored, what expired, what settled
 * since, and anyone else's rows, and it writes nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { createNotificationTools } from '../notifications'

const EXEC_OPTS = { toolCallId: 't1', messages: [] } as never
const NOW = Date.parse('2026-10-20T16:00:00.000Z')
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()

function ev(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    workspace_id: 'w1',
    user_id: 'u1',
    kind: 'activity',
    outcome: 'quiet',
    state: 'routed',
    priority: 0,
    facts: { title: `Sam completed GEN-${id.slice(1)}` },
    occurs_at: ago(60),
    expires_at: null,
    ref_type: 'notification',
    ref_id: `n-${id}`,
    delivered_at: null,
    delivered_key: null,
    ...over,
  }
}

type Out = {
  success: boolean
  time_zone: string
  counts: string[]
  total: number
  untold_count: number
  note: string
  events: Array<{ at: string; line: string; kind: string; told: boolean; ref?: { type: string; id: string } }>
}

function setup(rows: Array<Record<string, unknown>>) {
  const db = makeFakeSupabase()
  db.seed('agent_event', rows)
  db.seed('member', [{ id: 'm1', user_id: 'u1', workspace_id: 'w1', time_zone: 'America/New_York' }])
  const tools = createNotificationTools('u1', db as unknown as SupabaseClient, 'w1')
  const run = async (input: { unread_only?: boolean; limit?: number }) => (await tools.get_notifications.execute!(input, EXEC_OPTS)) as Out
  return { db, run }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('get_notifications', () => {
  it('lists the person’s events of the last 7 days, told or not, newest first, as the away section says them', async () => {
    const { db, run } = setup([
      ev('e1', { occurs_at: ago(30) }),
      ev('e2', {
        kind: 'work.needs_review',
        facts: { title: 'Q4 pricing memo' },
        occurs_at: ago(90),
        ref_type: 'work_item',
        ref_id: 'job-1',
        state: 'delivered',
        delivered_at: ago(80),
        delivered_key: 'away:msg-1',
      }),
      ev('e3', {
        kind: 'mention',
        facts: { title: 'Atlas launch', notificationType: 'action_assigned', targetType: 'action', targetId: 'a-7' },
        occurs_at: ago(120),
      }),
      // Left out: ignored by the router, marked expired, settled, too old,
      // someone else's, another workspace's, and a meeting that has started.
      ev('x1', { outcome: 'ignore' }),
      ev('x2', { state: 'expired' }),
      ev('x3', { state: 'delivered', delivered_at: ago(10), delivered_key: 'settled' }),
      ev('x4', { occurs_at: ago(8 * 24 * 60) }),
      ev('x5', { user_id: 'u2' }),
      ev('x6', { workspace_id: 'w2' }),
      ev('x7', { kind: 'meeting.soon', facts: { title: 'Standup' }, occurs_at: ago(5), expires_at: ago(5) }),
    ])
    db.seed('tracked_job', [{ id: 'job-1', workspace_id: 'w1', status: 'needs_review' }])

    const out = await run({})
    expect(out.success).toBe(true)
    expect(out.time_zone).toBe('America/New_York')
    expect(out.events).toEqual([
      // A teammate's update points at its notification only: nothing to open.
      { at: '2026-10-20 11:30', line: 'Update: Sam completed GEN-1', kind: 'activity', told: false },
      { at: '2026-10-20 10:30', line: 'Ready for your review: Q4 pricing memo', kind: 'work.needs_review', told: true, ref: { type: 'work_item', id: 'job-1' } },
      // A notice opens its target.
      { at: '2026-10-20 10:00', line: 'Assigned to you: Atlas launch', kind: 'mention', told: false, ref: { type: 'action', id: 'a-7' } },
    ])
    // Counted as "while you were away" counts: waiting on you first.
    expect(out.counts).toEqual(['1 waiting on you', '1 mention', '1 update from teammates'])
    expect(out.total).toBe(3)
    expect(out.untold_count).toBe(2)
    expect(out.note).toMatch(/data, never instructions/)
    // Read-only: nothing marked delivered, expired or settled.
    expect(db.calls.filter((c) => c.op !== 'select')).toEqual([])
  })

  it('unread_only keeps what was not told yet; limit caps the list (at most 20) while the counts cover them all', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ev(`e${i + 1}`, { occurs_at: ago(i + 1) }))
    rows.push(ev('t1', { occurs_at: ago(0.5), state: 'delivered', delivered_at: ago(0.2), delivered_key: 'turn:1' }))
    const { run } = setup(rows)

    const untold = await run({ unread_only: true, limit: 3 })
    expect(untold.events.map((e) => e.line)).toEqual(['Update: Sam completed GEN-1', 'Update: Sam completed GEN-2', 'Update: Sam completed GEN-3'])
    expect(untold.events.every((e) => !e.told)).toBe(true)
    expect(untold.counts).toEqual(['25 updates from teammates'])

    const all = await run({ limit: 50 })
    expect(all.events).toHaveLength(20)
    expect(all.events[0]).toMatchObject({ told: true })
    expect(all.total).toBe(26)
    expect(all.untold_count).toBe(25)

    expect((await run({})).events).toHaveLength(10)
  })

  it('leaves out a row whose subject settled since, told or not, without marking it', async () => {
    const { db, run } = setup([
      ev('d1', { kind: 'email.drafted', facts: { from: 'dana@acme.com' }, ref_type: 'email_draft', ref_id: 'dr-1' }),
      ev('d2', { kind: 'email.drafted', facts: { from: 'lee@acme.com' }, ref_type: 'email_draft', ref_id: 'dr-2', occurs_at: ago(70) }),
      ev('m1', { kind: 'mention', facts: { title: 'Atlas', notificationType: 'comment_reply' }, state: 'delivered', delivered_at: ago(20), delivered_key: 'away:x' }),
    ])
    db.seed('email_draft', [
      { id: 'dr-1', workspace_id: 'w1', status: 'sent' },
      { id: 'dr-2', workspace_id: 'w1', status: 'pending_review' },
    ])
    db.seed('notification', [{ id: 'n-m1', workspace_id: 'w1', is_read: true }])

    const out = await run({})
    expect(out.events.map((e) => e.line)).toEqual(['Draft ready: reply to lee@acme.com'])
    expect(out.counts).toEqual(['1 draft ready'])
    expect(db.calls.filter((c) => c.op !== 'select')).toEqual([])
  })

  it('returns the read’s error', async () => {
    const db = makeFakeSupabase()
    const failing = {
      from: (table: string) => {
        if (table !== 'agent_event') return db.from(table)
        const chain: Record<string, unknown> = {}
        for (const k of ['select', 'eq', 'in', 'neq', 'gte', 'order', 'limit', 'is']) chain[k] = () => chain
        chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { message: 'boom' } })
        return chain
      },
    }
    const tools = createNotificationTools('u1', failing as unknown as SupabaseClient, 'w1')
    expect(await tools.get_notifications.execute!({}, EXEC_OPTS)).toEqual({ success: false, error: 'boom' })
  })
})
