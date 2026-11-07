/**
 * POST /api/intake/quotes/<key>: a website's quote form posting to the
 * business (roadmap B1). Public on purpose: the proxy's matcher covers
 * /account and /admin only, and the key in the URL is the authentication
 * (./intake-key.ts). In order:
 *
 *   1. the key: malformed, wrong or revoked → 404, nothing read;
 *   2. the origin: when the owner listed origins, a browser from any other
 *      site is refused (403); with none listed any origin may post (the key
 *      is the gate). The CORS answer mirrors the allowed origin;
 *   3. the hourly cap per workspace (QUOTE_INTAKE_HOURLY_CAP): past it, 429;
 *   4. the body (JSON, form or multipart; ./intake.ts): a honeypot hit is
 *      answered 200 as if stored, a post with no phone and no email is 400;
 *   5. the website flow's live check (roadmap track E): a post whose
 *      `_dial8_test` nonce is a pending check's is recorded as the check and
 *      answered `{ ok, test }`, never stored as a quote;
 *   6. the quote is received (./receive.ts): the contact, the quote, the
 *      owner's inbox event and the loops.
 *
 * Answers JSON `{ ok, quote_id }` (201; 200 for a re-posted submission), or
 * a 303 to the form's `_redirect` when it names a listed origin's page (a
 * plain HTML form that wants a thank-you page). Never the quote back, never
 * anything of the business's. Logs ids and outcomes only.
 *
 * Pure over {@link QuoteIntakeDeps}; the route passes the real store.
 */
import { apiError, badRequest, notFound, rateLimited, serverError } from '@/lib/api-errors'
import type { IntakeKey } from './intake-key'
import { parseQuoteForm, readFormBody, type ParsedQuote } from './intake'
import { INTAKE_TEST_FIELD } from '@/lib/website/types'
import type { ReceiveQuoteResult } from './receive'

/** Website quotes one workspace takes in an hour. */
export const QUOTE_INTAKE_HOURLY_CAP = 30
const HOUR_MS = 60 * 60_000

export interface QuoteIntakeDeps {
  findKey(key: string): Promise<IntakeKey | null>
  /** The business's owner: whose inbox hears it. */
  ownerOf(key: IntakeKey): Promise<string | null>
  countSince(workspaceId: string, sinceIso: string): Promise<number>
  receive(args: { workspaceId: string; ownerUserId: string }, quote: ParsedQuote): Promise<ReceiveQuoteResult>
  touchKey(keyId: string): Promise<void>
  /**
   * The website flow's live check (roadmap track E, src/lib/website/deploy.ts):
   * true when the post's test field carries the nonce of this workspace's
   * pending check, which it records. Such a post is the check, never a quote.
   */
  takeTest?(workspaceId: string, nonce: string): Promise<boolean>
  now?: () => number
}

/** The CORS headers for a request from `origin` under `key`: the origin mirrored when allowed. Pure. */
export function corsHeaders(origin: string | null, key: Pick<IntakeKey, 'allowedOrigins'> | null): Record<string, string> {
  const headers: Record<string, string> = { Vary: 'Origin' }
  if (!origin) return headers
  const allowed = !key || key.allowedOrigins.length === 0 || key.allowedOrigins.includes(origin.toLowerCase())
  if (!allowed) return headers
  return {
    ...headers,
    'Access-Control-Allow-Origin': key && key.allowedOrigins.length ? origin : '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
  }
}

/** Whether a browser from `origin` may post under `key`. Pure. */
export function originAllowed(origin: string | null, key: Pick<IntakeKey, 'allowedOrigins'>): boolean {
  if (!origin || key.allowedOrigins.length === 0) return true
  return key.allowedOrigins.includes(origin.toLowerCase())
}

/** A `_redirect` the form asked for, when it is a page of a listed origin; else null. Pure. */
export function safeRedirect(value: unknown, key: Pick<IntakeKey, 'allowedOrigins'>): string | null {
  if (typeof value !== 'string' || !key.allowedOrigins.length) return null
  try {
    const url = new URL(value)
    return key.allowedOrigins.includes(url.origin.toLowerCase()) ? url.toString() : null
  } catch {
    return null
  }
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value)
  return response
}

