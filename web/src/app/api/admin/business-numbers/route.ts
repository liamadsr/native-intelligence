import { requireAdmin } from '@/lib/admin'
import { apiError, badRequest, conflict, serverError, unauthorized } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { attachBusinessNumber, buyBusinessNumber } from '@/lib/customers/numbers'
import { businessName, businessOwnerUserId } from '@/lib/customers/store'

export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/business-numbers: give a business the number its customers
 * text (roadmap B2). Native Intelligence's admins only: a number costs Native Intelligence money each
 * month and lives in Native Intelligence's Twilio account, so no workspace sets up its own.
 * Body: `{ workspace_id, area_code: "929" }` buys a new local number, or
 * `{ workspace_id, phone: "+16465550173" }` attaches one already in the
 * account. The number answers to the business's owner (its profile's, else
 * the workspace's owner). One per workspace.
 */
export async function POST(request: Request) {
  try {
    await requireAdmin()
  } catch {
    return unauthorized()
  }
  const body = (await request.json().catch(() => null)) as { workspace_id?: unknown; area_code?: unknown; phone?: unknown } | null
  const workspaceId = typeof body?.workspace_id === 'string' && /^[0-9a-f-]{36}$/i.test(body.workspace_id) ? body.workspace_id : null
  if (!workspaceId) return badRequest('Name the business by workspace_id.')
  const supabase = getServiceClient()
  let ownerUserId: string | null
  try {
    ownerUserId = await businessOwnerUserId(supabase, workspaceId)
  } catch {
    return serverError()
  }
  if (!ownerUserId) return badRequest('That workspace has no owner to answer its customers.')
  const args = { workspaceId, ownerUserId }
  const result =
    typeof body?.phone === 'string'
      ? await attachBusinessNumber(supabase, { ...args, phone: body.phone })
      : typeof body?.area_code === 'string'
        ? await buyBusinessNumber(supabase, { ...args, areaCode: body.area_code.trim(), businessName: await businessName(supabase, workspaceId) })
        : null
  if (!result) return badRequest('Send { workspace_id, area_code } to buy a number or { workspace_id, phone } to attach one.')
  if (result.ok) return Response.json({ phone_number: result.number.phone }, { status: 201 })
  switch (result.reason) {
    case 'not_configured':
      return apiError('Texting is not set up on this deployment.', { status: 503, code: 'NOT_CONFIGURED' })
    case 'has_number':
      return conflict('This business already has a customer number.', undefined, 'HAS_NUMBER')
    case 'taken':
      return conflict('That number already belongs to a business.', undefined, 'NUMBER_TAKEN')
    case 'none_available':
      return apiError('No number is free in that area code. Try a nearby one.', { status: 404, code: 'NONE_AVAILABLE' })
    case 'not_in_account':
      return apiError("That number isn't in Native Intelligence's Twilio account.", { status: 404, code: 'NOT_IN_ACCOUNT' })
    case 'bad_input':
      return badRequest(result.error ?? 'That number or area code is not valid.')
    default:
      console.error(`[business-number] ws=${workspaceId} ${result.reason}: ${result.error ?? ''}`)
      return serverError('Could not set up the number right now.')
  }
}
