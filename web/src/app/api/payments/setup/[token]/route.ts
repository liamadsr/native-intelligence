import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { getStripe } from '@/lib/stripe'
import { connectAvailability, paymentsOrigin, PAYMENTS_PATHS } from '@/lib/payments/config'
import { consumeSetupLink } from '@/lib/payments/setup-link'
import { startExistingAccount, startNewAccount } from '@/lib/payments/onboarding'
import { getConnectedAccount } from '@/lib/payments/accounts'
import { bindingCookieOptions } from '@/lib/oauth/state'

/**
 * A setup link's button (roadmap C1; the page is src/app/payments/setup/[token]).
 * Uses the link once, then sends the browser to Stripe: hosted onboarding for
 * a new account (mode=new), or Stripe OAuth for one the owner already has
 * (mode=existing). Same-origin form posts only: a link preview or another
 * site can't use it up.
 */
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const origin = paymentsOrigin()
  const done = (query: Record<string, string>) => NextResponse.redirect(`${origin}${PAYMENTS_PATHS.done}?${new URLSearchParams(query)}`, 303)

  if (!sameOrigin(request)) return NextResponse.json({ error: 'Cross-site request refused' }, { status: 403 })
  const availability = connectAvailability()
  if (!availability.ok) return done({ e: 'payments_off' })

  const form = await request.formData().catch(() => null)
  const mode = form?.get('mode') === 'existing' ? 'existing' : 'new'
  const { token } = await params
  const supabase = getServiceClient()
  const used = await consumeSetupLink(supabase, token)
  if (!used.ok) return done({ e: used.reason === 'expired' ? 'expired' : used.reason === 'lookup_failed' ? 'server' : 'used' })
  const { link } = used

  // Still allowed to connect this workspace's payments.
  const { data: member } = await supabase.from('member').select('role').eq('workspace_id', link.workspaceId).eq('user_id', link.userId).maybeSingle<{ role: string | null }>()
  if (member?.role !== 'owner' && member?.role !== 'admin') return done({ e: 'not_admin' })

  const stripe = getStripe()
  const args = { workspaceId: link.workspaceId, userId: link.userId, origin, linkId: link.id }
  if (mode === 'existing') {
    // A workspace already taking payments keeps its account (the page hides the buttons; this is the POST's own check).
    if ((await getConnectedAccount(supabase, link.workspaceId))?.status === 'ready') return done({ e: 'already_connected' })
    const [{ data: workspace }, user] = await Promise.all([
      supabase.from('workspace').select('name').eq('id', link.workspaceId).maybeSingle<{ name: string | null }>(),
      supabase.auth.admin.getUserById(link.userId).catch(() => null),
    ])
    const started = startExistingAccount(stripe, { ...args, ownerEmail: user?.data?.user?.email ?? null, businessName: workspace?.name ?? null })
    if (!started.ok) return done({ e: started.reason })
    const response = NextResponse.redirect(started.redirectUrl, 303)
    if (started.cookie) response.cookies.set(started.cookie.name, started.cookie.value, bindingCookieOptions(started.cookie.maxAgeSeconds))
    return response
  }
  const started = await startNewAccount(supabase, stripe, { ...args, livemode: availability.livemode })
  if (!started.ok) {
    if (started.error) console.error('[payments] setup failed:', started.reason, started.error)
    return done({ e: started.reason })
  }
  return NextResponse.redirect(started.redirectUrl, 303)
}

/** A same-origin form post (the browser's Origin, or its fetch metadata). */
function sameOrigin(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site')
  if (site) return site === 'same-origin'
  const origin = request.headers.get('origin')
  if (!origin) return false
  try {
    return new URL(origin).host === new URL(request.url).host
  } catch {
    return false
  }
}
