import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, forbidden, notFound, serverError } from '@/lib/api-errors'
import {
  SYSTEM_DOCUMENT_PRIVATE_REFUSAL,
  SYSTEM_DOCUMENT_PRIVATE_SQLSTATE,
  VISIBILITY_REFUSAL,
  documentUpdateRefusal,
  isSystemDocument,
  loadDocumentAccess,
} from '@/lib/documents/access'
import { NextResponse, type NextRequest } from 'next/server'

const VISIBILITY_VALUES = ['workspace', 'private'] as const

/** Postgres insufficient_privilege (the 369 guard raises it for a non-creator). */
const NOT_ALLOWED = '42501'

/**
 * PATCH /api/account/documents/[id]/visibility
 *
 * The document twin of the capture scope route (migration 369): "Only me" is
 * creator-only, and a system document (a canon_key, or the product-doc
 * pointer) is never private. The checks are EXPLICIT rather than left to RLS
 * and the guard so the person gets a truthful 403 instead of a silent
 * zero-row update. Someone else's private document is a 404: to them it does
 * not exist.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const { id } = await params
  const body = await request.json()
  const { visibility } = body as { visibility?: string }

  if (!visibility || !VISIBILITY_VALUES.includes(visibility as typeof VISIBILITY_VALUES[number])) {
    return badRequest('visibility must be workspace or private')
  }

  const { access, error: fetchError } = await loadDocumentAccess(supabase, workspaceId, user.id, id)
  if (fetchError) return serverError(fetchError)
  if (!access) return notFound('Document not found')
  if (!access.memberId || access.row.created_by !== access.memberId) return forbidden(VISIBILITY_REFUSAL)
  if (visibility === 'private' && isSystemDocument(access)) return forbidden(SYSTEM_DOCUMENT_PRIVATE_REFUSAL)
  const refusal = documentUpdateRefusal(access, { visibility })
  if (refusal) return forbidden(refusal)

  const { data, error } = await supabase
    .from('document')
    .update({ visibility })
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .eq('created_by', access.memberId)
    .select('id, visibility')
    .single()

  if (error) {
    const code = (error as { code?: string }).code
    if (code === SYSTEM_DOCUMENT_PRIVATE_SQLSTATE) return forbidden(SYSTEM_DOCUMENT_PRIVATE_REFUSAL)
    if (code === NOT_ALLOWED) return forbidden(VISIBILITY_REFUSAL)
    return serverError(error.message)
  }

  return NextResponse.json({ document: data })
}
