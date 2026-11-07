import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, conflict, forbidden, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { parseProfilePatch } from '@/lib/customers/profile-input'
import { activeBusinessNumber } from '@/lib/customers/numbers'
import { getBusinessProfile, upsertBusinessProfile } from '@/lib/customers/store'

export const dynamic = 'force-dynamic'

/**
 * GET / PATCH /api/account/business: the workspace's business profile
 * (roadmap B, migration 458): what customers may be told, when jobs can be
 * booked, its public booking link, and its customer number. Any member reads;
 * only an owner changes it (the agent changes it through
 * update_business_profile, as the person).
 */
export async function GET() {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  const supabase = getServiceClient()
  try {
    const [profile, number, key] = await Promise.all([
      getBusinessProfile(supabase, auth.workspaceId),
      activeBusinessNumber(supabase, auth.workspaceId),
      supabase.from('quote_intake_key').select('key_prefix, allowed_origins, created_at, last_used_at').eq('workspace_id', auth.workspaceId).is('revoked_at', null).maybeSingle(),
    ])
    return Response.json({
      profile,
      phone_number: number ? number.phone : null,
      intake_key: key.data ? { prefix: key.data.key_prefix, allowed_origins: key.data.allowed_origins, created_at: key.data.created_at, last_used_at: key.data.last_used_at } : null,
    })
  } catch (err) {
    console.error('[business] read failed:', err instanceof Error ? err.message : String(err))
    return serverError()
  }
}

export async function PATCH(request: Request) {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  if (auth.member.role !== 'owner') return forbidden('Only an owner of the workspace can change the business profile.')
  const body = await request.json().catch(() => null)
  const patch = parseProfilePatch(body)
  if ('error' in patch) return badRequest(patch.error)
  const written = await upsertBusinessProfile(getServiceClient(), { workspaceId: auth.workspaceId, ownerUserId: auth.user.id }, patch.patch)
  if (!written.ok) {
    if (written.reason === 'slug_taken') return conflict('That booking link is taken. Pick another.', undefined, 'SLUG_TAKEN')
    if (written.reason === 'invalid') return badRequest(written.error ?? 'Those settings are not valid.')
    return serverError()
  }
  return Response.json({ profile: written.profile })
}
