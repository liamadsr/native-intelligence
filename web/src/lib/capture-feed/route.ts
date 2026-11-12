/**
 * What the capture feed's routes (src/app/api/internal/capture-feed/*) and
 * the call recorder's work route share: the secret first (404 while the
 * feed is off here, 401 without it), then a body within its size and shape.
 * Answers use the app's error shape (src/lib/api-errors).
 */
import 'server-only'
import type { z } from 'zod'
import { apiError, badRequest, notFound, unauthorized } from '@/lib/api-errors'
import { checkCaptureFeedAuth } from './auth'

/** The most a request's body may be (200 segments of 4000 characters, and some). */
export const CAPTURE_FEED_MAX_BODY_BYTES = 1024 * 1024

/** The request, checked and parsed, or the answer that refuses it. */
export async function feedRequest<S extends z.ZodTypeAny>(request: Request, schema: S): Promise<z.infer<S> | Response> {
  const auth = checkCaptureFeedAuth(request)
  if (auth === 'off') return notFound()
  if (auth === 'refused') return unauthorized()
  const raw = await request.text()
  if (raw.length > CAPTURE_FEED_MAX_BODY_BYTES) return apiError('Too large', { status: 413 })
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return badRequest('Invalid JSON body')
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) return badRequest('Invalid request', parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join('.'), message: i.message })))
  return parsed.data
}

/** The answer when a write failed and the producer should send the same request again. */
export function feedRetryLater(): Response {
  return apiError('Try again', { status: 503, code: 'FEED_RETRY' })
}
