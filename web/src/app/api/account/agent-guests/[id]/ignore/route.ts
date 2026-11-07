import { requireUser } from '@/lib/api-auth'
import { serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { getGuest, removeGuest } from '@/lib/guests/store'
import { guestRefusal, settleGuestRequestCard } from '@/lib/guests/people-server'

/**
 * POST → { ok: true }: ignore a JOIN request (guest access). They hear
 * nothing more, and the chat's request card shows it ignored. Idempotent: a request already ignored, or the person already
 * removed, is still ok. Only a request is ignored; an invited or active
 * person is removed from their own page (DELETE ..), so this answers 409 for
 * them.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { id } = await params
  const supabase = getServiceClient()
  let guest
  try {
    guest = await getGuest(supabase, auth.user.id, id)
  } catch {
    return serverError('Could not read that request')
  }
  if (!guest) return guestRefusal('not_found')
  if (guest.state === 'removed') return Response.json({ ok: true })
  if (guest.state !== 'requested') return guestRefusal('wrong_state')
  const result = await removeGuest(supabase, auth.user.id, id)
  if (result.ok) {
    await settleGuestRequestCard(supabase, guest, { status: 'ignored' })
    return Response.json({ ok: true })
  }
  // Settled in the meantime: ignored elsewhere is still ok.
  if (result.reason === 'wrong_state') {
    const now = await getGuest(supabase, auth.user.id, id).catch(() => null)
    if (now?.state === 'removed') return Response.json({ ok: true })
  }
  return guestRefusal(result.reason)
}
