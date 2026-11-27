/**
 * Where a WordPress site hands back the application password the owner just
 * approved (docs/plans/hosted-site-builders.md, migration 723): WordPress's
 * "Authorize Application" page redirects here with `site_url`, `user_login`
 * and `password` in the query (that is WordPress's own design), or with
 * `success=false` when they rejected it.
 *
 * The state must be ours and for the person signed in here
 * (src/lib/website/builder.ts completeWordpressConnect), so a link made in
 * someone else's workspace can't take this site's login there. The password
 * is never logged, echoed or kept anywhere but encrypted on the site's row;
 * the answer is a plain page with no referrer and no caching, since the
 * address it was asked at holds the password.
 */
import { requireUser } from '@/lib/api-auth'
import { getServiceClient } from '@/lib/supabase/service'
import { appOrigin } from '@/lib/twilio/config'
import { completeWordpressConnect } from '@/lib/website/builder'

export const dynamic = 'force-dynamic'

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

/** The answer page: one line, a way back to the app. */
function answerPage(status: number, line: string): Response {
  const home = `${appOrigin().replace(/\/$/, '')}/account`
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Native Intelligence</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><p>${escapeHtml(line)}</p><p><a href="${escapeHtml(home)}" rel="noreferrer">Back to Native Intelligence</a></p></body></html>`
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' },
  })
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const params = url.searchParams
  if (params.get('rejected') === '1' || params.get('success') === 'false') {
    return answerPage(200, 'Nothing was connected: the request was turned down on WordPress. You can ask for a new link any time.')
  }
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
    return { ok: false as const, code: 'FAILED', error: 'Something went wrong connecting the site. Ask for a new link and try again.' }
  })
  if (!result.ok) {
    console.warn(`[website] wordpress connect refused: ${result.code}`)
    return answerPage(result.code === 'WRONG_PERSON' ? 403 : 400, result.error)
  }
  return answerPage(200, 'Your WordPress site is connected. Back in Native Intelligence (or by text) you can ask for changes; nothing goes live without your yes.')
}
