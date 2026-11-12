/**
 * The DataForSEO HTTP transport: credentials, timeouts, retries, gzip and the
 * HTTP-error ladder. Every DataForSEO call in the app goes through here.
 *
 * Credentials: DATAFORSEO_API_KEY holds the "Base64" credential DataForSEO
 * shows (base64 of `login:password`) and is sent as `Authorization: Basic
 * <value>`. It is read on every call, never at module load, so a server
 * without it still boots and only the SEO calls refuse (SEO_NOT_CONFIGURED).
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import 'server-only'

// No runtime cycle: envelope.ts imports only the DataforseoErrorClassifier
// type from here.
import {
  warnIfUpstreamResponseFailed,
  type DataforseoResponseLike,
  type DataforseoTaskLike,
} from '@/lib/seo/dataforseo/envelope'
import { noteDataforseoCharges } from '@/lib/seo/dataforseo/charge-capture'
import { inDataforseoSlot } from '@/lib/seo/dataforseo/request-slots'
import { SeoError, type SeoErrorCode } from '@/lib/seo/errors'

const API_BASE = 'https://api.dataforseo.com'
const MAX_DATAFORSEO_ERROR_PAYLOAD_LENGTH = 1600
// Safety ceiling on any live call (Lighthouse is the slowest, ~tens of seconds).
const DATAFORSEO_REQUEST_TIMEOUT_MS = 60_000
// Retry free reads on transient 5xx. Total attempts = retries + 1; the shared
// request-timeout signal still caps overall wall time. Only GETs (task
// collection, reference lists) retry unless a request opts in: a POST is
// where the provider bills, and a 5xx does not prove it skipped the charge,
// so a paid POST is never replayed automatically (the person or the step
// retries, and the stored lookups and begin/record markers cover that). The
// two free POSTs (the goto converter, the sandbox) opt back in.
export const DATAFORSEO_MAX_RETRIES = 2
const DATAFORSEO_RETRY_BACKOFF_MS = 250

/** The server setting that holds the DataForSEO credential. */
export const DATAFORSEO_API_KEY_SETTING = 'DATAFORSEO_API_KEY'

/** Whether this server has a DataForSEO credential. Read at call time. */
export function isDataforseoConfigured(): boolean {
  return Boolean(process.env[DATAFORSEO_API_KEY_SETTING]?.trim())
}

/**
 * The `Authorization` header value, read from the environment on every call.
 * An empty value counts as unset.
 */
function dataforseoAuthorization(): string {
  const apiKey = process.env[DATAFORSEO_API_KEY_SETTING]?.trim()
  if (!apiKey) {
    throw new SeoError(
      'SEO_NOT_CONFIGURED',
      `DataForSEO is not set up on this server: set ${DATAFORSEO_API_KEY_SETTING} to the Base64 credential DataForSEO shows for the account (base64 of login:password).`,
      { provider: 'dataforseo', setting: DATAFORSEO_API_KEY_SETTING },
    )
  }
  return `Basic ${apiKey}`
}

/**
 * Translates a DataForSEO HTTP/task failure into a product-specific SeoError
 * (e.g. "billing issue"). Returns null when the failure isn't one this
 * classifier recognises, so the caller can fall back to a generic error. See
 * {@link createDataforseoBillingClassifier}.
 */
export type DataforseoErrorClassifier = (
  status: number | undefined,
  details: string,
  path: string,
) => SeoError | null

function formatDataforseoErrorPayload(value: unknown): string {
  const text =
    typeof value === 'string'
      ? value
      : (() => {
          try {
            return JSON.stringify(value)
          } catch {
            return String(value)
          }
        })()

  return text.length > MAX_DATAFORSEO_ERROR_PAYLOAD_LENGTH
    ? `${text.slice(0, MAX_DATAFORSEO_ERROR_PAYLOAD_LENGTH)}... [truncated]`
    : text
}

function formatDataforseoRequestPath(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

/**
 * A DataForSEO response body as text, inflated first if it is still gzip.
 * The first two bytes decide, not Content-Encoding: runtimes that already
 * decoded the body keep that header, so trusting it would inflate twice.
 */
export async function readDataforseoText(response: Response): Promise<string> {
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    return new TextDecoder().decode(bytes)
  }
  const inflated = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
  return new Response(inflated).text()
}

