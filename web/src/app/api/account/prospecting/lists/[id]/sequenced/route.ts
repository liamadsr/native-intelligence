/**
 * GET /api/account/prospecting/lists/[id]/sequenced — the "Sequenced" chip (§8).
 *
 *   { sequenced: { <contact_id>: { status, sequence_id, sequence_name } } }
 *
 * DERIVED, not stored. There is no `stage='contacted'` and no column on the
 * entry: the moment someone enrolls a contact from the CRM instead of from
 * Prospecting, a shadowed column would be wrong and nothing would notice.
 * `sequence_enrollment` is the only thing that decides, so it is the only
 * thing read.
 *
 * Keyed by `contact_id` because that is what the People tab's rows carry once
 * they are saved; an unsaved row has no contact and therefore no chip.
 */
import { NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { serverError } from '@/lib/api-errors'
import { listSequencedByList } from '@/lib/prospecting/lists'

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id } = await params

  const result = await listSequencedByList(supabase, { workspaceId, listId: id })
  if (!result.ok) return serverError()

  // A list id from another workspace produces an EMPTY map, not a 404: the
  // reads are workspace-scoped, and "this list has no sequenced contacts" is
  // both true and non-confirming. The list's own GET already 404s a foreign
  // id, so nothing is hidden that the UI needed.
  return NextResponse.json({ sequenced: result.sequenced })
}
