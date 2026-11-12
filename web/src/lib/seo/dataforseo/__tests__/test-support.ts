/**
 * Test-only helpers for the DataForSEO library: never imported by shipped code.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import { DataforseoChargedTaskError, SeoError } from '@/lib/seo/errors'
import { DataforseoChargeUnknownError } from '../charge-capture'
import { afterEach, beforeEach, vi } from 'vitest'
import type { DataforseoMeter, SeoSpendFeature } from '../meter'

/** A made-up credential: base64 of "login@example.com:not-a-real-password". */
export const TEST_DATAFORSEO_API_KEY = Buffer.from(
  'login@example.com:not-a-real-password',
).toString('base64')

/**
 * Sets DATAFORSEO_API_KEY for each test in the file and undoes every env and
 * global stub (the fetch stubs) after it, so no test ever reaches the network
 * with a real key.
 */
export function setupDataforseoTestEnv(apiKey = TEST_DATAFORSEO_API_KEY) {
  beforeEach(() => {
    vi.stubEnv('DATAFORSEO_API_KEY', apiKey)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })
}

/** A meter that runs every call and records nothing: for tests only. */
export function createUnmeteredTestMeter(): DataforseoMeter {
  return {
    async run({ exec }) {
      return (await exec()).data
    },
  }
}

export interface RecordedSpend {
  feature: SeoSpendFeature
  costUsd: number
  path: string[]
  /** True when the call failed after DataForSEO billed it. */
  failed: boolean
  /** True when the charge could not be read and the estimate was counted. */
  estimated?: true
}

/**
 * A meter with a USD budget, shaped like a real one: it refuses a call whose
 * estimate does not fit what is left (without running it), and records the
 * provider's real cost of every billed call, failed ones included, and the
 * estimate of a call whose charge could not be read.
 */
export function createRecordingTestMeter(budgetUsd = Number.POSITIVE_INFINITY) {
  const estimates: Array<{ feature: SeoSpendFeature; estimateUsd: number }> = []
  const spend: RecordedSpend[] = []
  const spentUsd = () => spend.reduce((sum, entry) => sum + entry.costUsd, 0)

  const meter: DataforseoMeter = {
    async run({ feature, estimateUsd, exec }) {
      estimates.push({ feature, estimateUsd })
      if (spentUsd() + estimateUsd > budgetUsd) {
        throw new SeoError(
          'SPEND_LIMIT_REACHED',
          `Estimated $${estimateUsd} does not fit the remaining budget`,
        )
      }
      try {
        const { data, billing } = await exec()
        spend.push({ feature, ...billing, failed: false })
        return data
      } catch (error) {
        if (error instanceof DataforseoChargedTaskError) {
          spend.push({ feature, ...error.billing, failed: true })
        } else if (error instanceof DataforseoChargeUnknownError) {
          spend.push({
            feature,
            path: error.path,
            costUsd: estimateUsd,
            failed: true,
            estimated: true,
          })
        }
        throw error
      }
    },
  }
  return { meter, estimates, spend, spentUsd }
}
