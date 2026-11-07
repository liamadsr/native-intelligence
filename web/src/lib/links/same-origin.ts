/**
 * True for a POST from one of our own pages (a single-use link's button,
 * src/app/api/links/[token]/route.ts): `Sec-Fetch-Site: same-origin` when the
 * browser sends it, otherwise an `Origin` on the host the request came to.
 * Neither: refused, so another site's auto-submitting form can't use a link.
 */
export function isSameOriginPost(req: Request): boolean {
  const site = req.headers.get('sec-fetch-site')
  if (site) return site === 'same-origin'
  const origin = req.headers.get('origin')
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host')
  if (!origin || !host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}
