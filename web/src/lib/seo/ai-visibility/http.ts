/**
 * One mapping from the AI visibility core's refusals to what a route
 * answers, so every route says the same thing for the same refusal:
 *
 *   NOT_FOUND                            404
 *   VALIDATION_ERROR, NO_SITE, NO_PROMPTS 400 (the core's own words)
 *   TRACKER_LIMIT                        422
 *   DUPLICATE_TRACKER, NOT_RUNNING       409
 *   RUN_IN_PROGRESS                      409, details.run: the live check
 *   CONFIRMATION_REQUIRED                409, details: the estimate (the UI
 *                                        shows it and sends confirmed: true)
 *   the access check's refusals          seoRefusalResponse picks the status:
 *                                        SEO_NOT_CONFIGURED, CHECK_FAILED 503;
 *                                        FREE_PLAN, NOT_A_MEMBER, UNATTENDED 403
 *   SAVE_FAILED, START_FAILED            500
 */
import { apiError, notFound } from '@/lib/api-errors'
import { seoRefusalResponse } from '@/lib/seo/http'
import { isSeoRefusalCode } from '@/lib/seo/spend-view'
import 'server-only'

export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Refusal = { ok: false; code: string; message: string } & Record<
  string,
  unknown
>

export function aiFailureResponse(out: Refusal) {
  const code = out.code
  if (isSeoRefusalCode(code))
    return seoRefusalResponse({ ok: false, code, message: out.message })
  switch (out.code) {
    case 'NOT_FOUND':
      return notFound(out.message)
    case 'VALIDATION_ERROR':
    case 'NO_SITE':
    case 'NO_PROMPTS':
      return apiError(out.message, { status: 400, code: out.code })
    case 'TRACKER_LIMIT':
      return apiError(out.message, { status: 422, code: out.code })
    case 'DUPLICATE_TRACKER':
    case 'NOT_RUNNING':
      return apiError(out.message, { status: 409, code: out.code })
    case 'RUN_IN_PROGRESS':
      return apiError(out.message, {
        status: 409,
        code: out.code,
        details: { run: out.run ?? null },
      })
    case 'CONFIRMATION_REQUIRED':
      return apiError(out.message, {
        status: 409,
        code: out.code,
        details: {
          estimate: out.estimate ?? null,
          previous_estimate: out.previous_estimate ?? null,
          estimate_usd: out.estimate_usd ?? null,
        },
      })
    default:
      return apiError(out.message, { status: 500, code: out.code })
  }
}

/** A JSON body, or null when it isn't one. */
export async function jsonBody(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const body = await request.json().catch(() => null)
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null
}
