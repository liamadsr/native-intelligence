import { badRequest, notFound, serverError, unauthorized, noWorkspace } from '@/lib/api-errors'
import { getDocumentRevision } from '@/lib/documents/revision'
import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * GET /api/account/documents/[id]/revisions/[number]
 *
 * One version with its text, and the one before it (the history view diffs
 * the two to show what that change did).
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string; number: string }> }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return unauthorized()
  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return noWorkspace()
  const { id, number } = await params
  const revisionNumber = Number(number)
  if (!Number.isInteger(revisionNumber) || revisionNumber < 1) return badRequest('Invalid revision number')

  const { revision, previous, error } = await getDocumentRevision(supabase, id, workspaceId, revisionNumber)
  if (error) return serverError(error)
  if (!revision) return notFound('Revision not found')
  return NextResponse.json({ revision, previous })
}
