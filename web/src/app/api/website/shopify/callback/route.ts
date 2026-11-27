/**
 * Where Shopify sends the merchant back after they approve our app on their
 * store (docs/plans/hosted-site-builders.md, Shopify; migration 724): the
 * query carries `code`, `shop`, `state`, `timestamp` and Shopify's `hmac`
 * over them. This is the redirect URL the app's settings in Shopify name
 * (deploy/app/.env.example, SHOPIFY_CLIENT_ID).
 *
 * Shopify's HMAC, our state and the signed-in person are checked
 * (src/lib/website/builder.ts completeShopifyConnect); the code is traded for
 * the store's token server-side and kept only encrypted. Then, as the
 * WordPress callback does, a 303 to this path with only a result code (the
 * one-time code leaves the address bar; the edge's logs redact code and state).
 */
import { requireUser } from '@/lib/api-auth'
import { getServiceClient } from '@/lib/supabase/service'
import { completeShopifyConnect, CONNECT_REFUSALS } from '@/lib/website/builder'
import { resultPage, settle } from '@/lib/website/callback-page'

export const dynamic = 'force-dynamic'

const CONNECTED = 'Your Shopify store is connected. Back in Native Intelligence (or by text) you can ask for changes to its pages and product descriptions; nothing goes live without your yes.'

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const params = url.searchParams
  const shown = params.get('result')
  if (shown && !params.has('code')) return resultPage(shown, CONNECTED, CONNECT_REFUSALS)
  if (params.get('error')) return settle(url, 'REJECTED')
  const auth = await requireUser()
  const sessionUserId = auth instanceof Response ? null : auth.user.id
  const result = await completeShopifyConnect(getServiceClient(), { params, sessionUserId }).catch((err: unknown) => {
    console.error('[website] shopify connect failed:', err instanceof Error ? err.name : 'error')
    return { ok: false as const, code: 'FAILED', error: CONNECT_REFUSALS.FAILED }
  })
  if (!result.ok) {
    console.warn(`[website] shopify connect refused: ${result.code}`)
    return settle(url, result.code)
  }
  return settle(url, 'connected')
}
