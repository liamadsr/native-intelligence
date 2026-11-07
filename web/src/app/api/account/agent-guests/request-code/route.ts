import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { setRequestsOpen } from '@/lib/guests/store'

/**
 * PATCH { open: boolean } → { code, open }: the People tab's "Let people ask"
 * (guest access, PR5). While open, someone who texts "JOIN <code>" to the
 * Dial8 number lands on the tab as a request for the owner to allow or ignore.
 */
export async function PATCH(req: Request) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  let body: { open?: unknown }
  try {
    body = await req.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  if (typeof body.open !== 'boolean') return badRequest('open must be true or false')
  const state = await setRequestsOpen(getServiceClient(), auth.user.id, auth.workspaceId, body.open)
  return state ? Response.json(state) : serverError('Couldn’t change that. Try again.')
}
