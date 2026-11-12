/**
 * DataForSEO transport: credentials, retries, gzip, HTTP errors, timeouts.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TEST_DATAFORSEO_API_KEY, setupDataforseoTestEnv } from './test-support'

import {
  DATAFORSEO_MAX_RETRIES,
  dataforseoGet,
  dataforseoPost,
  isDataforseoConfigured,
} from '@/lib/seo/dataforseo/core'

setupDataforseoTestEnv()

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DataForSEO credentials', () => {
  it.each(['', '   '])(
    'refuses with SEO_NOT_CONFIGURED, naming the setting, when DATAFORSEO_API_KEY is %j, without calling DataForSEO',
    async (value) => {
      vi.stubEnv('DATAFORSEO_API_KEY', value)
      const fetchMock = vi.fn<typeof fetch>()
      vi.stubGlobal('fetch', fetchMock)

      expect(isDataforseoConfigured()).toBe(false)
      await expect(
        dataforseoGet('/v3/appendix/user_data'),
      ).rejects.toMatchObject({
        code: 'SEO_NOT_CONFIGURED',
        message: expect.stringContaining('DATAFORSEO_API_KEY'),
      })
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it('reads the key on every call, not once at load', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ status_code: 20000, tasks: [] }),
      )
    vi.stubGlobal('fetch', fetchMock)

    await dataforseoGet('/v3/appendix/user_data')
    vi.stubEnv('DATAFORSEO_API_KEY', 'c2Vjb25kOmtleQ==')
    await dataforseoGet('/v3/appendix/user_data')

    const auth = fetchMock.mock.calls.map(([, init]) =>
      new Headers(init?.headers).get('Authorization'),
    )
    expect(auth).toEqual([
      `Basic ${TEST_DATAFORSEO_API_KEY}`,
      'Basic c2Vjb25kOmtleQ==',
    ])
  })
})

describe('DataForSEO transport', () => {
  it('retries a transient 5xx on a free read (GET) and returns the parsed envelope', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('upstream failure', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ status_code: 20000, tasks: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      dataforseoGet('/v3/serp/google/organic/task_get/advanced/t-1'),
    ).resolves.toEqual({ status_code: 20000, tasks: [] })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(
      'https://api.dataforseo.com/v3/serp/google/organic/task_get/advanced/t-1',
    )
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      `Basic ${TEST_DATAFORSEO_API_KEY}`,
    )
    expect(new Headers(init?.headers).get('Accept-Encoding')).toBe('gzip')
  })

  // A POST is where the provider bills, and a 5xx does not prove it skipped
  // the charge: replaying it could pay twice for one answer.
  it('never replays a POST on a 5xx unless the request says it is free', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('upstream failure', { status: 502 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      dataforseoPost('/v3/backlinks/summary/live', []),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' })
    expect(fetchMock).toHaveBeenCalledOnce()

    fetchMock.mockReset()
    fetchMock
      .mockResolvedValueOnce(new Response('upstream failure', { status: 502 }))
      .mockResolvedValueOnce(Response.json({ status_code: 20000, tasks: [] }))
    await expect(
      dataforseoPost('/v3/appendix/goto_url_converter', [], {
        maxServerErrorRetries: DATAFORSEO_MAX_RETRIES,
      }),
    ).resolves.toEqual({ status_code: 20000, tasks: [] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('gives a request its own deadline when it asks for one, 60 s otherwise', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          Response.json({ status_code: 20000, tasks: [] }),
        ),
    )

    await dataforseoPost('/v3/backlinks/summary/live', [])
    await dataforseoPost('/v3/backlinks/summary/live', [], {
      timeoutMs: 150_000,
    })
    expect(timeout.mock.calls).toEqual([[60_000], [150_000]])
  })

  // Some runtimes hand the body over still gzipped because we set
  // Accept-Encoding ourselves; parsing it raw would fail every call.
  it('inflates a body the runtime left gzipped', async () => {
    const envelope = { status_code: 20000, tasks: [] }
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(new Uint8Array(gzipSync(JSON.stringify(envelope))), {
          headers: { 'Content-Encoding': 'gzip' },
        }),
      ),
    )

    await expect(
      dataforseoPost('/v3/backlinks/summary/live', []),
    ).resolves.toEqual(envelope)
  })

  // An unverified account answers with HTTP 403 (status_code 40104). Left as
  // INTERNAL_ERROR it would read as "an unexpected error occurred".
  it('maps a 403 to PROVIDER_AUTH_FAILED', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ status_code: 40104 }, { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      dataforseoPost('/v3/backlinks/summary/live', []),
    ).rejects.toMatchObject({ code: 'PROVIDER_AUTH_FAILED' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  // The request-deadline abort arrives as a bare DOMException. Left unclassified
  // it escapes as an anonymous INTERNAL_ERROR; retrying it would replay a call
  // DataForSEO may already have billed. Both names are reachable: the shared
  // budget aborts with TimeoutError, Lighthouse's own controller with AbortError.
  it.each(['TimeoutError', 'AbortError'])(
    'maps a %s abort to UPSTREAM_UNAVAILABLE without retrying',
    async (name) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockRejectedValue(new DOMException('aborted', name))
      vi.stubGlobal('fetch', fetchMock)

      await expect(
        dataforseoPost('/v3/serp/google/organic/live/advanced', []),
      ).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
        name: 'DataForSEOTimeoutError',
      })
      expect(fetchMock).toHaveBeenCalledOnce()
    },
  )

  // Seen in production: headers arrive in time, then the deadline aborts
  // while the body is still streaming in.
  it('maps a timeout while reading the body to UPSTREAM_UNAVAILABLE', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new DOMException('aborted', 'TimeoutError'))
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response(body)),
    )

    await expect(
      dataforseoPost('/v3/dataforseo_labs/google/ranked_keywords/live', []),
    ).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      name: 'DataForSEOTimeoutError',
    })
  })
})
