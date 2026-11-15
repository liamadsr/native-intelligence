/**
 * GET /api/internal/cloud-browser/tls-ask?domain=<host> → 200 or 403, no body.
 *
 * Our edge's question before it gets a certificate for a cloud browser hub's
 * name on the runtime backend (Caddy's on-demand TLS `ask`): 200 only for
 * `<sandbox id>.<CLOUD_BROWSER_HUB_DOMAIN>` naming a running or paused browser
 * sandbox of this database (src/lib/cloud-browser/hub-tls.ts). Anything else,
 * the hosted backend and a malformed name included, is a 403 that says nothing.
 * No secret: the answer is not one. Never a 500 into the edge.
 */
import { hubTlsAllowed } from '@/lib/cloud-browser/hub-tls'

export const dynamic = 'force-dynamic'

const answer = (status: 200 | 403) => new Response(null, { status, headers: { 'cache-control': 'no-store' } })

export async function GET(request: Request) {
  let domain: string | null = null
  try {
    domain = new URL(request.url).searchParams.get('domain')
  } catch {
    return answer(403)
  }
  return answer((await hubTlsAllowed(domain)) ? 200 : 403)
}
