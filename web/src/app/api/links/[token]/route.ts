import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase/service'
import { consumeOneTimeLink, isLinkToken } from '@/lib/links/one-time'
import { LINK_PURPOSES, type LinkStart } from '@/lib/links/purposes'
import { isSameOriginPost } from '@/lib/links/same-origin'
import { OAUTH_NONCE_COOKIE, OAUTH_STATE_TTL_MS, bindingCookieOptions } from '@/lib/oauth/state'
import { appOrigin } from '@/lib/twilio/config'

export const dynamic = 'force-dynamic'

/**
 * POST /api/links/[token]: the button on a single-use link's page
 * (src/app/l/[token]/page.tsx). Uses the link (once: src/lib/links/one-time.ts)
 * and does what its purpose does (src/lib/links/purposes.ts): for a connect,
 * a 303 to the provider's sign-in with the oauth_nonce binding cookie set in
 * this browser, which the OAuth callback requires.
 *
 * Public on purpose (the link is the credential; src/proxy.ts doesn't cover
 * it), but same-origin only: a POST another site's page makes (an
 * auto-submitting form) is refused, so the link is only ever used by
 * someone who saw its page and tapped the button. A GET does nothing here:
 * link previews only ever see the page.
 *
 * A used, expired or unknown link goes back to its page, which says so.
 */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (!isSameOriginPost(req)) return new Response('Forbidden', { status: 403 })
  if (!isLinkToken(token)) return NextResponse.redirect(pageUrl('/l/done?status=invalid'), 303)

  const used = await consumeOneTimeLink(getServiceClient(), token)
  if (!used.ok) return NextResponse.redirect(pageUrl(used.reason === 'lookup_failed' ? `/l/${token}` : '/l/done?status=invalid'), 303)

  let started: LinkStart
  try {
    started = LINK_PURPOSES[used.link.purpose].start(used.link)
  } catch (err) {
    started = { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  if (!started.ok) {
    console.warn(`[links] start failed purpose=${used.link.purpose}: ${started.error}`)
    return NextResponse.redirect(pageUrl('/l/done?status=failed'), 303)
  }
  console.info(`[links] used purpose=${used.link.purpose} link=${used.link.id}`)
  const response = NextResponse.redirect(started.redirect, 303)
  if (started.oauthNonce) response.cookies.set(OAUTH_NONCE_COOKIE(), started.oauthNonce, bindingCookieOptions(Math.floor(OAUTH_STATE_TTL_MS / 1000)))
  return response
}

function pageUrl(path: string): string {
  return `${appOrigin()}${path}`
}
