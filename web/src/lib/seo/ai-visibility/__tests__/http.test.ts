/**
 * The routes' answer to the access check's refusals (../http.ts): every code
 * checkSeoDataAccess can answer goes through seoRefusalResponse, which picks
 * the status, never the 500 a code it doesn't know would get.
 */
import { describe, expect, it } from 'vitest'
import { aiFailureResponse } from '../http'

describe('aiFailureResponse', () => {
  it.each([
    ['SEO_NOT_CONFIGURED', 503],
    ['CHECK_FAILED', 503],
    ['FREE_PLAN', 403],
    ['NOT_A_MEMBER', 403],
    ['UNATTENDED', 403],
  ])('%s answers %i with its own words', async (code, status) => {
    const res = aiFailureResponse({
      ok: false,
      code,
      message: `Refused: ${code}.`,
    })
    expect(res.status).toBe(status)
    expect(await res.json()).toMatchObject({
      error: `Refused: ${code}.`,
      code,
    })
  })

  it('a confirmation refusal is 409 with the estimate before and after', async () => {
    const res = aiFailureResponse({
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      message: 'Confirm to turn it on.',
      estimate: { monthly_usd: 0 },
      previous_estimate: { monthly_usd: 0 },
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      details: {
        estimate: { monthly_usd: 0 },
        previous_estimate: { monthly_usd: 0 },
      },
    })
  })
})
