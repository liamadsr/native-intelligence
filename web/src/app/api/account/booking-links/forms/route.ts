import { getServiceClient } from '@/lib/admin'
import { requireWorkspace } from '@/lib/api-auth'
import { serverError } from '@/lib/api-errors'
import { gateableForms } from '@/lib/booking-links/form-gate'

/**
 * GET /api/account/booking-links/forms → { forms }: the forms the caller may
 * put in front of a booking link (anyone-can-fill, on, no files, on a table
 * they can change), each with the fields a rule can check (booking insights
 * phase 4, src/lib/booking-links/form-gate.ts).
 */
export async function GET() {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  try {
    return Response.json({ forms: await gateableForms(getServiceClient(), { workspaceId: auth.workspaceId, userId: auth.user.id }) }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Could not read the forms')
  }
}
