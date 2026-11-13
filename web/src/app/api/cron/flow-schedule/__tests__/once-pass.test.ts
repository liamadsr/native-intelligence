/**
 * The schedule pass's one-time runs: the tick claims a due once-schedule in
 * ONE compare-and-set that clears next_run_at and switches the loop off, then
 * emits its single fire, so it runs one time and reads as finished; a second
 * tick finds nothing. A failed emit puts the loop back (on, due) for the next
 * tick. A recurring custom schedule moves to its next run as before. While
 * the workspace's autonomy is off the tick does not claim a one-time loop: it
 * stays on and due, and fires on the first tick after autonomy is back on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'

type Row = Record<string, unknown>

const h = vi.hoisted(() => ({
  flows: [] as Row[],
  sent: [] as unknown[],
  sendFails: false,
  /** workspace.settings by id (the kill switch reads agent_autonomy.mode). */
  settings: {} as Record<string, unknown>,
}))

/** Only the flow table answers; every other pass reads nothing. */
function fakeDb() {
  return {
    from: (table: string) => {
      const filters: Array<(r: Row) => boolean> = []
      let update: Row | null = null
      const c: Record<string, unknown> = {}
      const rows = () =>
        table === 'flow'
          ? h.flows.filter((r) => filters.every((f) => f(r)))
          : table === 'workspace'
            ? Object.entries(h.settings).map(([id, settings]) => ({ id, settings })).filter((r) => filters.every((f) => f(r)))
            : []
      const run = () => {
        const hit = rows()
        if (update) for (const r of hit) Object.assign(r, update)
        return { data: update ? hit.map((r) => ({ id: r.id })) : hit.map((r) => ({ ...r })), error: null }
      }
      Object.assign(c, {
        select: () => c,
        eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), c),
        is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), c),
        not: () => c,
        lte: (k: string, v: string) => (filters.push((r) => typeof r[k] === 'string' && (r[k] as string) <= v), c),
        order: () => c,
        limit: () => c,
        update: (p: Row) => ((update = p), c),
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (ok: (v: unknown) => unknown) => Promise.resolve(run()).then(ok),
      })
      return c
    },
  }
}

vi.mock('@/lib/api-auth', () => ({ requireCronSecret: () => null }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => fakeDb() }))
vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    send: async (e: unknown) => {
      if (h.sendFails) throw new Error('down')
      h.sent.push(e)
    },
  },
}))
vi.mock('@/lib/flows/proposal-age-out', () => ({ ageOutStaleProposals: async () => ({ dismissed: 0 }), groomExpiredAttentionCards: async () => ({ expired: 0 }) }))
vi.mock('@/lib/suggestions/sweep', () => ({ expireStaleSuggestions: async () => ({ expired: 0 }), purgeResolvedSuggestions: async () => ({ purged: 0 }) }))
vi.mock('@/lib/work/reaper', () => ({ reapStaleWork: async () => ({ failed: 0, extended: 0, expired: 0, questionsReconciled: 0, questionsExpired: 0 }) }))
vi.mock('@/lib/attention/read-digest', () => ({ readSettledRunDigests: async () => ({ read: 0 }) }))
vi.mock('@/lib/reminders/dispatch', () => ({ runReminderPass: async () => ({}) }))

const { GET } = await import('../route')
const tick = () => GET(new Request('http://localhost/api/cron/flow-schedule') as unknown as NextRequest)

const NY = 'America/New_York'
const DUE = '2026-11-16T14:00:00.000Z'

beforeEach(() => {
  h.sent = []
  h.sendFails = false
  h.settings = {}
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-16T14:03:00.000Z'))
  h.flows = [
    { id: 'f-once', workspace_id: 'ws-1', trigger_type: 'schedule', enabled: true, next_run_at: DUE, trigger_config: { kind: 'schedule', cadence: 'once', run_at: '2026-11-16T09:00', timezone: NY } },
    { id: 'f-cron', workspace_id: 'ws-1', trigger_type: 'schedule', enabled: true, next_run_at: DUE, trigger_config: { kind: 'schedule', cadence: 'cron', cron: '0 9 * * 1-5', timezone: NY } },
  ]
})

describe('the schedule pass and one-time runs', () => {
  it('fires a one-time loop once, then it is off with no next run; a custom schedule moves on', async () => {
    const res = await (await tick()).json()
    expect(res.schedule).toMatchObject({ due: 2, fired: 2 })
    expect(h.sent).toEqual([
      { name: 'flow/schedule.due', data: { flow_id: 'f-once', workspace_id: 'ws-1', scheduled_for: DUE } },
      { name: 'flow/schedule.due', data: { flow_id: 'f-cron', workspace_id: 'ws-1', scheduled_for: DUE } },
    ])
    expect(h.flows[0]).toMatchObject({ enabled: false, next_run_at: null })
    expect(h.flows[1]).toMatchObject({ enabled: true, next_run_at: '2026-11-17T14:00:00.000Z' })

    // The next tick: nothing due, nothing fired.
    h.sent = []
    const again = await (await tick()).json()
    expect(again.schedule).toMatchObject({ due: 0, fired: 0 })
    expect(h.sent).toEqual([])
  })

  it('a failed emit puts the one-time loop back, on and due, for the next tick', async () => {
    h.flows = [h.flows[0]]
    h.sendFails = true
    const res = await (await tick()).json()
    expect(res.schedule).toMatchObject({ fired: 0, errored: 1 })
    expect(h.flows[0]).toMatchObject({ enabled: true, next_run_at: DUE })
  })

  it('autonomy off: the one-time loop is not claimed, stays on and due, and fires once autonomy is back', async () => {
    h.flows = [h.flows[0]]
    h.settings = { 'ws-1': { agent_autonomy: { mode: 'off' } } }
    const held = await (await tick()).json()
    expect(held.schedule).toMatchObject({ due: 1, fired: 0, held: 1, errored: 0 })
    expect(h.sent).toEqual([])
    expect(h.flows[0]).toMatchObject({ enabled: true, next_run_at: DUE })

    // Still off a tick later: still held, never lost.
    vi.setSystemTime(new Date('2026-11-16T15:03:00.000Z'))
    expect((await (await tick()).json()).schedule).toMatchObject({ fired: 0, held: 1 })
    expect(h.flows[0]).toMatchObject({ enabled: true, next_run_at: DUE })

    // Autonomy back on: the next tick fires it, then it is finished.
    h.settings = { 'ws-1': { agent_autonomy: { mode: 'propose' } } }
    const back = await (await tick()).json()
    expect(back.schedule).toMatchObject({ fired: 1, held: 0 })
    expect(h.sent).toEqual([{ name: 'flow/schedule.due', data: { flow_id: 'f-once', workspace_id: 'ws-1', scheduled_for: DUE } }])
    expect(h.flows[0]).toMatchObject({ enabled: false, next_run_at: null })
  })

  it('autonomy off holds only one-time loops: a recurring schedule still advances (its dispatcher ledgers the pause)', async () => {
    h.settings = { 'ws-1': { agent_autonomy: { mode: 'off' } } }
    const res = await (await tick()).json()
    expect(res.schedule).toMatchObject({ due: 2, fired: 1, held: 1 })
    expect(h.flows[1]).toMatchObject({ enabled: true, next_run_at: '2026-11-17T14:00:00.000Z' })
  })
})
