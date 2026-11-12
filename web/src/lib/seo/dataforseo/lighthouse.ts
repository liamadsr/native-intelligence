/**
 * DataForSEO OnPage Lighthouse (live).
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import 'server-only'

import {
  noteDataforseoCharges,
  noteUnknownDataforseoCharge,
} from '@/lib/seo/dataforseo/charge-capture'
import {
  dataforseoPostResponse,
  readDataforseoText,
} from '@/lib/seo/dataforseo/core'
import {
  assertOk,
  buildTaskBilling,
  DataforseoChargedTaskError,
  warnIfUpstreamResponseFailed,
  type DataforseoApiResponse,
  type DataforseoResponseLike,
  type DataforseoTaskLike,
} from '@/lib/seo/dataforseo/envelope'
import {
  parseDataforseoLighthousePayload,
  requestCategories,
  type LighthouseStrategy,
} from '@/lib/seo/dataforseo/lighthouse-payload'
import type { StoredLighthousePayload } from '@/lib/seo/dataforseo/lighthouse-stored-payload'

const LIGHTHOUSE_PATH = '/v3/on_page/lighthouse/live/json'
const REQUEST_TIMEOUT_MS = 60_000

// One payload read+parse at a time per process. The raw Lighthouse payload
// (1-10MB, held several times over while parsing) is the memory-heavy step,
// and concurrent checks bursting onto one process would hold several at once.
// The DataForSEO fetches themselves stay concurrent — parsing (well under a
// second each) is cheap against a 30-60s fetch, and an un-read response body
// stays streamed, so queued siblings don't buffer.
let parseChain: Promise<unknown> = Promise.resolve()
function withParseLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = parseChain.then(fn, fn)
  parseChain = run.catch(() => {})
  return run
}

export type LighthouseInput = {
  url: string
  strategy: LighthouseStrategy
}

export async function fetchLighthouseResult(
  input: LighthouseInput,
): Promise<DataforseoApiResponse<StoredLighthousePayload>> {
  // Billed, non-idempotent POST: a 5xx does not prove the provider skipped
  // the charge, so never replay it. The response is taken un-consumed (unlike
  // dataforseoPost) so the multi-MB body read happens inside the parse lock,
  // and the timeout is cleared once headers arrive — an armed signal would
  // otherwise cover a body read queued behind the lock past 60s and abort an
  // already-billed call unmetered.
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let response: Response
  try {
    response = await dataforseoPostResponse(
      LIGHTHOUSE_PATH,
      [
        {
          url: input.url,
          for_mobile: input.strategy === 'mobile',
          categories: [...requestCategories],
        },
      ],
      { maxServerErrorRetries: 0, signal: controller.signal },
    )
  } finally {
    clearTimeout(timeout)
  }

  return withParseLock(async () => {
    let body: DataforseoResponseLike<DataforseoTaskLike>
    try {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the envelope is checked by assertOk and the payload parser below
      body = JSON.parse(
        await readDataforseoText(response),
      ) as DataforseoResponseLike<DataforseoTaskLike>
    } catch (error) {
      // A 2xx whose body could not be read or parsed: it may have been
      // charged, and nobody can say how much (the meter counts the estimate).
      noteUnknownDataforseoCharge(LIGHTHOUSE_PATH)
      throw error
    }
    noteDataforseoCharges(body, LIGHTHOUSE_PATH)
    warnIfUpstreamResponseFailed(body, LIGHTHOUSE_PATH)
    // Build the metering envelope before parsing. The provider has already
    // charged a successful task, so a malformed payload must carry its
    // billing metadata out to the meter instead of looking retryable.
    const task = assertOk(body)
    const billing = buildTaskBilling(task)
    try {
      const data = parseDataforseoLighthousePayload(body, input)
      return { data, billing }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new DataforseoChargedTaskError(message, billing)
    }
  })
}
