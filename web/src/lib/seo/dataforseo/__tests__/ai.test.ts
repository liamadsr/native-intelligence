/**
 * LLM responses: never replayed, given their own deadline, and metered even
 * when a charged answer fails our shape check.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import {
  fetchLlmResponse,
  LLM_RESPONSE_TIMEOUT_MS,
} from '@/lib/seo/dataforseo/ai'
import { createDataforseoClient } from '@/lib/seo/dataforseo/client'
import { expect, it, vi } from 'vitest'
import {
  createRecordingTestMeter,
  setupDataforseoTestEnv,
} from './test-support'

setupDataforseoTestEnv()

vi.mock('@/lib/seo/dataforseo/llm-models', () => ({
  isKnownLlmModelName: async () => true,
}))

it('never replays a billed llm_responses call on a 5xx (a retry could double-charge)', async () => {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response('upstream error', { status: 502 }))
  vi.stubGlobal('fetch', fetchMock)

  await expect(
    fetchLlmResponse({
      modelSlug: 'claude',
      modelName: 'claude-sonnet-5',
      userPrompt: 'Which SEO tools?',
      webSearch: false,
    }),
  ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' })
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it('gives a live answer its own deadline, longer than the 60 s default', async () => {
  const timeout = vi.spyOn(AbortSignal, 'timeout')
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status_code: 20000,
        tasks: [
          {
            status_code: 20000,
            path: ['v3', 'ai_optimization', 'claude', 'llm_responses', 'live'],
            cost: 0.01,
            result: [{ items: [] }],
          },
        ],
      }),
    ),
  )

  await fetchLlmResponse({
    modelSlug: 'claude',
    modelName: 'claude-sonnet-5',
    userPrompt: 'Which SEO tools?',
    webSearch: true,
  }).catch(() => {})
  expect(LLM_RESPONSE_TIMEOUT_MS).toBe(150_000)
  expect(timeout).toHaveBeenCalledWith(LLM_RESPONSE_TIMEOUT_MS)
  expect(timeout).not.toHaveBeenCalledWith(60_000)
})

it('a charged answer whose shape changed is recorded by the meter and still fails', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const path = ['v3', 'ai_optimization', 'claude', 'llm_responses', 'live']
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status_code: 20000,
        tasks: [
          {
            status_code: 20000,
            path,
            cost: 0.02,
            // items is no longer a list.
            result: [{ items: 'answer text' }],
          },
        ],
      }),
    ),
  )
  const { meter, spend } = createRecordingTestMeter()

  await expect(
    createDataforseoClient(meter).aiSearch.llmResponse({
      modelSlug: 'claude',
      modelName: 'claude-sonnet-5',
      userPrompt: 'Which SEO tools?',
      webSearch: false,
    }),
  ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
  expect(spend).toEqual([
    { feature: 'ai_visibility', costUsd: 0.02, path, failed: true },
  ])
})
