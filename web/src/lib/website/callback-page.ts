/**
 * The page a builder's connect callback answers with (migration 724,
 * docs/plans/hosted-site-builders.md): the callback stores the login, then
 * sends the browser (303) to its own path with only a result code, so the
 * address that carried a password or a code leaves the address bar and the
 * history; the page there is drawn from that code alone, in fixed words.
 * No caching, no referrer. Server only.
 */
import { appOrigin } from '@/lib/twilio/config'

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

/** The answer page: one line, a way back to the app. */
export function answerPage(status: number, line: string): Response {
  const home = `${appOrigin().replace(/\/$/, '')}/account`
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Native Intelligence</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><p>${escapeHtml(line)}</p><p><a href="${escapeHtml(home)}" rel="noreferrer">Back to Native Intelligence</a></p></body></html>`
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' },
  })
}

/** To this same path, with only the result code. */
export function settle(request: URL, result: string): Response {
  const to = new URL(request.pathname, appOrigin())
  to.searchParams.set('result', result)
  return new Response(null, { status: 303, headers: { Location: to.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } })
}

/** The page after the redirect: `connected`'s words, or a refusal's from the fixed map (an unknown code is FAILED's). */
export function resultPage(code: string, connected: string, refusals: Readonly<Record<string, string>>): Response {
  if (code === 'connected') return answerPage(200, connected)
  return answerPage(code === 'WRONG_PERSON' ? 403 : 400, refusals[code] ?? refusals.FAILED ?? 'Something went wrong.')
}
