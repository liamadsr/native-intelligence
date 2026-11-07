import { requireUser } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'

/**
 * DELETE /api/account/device-tokens/{id}
 * Revoke (delete) one of the current user's device tokens. The device using
 * it immediately stops authenticating. Scoped to the caller's own tokens.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { user } = auth

  const { id } = await params

  const service = getServiceClient()
  const { data, error } = await service
    .from('device_token')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id) // never let one user revoke another's token
    .select('id')
    .maybeSingle()

  if (error) return serverError(error.message)
  if (!data) return notFound('Device token not found')

  return Response.json({ ok: true })
}
