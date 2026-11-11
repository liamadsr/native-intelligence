/**
 * A ring's timer (src/lib/inngest/team-calls.ts): it sleeps to a second past
 * the ring's time, then misses the ring only if it is still open (565's
 * team_call_expire_rings decides), telling its person; a ring answered
 * meanwhile changes nothing; a malformed event does nothing at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  expired: [] as unknown[],
  expireCalls: [] as Array<string | null>,
  told: [] as unknown[][],
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { createFunction: () => ({}) } }))
vi.mock('@/lib/team-calls/store', async (orig) => ({
  ...(await orig<typeof import('@/lib/team-calls/store')>()),
  expireRings: async (_svc: unknown, ringId: string | null) => {
    h.expireCalls.push(ringId)
    return h.expired
  },
  notifyMissedCalls: async (_svc: unknown, rings: unknown[]) => {
    h.told.push(rings)
    return rings.length
  },
}))

import { runTeamCallRingTimer } from '../team-calls'

const RING = '99999999-9999-4999-8999-999999999999'
function stepTools() {
  const sleeps: Array<[string, Date]> = []
  const runs: string[] = []
  return {
    sleeps,
    runs,
    step: {
      sleepUntil: async (id: string, until: Date) => {
        sleeps.push([id, until])
      },
      run: async <T,>(id: string, fn: () => Promise<T>) => {
        runs.push(id)
        return fn()
      },
    },
  }
}

beforeEach(() => {
  h.expired = []
  h.expireCalls = []
  h.told = []
})

describe('runTeamCallRingTimer', () => {
  it('unanswered: sleeps past its time, misses it, tells its person', async () => {
    h.expired = [{ ring_id: RING }]
    const t = stepTools()
    const out = await runTeamCallRingTimer({ event: { data: { ringId: RING, expiresAt: '2026-11-11T10:00:40.000Z' } }, step: t.step })
    expect(t.sleeps).toEqual([['ring', new Date('2026-11-11T10:00:41.000Z')]])
    expect(h.expireCalls).toEqual([RING])
    expect(h.told).toEqual([[{ ring_id: RING }]])
    expect(out).toEqual({ status: 'done', missed: 1 })
  })

  it('answered meanwhile: nothing missed, nobody told', async () => {
    const t = stepTools()
    const out = await runTeamCallRingTimer({ event: { data: { ringId: RING, expiresAt: '2026-11-11T10:00:40.000Z' } }, step: t.step })
    expect(t.runs).toEqual(['expire'])
    expect(h.told).toEqual([])
    expect(out).toEqual({ status: 'done', missed: 0 })
  })

  it('a malformed event: nothing', async () => {
    const t = stepTools()
    expect(await runTeamCallRingTimer({ event: { data: { ringId: 'x', expiresAt: 'soon' } }, step: t.step })).toEqual({ status: 'skipped', reason: 'bad_event' })
    expect(t.sleeps).toEqual([])
    expect(h.expireCalls).toEqual([])
  })
})
