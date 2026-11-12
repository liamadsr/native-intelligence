/**
 * Lighthouse fetcher billing and retries.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createRecordingTestMeter,
  setupDataforseoTestEnv,
} from './test-support'

import { createDataforseoClient } from '@/lib/seo/dataforseo/client'
import { DataforseoChargedTaskError } from '@/lib/seo/dataforseo/envelope'
import { fetchLighthouseResult } from '@/lib/seo/dataforseo/lighthouse'

setupDataforseoTestEnv()

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchLighthouseResult', () => {
  it('carries billing metadata when parsing fails after a billed success', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status_code: 20000,
        status_message: 'Ok.',
        tasks: [
          {
            id: 'task-1',
            status_code: 20000,
            status_message: 'Ok.',
            path: ['v3', 'on_page', 'lighthouse', 'live', 'json'],
            cost: 0.00425,
            result: [
              {
                requestedUrl: 'https://example.com/',
                finalUrl: 'https://example.com/',
                categories: {},
                audits: {},
              },
            ],
          },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const rejection = fetchLighthouseResult({
      url: 'https://example.com/',
      strategy: 'mobile',
    })

    await expect(rejection).rejects.toBeInstanceOf(DataforseoChargedTaskError)
    await expect(rejection).rejects.toMatchObject({
      billing: {
        path: ['v3', 'on_page', 'lighthouse', 'live', 'json'],
        costUsd: 0.00425,
      },
    })
  })

  it('does not retry an HTTP 5xx (the provider may have charged the task)', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('upstream failure', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      fetchLighthouseResult({
        url: 'https://example.com/',
        strategy: 'mobile',
      }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('counts the estimate when the billed answer is cut off before it parses', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('{"status_code":20000,"tasks":[')),
    )
    const { meter, spend } = createRecordingTestMeter()

    await expect(
      createDataforseoClient(meter).lighthouse.live({
        url: 'https://example.com/',
        strategy: 'mobile',
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(spend).toMatchObject([
      {
        feature: 'lighthouse',
        path: ['v3', 'on_page', 'lighthouse', 'live', 'json'],
        failed: true,
        estimated: true,
      },
    ])
  })
})
