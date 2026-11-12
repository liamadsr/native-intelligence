/**
 * Free appendix endpoints.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import { expect, it, vi } from 'vitest'
import { setupDataforseoTestEnv } from './test-support'

import { resolveGotoUrls } from '@/lib/seo/dataforseo/appendix'

setupDataforseoTestEnv()

it("maps each goto URL to its page and leaves out one it couldn't resolve", async () => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      status_code: 20000,
      tasks: [
        {
          status_code: 20000,
          result: [
            {
              goto: 'https://google.com/goto?url=a',
              url: 'https://example.com/page',
            },
            { goto: 'https://google.com/goto?url=b', url: null },
          ],
        },
      ],
    }),
  )
  vi.stubGlobal('fetch', fetchMock)

  const urls = [
    'https://google.com/goto?url=a',
    'https://google.com/goto?url=b',
  ]
  const resolved = await resolveGotoUrls(urls)

  expect([...resolved]).toEqual([
    ['https://google.com/goto?url=a', 'https://example.com/page'],
  ])
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining('/v3/appendix/goto_url_converter'),
    expect.objectContaining({
      body: JSON.stringify([{ goto_urls: urls }]),
    }),
  )
})
