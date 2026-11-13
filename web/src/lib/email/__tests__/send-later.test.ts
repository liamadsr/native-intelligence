/**
 * Send later in the browser (../send-later.ts): the presets (tomorrow at 8,
 * the next Monday at 8, left out when tomorrow is Monday), a picked time
 * (future only, local), how a time reads, and scheduling: the toast says
 * when, and its Undo cancels (a normal draft again, Drafts synced).
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { cancelScheduledSend, minPickValue, pickedSendAt, scheduleSend, scheduledForLabel, sendLaterPresets, type SendLaterDeps } from '../send-later'

// Friday 13 November 2026, 10:00 local.
const FRIDAY = new Date(2026, 10, 13, 10, 0)

describe('sendLaterPresets', () => {
  it('a Friday: tomorrow at 8:00 AM and Monday at 8:00 AM', () => {
    expect(sendLaterPresets(FRIDAY)).toEqual([
      { id: 'tomorrow', label: 'Tomorrow, 8:00 AM', at: new Date(2026, 10, 14, 8, 0) },
      { id: 'monday', label: 'Monday, 8:00 AM', at: new Date(2026, 10, 16, 8, 0) },
    ])
  })

  it('a Sunday: tomorrow is Monday, so Monday is not offered twice', () => {
    expect(sendLaterPresets(new Date(2026, 10, 15, 21, 0)).map((p) => p.id)).toEqual(['tomorrow'])
  })

  it('a Monday: the Monday offered is next week’s', () => {
    expect(sendLaterPresets(new Date(2026, 10, 16, 9, 0))[1].at).toEqual(new Date(2026, 10, 23, 8, 0))
  })

  it('late at night, tomorrow is still the next calendar day', () => {
    expect(sendLaterPresets(new Date(2026, 10, 13, 23, 59))[0].at).toEqual(new Date(2026, 10, 14, 8, 0))
  })
})

describe('a picked time', () => {
  it('is a local time in the future, to the minute', () => {
    expect(pickedSendAt('2026-11-20T14:30', FRIDAY)).toEqual(new Date(2026, 10, 20, 14, 30))
  })

  it('refuses the past, now, an impossible date and junk', () => {
    expect(pickedSendAt('2026-11-13T09:59', FRIDAY)).toBeNull()
    expect(pickedSendAt('2026-11-13T10:00', FRIDAY)).toBeNull()
    expect(pickedSendAt('2026-02-30T10:00', FRIDAY)).toBeNull()
    expect(pickedSendAt('tomorrow', FRIDAY)).toBeNull()
  })

  it('the input’s minimum is the next whole minute', () => {
    expect(minPickValue(new Date(2026, 10, 13, 10, 0, 30))).toBe('2026-11-13T10:01')
  })
})

describe('scheduledForLabel', () => {
  it('reads today, tomorrow, a weekday this week, else the date', () => {
    expect(scheduledForLabel(new Date(2026, 10, 13, 15, 30), FRIDAY)).toBe('Today, 3:30 PM')
    expect(scheduledForLabel(new Date(2026, 10, 14, 8, 0), FRIDAY)).toBe('Tomorrow, 8:00 AM')
    expect(scheduledForLabel(new Date(2026, 10, 16, 8, 0), FRIDAY)).toBe('Monday, 8:00 AM')
    expect(scheduledForLabel(new Date(2026, 10, 30, 8, 0), FRIDAY)).toBe('Nov 30, 8:00 AM')
    expect(scheduledForLabel(new Date(2027, 0, 4, 8, 0), FRIDAY)).toBe('Jan 4, 2027, 8:00 AM')
  })
})

function harness(replies: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = []
  const toasts: Array<{ kind: string; message: string; undo?: () => void }> = []
  const deps: SendLaterDeps = {
    fetch: async (url, init) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined })
      const r = replies.shift() ?? { status: 200, body: {} }
      return new Response(JSON.stringify(r.body), { status: r.status })
    },
    toast: {
      success: (message, opts) => void toasts.push({ kind: 'success', message, ...(opts?.action ? { undo: opts.action.onClick } : {}) }),
      error: (message) => void toasts.push({ kind: 'error', message }),
    },
    now: () => FRIDAY,
  }
  return { calls, toasts, deps }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('scheduleSend', () => {
  const at = new Date(2026, 10, 14, 8, 0)
  const row = { id: 'sched-1', send_at: at.toISOString(), status: 'scheduled' }

  it('posts the message and its time, then toasts when, with Undo that cancels and keeps a draft', async () => {
    const { calls, toasts, deps } = harness([{ status: 200, body: { scheduled: row } }, { status: 200, body: { ok: true } }])
    const request = { account_id: 'acct-1', to: ['dana@harborline.example'], subject: 'Q4 renewal', body_html: '<p>Hi</p>' }
    expect(await scheduleSend(request, at, deps)).toMatchObject({ id: 'sched-1' })
    expect(calls[0]).toEqual({ url: '/api/account/email/scheduled', method: 'POST', body: { ...request, send_at: at.toISOString() } })
    expect(toasts[0]).toMatchObject({ kind: 'success', message: 'Scheduled for Tomorrow, 8:00 AM' })
    toasts[0].undo!()
    await flush()
    await flush()
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/account/email/scheduled',
      'POST /api/account/email/scheduled/sched-1/cancel',
      'POST /api/account/email/sync',
    ])
    expect(toasts[1]).toMatchObject({ kind: 'success', message: 'Kept as a draft' })
  })

  it('says the route’s refusal and schedules nothing', async () => {
    const { toasts, deps } = harness([{ status: 400, body: { error: 'Pick a time in the future' } }])
    expect(await scheduleSend({ thread_id: 'thr-1', draft_id: 'm-1' }, at, deps)).toBeNull()
    expect(toasts).toEqual([{ kind: 'error', message: 'Pick a time in the future' }])
  })

  it('a cancel the route refuses (already sent) is said, and nothing is synced', async () => {
    const { calls, toasts, deps } = harness([{ status: 409, body: { error: 'It is already being sent, or was sent' } }])
    expect(await cancelScheduledSend('sched-1', deps)).toBe(false)
    expect(toasts).toEqual([{ kind: 'error', message: 'It is already being sent, or was sent' }])
    expect(calls).toHaveLength(1)
  })
})
