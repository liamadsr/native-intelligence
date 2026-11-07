import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * GET /api/account/actions/:id/documents
 * Returns documents linked to this action.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase } = auth

  const { id } = await params

  const { data, error } = await supabase
    .from('action_document')
    .select(`
      id,
      document:document!document_id(id, title, updated_at, created_by:member!created_by(id, display_name))
    `)
    .eq('action_id', id)
    .order('created_at', { ascending: false })

  if (error) {
    return serverError(error.message)
  }

  const documents = (data || []).map((row) => {
    const doc = row.document as unknown as {
      id: string
      title: string
      updated_at: string
      created_by: { id: string; display_name: string } | null
    } | null
    return {
      link_id: row.id,
      id: doc?.id,
      title: doc?.title,
      updated_at: doc?.updated_at,
      created_by_name: doc?.created_by?.display_name || null,
    }
  })

  return NextResponse.json({ documents })
}

/**
 * POST /api/account/actions/:id/documents
 * Link a document to this action.
 * Body: { document_id: string }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { id } = await params
  const body = await request.json()
  const documentId = body.document_id

  if (!documentId) {
    return badRequest('document_id is required')
  }

  // The action and the document must both be in this workspace: RLS on
  // action_document checks only the action's, and a cross-workspace link is
  // drift (it also blocks a workspace merge).
  const [{ data: action }, { data: document }] = await Promise.all([
    supabase.from('actions').select('id').eq('id', id).eq('workspace_id', workspaceId).maybeSingle(),
    supabase.from('document').select('id').eq('id', documentId).eq('workspace_id', workspaceId).maybeSingle(),
  ])
  if (!action || !document) {
    return notFound('Action or document not found')
  }

  const { data, error } = await supabase
    .from('action_document')
    .insert({ action_id: id, document_id: documentId })
    .select('id')
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'Document already linked' }, { status: 409 })
    }
    return serverError(error.message)
  }

  return NextResponse.json({ link: data })
}

/**
 * DELETE /api/account/actions/:id/documents
 * Unlink a document from this action.
 * Query: ?link_id=uuid
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase } = auth

  const { id } = await params
  const linkId = request.nextUrl.searchParams.get('link_id')

  if (!linkId) {
    return badRequest('link_id is required')
  }

  const { error } = await supabase
    .from('action_document')
    .delete()
    .eq('id', linkId)
    .eq('action_id', id)

  if (error) {
    return serverError(error.message)
  }

  return NextResponse.json({ success: true })
}
