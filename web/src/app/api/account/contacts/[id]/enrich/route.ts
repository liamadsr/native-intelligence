import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { apiError, notFound, noWorkspace, serverError, unauthorized } from '@/lib/api-errors'
import { startContactEnrichment } from '@/lib/crm/manual-enrichment'

/**
 * POST /api/account/contacts/[id]/enrich
 *
 * Manually queue web enrichment for one contact. Returns 202 immediately —
 * the Exa deep search runs in Inngest (crm/enrich-contact.manual).
 *
 * The work is startContactEnrichment (src/lib/crm/manual-enrichment.ts), the
 * one path this button and the chat's `enrich_contact` tool share, so the two
 * can't drift. This route only maps its result to HTTP.
 *
 * A manual trigger MAY re-run an already-enriched contact: the user is
 * explicitly asking for a refresh, and re-running is safe because the column
 * write-back is fill-empty-only — a refresh can only add to empty columns and
 * rewrite the `metadata.enrichment` blob, never overwrite a value someone
 * typed in.
 *
 * The one thing it cannot override is the permanent-failure marker: those
 * failures (schema-unsatisfiable, 4xx) reproduce identically on every retry, so
 * re-queueing just burns a paid search to reach the same dead end. 409.
 *
 * Auth follows the sibling [id] route: session user → current workspace → the
 * row must belong to that workspace (the helper's SELECT is the ownership
 * check, under RLS with the user's own client). A failed event send settles
 * the click's Activity row and rethrows (a 500).
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return unauthorized()

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return noWorkspace()

  const { id } = await params

  const started = await startContactEnrichment(supabase, { contactId: id, workspaceId, userId: user.id })
  if (!started.ok) {
    if (started.reason === 'not_found') return notFound('Contact not found')
    if (started.reason === 'permanent_failure') return apiError(started.error, { status: 409, code: started.code })
    // Already being enriched (another click, or the chat): that run is this one.
    if (started.reason === 'already_running') return NextResponse.json({ status: 'pending' }, { status: 202 })
    return serverError(started.error)
  }

  return NextResponse.json({ status: 'pending' }, { status: 202 })
}
