import { getServiceClient } from '@/lib/supabase/service'
import { loadBookingPage, supabaseBookingLinkDeps } from '@/lib/customers/booking-link'
import { BookingView } from './booking-view'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Book a time',
  // One business's booking page: keep it out of the search index.
  robots: { index: false, follow: false },
}

/**
 * A business's public booking page (roadmap B4): its open times, and a
 * short form. The request waits for the owner's yes; the customer is texted
 * once they give it. Open times only: nothing of the owner's calendar.
 */
export default async function BookingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const state = await loadBookingPage(slug, supabaseBookingLinkDeps(getServiceClient()))
  return <BookingView slug={slug} state={state} />
}
