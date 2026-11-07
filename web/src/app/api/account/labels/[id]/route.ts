import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { forbidden, notFound } from '@/lib/api-errors'
import { NextResponse, type NextRequest } from 'next/server'

const LABEL_FIELDS = 'id, name, color, group_name, scopes, created_at'

const VALID_SCOPES = ['action', 'email_thread', 'project', 'initiative', 'capture']

export async function PATCH(
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

  const updates: Record<string, unknown> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.color !== undefined) updates.color = body.color
  if (body.group_name !== undefined) updates.group_name = body.group_name
  if (body.scopes !== undefined) {
    updates.scopes = Array.isArray(body.scopes) && body.scopes.length > 0
      ? body.scopes.filter((s: string) => VALID_SCOPES.includes(s))
      : null
  }

  const { data, error } = await supabase
    .from('label')
    .update(updates)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select(LABEL_FIELDS)
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { error: 'A label with that name already exists' },
        { status: 409 },
      )
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ label: data })
}

export async function DELETE(
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

  // count: 'exact' because the label RLS (owner/admin manage, migration 020)
  // skips a refused row without an error, which read as success.
  const { error, count } = await supabase
    .from('label')
    .delete({ count: 'exact' })
    .eq('id', id)
    .eq('workspace_id', workspaceId)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!count) {
    const { data: visible } = await supabase
      .from('label')
      .select('id')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    return visible
      ? forbidden('Only a workspace owner or admin can delete labels')
      : notFound('Label not found')
  }

  return NextResponse.json({ success: true })
}
