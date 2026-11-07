import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { paymentsOrigin, PAYMENTS_PATHS } from '@/lib/payments/config'
import { getConnectedAccount } from '@/lib/payments/accounts'
import { textSetupLink } from '@/lib/payments/setup'
import { setupReturnQuery, verifySetupReturn } from '@/lib/payments/return-token'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Stripe's refresh URL (roadmap C1): its Account Link expired or was already
 * opened. This never mints a Stripe link for whoever holds the URL; it texts
 * the owner who started setup a fresh single-use setup link (paced per
 * workspace: src/lib/payments/setup-link.ts) and says so. Only with the URL's
 * signed `s` (src/lib/payments/return-token.ts): a bare workspace id texts
 * nobody and says nothing about the workspace.
 */
export async function GET(request: Request) {
  const origin = paymentsOrigin()
  const params = new URL(request.url).searchParams
  const workspaceId = params.get('w') ?? ''
  const done = (query: Record<string, string>) => NextResponse.redirect(`${origin}${PAYMENTS_PATHS.done}?${new URLSearchParams(query)}`, 303)
  if (!UUID.test(workspaceId) || !verifySetupReturn(workspaceId, params.get('s'))) return done({ e: 'invalid' })
  const back = (t: string) => NextResponse.redirect(`${origin}${PAYMENTS_PATHS.done}?${setupReturnQuery(workspaceId)}&t=${encodeURIComponent(t)}`, 303)
  const supabase = getServiceClient()
  const account = await getConnectedAccount(supabase, workspaceId)
  if (!account?.connectedBy) return done({ e: 'invalid' })
  if (account.status === 'ready') return back('ready')
  const texted = await textSetupLink(supabase, { workspaceId, userId: account.connectedBy })
  return back(texted.sent ? 'sent' : texted.reason)
}
