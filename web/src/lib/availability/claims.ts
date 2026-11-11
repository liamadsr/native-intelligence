/**
 * A host's claims on their own time (migration 554, host_time_claim): the
 * times held for an offer they made (src/lib/time-offers/) and the meetings
 * booked from one. The busy read (./busy.ts listCountedEvents) adds them to
 * the person's calendar events, so find_times, a group's time, Copy
 * availability and a business's booking slots never offer a held or booked
 * time.
 *
 * A hold counts until it expires; a booking's claim until it is released.
 * Only time leaves here: the claim's own id, never who it is for.
 *
 * Strict: a failed read throws (a time is never free because the claims
 * couldn't be read).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CalendarEvent } from '@/lib/integrations/calendar'

export interface HostClaim {
  id: string
  start: string
  end: string
  kind: 'hold' | 'booking'
  offerId: string | null
  bookingId: string | null
}

/** Claims a read leaves out: an offer's own holds (while it is being picked from), a booking's own claim (while it moves). */
export interface ClaimExceptions {
  offerId?: string
  bookingId?: string
}

interface ClaimRow {
  id: string
  starts_at: string
  ends_at: string
  kind: string
  offer_id: string | null
  booking_id: string | null
  expires_at: string | null
}

/**
 * The host's live claims overlapping [timeMin, timeMax): every booking's,
 * and every hold that hasn't expired. Throws on a failed read.
 */
export async function readHostClaims(
  supabase: SupabaseClient,
  hostUserId: string,
  range: { timeMin: string; timeMax: string },
  now: number = Date.now(),
): Promise<HostClaim[]> {
  const { data, error } = await supabase
    .from('host_time_claim')
    .select('id, starts_at, ends_at, kind, offer_id, booking_id, expires_at')
    .eq('host_user_id', hostUserId)
    .lt('starts_at', range.timeMax)
    .gt('ends_at', range.timeMin)
    .limit(1000)
  if (error) throw new Error(`Held times could not be read: ${error.message}`)
  const out: HostClaim[] = []
  for (const row of (data as ClaimRow[] | null) ?? []) {
    if (row.kind !== 'hold' && row.kind !== 'booking') continue
    if (row.kind === 'hold' && (!row.expires_at || Date.parse(row.expires_at) <= now)) continue
    out.push({ id: row.id, start: row.starts_at, end: row.ends_at, kind: row.kind, offerId: row.offer_id, bookingId: row.booking_id })
  }
  return out
}

/** The claims a read keeps, `except` left out. Pure. */
export function claimsExcept(claims: readonly HostClaim[], except: ClaimExceptions | undefined): HostClaim[] {
  if (!except) return [...claims]
  return claims.filter((c) => !(except.offerId && c.kind === 'hold' && c.offerId === except.offerId) && !(except.bookingId && c.bookingId === except.bookingId))
}

/** Claims as busy calendar events (titleless: the engine sees time only). Pure. */
export function claimEvents(claims: readonly HostClaim[]): CalendarEvent[] {
  return claims.map((c) => ({ id: `claim:${c.id}`, title: 'Busy', start: new Date(Date.parse(c.start)).toISOString(), end: new Date(Date.parse(c.end)).toISOString(), status: 'confirmed' }))
}
