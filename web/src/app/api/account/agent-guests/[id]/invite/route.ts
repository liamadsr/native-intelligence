import { requireUser } from '@/lib/api-auth'
import { getServiceClient } from '@/lib/supabase/service'
import { renewInvite } from '@/lib/guests/store'
import { guestRefusal, toGuestView, toInvite } from '@/lib/guests/people-server'

/**
 * POST → { guest, invite }: a fresh invite for a channel of theirs not yet
 * bound: someone who hasn't messaged yet, or is in on one channel and not
 * the other (guest access). The old code stops working; the new one is shown once.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { id } = await params
  const result = await renewInvite(getServiceClient(), auth.user.id, id)
  if (!result.ok) return guestRefusal(result.reason)
  return Response.json({ guest: toGuestView(result.guest), invite: toInvite(result.guest, result.inviteCode) })
}
