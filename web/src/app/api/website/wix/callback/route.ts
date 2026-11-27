/**
 * Where Wix sends the owner back after they install our app on their site
 * (docs/plans/hosted-site-builders.md, Wix, phase 4): the redirect URL the
 * app's install settings name (deploy/app/.env.example, WIX_APP_ID), with the
 * site's `instanceId` and our `state`. The state and the signed-in person are
 * checked and the install proven with a token for that instance
 * (src/lib/website/builder.ts completeWixConnect); then a 303 to this path with
 * only a result code, as the other builders' callbacks do.
 */
import { requireUser } from '@/lib/api-auth'
import { getServiceClient } from '@/lib/supabase/service'
import { completeWixConnect, CONNECT_REFUSALS } from '@/lib/website/builder'
import { resultPage, settle } from '@/lib/website/callback-page'

export const dynamic = 'force-dynamic'

const CONNECTED = 'Your Wix site is connected. Back in Native Intelligence (or by text) you can put your form on every page and change your CMS items and product descriptions; the words of a page itself stay yours to edit in Wix. Nothing goes live without your yes.'

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const params = url.searchParams
  const shown = params.get('result')
  if (shown && !params.has('instanceId')) return resultPage(shown, CONNECTED, CONNECT_REFUSALS)
  if (params.get('error')) return settle(url, 'REJECTED')
  const auth = await requireUser()
  const sessionUserId = auth instanceof Response ? null : auth.user.id
  const result = await completeWixConnect(getServiceClient(), { params, sessionUserId }).catch((err: unknown) => {
    console.error('[website] wix connect failed:', err instanceof Error ? err.name : 'error')
    return { ok: false as const, code: 'FAILED', error: CONNECT_REFUSALS.FAILED }
  })
  if (!result.ok) {
    console.warn(`[website] wix connect refused: ${result.code}`)
    return settle(url, result.code)
  }
  return settle(url, 'connected')
}
