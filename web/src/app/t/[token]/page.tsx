import { getServiceClient } from '@/lib/supabase/service'
import { loadOfferPage } from '@/lib/time-offers/public'
import { OfferView } from './offer-view'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Pick a time',
  // One person's private offer: keep it out of the search index.
  robots: { index: false, follow: false },
}

/**
 * A time offer's page (availability phase 3b): the few times someone offered
 * an outside guest, held for them; the guest picks one and it is booked on
 * the host's calendar. No sign-in: the link's token is the key. Nothing of
 * the host's calendar but the offered times. Server-rendered from the same
 * read as GET /api/public/time-offers/<token>.
 */
export default async function TimeOfferPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const load = await loadOfferPage(getServiceClient(), token)
  return (
    <main>
      <OfferView token={token} load={load} />
    </main>
  )
}
