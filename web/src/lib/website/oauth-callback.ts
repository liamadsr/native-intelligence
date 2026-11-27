/**
 * The callback of a builder connected by OAuth (Webflow, WordPress.com: phase 3
 * of docs/plans/hosted-site-builders.md): its consent page sends the owner
 * back with a code and our state. The state and the signed-in person are
 * checked and the code traded server-side (./builder.ts
 * completeOAuthBuilderConnect); then a 303 to the same path with only a result
 * code, as the WordPress and Shopify callbacks do (./callback-page.ts). Server only.
 */
import { requireUser } from '@/lib/api-auth'
import { getServiceClient } from '@/lib/supabase/service'
import { completeOAuthBuilderConnect, CONNECT_REFUSALS } from './builder'
import { resultPage, settle } from './callback-page'
import { PROVIDER_LABEL } from './providers/types'

export async function oauthBuilderCallback(provider: 'webflow' | 'wpcom', request: Request): Promise<Response> {
  const url = new URL(request.url)
  const params = url.searchParams
  const shown = params.get('result')
  if (shown && !params.has('code')) {
    const what = provider === 'webflow' ? 'its CMS items' : 'its pages and posts'
    return resultPage(shown, `Your ${PROVIDER_LABEL[provider]} site is connected. Back in Native Intelligence (or by text) you can ask for changes to ${what}; nothing goes live without your yes.`, CONNECT_REFUSALS)
  }
  if (params.get('error')) return settle(url, 'REJECTED')
  const auth = await requireUser()
  const sessionUserId = auth instanceof Response ? null : auth.user.id
  const result = await completeOAuthBuilderConnect(getServiceClient(), provider, { params, sessionUserId }).catch((err: unknown) => {
    console.error(`[website] ${provider} connect failed:`, err instanceof Error ? err.name : 'error')
    return { ok: false as const, code: 'FAILED', error: CONNECT_REFUSALS.FAILED }
  })
  if (!result.ok) {
    console.warn(`[website] ${provider} connect refused: ${result.code}`)
    return settle(url, result.code)
  }
  return settle(url, 'connected')
}
