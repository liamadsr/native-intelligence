/**
 * The rank routes' one mapping from a core's answer to HTTP: the person's
 * yes (409 NEEDS_GO_AHEAD with the estimates the page shows), and every code
 * of the access check (the guest and the unreadable plan included) answered
 * as every SEO route answers it.
 */
import { describe, expect, it } from 'vitest'
import { rankFailureResponse } from '../http'
import { estimateView, goAheadRefusal } from '../view'

const before = estimateView({
  keywords: ['plumber austin'],
  devices: 'mobile',
  serp_depth: 20,
  schedule: 'weekly',
})
const after = estimateView({
  keywords: ['plumber austin'],
  devices: 'both',
  serp_depth: 20,
  schedule: 'weekly',
})

describe('rankFailureResponse', () => {
  it('a go-ahead refusal is a 409 carrying both estimates', async () => {
    const res = rankFailureResponse(goAheadRefusal('schedule', after, before))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body).toMatchObject({
      code: 'NEEDS_GO_AHEAD',
      details: {
        estimate: { devices: 'both', schedule: 'weekly' },
        previous_estimate: { devices: 'mobile' },
      },
    })
    expect(body.error).toMatch(/a month/)
  })

  it('a check’s go-ahead carries its estimate and no previous one', async () => {
    const check = estimateView({
      keywords: ['a'],
      devices: 'mobile',
      serp_depth: 20,
      schedule: 'manual',
    })
    const body = await rankFailureResponse(
      goAheadRefusal('check', check),
    ).json()
    expect(body.details).toEqual({ estimate: check, previous_estimate: null })
  })

  it('every access refusal answers as the SEO area does, whatever the core marked', async () => {
    const cases: Array<[string, number]> = [
      ['SEO_NOT_CONFIGURED', 503],
      ['CHECK_FAILED', 503],
      ['FREE_PLAN', 403],
      ['NOT_A_MEMBER', 403],
      ['UNATTENDED', 403],
    ]
    for (const [code, status] of cases) {
      const res = rankFailureResponse({ ok: false, code, message: 'No.' })
      expect(res.status).toBe(status)
      expect(await res.json()).toMatchObject({ code, error: 'No.' })
    }
  })

  it('the core’s own codes keep their statuses and details', async () => {
    const res = rankFailureResponse(
      { code: 'DUPLICATE_TRACKER', message: 'Already tracked.' },
      { tracker_id: 't1' },
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({
      code: 'DUPLICATE_TRACKER',
      details: { tracker_id: 't1' },
    })
  })
})
