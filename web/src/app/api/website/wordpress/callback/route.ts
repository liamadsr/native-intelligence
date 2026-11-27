/**
 * Where a WordPress site hands back the application password the owner just
 * approved (docs/plans/hosted-site-builders.md, migration 724): WordPress's
 * "Authorize Application" page redirects here with `site_url`, `user_login`
 * and `password` in the query (that is WordPress's own design), or with
 * `success=false` when they rejected it.
 *
 * The state must be ours and for the person signed in here
 * (src/lib/website/builder.ts completeWordpressConnect), so a link made in
 * someone else's workspace can't take this site's login there. The password
 * is never logged, echoed or kept anywhere but encrypted on the site's row:
 * the edge's logs redact `password` and `user_login` (deploy/edge/Caddyfile),
 * and the answer is a 303 to this path without the query (no-store, no
 * referrer), so the address that held the password leaves the browser too.
 */
import { requireUser } from '@/lib/api-auth'
import { getServiceClient } from '@/lib/supabase/service'
import { resultPage, settle } from '@/lib/website/callback-page'
import { completeWordpressConnect, CONNECT_REFUSALS } from '@/lib/website/builder'

export const dynamic = 'force-dynamic'

const CONNECTED = 'Your WordPress site is connected. Back in Native Intelligence (or by text) you can ask for changes; nothing goes live without your yes.'

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const params = url.searchParams
  // The page after the redirect: fixed words for a fixed code.
  const shown = params.get('result')
  if (shown && !params.has('password')) return resultPage(shown, CONNECTED, CONNECT_REFUSALS)
  if (params.get('rejected') === '1' || params.get('success') === 'false') return settle(url, 'REJECTED')
  const auth = await requireUser()
  const sessionUserId = auth instanceof Response ? null : auth.user.id
  const result = await completeWordpressConnect(getServiceClient(), {
    state: params.get('state'),
    sessionUserId,
    siteUrl: params.get('site_url'),
    userLogin: params.get('user_login'),
    password: params.get('password'),
  }).catch((err: unknown) => {
    console.error('[website] wordpress connect failed:', err instanceof Error ? err.name : 'error')
    return { ok: false as const, code: 'FAILED', error: CONNECT_REFUSALS.FAILED }
  })
  if (!result.ok) {
    console.warn(`[website] wordpress connect refused: ${result.code}`)
    return settle(url, result.code)
  }
  return settle(url, 'connected')
}
