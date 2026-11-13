import { redirect } from 'next/navigation'
import { getServiceClient } from '@/lib/admin'
import { createClient } from '@/lib/supabase/server'
import { addressDomain } from '@/lib/workspace-join/domains'
import { findDomainOffers } from '@/lib/workspace-join/domain-offer'
import { JOIN_OFFER_PAGE } from '@/lib/workspace-join/sign-in-check'
import { JoinTeamView } from './join-team-view'

export const metadata = {
  title: 'Join your team',
  robots: { index: false, follow: false },
}

/**
 * Join by email domain (src/lib/workspace-join/domain-offer.ts): the
 * workspaces that list the signed-in person's verified domain, each with
 * its owner's name and a Join button, and "Not now" for all of them.
 * Sign-in sends people here once per sign-in when there is something to
 * offer. Signed out: sign in first. Nothing on offer: the app.
 */
export default async function JoinTeamPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect(`/login?redirect=${encodeURIComponent(JOIN_OFFER_PAGE)}`)

  let offers: Awaited<ReturnType<typeof findDomainOffers>> = []
  try {
    offers = await findDomainOffers(getServiceClient(), user)
  } catch (err) {
    console.error('[workspace-join] offers failed:', err instanceof Error ? err.message : err)
  }
  if (offers.length === 0) redirect('/account')

  return <JoinTeamView offers={offers} domain={addressDomain(user.email) ?? ''} />
}
