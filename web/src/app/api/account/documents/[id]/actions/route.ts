import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * GET /api/account/documents/:id/actions
 * Returns actions linked to this document.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) {
    return NextResponse.json({ error: 'No workspace' }, { status: 400 })
  }

  const { id } = await params

  const { data, error } = await supabase
    .from('action_document')
    .select(`
      id,
      action:actions!action_id(id, identifier, title, workflow_state:workflow_state!status_id(name, color, category))
    `)
    .eq('document_id', id)
    .order('created_at', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const actions = (data || []).map((row) => {
    const action = row.action as unknown as {
      id: string
      identifier: string
      title: string
      workflow_state: { name: string; color: string; category: string } | null
    } | null
    return {
      link_id: row.id,
      id: action?.id,
      identifier: action?.identifier,
      title: action?.title,
      status_name: action?.workflow_state?.name || null,
      status_color: action?.workflow_state?.color || null,
    }
  })

  return NextResponse.json({ actions })
}

/**
 * POST /api/account/documents/:id/actions
 * Link an action to this document.
 * Body: { action_id: string }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) {
    return NextResponse.json({ error: 'No workspace' }, { status: 400 })
  }

  const { id } = await params
  const body = await request.json()
  const actionId = body.action_id

  if (!actionId) {
    return NextResponse.json({ error: 'action_id is required' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('action_document')
    .insert({ action_id: actionId, document_id: id })
    .select('id')
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'Action already linked' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ link: data })
}

/**
 * DELETE /api/account/documents/:id/actions
 * Unlink an action from this document.
 * Query: ?link_id=uuid
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) {
    return NextResponse.json({ error: 'No workspace' }, { status: 400 })
  }

  const { id } = await params
  const linkId = request.nextUrl.searchParams.get('link_id')

  if (!linkId) {
    return NextResponse.json({ error: 'link_id is required' }, { status: 400 })
  }

  const { error } = await supabase
    .from('action_document')
    .delete()
    .eq('id', linkId)
    .eq('document_id', id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
