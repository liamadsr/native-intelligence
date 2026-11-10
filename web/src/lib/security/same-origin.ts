/**
 * The same-origin check for cookie-authenticated, state-changing routes
 * (security review 2026-10-31; first used by /api/local-agent/**).
 *
 * A browser attaches the person's session cookies to a request any page
 * makes, so the cookie alone does not prove the person's own app sent it.
 * SameSite=Lax keeps other sites' POSTs cookie-less, but not a sibling
 * subdomain's: to a browser every *.nativeintelligence.dev is the same site. So the request
 * must also show it came from this origin:
 *   - an `Origin` header, when there is one, must be exactly this app's origin;
 *   - without one, `Sec-Fetch-Site` must be `same-origin` or `none` (the
 *     person's own navigation);
 *   - with neither, only a bearer-authenticated caller passes. Browsers send at
 *     least one of the two on every POST, and a page can't add an
 *     `Authorization` header to a cross-origin request (it needs a CORS
 *     preflight no route here grants), so that caller is not a browser and
 *     rides no ambient cookie (the relay's e2e scripts, scripts/local-agent).
 *
 * "This app's origin" is the origin the request was sent to: X-Forwarded-Host
 * (else Host) with the request's scheme, which is https://nativeintelligence.dev in the
 * desktop webview and a browser, and http://localhost:3000 in dev. A browser
 * sets Host itself and can't set X-Forwarded-Host cross-origin. Not for the
 * Mac body's routes: they take the session's la1 bearer, never a cookie.
 */
import { apiError } from '@/lib/api-errors'

export const CROSS_SITE_REQUEST = 'CROSS_SITE_REQUEST'

/** The first value of a forwarded header (a proxy chain may list several). */
function firstValue(value: string | null): string | null {
  const first = value?.split(',')[0]?.trim()
  return first ? first : null
}

/** The origin `request` was sent to, normalized as a browser serializes `Origin`; null when unreadable. */
export function requestOrigin(request: Request): string | null {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return null
  }
  const host = firstValue(request.headers.get('x-forwarded-host')) ?? firstValue(request.headers.get('host')) ?? url.host
  const proto = firstValue(request.headers.get('x-forwarded-proto')) ?? url.protocol.replace(/:$/, '')
  try {
    return new URL(`${proto}://${host}`).origin
  } catch {
    return null
  }
}

/** Null when `request` came from this app's own origin (see the module doc), else the 403 to return. */
export function crossSiteRefusal(request: Request): Response | null {
  const origin = request.headers.get('origin')
  if (origin !== null) return origin === requestOrigin(request) ? null : refused()
  const site = request.headers.get('sec-fetch-site')
  if (site !== null) return site === 'same-origin' || site === 'none' ? null : refused()
  return /^Bearer\s+\S/i.test(request.headers.get('authorization') ?? '') ? null : refused()
}

function refused(): Response {
  return apiError('This request must come from Native Intelligence itself', { status: 403, code: CROSS_SITE_REQUEST })
}