/** A request-deadline abort as UPSTREAM_UNAVAILABLE; any other error as is. */
function asDataforseoTimeoutError(error: unknown, url: string): unknown {
  if (
    !(error instanceof Error) ||
    (error.name !== 'TimeoutError' && error.name !== 'AbortError')
  )
    return error
  const path = formatDataforseoRequestPath(url)
  // The provider's trouble, so callers usually don't log it as an exception:
  // warn to keep timeouts visible in the logs.
  console.warn('dataforseo.upstream-timeout', {
    event: 'dataforseo.upstream-timeout',
    path,
  })
  const timeoutError = new SeoError(
    'UPSTREAM_UNAVAILABLE',
    `DataForSEO request timed out on ${path}`,
    { provider: 'dataforseo', providerPath: path },
  )
  timeoutError.name = 'DataForSEOTimeoutError'
  return timeoutError
}

/**
 * The single authenticated `fetch` used by every DataForSEO call. Throws on
 * non-2xx; task-level failures (which return HTTP 200) are handled downstream
 * by {@link assertOk}. An optional classifier maps recognised HTTP failures to
 * product errors.
 */
function createAuthenticatedFetch(
  classify?: DataforseoErrorClassifier,
  maxServerErrorRetries = DATAFORSEO_MAX_RETRIES,
  timeoutMs = DATAFORSEO_REQUEST_TIMEOUT_MS,
) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    // Resolve the signal once so retries share the overall request timeout
    // rather than restarting a fresh budget on each attempt. It starts here,
    // once the request has its slot, so waiting for a slot does not count.
    const signal = init?.signal ?? AbortSignal.timeout(timeoutMs)
    // Ask for gzip explicitly: DataForSEO answers uncompressed otherwise
    // (~9.9 MB vs ~0.6 MB for the US location list) and slow links hit the
    // timeout. Some runtimes then leave the body gzipped, so read it with
    // readDataforseoText.
    const headers = new Headers(init?.headers)
    headers.set('Authorization', dataforseoAuthorization())
    if (!headers.has('Accept-Encoding')) headers.set('Accept-Encoding', 'gzip')

    for (let attempt = 0; ; attempt++) {
      let response: Response
      try {
        response = await fetch(url, { ...init, headers, signal })
      } catch (error) {
        // Both abort flavours mean "we ran out of time", and neither carries a
        // useful name of its own: the shared budget above rejects with
        // TimeoutError, while Lighthouse passes its own AbortController
        // deadline via init.signal and rejects with AbortError. Classify them
        // so callers get a provider-degradation error instead of an anonymous
        // internal one. Deliberately not retried: a call that ran past the
        // deadline may already be billed by DataForSEO, and because this is not
        // a DataforseoChargedTaskError the meter records nothing for it, so
        // replaying would be spend nobody sees, twice.
        throw asDataforseoTimeoutError(error, url)
      }
      if (response.ok) return response

      // Transient upstream 5xx on an idempotent read -> back off and retry.
      if (response.status >= 500 && attempt < maxServerErrorRetries) {
        await new Promise((resolve) =>
          setTimeout(resolve, DATAFORSEO_RETRY_BACKOFF_MS * (attempt + 1)),
        )
        continue
      }

      const rawText = await readDataforseoText(response)
      const path = formatDataforseoRequestPath(url)
      const classified = classify?.(response.status, rawText, path)
      if (classified) throw classified

      // An unverified account (status_code 40104) answers with 403, not 401.
      const isAuthFailure = response.status === 401 || response.status === 403
      const code: SeoErrorCode =
        response.status >= 500
          ? 'UPSTREAM_UNAVAILABLE'
          : response.status === 429
            ? 'RATE_LIMITED'
            : isAuthFailure
              ? 'PROVIDER_AUTH_FAILED'
              : 'INTERNAL_ERROR'
      const error = new SeoError(
        code,
        isAuthFailure
          ? `DataForSEO refused the credentials (HTTP ${response.status} on ${path}): check ${DATAFORSEO_API_KEY_SETTING} and that the DataForSEO account is verified`
          : `DataForSEO HTTP ${response.status} on ${path}`,
        {
          provider: 'dataforseo',
          providerStatus: String(response.status),
          providerPath: path,
          responseBody: formatDataforseoErrorPayload(rawText),
        },
      )
      error.name = 'DataForSEOHttpError'
      // The provider's trouble, so callers usually don't log it as an
      // exception: warn here to keep the provider's failure rate visible.
      if (code === 'UPSTREAM_UNAVAILABLE')
        console.warn('dataforseo.upstream-http-failed', {
          event: 'dataforseo.upstream-http-failed',
          path,
          status: response.status,
        })
      throw error
    }
  }
}

