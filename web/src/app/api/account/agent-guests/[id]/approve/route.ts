import { requireUser } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { isGuestPresetId } from '@/lib/guests/presets'
import { approveRequest } from '@/lib/guests/store'
import { guestRefusal, settleGuestRequestCard, toGuestView } from '@/lib/guests/people-server'

/**
 * POST { preset: 'household' | 'colleague' } → { guest }: say yes to someone
 * who texted JOIN (guest access): they become an active guest with that
 * preset's tools, and the chat's request card shows it settled. From the
 * People tab and that card. 409
 * GUEST_WRONG_STATE once the request is settled or gone.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { id } = await params
  let body: { preset?: unknown }
  try {
    body = await req.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  if (!isGuestPresetId(body.preset)) return badRequest('Allow them as Household or Colleague.')
  const supabase = getServiceClient()
  const result = await approveRequest(supabase, auth.user.id, id, body.preset)
  if (!result.ok) return guestRefusal(result.reason)
  await settleGuestRequestCard(supabase, result.guest, { status: 'approved', preset: body.preset })
  return Response.json({ guest: toGuestView(result.guest) })
}
