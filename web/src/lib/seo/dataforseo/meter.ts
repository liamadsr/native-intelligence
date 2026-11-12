/**
 * The metering seam. Every paid DataForSEO call in createDataforseoClient goes
 * through a DataforseoMeter the caller injects, so this library decides
 * nothing about budgets or ledgers: it hands the meter an upper-bound USD
 * estimate before the call and the provider's real USD cost after it.
 *
 * A meter implementation, in outline:
 *
 *   async run({ feature, estimateUsd, exec }) {
 *     await refuseUnlessFits(estimateUsd)        // throw SeoError('SPEND_LIMIT_REACHED')
 *     try {
 *       const { data, billing } = await exec()
 *       await record(feature, billing.costUsd, billing.path)
 *       return data
 *     } catch (error) {
 *       // Billed by DataForSEO even though it failed: still spend.
 *       if (error instanceof DataforseoChargedTaskError)
 *         await record(feature, error.billing.costUsd, error.billing.path)
 *       throw error
 *     }
 *   }
 *
 * Any other error means nothing was billed: the client's one choke point
 * (execForMeter in client.ts) turns every throw after a charge, a result
 * that failed our own parsing included, into a DataforseoChargedTaskError
 * carrying that charge. A request DataForSEO rejected as
 * malformed without billing it never reaches the meter as a charged error:
 * the client turns it into a VALIDATION_ERROR first (see client.ts).
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import type { DataforseoApiResponse } from '@/lib/seo/dataforseo/envelope'

/** Which part of the SEO area a paid call belongs to (for the spend ledger). */
export type SeoSpendFeature =
  | 'keywords'
  | 'domain'
  | 'serp'
  | 'rank_tracking'
  | 'backlinks'
  | 'ai_visibility'
  | 'local_seo'
  | 'lighthouse'

export interface DataforseoMeter {
  /**
   * Refuse (throw) when `estimateUsd` does not fit what the workspace may still spend; otherwise run `exec` and
   * record the provider's real cost. A call that failed AFTER being billed (DataforseoChargedTaskError) is still recorded.
   */
  run<T>(call: {
    feature: SeoSpendFeature
    estimateUsd: number
    exec: () => Promise<DataforseoApiResponse<T>>
  }): Promise<T>
}
