/**
 * The time offers' one sweep (availability phase 3a), every 5 minutes
 * (src/lib/inngest/time-offers.ts), for every booking on the one model
 * (offers', booking links' and customers' jobs alike, migration 581):
 *
 *   1. offers past their expiry (open, or still waiting on a card) expire,
 *      and their holds go;
 *   2. expired holds left behind are deleted (none blocks anything anyway:
 *      every insert deletes the host's first, and every read skips them);
 *      a request whose hold ran out with no answer from the host (a booking
 *      link's that asks first, a customer's job) expires and lets its time
 *      go: a texting customer is told, as when their approval lapses
 *      (src/lib/customers/booking.ts expireOrDecline);
 *   3. bookings left in 'booking' over BOOKING_STUCK_MS (a crash between the
 *      claim and the provider write, or a provider that failed) are written
 *      again: the same idempotency key never makes a second event, and after
 *      BOOKING_ATTEMPTS_MAX tries one is failed, its time let go, and the
 *      host told (./accept.ts finishBooking);
 *   4. claims of meetings that ended over a day ago are deleted.
 *
 * Server only; service role. Throws only on a failed read of what to do, so
 * the step retries.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { finishBooking, type AcceptDeps } from './accept'
import { closeOffer } from './offers'
import { deleteBookingClaims, deleteEndedBookingClaims, deleteExpiredHolds, getBooking, keepBookingClaims, lapsedOffers, lapsedRequestClaims, stuckBookings } from './store'
import { BOOKING_STUCK_MS } from './types'

export interface SweepResult {
  expired: number
  /** Requests whose hold ran out unanswered. */
  lapsedRequests: number
  finished: number
  failed: number
  stillBooking: number
}

export async function sweepTimeOffers(supabase: SupabaseClient, deps: AcceptDeps = {}): Promise<SweepResult> {
  const now = (deps.now ?? Date.now)()
  const nowIso = new Date(now).toISOString()
  const result: SweepResult = { expired: 0, lapsedRequests: 0, finished: 0, failed: 0, stillBooking: 0 }

  for (const { id } of await lapsedOffers(supabase, nowIso)) {
    const closed = await closeOffer(supabase, id, ['open', 'pending_send'], 'expired').catch(() => null)
    if (closed) result.expired++
  }
  await deleteExpiredHolds(supabase, null, nowIso)

  for (const bookingId of await lapsedRequestClaims(supabase, nowIso)) {
    const booking = await getBooking(supabase, bookingId).catch(() => null)
    if (booking?.state === 'requested') {
      if (booking.source === 'customer') {
        const { expireOrDecline } = await import('@/lib/customers/booking')
        await expireOrDecline(supabase, { workspaceId: booking.workspaceId, bookingId }, 'expired').catch(() => {})
      } else {
        const { settleLinkRequest } = await import('@/lib/booking-links/book')
        await settleLinkRequest(supabase, bookingId, 'expired')
      }
      result.lapsedRequests++
    } else if (booking && (booking.state === 'confirmed' || booking.state === 'booking')) {
      // Said yes to, its hold never cleared: it keeps its time.
      await keepBookingClaims(supabase, booking).catch(() => {})
    } else {
      // Over, or gone: its claims block nothing.
      await deleteBookingClaims(supabase, bookingId).catch(() => {})
    }
  }

  for (const booking of await stuckBookings(supabase, new Date(now - BOOKING_STUCK_MS).toISOString())) {
    const after = await finishBooking(supabase, booking.id, deps)
    if (after?.state === 'confirmed') result.finished++
    else if (after?.state === 'failed') result.failed++
    else if (after?.state === 'booking') result.stillBooking++
  }

  await deleteEndedBookingClaims(supabase, new Date(now - 24 * 60 * 60_000).toISOString()).catch(() => {})
  return result
}
