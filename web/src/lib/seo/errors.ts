/**
 * Typed errors for the SEO area. Every failure the DataForSEO client throws
 * on purpose is a SeoError with a `code` from the closed union below, so a
 * caller (a tool, an API route) can map the code to its own copy without
 * parsing messages. Messages can carry provider detail (a path, a status) and
 * belong in logs; `details` holds the same as strings for structured logs.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import type { DataforseoApiCallCost } from '@/lib/seo/dataforseo/envelope'

export const SEO_ERROR_CODES = [
  /** Our input was refused before (or instead of) a paid call. */
  'VALIDATION_ERROR',
  /** DATAFORSEO_API_KEY is not set on this server. */
  'SEO_NOT_CONFIGURED',
  /** DataForSEO refused the credentials (HTTP 401 / 403). */
  'PROVIDER_AUTH_FAILED',
  /** The DataForSEO account's own balance or billing is the problem. */
  'INSUFFICIENT_PROVIDER_BALANCE',
  /** DataForSEO throttled us (HTTP 429). */
  'RATE_LIMITED',
  /** DataForSEO's own backend failed or timed out; retrying later can work. */
  'UPSTREAM_UNAVAILABLE',
  /**
   * A DataforseoMeter refused a call because its estimate does not fit what
   * the workspace may still spend. The library never throws this itself; it
   * is here so meters share one code.
   */
  'SPEND_LIMIT_REACHED',
  /** Anything else: a payload we could not read, a request we got wrong. */
  'INTERNAL_ERROR',
] as const

export type SeoErrorCode = (typeof SEO_ERROR_CODES)[number]

export class SeoError extends Error {
  constructor(
    public readonly code: SeoErrorCode,
    message?: string,
    public readonly details?: Record<string, string>,
  ) {
    super(message ?? code)
    this.name = 'SeoError'
  }
}

export function isSeoError(error: unknown): error is SeoError {
  return error instanceof SeoError
}

/**
 * Thrown when a DataForSEO task fails *after* it was billed (cost + path are
 * present). A DataforseoMeter catches this to record the cost of the
 * failed-but-charged call before rethrowing. Do not throw this for access /
 * balance failures; classify those first even when DataForSEO includes billing
 * metadata on the failed task.
 */
export class DataforseoChargedTaskError extends SeoError {
  constructor(
    message: string,
    public readonly billing: DataforseoApiCallCost,
    /**
     * True when the task failed because OUR request was malformed (DataForSEO
     * "Invalid Field: ..."). Nothing of value came back, so when the task
     * wasn't billed the client turns this into a VALIDATION_ERROR before the
     * meter sees it (see client.ts).
     */
    public readonly isInvalidField = false,
    /**
     * Classification for the failure. Defaults to INTERNAL_ERROR (our bug);
     * DataForSEO's own backend failures pass UPSTREAM_UNAVAILABLE so callers
     * can say "provider temporarily unavailable".
     */
    code: SeoErrorCode = 'INTERNAL_ERROR',
  ) {
    super(code, message)
    this.name = 'DataforseoChargedTaskError'
  }
}
