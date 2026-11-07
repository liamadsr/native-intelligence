import { notFound, serverError, unauthorized, noWorkspace } from '@/lib/api-errors'
import { listDocumentRevisions } from '@/lib/documents/revision'
import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * GET /api/account/documents/[id]/revisions?limit=30&before=12
 *
 * The document's version history, newest first (src/lib/documents/revision.ts):
 * one row per change, without the text. Any member who can read the document
 * can read its history (RLS on document_revision).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return unauthorized()
  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return noWorkspace()
  const { id } = await params

  const { data: doc, error: docError } = await supabase
    .from('document')
    .select('id, revision')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (docError) return serverError(docError.message)
  if (!doc) return notFound('Document not found')

  const limit = Number(request.nextUrl.searchParams.get('limit') ?? 30)
  const before = Number(request.nextUrl.searchParams.get('before') ?? 0) || null
  const { revisions, error } = await listDocumentRevisions(supabase, id, workspaceId, { limit, before })
  if (error) return serverError(error)

  return NextResponse.json({ revisions, current_revision: (doc as { revision?: number }).revision ?? 1 })
}
