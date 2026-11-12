/**
 * What GET /api/account/seo/spend returns: the month's search-data spend
 * against the workspace's ceiling, and whether paid lookups can be made at
 * all, so every SEO page can show "not set up" or its quiet spend line
 * without spending. Safe to import from client components (types only).
 */
/**
 * Why paid lookups may not be made (src/lib/seo/access.ts), as a route's
 * `code` and a tool's `code`:
 *   SEO_NOT_CONFIGURED  the server has no provider key (503)
 *   FREE_PLAN           the person's plan does not pay for search data (403)
 *   NOT_A_MEMBER        a workspace guest: reads what is there, never spends (403)
 *   UNATTENDED          a turn nobody is in (403)
 *   CHECK_FAILED        the plan or membership could not be read just now: try again (503)
 */
export const SEO_REFUSAL_CODES = ['SEO_NOT_CONFIGURED', 'FREE_PLAN', 'NOT_A_MEMBER', 'UNATTENDED', 'CHECK_FAILED'] as const
export type SeoRefusalCode = (typeof SEO_REFUSAL_CODES)[number]

export function isSeoRefusalCode(value: unknown): value is SeoRefusalCode {
  return typeof value === 'string' && (SEO_REFUSAL_CODES as readonly string[]).includes(value)
}

/**
 * The refusals that mean "lookups are off for you here" (a page shows its
 * notice in place of the buying controls). CHECK_FAILED is not one: it is a
 * passing failure the person retries.
 */
export const SEO_DATA_OFF_CODES: ReadonlySet<string> = new Set(['SEO_NOT_CONFIGURED', 'FREE_PLAN', 'NOT_A_MEMBER', 'UNATTENDED'])

export interface SeoSpendView {
  spent_dollars: number
  cap_dollars: number
  /** ISO time the month's count starts over. */
  resets_at: string
  /** The server has the search-data provider's key. */
  configured: boolean
  /** This person may make paid lookups now (the ceiling is still checked at each call). */
  can_buy: boolean
  /** Why not, with words for the person. Null when can_buy. */
  refusal: {
    code: SeoRefusalCode
    message: string
  } | null
}
