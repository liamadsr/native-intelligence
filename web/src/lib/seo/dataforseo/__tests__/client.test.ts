/**
 * The metered client on the DataforseoMeter seam: estimate before, real cost
 * after, charged failures recorded, over-budget calls refused unsent.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import { createDataforseoClient } from '@/lib/seo/dataforseo/client'
import type { DataforseoMeter } from '@/lib/seo/dataforseo/meter'
import { dataforseoPricing } from '@/lib/seo/dataforseo/pricing'
import { SeoError } from '@/lib/seo/errors'
import { describe, expect, it, vi } from 'vitest'
import {
  createRecordingTestMeter,
  createUnmeteredTestMeter,
  setupDataforseoTestEnv,
} from './test-support'

setupDataforseoTestEnv()

const backlinksInput = { target: 'example.com' }
const backlinksPath = ['v3', 'backlinks', 'summary', 'live']
// Below the summary estimate, as a real charge is (the estimate is an upper bound).
const RAW_COST = 0.02

/** Stubs DataForSEO with one answer per call, in order. */
function stubDataforseo(...bodies: unknown[]) {
  const fetchMock = vi.fn<typeof fetch>()
  for (const body of bodies) {
    fetchMock.mockResolvedValueOnce(Response.json(body))
  }
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function okSummary(costUsd: number) {
  return {
    status_code: 20000,
    tasks: [
      {
        status_code: 20000,
        path: backlinksPath,
        cost: costUsd,
        result: [{ target: 'example.com', rank: 42 }],
      },
    ],
  }
}

describe('createDataforseoClient metering', () => {
  it('estimates before the call, then records the real cost after it', async () => {
    const { meter, estimates, spend } = createRecordingTestMeter()
    const fetchMock = stubDataforseo(okSummary(RAW_COST))

    const client = createDataforseoClient(meter)
    const result = await client.backlinks.summary(backlinksInput)

    expect(result).toMatchObject({ rank: 42 })
    expect(estimates).toEqual([
      {
        feature: 'backlinks',
        estimateUsd: dataforseoPricing.backlinks.summary(backlinksInput),
      },
    ])
    expect(spend).toEqual([
      {
        feature: 'backlinks',
        costUsd: RAW_COST,
        path: backlinksPath,
        failed: false,
      },
    ])
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('hands the meter the estimate first and runs the provider only through exec', async () => {
    const order: string[] = []
    const fetchMock = vi.fn<typeof fetch>(async () => {
      order.push('provider')
      return Response.json(okSummary(RAW_COST))
    })
    vi.stubGlobal('fetch', fetchMock)
    const meter: DataforseoMeter = {
      async run({ estimateUsd, exec }) {
        order.push(`estimate ${estimateUsd > 0}`)
        const { data, billing } = await exec()
        order.push(`record ${billing.costUsd}`)
        return data
      },
    }

    await createDataforseoClient(meter).backlinks.summary(backlinksInput)

    expect(order).toEqual(['estimate true', 'provider', `record ${RAW_COST}`])
  })

  it('never calls the provider when the estimate does not fit the budget', async () => {
    const estimate = dataforseoPricing.backlinks.summary(backlinksInput)
    const { meter, spend } = createRecordingTestMeter(estimate / 2)
    const fetchMock = stubDataforseo(okSummary(RAW_COST))

    const client = createDataforseoClient(meter)
    await expect(
      client.backlinks.summary(backlinksInput),
    ).rejects.toMatchObject({ code: 'SPEND_LIMIT_REACHED' })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(spend).toEqual([])
  })

  it('records a charged DataForSEO task failure at its cost before rethrowing', async () => {
    const { meter, spend } = createRecordingTestMeter()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubDataforseo({
      status_code: 20000,
      tasks: [
        {
          status_code: 40000,
          status_message: 'DataForSEO task failed',
          path: backlinksPath,
          cost: RAW_COST,
        },
      ],
    })

    const client = createDataforseoClient(meter)
    await expect(client.backlinks.summary(backlinksInput)).rejects.toThrow(
      'DataForSEO task failed',
    )

    expect(spend).toEqual([
      {
        feature: 'backlinks',
        costUsd: RAW_COST,
        path: backlinksPath,
        failed: true,
      },
    ])
  })

  it('turns an unbilled invalid-field failure into VALIDATION_ERROR, records nothing, and logs the field but not its value', async () => {
    const { meter, spend } = createRecordingTestMeter()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubDataforseo({
      status_code: 20000,
      tasks: [
        {
          status_code: 40501,
          status_message: "Invalid Field: 'target'.",
          path: backlinksPath,
          cost: 0,
          data: { target: 'customer.example' },
        },
      ],
    })

    const client = createDataforseoClient(meter)
    const failure = client.backlinks.summary(backlinksInput)
    await expect(failure).rejects.toBeInstanceOf(SeoError)
    await expect(failure).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })

    expect(spend).toEqual([])
    expect(warn).toHaveBeenCalledWith('dataforseo.invalid-field', {
      event: 'dataforseo.invalid-field',
      path: '/v3/backlinks/summary/live',
      field: 'target',
    })
  })

  it('still records an invalid-field failure DataForSEO did bill', async () => {
    const { meter, spend } = createRecordingTestMeter()
    stubDataforseo({
      status_code: 20000,
      tasks: [
        {
          status_code: 40501,
          status_message: "Invalid Field: 'target'.",
          path: backlinksPath,
          cost: 0.01,
        },
      ],
    })

    await expect(
      createDataforseoClient(meter).backlinks.summary(backlinksInput),
    ).rejects.toMatchObject({ isInvalidField: true })
    expect(spend).toMatchObject([{ costUsd: 0.01, failed: true }])
  })

  it('records a charged task whose result has an unexpected shape, and still fails the call', async () => {
    const { meter, spend } = createRecordingTestMeter()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    stubDataforseo({
      status_code: 20000,
      tasks: [
        {
          status_code: 20000,
          path: backlinksPath,
          cost: RAW_COST,
          // A field the provider renamed or retyped: rank is now a string.
          result: [{ target: 'example.com', rank: 'forty-two' }],
        },
      ],
    })

    const failure = createDataforseoClient(meter).backlinks.summary(
      backlinksInput,
    )
    await expect(failure).rejects.toBeInstanceOf(SeoError)
    await expect(failure).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(spend).toEqual([
      {
        feature: 'backlinks',
        costUsd: RAW_COST,
        path: backlinksPath,
        failed: true,
      },
    ])
  })

  it('records a charged list whose items fail the shape check (every entry that parses items)', async () => {
    const { meter, spend } = createRecordingTestMeter()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const path = ['v3', 'backlinks', 'referring_domains', 'live']
    stubDataforseo({
      status_code: 20000,
      tasks: [
        {
          status_code: 20000,
          path,
          cost: 0.03,
          result: [{ total_count: 1, items: 'not a list' }],
        },
      ],
    })

    await expect(
      createDataforseoClient(meter).backlinks.referringDomains({
        target: 'example.com',
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(spend).toEqual([
      { feature: 'backlinks', costUsd: 0.03, path, failed: true },
    ])
  })

  it('records a charged task the classifier turned into a billing error, keeping its code', async () => {
    const { meter, spend } = createRecordingTestMeter()
    stubDataforseo({
      status_code: 20000,
      tasks: [
        {
          status_code: 40210,
          status_message: 'Balance is too low.',
          path: backlinksPath,
          cost: RAW_COST,
        },
      ],
    })

    await expect(
      createDataforseoClient(meter).backlinks.summary(backlinksInput),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PROVIDER_BALANCE' })
    expect(spend).toEqual([
      {
        feature: 'backlinks',
        costUsd: RAW_COST,
        path: backlinksPath,
        failed: true,
      },
    ])
  })

  it('records nothing for an unexpected shape the provider did not charge', async () => {
    const { meter, spend } = createRecordingTestMeter()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    stubDataforseo({
      status_code: 20000,
      tasks: [
        {
          status_code: 20000,
          path: backlinksPath,
          cost: 0,
          result: [{ target: 'example.com', rank: 'forty-two' }],
        },
      ],
    })

    await expect(
      createDataforseoClient(meter).backlinks.summary(backlinksInput),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(spend).toEqual([])
  })

  it('records nothing when the call fails before an answer (a connection that never got through)', async () => {
    const { meter, spend } = createRecordingTestMeter()
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed')),
    )

    await expect(
      createDataforseoClient(meter).backlinks.summary(backlinksInput),
    ).rejects.toThrow('fetch failed')
    expect(spend).toEqual([])
  })

  it('counts the estimate for a paid call our own deadline cut off after it was sent, keeping the error', async () => {
    const { meter, spend } = createRecordingTestMeter()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockRejectedValue(new DOMException('aborted', 'TimeoutError')),
    )

    await expect(
      createDataforseoClient(meter).backlinks.summary(backlinksInput),
    ).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      message: 'DataForSEO request timed out on /v3/backlinks/summary/live',
    })
    expect(spend).toEqual([
      {
        feature: 'backlinks',
        path: backlinksPath,
        costUsd: dataforseoPricing.backlinks.summary(backlinksInput),
        failed: true,
        estimated: true,
      },
    ])
  })

  it('counts the estimate for a paid 2xx answer cut off mid-body, keeping the parse error', async () => {
    const { meter, spend } = createRecordingTestMeter()
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response('{"status_code":20000,"tasks":[{"status_code":200'),
        ),
    )

    const failure = createDataforseoClient(meter).backlinks.summary(
      backlinksInput,
    )
    await expect(failure).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    await expect(failure).rejects.toThrow(/JSON/)
    expect(spend).toMatchObject([
      { feature: 'backlinks', path: backlinksPath, estimated: true },
    ])
  })

  it('attributes the spend to the feature a caller passes', async () => {
    const { meter, estimates, spend } = createRecordingTestMeter()
    stubDataforseo({
      status_code: 20000,
      tasks: [
        {
          status_code: 20000,
          path: ['v3', 'dataforseo_labs', 'google', 'keyword_overview', 'live'],
          cost: 0.0121,
          result: [{ items: [{ keyword: 'best crm' }] }],
        },
      ],
    })

    await createDataforseoClient(meter).labs.keywordOverview({
      keywords: ['best crm'],
      locationCode: 2840,
      languageCode: 'en',
      feature: 'keywords',
    })

    expect(estimates[0]?.feature).toBe('keywords')
    expect(spend[0]?.feature).toBe('keywords')
  })

  it('refuses before the provider when DATAFORSEO_API_KEY is unset', async () => {
    vi.stubEnv('DATAFORSEO_API_KEY', '')
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      createDataforseoClient(createUnmeteredTestMeter()).backlinks.summary(
        backlinksInput,
      ),
    ).rejects.toMatchObject({ code: 'SEO_NOT_CONFIGURED' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('readsTaskPostBatch', () => {
  const query = {
    keyword: 'running shoes',
    locationCode: 2840,
    languageCode: 'en',
    device: 'desktop' as const,
    depth: 10,
  }
  const posted = {
    status_code: 20000,
    tasks: [
      { id: 'read-1', status_code: 20100, cost: 0.0012 },
      { id: 'read-2', status_code: 20100, cost: 0.0012 },
      { id: 'read-3', status_code: 20100, cost: 0.0012 },
    ],
  }

  it('meters each query on its own and resolves per query, in order', async () => {
    const { meter, estimates, spend } = createRecordingTestMeter()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(posted))
        .mockResolvedValueOnce(
          Response.json({
            status_code: 50000,
            status_message: 'Internal Error.',
          }),
        )
        .mockResolvedValueOnce(Response.json(posted)),
    )

    const settled = await createDataforseoClient(meter).serp.readsTaskPostBatch(
      [query, query, query],
    )

    expect(settled.map((outcome) => outcome.status)).toEqual([
      'fulfilled',
      'rejected',
      'fulfilled',
    ])
    expect(settled[0]).toEqual({
      status: 'fulfilled',
      value: ['read-1', 'read-2', 'read-3'],
    })
    expect(estimates).toEqual(
      Array(3).fill({
        feature: 'serp',
        estimateUsd: dataforseoPricing.serp.readsTaskPost(query),
      }),
    )
    // The failed post was not billed, so only two are recorded.
    expect(spend.map((entry) => entry.costUsd)).toEqual([
      expect.closeTo(0.0036, 10),
      expect.closeTo(0.0036, 10),
    ])
  })

  it('refuses only the queries that no longer fit the budget', async () => {
    const estimate = dataforseoPricing.serp.readsTaskPost(query)
    // Room for one query's estimate plus what it really cost, not a second.
    const { meter, spend } = createRecordingTestMeter(estimate + 0.001)
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(posted))
    vi.stubGlobal('fetch', fetchMock)

    const client = createDataforseoClient(meter)
    const [first] = await client.serp.readsTaskPostBatch([query])
    const [second] = await client.serp.readsTaskPostBatch([query])

    expect(first?.status).toBe('fulfilled')
    expect(second).toMatchObject({
      status: 'rejected',
      reason: { code: 'SPEND_LIMIT_REACHED' },
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(spend).toHaveLength(1)
  })
})