type DataforseoRequestOptions = {
  /** Maps a recognised access / billing HTTP failure to a product error. */
  classify?: DataforseoErrorClassifier
  /**
   * Retries on a transient 5xx. Default: DATAFORSEO_MAX_RETRIES for a GET (a
   * free read), 0 for a POST (where the provider bills: a 5xx does not prove
   * it skipped the charge, so a paid POST is never replayed). Only a POST
   * that costs nothing may pass DATAFORSEO_MAX_RETRIES.
   */
  maxServerErrorRetries?: number
  /** The sandbox host validates requests like production at zero cost. */
  baseUrl?: string
  signal?: AbortSignal
  /**
   * The request's deadline when no `signal` is given (default 60 s). A paid
   * call that takes longer gets its own: a call cut off on our side writes
   * nothing to the ledger, even when the provider still billed it.
   */
  timeoutMs?: number
}

async function requestDataforseo<TTask extends DataforseoTaskLike>(
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  options: DataforseoRequestOptions,
): Promise<DataforseoResponseLike<TTask> | null> {
  // Refuse before waiting for a slot when the server has no credential.
  dataforseoAuthorization()
  const doFetch = createAuthenticatedFetch(
    options.classify,
    options.maxServerErrorRetries ??
      (method === 'GET' ? DATAFORSEO_MAX_RETRIES : 0),
    options.timeoutMs,
  )
  const url = `${options.baseUrl ?? API_BASE}${path}`
  // The slot covers the body read too: the connection stays busy until then.
  const text = await inDataforseoSlot(async () => {
    const response = await doFetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
      signal: options.signal,
    })
    // The deadline also covers the body: a slow response can send its headers
    // in time and still run out the clock while the body streams in.
    try {
      return await readDataforseoText(response)
    } catch (error) {
      throw asDataforseoTimeoutError(error, url)
    }
  })
  if (text === '') return null
  // The task type is the caller's claim about the payload; billing metadata
  // and item fields are validated downstream (envelope.ts + section Zod
  // schemas).
  const parsed = JSON.parse(text) as DataforseoResponseLike<TTask>
  // The charge is read off the tasks before anything parses their result,
  // so a metered call that fails later still records it (charge-capture.ts).
  // The sandbox bills nothing.
  if (!options.baseUrl) noteDataforseoCharges(parsed, path)
  warnIfUpstreamResponseFailed(parsed, path)
  return parsed
}

/**
 * POST `tasks` (the standard array-of-task-payloads body) to a DataForSEO
 * endpoint and return the parsed response envelope. The task type parameter is
 * the caller's claim about the payload shape — fields we act on are validated
 * downstream (billing metadata in envelope.ts, items via the section fetchers'
 * Zod schemas). The credential is read per call from the environment.
 */
export function dataforseoPost<
  TTask extends DataforseoTaskLike = DataforseoTaskLike,
>(
  path: string,
  tasks: unknown[],
  options: DataforseoRequestOptions = {},
): Promise<DataforseoResponseLike<TTask> | null> {
  return requestDataforseo('POST', path, tasks, options)
}

/**
 * POST like {@link dataforseoPost} but return the UN-CONSUMED Response
 * (headers only) — the same auth, retry policy, and HTTP-error ladder apply.
 * For the one endpoint whose body is too big to read eagerly: Lighthouse
 * reads its multi-MB body behind a parse lock, and passes its own `signal` so
 * the timeout can be cleared once headers arrive. The concurrency slot is
 * released once the headers are in.
 */
export async function dataforseoPostResponse(
  path: string,
  tasks: unknown[],
  options: DataforseoRequestOptions & { signal?: AbortSignal } = {},
): Promise<Response> {
  dataforseoAuthorization()
  const doFetch = createAuthenticatedFetch(
    options.classify,
    options.maxServerErrorRetries ?? 0,
  )
  return inDataforseoSlot(() =>
    doFetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(tasks),
      signal: options.signal,
    }),
  )
}

/** GET a DataForSEO endpoint (task_get collection, appendix/locations data). */
export function dataforseoGet<
  TTask extends DataforseoTaskLike = DataforseoTaskLike,
>(
  path: string,
  options: DataforseoRequestOptions = {},
): Promise<DataforseoResponseLike<TTask> | null> {
  return requestDataforseo('GET', path, undefined, options)
}
