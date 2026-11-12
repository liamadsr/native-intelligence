/**
 * How the local SEO routes answer a core's refusal, in one place, so every
 * route says the same thing for the same failure. Provider failures (a thrown
 * SeoError) go through seoErrorResponse (../http.ts) instead.
 *
 *   access refusals (every code isSeoRefusalCode knows)  seoRefusalResponse
 *                                    picks the status (503 or 403)
 *   NOT_FOUND                        404
 *   INVALID, PLACE_NOT_FOUND         400
 *   CONFIRMATION_REQUIRED            409, details: { estimate_usd, estimate }
 *                                    (the page shows the cost, asks, and
 *                                    sends again with confirmed: true)
 *   ESTIMATE_CHANGED                 409, details: { estimate_usd, estimate }
 *   SCAN_ALREADY_RUNNING             409, details: { scan }
 *   ALREADY_TRACKED                  409, details: { business }
 *   STILL_RUNNING, NOT_RUNNING,
 *   LIMIT_REACHED                    409
 *   START_FAILED                     500
 */
import {
  apiError,
  badRequest,
  conflict,
  notFound,
  serverError,
} from '@/lib/api-errors'
import type { SeoDataRefusal } from '@/lib/seo/access'
import { seoRefusalResponse } from '@/lib/seo/http'
import { isSeoRefusalCode } from '@/lib/seo/spend-view'
import 'server-only'

export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A core's `{ ok: false, code, message }` as a response. Extra fields (the live scan, the tracked business, the estimate) ride in `details`. */
export function localFailureResponse(
  out: { code: string; message: string } & Record<string, unknown>,
) {
  const { code, message, ok: _ok, ...rest } = out
  const details = Object.keys(rest).length > 0 ? rest : undefined
  if (isSeoRefusalCode(code))
    return seoRefusalResponse(out as unknown as SeoDataRefusal)
  switch (code) {
    case 'NOT_FOUND':
      return notFound(message)
    case 'INVALID':
    case 'PLACE_NOT_FOUND':
      return apiError(message, { status: 400, code, details })
    case 'ALREADY_TRACKED':
    case 'SCAN_ALREADY_RUNNING':
    case 'STILL_RUNNING':
    case 'ESTIMATE_CHANGED':
    case 'CONFIRMATION_REQUIRED':
    case 'NOT_RUNNING':
    case 'LIMIT_REACHED':
      return conflict(message, details, code)
    case 'START_FAILED':
      return serverError(message)
    default:
      return badRequest(message, { code })
  }
}

/** A JSON body, or null when there is none or it isn't an object. */
export async function readBody(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const body = (await request.json().catch(() => null)) as unknown
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null
}

export function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function optionalString(
  value: unknown,
  max: number,
): string | undefined {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, max)
    : undefined
}
