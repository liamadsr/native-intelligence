/**
 * The rank routes' shared answers: a core failure as an HTTP response (the
 * same code always gets the same status), the UUID check for path params,
 * and the page numbers of a list's query string.
 *
 *   NEEDS_GO_AHEAD  409, details: { estimate, previous_estimate }: the change
 *                   or check needs the person's yes. Show the cost and send
 *                   the same request again with `confirmed: true`.
 *   The access check's refusals (SEO_NOT_CONFIGURED, FREE_PLAN, NOT_A_MEMBER,
 *   UNATTENDED, CHECK_FAILED) answer as every SEO route does
 *   (seoRefusalResponse: 503 or 403).
 */
import { apiError } from '@/lib/api-errors'
import { seoRefusalResponse } from '@/lib/seo/http'
import { isSeoRefusalCode } from '@/lib/seo/spend-view'
import 'server-only'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

const STATUS: Record<string, number> = {
  INVALID_INPUT: 400,
  NO_SITE: 400,
  NOT_FOUND: 404,
  DUPLICATE_TRACKER: 409,
  TOO_MANY_TRACKERS: 409,
  ALREADY_RUNNING: 409,
  NOT_RUNNING: 409,
  NEEDS_GO_AHEAD: 409,
  NO_KEYWORDS: 409,
  CREATE_FAILED: 500,
  START_FAILED: 500,
  SPEND_LIMIT_REACHED: 402,
}

/**
 * A core refusal or failure as the route's answer. `details` carries what the
 * client needs to act on it (the live check, the existing tracker); a
 * go-ahead refusal carries its own estimates.
 */
export function rankFailureResponse(
  failure: { code: string; message: string } & Record<string, unknown>,
  details?: unknown,
) {
  const code = failure.code
  if (isSeoRefusalCode(code))
    return seoRefusalResponse({ ok: false, code, message: failure.message })
  return apiError(failure.message, {
    status: STATUS[code] ?? 400,
    code,
    details:
      code === 'NEEDS_GO_AHEAD'
        ? {
            estimate: failure.estimate ?? null,
            previous_estimate: failure.previous_estimate ?? null,
          }
        : details,
  })
}

/** `offset` and `limit` from a query string, as numbers (the queries clamp them). */
export function pageParams(url: string): { offset?: number; limit?: number } {
  const params = new URL(url).searchParams
  const num = (name: string) => {
    const raw = params.get(name)
    if (raw === null || raw.trim() === '') return undefined
    const n = Number(raw)
    return Number.isFinite(n) ? n : undefined
  }
  return { offset: num('offset'), limit: num('limit') }
}

/** A JSON body, or null when there is none or it isn't an object. */
export async function jsonBody(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const body = (await request.json().catch(() => null)) as unknown
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null
}
