import { NextResponse } from 'next/server'
import { apiError } from '@/lib/api-errors'
import { sandboxSigningKey, sandboxVerifyKey } from '@/lib/cloud-browser/viewer-token'

/**
 * GET /api/browser-exit/key: the server's public key (base64 SPKI DER), not a
 * secret, and the public IP the request came from. The desktop checks an exit
 * token with the key before its Mac connects anywhere, and blocks its own
 * public IP (a router answers there: the hairpin) whatever a hub says
 * (dial8-desktop crates/browser-exit; docs/plans/cloud-browser.md C4). It
 * fetches both from the app's own origin, never from the page. Not cached: the
 * IP is the caller's.
 *
 * The desktop no longer trusts this key: release builds pin the public half
 * of CLOUD_BROWSER_SIGNING_KEY in the binary (browser_exit.rs PINNED_KEYS,
 * security review 2026-10-31). Rotating that key therefore needs a desktop
 * release carrying the new public key FIRST, or every Mac exit stops.
 */
export async function GET(request: Request) {
  const key = sandboxSigningKey()
  if (!key) return apiError('The cloud browser exit is not set up', { status: 503, code: 'EXIT_UNCONFIGURED' })
  // Vercel sets these from the connection itself; the first forwarded address is the client's.
  const ip = request.headers.get('x-real-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  return NextResponse.json({ key: sandboxVerifyKey(key), ip }, { headers: { 'cache-control': 'no-store' } })
}
