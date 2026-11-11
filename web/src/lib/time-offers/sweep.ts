/**
 * The time offers' one sweep (availability phase 3a), every 5 minutes
 * (src/lib/inngest/time-offers.ts):
 *
 *   1. offers past their expiry (open, or still waiting on a card) expire,
 *      and their holds go;
 *   2. expired holds left behind are deleted (none blocks anything anyway:
 *      every insert deletes the host's first, and every read skips them);
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
import { deleteEndedBookingClaims, deleteExpiredHolds, lapsedOffers, stuckBookings } from './store'
import { BOOKING_STUCK_MS } from './types'

export interface SweepResult {
  expired: number
  finished: number
  failed: number
  stillBooking: number
}

export async function sweepTimeOffers(supabase: SupabaseClient, deps: AcceptDeps = {}): Promise<SweepResult> {
  const now = (deps.now ?? Date.now)()
  const nowIso = new Date(now).toISOString()
  const result: SweepResult = { expired: 0, finished: 0, failed: 0, stillBooking: 0 }

  for (const { id } of await lapsedOffers(supabase, nowIso)) {
    const closed = await closeOffer(supabase, id, ['open', 'pending_send'], 'expired').catch(() => null)
    if (closed) result.expired++
  }
  await deleteExpiredHolds(supabase, null, nowIso)

  for (const booking of await stuckBookings(supabase, new Date(now - BOOKING_STUCK_MS).toISOString())) {
    const after = await finishBooking(supabase, booking.id, deps)
    if (after?.state === 'confirmed') result.finished++
    else if (after?.state === 'failed') result.failed++
    else if (after?.state === 'booking') result.stillBooking++
  }

  await deleteEndedBookingClaims(supabase, new Date(now - 24 * 60 * 60_000).toISOString()).catch(() => {})
  return result
}
