/**
 * The Rankings page's fetch layer and the person's yes: `confirmed` goes out
 * only when the caller says the person pressed the button that named the
 * cost, and a 409 NEEDS_GO_AHEAD hands back the server's own figures so the
 * page can show them and ask again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RankEstimateView } from '@/lib/seo/rank/view'
import { addKeywords, createTracker, goAheadOf, startCheck, updateTracker } from '../api'

const estimate: RankEstimateView = {
  keyword_count: 2,
  devices: 'mobile',
  serp_depth: 20,
  searches_per_read: 2,
  reads_per_check: { min: 3, max: 6 },
  per_check_usd: 0.0252,
  schedule: 'daily',
  checks_per_month: 30,
  monthly_usd: 0.756,
}

function respond(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const sent = (fetchMock: ReturnType<typeof respond>) => {
  const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
  return init.body ? JSON.parse(init.body as string) : undefined
}

afterEach(() => vi.unstubAllGlobals())

describe('the yes on the wire', () => {
  it('a start sends confirmed only when asked to', async () => {
    const run = { id: 'r1' }
    let f = respond(201, { run })
    await startCheck('t1')
    expect(sent(f)).toBeUndefined()
    f = respond(201, { run })
    await startCheck('t1', { confirmed: true })
    expect(sent(f)).toEqual({ confirmed: true })
  })

  it('an add and an update carry it the same way', async () => {
    let f = respond(201, { added: [], already_tracked: 0, over_cap: 0, rejected: 0 })
    await addKeywords('t1', ['a'])
    expect(sent(f)).toEqual({ keywords: ['a'] })
    f = respond(201, { added: [], already_tracked: 0, over_cap: 0, rejected: 0 })
    await addKeywords('t1', ['a'], { confirmed: true })
    expect(sent(f)).toEqual({ keywords: ['a'], confirmed: true })
    f = respond(200, { tracker: { id: 't1' } })
    await updateTracker('t1', { paused: false, confirmed: true })
    expect(sent(f)).toEqual({ paused: false, confirmed: true })
  })
})

describe('goAheadOf', () => {
  it('reads the server’s figures off a 409 NEEDS_GO_AHEAD', async () => {
    respond(409, { error: 'Confirm to go ahead.', code: 'NEEDS_GO_AHEAD', details: { estimate, previous_estimate: null } })
    const err = await createTracker({ schedule_interval: 'daily', keywords: ['a', 'b'] }).catch((e: unknown) => e)
    expect(goAheadOf(err)).toEqual({ estimate, previous: null })
  })

  it('is null for any other error, or a go-ahead with no figure', async () => {
    respond(409, { error: 'Already tracked.', code: 'DUPLICATE_TRACKER', details: { tracker_id: 't1' } })
    expect(goAheadOf(await createTracker({}).catch((e: unknown) => e))).toBeNull()
    respond(409, { error: 'Confirm.', code: 'NEEDS_GO_AHEAD', details: { estimate: null } })
    expect(goAheadOf(await createTracker({}).catch((e: unknown) => e))).toBeNull()
    expect(goAheadOf(new Error('boom'))).toBeNull()
  })
})
