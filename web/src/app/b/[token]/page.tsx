import { getServiceClient } from '@/lib/supabase/service'
import { loadBookingPage } from '@/lib/time-offers/public'
import { ManageView } from './manage-view'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Your meeting',
  // One guest's booking: keep it out of the search index.
  robots: { index: false, follow: false },
}

/**
 * A guest's manage page for a meeting they booked from a time offer
 * (availability phase 3b): the meeting, cancel it, or move it to another of
 * the host's open times. No sign-in: the link's token is the key.
 * Server-rendered from the same read as GET /api/public/bookings/<token>.
 */
export default async function ManageBookingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const load = await loadBookingPage(getServiceClient(), token)
  return (
    <main>
      <ManageView token={token} load={load} />
    </main>
  )
}
