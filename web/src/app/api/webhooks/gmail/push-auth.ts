/**
 * Who may post a Gmail push to /api/webhooks/gmail (security review
 * 2026-10-31, P2).
 *
 * Gmail's watch publishes to our Pub/Sub topic (GMAIL_PUBSUB_TOPIC), and the
 * topic's push subscription posts each message here. Two ways to prove a post
 * came from that subscription:
 *
 *   - Pub/Sub's own authentication (the target): the subscription signs every
 *     push with a Google ID token for a service account we own, sent as
 *     `Authorization: Bearer <jwt>`. Verified here: signed by Google (its
 *     published keys, RS256), issued by accounts.google.com, unexpired, `aud`
 *     our push endpoint (its origin and path: Pub/Sub's default audience is
 *     the endpoint URL, `?token=` included) or exactly GMAIL_PUSH_AUDIENCE,
 *     `email` the service account in GMAIL_PUSH_SERVICE_ACCOUNT, and
 *     `email_verified`. On whenever GMAIL_PUSH_SERVICE_ACCOUNT is set; the
 *     static token below is then not consulted. A refusal logs its reason
 *     (never the token).
 *   - Until then, a static `?token=` in the push endpoint's URL, equal to
 *     GMAIL_WEBHOOK_TOKEN (constant-time). Unset in production or preview, it
 *     fails closed; only local dev, where it is usually unset, lets a push in.
 *
 * Configuring the first (GCP, then Vercel, in that order: a push without the
 * header is refused the moment the env var lands):
 *   1. GCP: a service account for the push (e.g. gmail-push@<project>.iam.gserviceaccount.com),
 *      and on the topic's push subscription, "Enable authentication" with that
 *      account. The default audience (the endpoint URL) works; an explicit one
 *      should be `https://dial8.ai/api/webhooks/gmail` (the Pub/Sub service
 *      agent needs roles/iam.serviceAccountTokenCreator on the account, which
 *      the console offers to grant).
 *   2. Vercel (production, and preview if it has its own subscription):
 *      GMAIL_PUSH_SERVICE_ACCOUNT = that account's email. GMAIL_PUSH_AUDIENCE
 *      only when the subscription's audience is not our endpoint
 *      (`<NEXT_PUBLIC_APP_URL>/api/webhooks/gmail`, any query); it is then
 *      compared exactly.
 *   3. Then drop `?token=` from the push endpoint and GMAIL_WEBHOOK_TOKEN.
 */
import { timingSafeEqual } from 'crypto'
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'

export const PUSH_SERVICE_ACCOUNT_ENV = 'GMAIL_PUSH_SERVICE_ACCOUNT'
export const PUSH_AUDIENCE_ENV = 'GMAIL_PUSH_AUDIENCE'

/** Google's ID-token signing keys (fetched once, then cached by jose). */
const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']
/** A little clock skew between Google and us. */
const CLOCK_TOLERANCE_SECONDS = 60

let googleKeys: JWTVerifyGetKey | null = null
function googleKeySet(): JWTVerifyGetKey {
  return (googleKeys ??= createRemoteJWKSet(new URL(GOOGLE_CERTS_URL)))
}

function nonEmpty(v: string | undefined): string | null {
  const t = v?.trim()
  return t ? t : null
}

/**
 * The audience a push's ID token must carry: GMAIL_PUSH_AUDIENCE, compared
 * exactly; else our endpoint (`<NEXT_PUBLIC_APP_URL>/api/webhooks/gmail`),
 * compared on origin and path only. A subscription left on Pub/Sub's default
 * audience signs the push endpoint's URL, which still carries `?token=` while
 * the static token is being retired. Null when neither is known.
 */
export type PushAudience = { exact: string } | { endpoint: string }

