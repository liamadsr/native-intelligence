import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { forbidden, notFound } from '@/lib/api-errors'
import { NextResponse, type NextRequest } from 'next/server'
import { cleanScopes, LABEL_FIELDS, labelWriteError, toLabelResponse, type LabelRow } from '@/lib/tags/label-rows'

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
  if (body.scopes !== undefined) updates.scopes = cleanScopes(body.scopes)
  // A personal tag shared with the workspace (never the other way: 700's guard).
  if (body.personal === false) updates.owner_user_id = null

  const { data, error } = await supabase
    .from('label')
    .update(updates)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select(LABEL_FIELDS)
    .single()

  if (error) {
    const known = labelWriteError(error.code)
    if (known) return NextResponse.json({ error: known.message }, { status: known.status })
    // No row came back: not visible, or the policies refuse this person the change.
    if (error.code === 'PGRST116') return forbidden('You cannot change this tag')
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ label: toLabelResponse(data as LabelRow) })
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
      ? forbidden('Only the tag’s creator, or a workspace owner or admin, can delete it')
      : notFound('Label not found')
  }

  return NextResponse.json({ success: true })
}
