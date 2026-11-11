import { getServiceClient } from '@/lib/supabase/service'
import { loadLinkPage } from '@/lib/booking-links/public'
import { loadBookingPage, supabaseBookingLinkDeps } from '@/lib/customers/booking-link'
import { BookingView } from '../booking-view'
import { LinkView } from './link-view'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Book a time',
  // One person's (or one team's) booking page: keep it out of the search index.
  robots: { index: false, follow: false },
}

/**
 * A booking link's page (availability phase 4b), /book/<handle>/<slug>: the
 * link's open times, a day at a time in the guest's zone, and a short form;
 * booked on the hosts' calendars, or held for the host's yes when the link
 * asks first. No sign-in. Server-rendered from the same read as GET
 * /api/public/booking-links/<handle>/<slug>; the times are read in the
 * browser, a week at a time.
 *
 * The segment is [slug] (the handle) because /book/[slug] already is: the
 * app router keeps one name per dynamic level. A business's job link here is
 * its /book/<handle> page, as it always was.
 */
export default async function BookingLinkPage({ params }: { params: Promise<{ slug: string; link: string }> }) {
  const { slug: profile, link: slug } = await params
  const supabase = getServiceClient()
  const load = await loadLinkPage({ supabase }, profile, slug)
  if (load.kind === 'found' && load.data.purpose === 'job') {
    const state = await loadBookingPage(profile, supabaseBookingLinkDeps(supabase))
    return <BookingView slug={profile} state={state} />
  }
  return (
    <main>
      <LinkView profile={profile} slug={slug} load={load} />
    </main>
  )
}