/** A URL's origin and path (no query, no fragment), or null when it isn't one. */
function endpointOf(url: string): string | null {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}`
  } catch {
    return null
  }
}

export function pushAudience(): PushAudience | null {
  const configured = nonEmpty(process.env[PUSH_AUDIENCE_ENV])
  if (configured) return { exact: configured }
  const app = nonEmpty(process.env.NEXT_PUBLIC_APP_URL)
  if (!app) return null
  try {
    const endpoint = endpointOf(new URL('/api/webhooks/gmail', app).toString())
    return endpoint ? { endpoint } : null
  } catch {
    return null
  }
}

/** Whether a token's `aud` (a string, or a list of them) names the expected audience. */
function audienceMatches(aud: unknown, expected: PushAudience): boolean {
  const values = Array.isArray(aud) ? aud : [aud]
  return values.some(
    (v) => typeof v === 'string' && ('exact' in expected ? v === expected.exact : endpointOf(v) === expected.endpoint),
  )
}

/** Why a push was refused (logged, never with the token). */
export type PushRefusal =
  | 'no_token'
  | 'malformed'
  | 'signature'
  | 'expired'
  | 'issuer'
  | 'claims'
  | 'audience'
  | 'email'
  | 'email_unverified'
  | 'no_audience'
  | 'unverifiable'

/** A jose failure as a refusal reason, by its error code. */
function refusalOf(err: unknown): PushRefusal {
  const e = (err ?? {}) as { code?: unknown; claim?: unknown }
  switch (e.code) {
    case 'ERR_JWT_EXPIRED':
      return 'expired'
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED':
      return e.claim === 'iss' ? 'issuer' : e.claim === 'email' ? 'email' : 'claims'
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
    case 'ERR_JWKS_NO_MATCHING_KEY':
    case 'ERR_JWKS_MULTIPLE_MATCHING_KEYS':
    case 'ERR_JOSE_ALG_NOT_ALLOWED':
      return 'signature'
    case 'ERR_JWS_INVALID':
    case 'ERR_JWT_INVALID':
      return 'malformed'
    default:
      // Google's keys couldn't be fetched, or something unexpected: refused all the same.
      return 'unverifiable'
  }
}

/**
 * Whether the request carries a Google ID token from the push subscription's
 * service account, for our audience; else why not. Never throws.
 */
export async function verifyPushJwt(
  request: Request,
  expected: { serviceAccount: string; audience: PushAudience },
  keys: JWTVerifyGetKey = googleKeySet(),
): Promise<{ ok: true } | { ok: false; reason: PushRefusal }> {
  const header = request.headers.get('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
  if (!token) return { ok: false, reason: 'no_token' }
  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload']
  try {
    // The audience is checked below (origin and path for our endpoint), not by jose's exact match.
    ;({ payload } = await jwtVerify(token, keys, {
      algorithms: ['RS256'],
      issuer: GOOGLE_ISSUERS,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ['exp', 'iat', 'aud', 'email'],
    }))
  } catch (err) {
    return { ok: false, reason: refusalOf(err) }
  }
  if (!audienceMatches(payload.aud, expected.audience)) return { ok: false, reason: 'audience' }
  if (typeof payload.email !== 'string' || payload.email.toLowerCase() !== expected.serviceAccount.toLowerCase()) {
    return { ok: false, reason: 'email' }
  }
  if (payload.email_verified !== true) return { ok: false, reason: 'email_unverified' }
  return { ok: true }
}

/** The static `?token=` check (see the file comment). */
function verifyStaticToken(request: Request): boolean {
  const token = process.env.GMAIL_WEBHOOK_TOKEN
  if (!token) {
    // Fail closed in production/preview; allow only in local dev where the
    // secret is typically unset (mirrors requireCronSecret's fail-closed stance).
    const isProd = process.env.VERCEL_ENV === 'production' || process.env.VERCEL_ENV === 'preview' || process.env.NODE_ENV === 'production'
    return !isProd
  }

  // Check query parameter secret (set in Pub/Sub push endpoint URL)
  const url = new URL(request.url)
  const provided = url.searchParams.get('token') || ''
  try {
    return (
      provided.length === token.length &&
      timingSafeEqual(new TextEncoder().encode(provided), new TextEncoder().encode(token))
    )
  } catch {
    return false
  }
}

/**
 * Whether a Gmail push may be served: the ID token when GMAIL_PUSH_SERVICE_ACCOUNT
 * is set (no audience to check against refuses it), else the static token. A
 * refused ID token logs its reason, so a misconfigured subscription shows in
 * the logs instead of failing silently.
 */
export async function verifyGmailPush(request: Request, keys?: JWTVerifyGetKey): Promise<boolean> {
  const serviceAccount = nonEmpty(process.env[PUSH_SERVICE_ACCOUNT_ENV])
  if (!serviceAccount) return verifyStaticToken(request)
  const audience = pushAudience()
  const verdict = audience ? await verifyPushJwt(request, { serviceAccount, audience }, keys) : { ok: false as const, reason: 'no_audience' as const }
  if (!verdict.ok) console.warn(`[gmail-push] refused: ${verdict.reason}`)
  return verdict.ok
}
