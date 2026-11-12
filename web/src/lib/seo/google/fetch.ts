/**
 * One Google API call for the SEO area: plain fetch with a bearer token, a
 * timeout, Google's failures mapped to the codes a person can act on, and the
 * answer checked against a zod schema before anything reads it.
 *
 *   401                              RECONNECT_NEEDED (the grant is dead)
 *   403 scope insufficient           RECONNECT_NEEDED (signed in without the scope)
 *   403 API not enabled              UPSTREAM (this app's setup, not the person's)
 *   403 / 404 otherwise              NO_ACCESS (the account cannot read it)
 *   429, RESOURCE_EXHAUSTED          QUOTA (with Retry-After when Google gave one)
 *   400                              INVALID_REQUEST
 *   5xx, network, timeout, bad JSON  UPSTREAM
 *
 * A 403 is never read as a revoked grant: Google answers it for a site or
 * property the account simply cannot read.
 */
import 'server-only'
import type { z } from 'zod'
import { GoogleSeoError, productName } from './errors'
import type { GoogleProduct } from './view'

export const GOOGLE_TIMEOUT_MS = 20_000
/** The longest Retry-After we pass on (a day). */
const MAX_RETRY_AFTER_SECONDS = 86_400
/** Google's reasons for a spent quota (the older Search Console API answers them with a 403). */
const QUOTA_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'RATE_LIMIT_EXCEEDED',
])
/** How much of an error body we read to find Google's reason. */
const MAX_ERROR_BODY = 8_000

export interface GoogleRequest {
  product: GoogleProduct
  token: string
  method?: 'GET' | 'POST'
  body?: unknown
  timeoutMs?: number
  fetchImpl?: typeof fetch
  /** What the 403/404 sentence names ("this site", "this property"). */
  what?: string
}

/** Google's error body, as much of it as tells the cases apart. */
interface GoogleErrorBody {
  status: string | null
  reasons: string[]
  message: string
}

function readErrorBody(text: string): GoogleErrorBody {
  try {
    const parsed = JSON.parse(text) as {
      error?: {
        status?: unknown
        message?: unknown
        details?: unknown
        errors?: unknown
      }
    }
    const error = parsed?.error
    const reasons: string[] = []
    for (const list of [error?.details, error?.errors]) {
      if (!Array.isArray(list)) continue
      for (const item of list) {
        const reason = (item as { reason?: unknown } | null)?.reason
        if (typeof reason === 'string') reasons.push(reason)
      }
    }
    return {
      status: typeof error?.status === 'string' ? error.status : null,
      reasons,
      message: typeof error?.message === 'string' ? error.message : '',
    }
  } catch {
    return { status: null, reasons: [], message: '' }
  }
}

function retryAfter(response: Response): number | null {
  const value = response.headers.get('retry-after')
  if (!value || !/^\d+$/.test(value)) return null
  return Math.min(Number(value), MAX_RETRY_AFTER_SECONDS)
}

/** The error for a non-2xx answer. Exported for the tests. */
export function googleFailure(
  product: GoogleProduct,
  status: number,
  bodyText: string,
  retryAfterSeconds: number | null,
  what?: string,
): GoogleSeoError {
  const name = productName(product)
  const body = readErrorBody(bodyText)
  const detail = `HTTP ${status}${body.status ? ` ${body.status}` : ''}${body.reasons.length ? ` (${body.reasons.join(', ')})` : ''}`
  const scopeMissing =
    body.reasons.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT') ||
    /insufficient authentication scopes/i.test(body.message)
  if (status === 401 || (status === 403 && scopeMissing)) {
    return new GoogleSeoError(
      'RECONNECT_NEEDED',
      product,
      `${name} no longer accepts this connection. Reconnect ${name}.`,
      { reconnectBy: null, detail },
    )
  }
  if (
    status === 403 &&
    (body.reasons.includes('SERVICE_DISABLED') ||
      body.reasons.includes('accessNotConfigured'))
  ) {
    return new GoogleSeoError(
      'UPSTREAM',
      product,
      `${name} isn’t switched on for this app yet, so it can’t be read here. Nothing to fix on your side.`,
      { detail },
    )
  }
  if (
    status === 429 ||
    body.status === 'RESOURCE_EXHAUSTED' ||
    body.reasons.some((r) => QUOTA_REASONS.has(r))
  ) {
    return new GoogleSeoError(
      'QUOTA',
      product,
      `${name} has answered all it will for now. Try again ${retryAfterSeconds ? `in ${Math.ceil(retryAfterSeconds / 60)} minute${retryAfterSeconds > 60 ? 's' : ''}` : 'later'}.`,
      {
        retryAfterSeconds,
        detail,
      },
    )
  }
  if (status === 403 || status === 404) {
    return new GoogleSeoError(
      'NO_ACCESS',
      product,
      `The connected Google account can’t read ${what ?? 'that'} in ${name}. Check its access in ${name}, or choose another.`,
      { detail },
    )
  }
  if (status === 400) {
    return new GoogleSeoError(
      'INVALID_REQUEST',
      product,
      `${name} refused that request. Check the dates and options.`,
      { detail },
    )
  }
  return new GoogleSeoError(
    'UPSTREAM',
    product,
    `${name} didn’t answer just now. Try again in a moment.`,
    { detail },
  )
}

/** GET or POST a Google API and return its answer, checked by `schema`. Throws GoogleSeoError. */
export async function googleJson<S extends z.ZodType>(
  url: string,
  schema: S,
  req: GoogleRequest,
): Promise<z.infer<S>> {
  const name = productName(req.product)
  const send = req.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    req.timeoutMs ?? GOOGLE_TIMEOUT_MS,
  )
  let response: Response
  try {
    response = await send(url, {
      method: req.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${req.token}`,
        Accept: 'application/json',
        ...(req.body !== undefined
          ? { 'Content-Type': 'application/json' }
          : {}),
      },
      ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
      signal: controller.signal,
      cache: 'no-store',
    })
  } catch (err) {
    const timedOut = controller.signal.aborted
    throw new GoogleSeoError(
      'UPSTREAM',
      req.product,
      timedOut
        ? `${name} didn’t answer in time. Try again in a moment.`
        : `${name} couldn’t be reached. Try again in a moment.`,
      {
        detail: timedOut
          ? 'timeout'
          : err instanceof Error
            ? err.message
            : String(err),
      },
    )
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    const text = await response
      .text()
      .then((t) => t.slice(0, MAX_ERROR_BODY))
      .catch(() => '')
    throw googleFailure(
      req.product,
      response.status,
      text,
      retryAfter(response),
      req.what,
    )
  }

  let json: unknown
  try {
    json = await response.json()
  } catch {
    throw new GoogleSeoError(
      'UPSTREAM',
      req.product,
      `${name} sent an answer we couldn’t read. Try again in a moment.`,
      { detail: 'invalid JSON' },
    )
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    throw new GoogleSeoError(
      'UPSTREAM',
      req.product,
      `${name} sent an answer we couldn’t read. Try again in a moment.`,
      {
        detail: `schema: ${parsed.error.issues
          .slice(0, 3)
          .map((i) => i.path.join('.'))
          .join(', ')}`,
      },
    )
  }
  return parsed.data
}
