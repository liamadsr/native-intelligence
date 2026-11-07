import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { noWorkspace, notFound, serverError, unauthorized } from '@/lib/api-errors'
import { releaseHubspotPushHold } from '@/lib/crm/hubspot-push-hold-release'

/**
 * POST /api/account/contacts/[id]/hubspot-hold   → { released, pushed, contact }
 *
 * Release the HubSpot push HOLD on a contact an unattended run created
 * (Sequence step 2, plan A.1): the person's explicit approval that this
 * contact may leave the workspace. Clears `metadata.hubspot_push_hold` and
 * sends the same fire-and-forget crm/hubspot-push-contact event the manual
 * create surfaces send. Idempotent: a contact that is not held returns
 * `released: false` with the row unchanged. Called from the contact's own
 * badge and, per contact, from the run's review card.
 *
 * Auth follows the sibling [id] routes: session user → current workspace →
 * the row must belong to that workspace (the SELECT is the ownership check,
 * under RLS with the user's own client).
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return unauthorized()

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return noWorkspace()

  const { id } = await params
  const result = await releaseHubspotPushHold(supabase, { contactId: id, workspaceId })
  if (!result.ok) return result.status === 404 ? notFound(result.error) : serverError(result.error)
  return NextResponse.json({
    released: result.released,
    pushed: result.released ? result.pushed : false,
    contact: result.contact,
  })
}
