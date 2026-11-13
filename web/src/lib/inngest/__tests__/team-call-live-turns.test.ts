/**
 * team-calls/live-turn (src/lib/inngest/team-call-live-turns.ts): one turn
 * holding its lease, then, after a quiet spell, one more look so the words
 * said at the end of a turn are sent even when nobody speaks again. A bad
 * event, or the switch gone off since the turn was offered, runs nothing (the
 * lease runs out by itself). A turn that failed or stopped takes no second
 * look. Never retried (retries: 0); one at a time per capture, at most five
 * at once, within the plan's limits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIVEKIT_ENV } from '@/lib/team-calls/__tests__/signing'

const h = vi.hoisted(() => ({ turns: [] as unknown[], offers: [] as string[], outcome: 'ok' as string }))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/team-calls/live-turns', async (orig) => ({
  ...(await orig<typeof import('@/lib/team-calls/live-turns')>()),
  runLiveTurn: async (_svc: unknown, input: unknown) => (h.turns.push(input), h.outcome),
  offerLiveTurn: async (_svc: unknown, captureId: string) => (h.offers.push(captureId), 'too_few_words'),
}))

const { runTeamCallLiveTurn, teamCallLiveTurn } = await import('../team-call-live-turns')

const CAPTURE = '11111111-1111-4111-8111-111111111111'
const LEASE = '22222222-2222-4222-8222-222222222222'
const ON = { ...LIVEKIT_ENV, TEAM_CALL_RECORDER: 'on', CAPTURE_FEED_SECRET: 'capture-feed-secret-of-its-own-0123456789', TEAM_CALL_LIVE_AGENT: 'on' }

function ctx(data: unknown) {
  const steps: string[] = []
  return {
    steps,
    run: {
      event: { data },
      step: {
        run: async <T,>(id: string, fn: () => Promise<T>) => (steps.push(id), fn()),
        sleep: async (id: string, d: string) => void steps.push(`sleep:${id}:${d}`),
      },
    },
  }
}

let saved: NodeJS.ProcessEnv
beforeEach(() => {
  saved = { ...process.env }
  Object.assign(process.env, ON)
  h.turns = []
  h.offers = []
  h.outcome = 'ok'
})
afterEach(() => {
  process.env = saved
})

describe('team-call-live-turn', () => {
  it('runs the turn, then looks once more after a quiet spell', async () => {
    const c = ctx({ captureId: CAPTURE, lease: LEASE })
    expect(await runTeamCallLiveTurn(c.run)).toEqual({ status: 'ok', tail: 'too_few_words' })
    expect(h.turns).toEqual([{ captureId: CAPTURE, lease: LEASE }])
    expect(c.steps).toEqual(['turn', 'sleep:quiet:30s', 'tail'])
    expect(h.offers).toEqual([CAPTURE])
  })

  it('a turn that failed or stopped takes no second look', async () => {
    for (const outcome of ['failed', 'stopped', 'stale']) {
      h.outcome = outcome
      h.offers = []
      const c = ctx({ captureId: CAPTURE, lease: LEASE })
      expect(await runTeamCallLiveTurn(c.run)).toEqual({ status: outcome })
      expect(h.offers).toEqual([])
    }
  })

  it('a bad event, or the switch off since the offer, runs nothing', async () => {
    expect(await runTeamCallLiveTurn(ctx({ captureId: 'nope', lease: LEASE }).run)).toEqual({ status: 'skipped', reason: 'bad_event' })
    expect(await runTeamCallLiveTurn(ctx({ captureId: CAPTURE }).run)).toEqual({ status: 'skipped', reason: 'bad_event' })
    process.env.TEAM_CALL_LIVE_AGENT = ''
    expect(await runTeamCallLiveTurn(ctx({ captureId: CAPTURE, lease: LEASE }).run)).toEqual({ status: 'skipped', reason: 'off' })
    expect(h.turns).toEqual([])
  })

  it('is never retried, one at a time per capture, within the plan limit', () => {
    const opts = (teamCallLiveTurn as unknown as { opts: { retries: number; concurrency: Array<{ limit: number; key?: string }> } }).opts
    expect(opts.retries).toBe(0)
    expect(opts.concurrency).toContainEqual({ limit: 1, key: 'event.data.captureId' })
    for (const c of opts.concurrency) expect(c.limit).toBeLessThanOrEqual(5)
  })
})
