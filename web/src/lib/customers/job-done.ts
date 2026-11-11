/**
 * A booked job is done (roadmap B → D3): when the owner's agent marks a
 * quote done and that quote has a confirmed booking, track D's
 * `job/completed` event goes out for the booking, so the customer's review
 * request follows (src/lib/jobs/events.ts on track D's branch: its receiver
 * asks a customer at most once every 30 days, whatever the job).
 *
 * The event's name and payload are track D's (`jobRef` and `reason`, as
 * track C's paid links send it); once both are merged this calls its
 * emitJobCompleted. Never throws: a lost event is a review request not
 * sent, never a failed update.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { inngest } from '@/lib/inngest/client'

/** Track D's event (src/lib/jobs/events.ts JOB_COMPLETED_EVENT). */
export const JOB_COMPLETED_EVENT = 'job/completed' as const

export interface BookingJobDone {
  workspaceId: string
  contactId: string
  bookingId: string
  completedAt: string
  userId: string | null
}

/**
 * The quote's confirmed booking with a customer contact, when the quote just
 * became done; null otherwise. Throws on a failed read.
 */
export async function bookingJobDone(
  supabase: SupabaseClient,
  args: { workspaceId: string; quoteId: string; contactId: string | null; userId: string | null; now?: number },
): Promise<BookingJobDone | null> {
  const { data, error } = await supabase
    .from('meeting_booking')
    .select('id, contact_id, state, starts_at')
    .eq('workspace_id', args.workspaceId)
    .eq('quote_id', args.quoteId)
    .eq('state', 'confirmed')
    .order('starts_at', { ascending: false })
    .limit(1)
  if (error) throw new Error(`meeting_booking read failed: ${error.message}`)
  const booking = (data as Array<{ id: string; contact_id: string | null }> | null)?.[0]
  const contactId = booking?.contact_id ?? args.contactId
  if (!booking || !contactId) return null
  return { workspaceId: args.workspaceId, contactId, bookingId: booking.id, completedAt: new Date(args.now ?? Date.now()).toISOString(), userId: args.userId }
}

/** Send track D's job/completed for a booked job. Never throws; whether it went. */
export async function emitBookingJobDone(
  done: BookingJobDone,
  deps: { send?: (event: { name: string; data: Record<string, unknown> }) => Promise<unknown> } = {},
): Promise<boolean> {
  try {
    await (deps.send ?? ((e) => inngest.send(e as never)))({
      name: JOB_COMPLETED_EVENT,
      data: { workspaceId: done.workspaceId, contactId: done.contactId, jobRef: { type: 'booking', id: done.bookingId }, reason: 'done', completedAt: done.completedAt, userId: done.userId },
    })
    return true
  } catch (err) {
    console.warn('[job-done] job/completed not sent:', err instanceof Error ? err.message : String(err))
    return false
  }
}