/** Answer one form post (see the header). */
export async function handleQuoteIntake(request: Request, rawKey: string, deps: QuoteIntakeDeps): Promise<Response> {
  const origin = request.headers.get('origin')
  let key: IntakeKey | null
  try {
    key = await deps.findKey(rawKey)
  } catch (err) {
    console.error('[quote-intake] key lookup failed:', err instanceof Error ? err.message : String(err))
    return withHeaders(serverError('Could not take the quote right now.'), corsHeaders(origin, null))
  }
  if (!key) return withHeaders(notFound('Not found'), corsHeaders(origin, null))
  const cors = corsHeaders(origin, key)
  if (!originAllowed(origin, key)) {
    console.warn(`[quote-intake] ws=${key.workspaceId} origin refused`)
    return withHeaders(apiError('This site may not post quotes here.', { status: 403, code: 'ORIGIN_REFUSED' }), cors)
  }

  const now = (deps.now ?? Date.now)()
  try {
    if ((await deps.countSince(key.workspaceId, new Date(now - HOUR_MS).toISOString())) >= QUOTE_INTAKE_HOURLY_CAP) {
      console.warn(`[quote-intake] ws=${key.workspaceId} hourly cap reached`)
      return withHeaders(rateLimited('Too many quotes right now. Try again in a little while.'), cors)
    }
  } catch (err) {
    console.error('[quote-intake] cap read failed:', err instanceof Error ? err.message : String(err))
    return withHeaders(serverError('Could not take the quote right now.'), cors)
  }

  const fields = await readFormBody(request)
  if (!fields) return withHeaders(badRequest('Send the form as JSON or form fields.'), cors)
  const parsed = parseQuoteForm(fields)
  if (!parsed.ok) {
    // A bot filled the honeypot: answered as if stored, so it learns nothing.
    if (parsed.reason === 'bot') return withHeaders(Response.json({ ok: true }, { status: 200 }), cors)
    if (parsed.reason === 'no_contact') return withHeaders(badRequest('Add a phone number or an email, so the business can answer.'), cors)
    return withHeaders(badRequest('Send the form as JSON or form fields.'), cors)
  }

  // The website flow's live check: it went through the key, the origin, the cap and the parse like a customer's.
  const testNonce = fields[INTAKE_TEST_FIELD]
  if (typeof testNonce === 'string' && deps.takeTest) {
    let took = false
    try {
      took = await deps.takeTest(key.workspaceId, testNonce)
    } catch (err) {
      console.error('[quote-intake] test check failed:', err instanceof Error ? err.message : String(err))
    }
    if (took) {
      console.info(`[quote-intake] ws=${key.workspaceId} website check received`)
      return withHeaders(Response.json({ ok: true, test: true }, { status: 200 }), cors)
    }
  }

  let ownerUserId: string | null
  try {
    ownerUserId = await deps.ownerOf(key)
  } catch (err) {
    console.error('[quote-intake] owner lookup failed:', err instanceof Error ? err.message : String(err))
    return withHeaders(serverError('Could not take the quote right now.'), cors)
  }
  if (!ownerUserId) {
    console.error(`[quote-intake] ws=${key.workspaceId} has no owner to hear quotes`)
    return withHeaders(serverError('Could not take the quote right now.'), cors)
  }

  const received = await deps.receive({ workspaceId: key.workspaceId, ownerUserId }, parsed.quote)
  if (!received.ok) {
    console.error(`[quote-intake] ws=${key.workspaceId} ALERT quote not stored: ${received.error}`)
    return withHeaders(serverError('Could not take the quote right now.'), cors)
  }
  await deps.touchKey(key.id)
  console.info(`[quote-intake] ws=${key.workspaceId} quote=${received.quote.id} created=${received.created}`)

  const redirect = safeRedirect(fields._redirect, key)
  if (redirect) return withHeaders(new Response(null, { status: 303, headers: { Location: redirect } }), cors)
  return withHeaders(Response.json({ ok: true, quote_id: received.quote.id }, { status: received.created ? 201 : 200 }), cors)
}
