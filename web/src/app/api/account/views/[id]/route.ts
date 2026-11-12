import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { badRequest, forbidden, notFound } from '@/lib/api-errors'
import { isTableLayout } from '@/lib/views/types'
import { NextResponse, type NextRequest } from 'next/server'

// GET /api/account/views/[id] — Get single view
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { data, error } = await supabase
    .from('view')
    .select('*, view_favorite!left(id)')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 404 })

  const favorites = data.view_favorite as unknown as { id: string }[] | null
  const view = {
    ...data,
    view_favorite: undefined,
    is_favorited: Array.isArray(favorites) && favorites.length > 0,
  }

  return NextResponse.json({ view })
}

// PATCH /api/account/views/[id] — Update view
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const body = await request.json()

  // Only allow updating specific fields
  const allowedFields = [
    'name', 'description', 'icon', 'color', 'visibility', 'layout',
    'filters', 'grouping', 'sub_grouping', 'ordering', 'display_properties',
    'board_group_by', 'show_completed', 'completed_filter', 'show_sub_items',
    'nested_sub_items', 'show_empty_groups', 'team_id', 'is_pinned', 'pin_order',
    'metadata',
  ]

  const updates: Record<string, unknown> = {}
  for (const key of allowedFields) {
    if (key in body) updates[key] = body[key]
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
  }

  // The layouts as POST has them: a table's rows take the grid, board,
  // calendar and gallery, and only they take the three table-only ones.
  if ('layout' in updates) {
    const { data: existing } = await supabase
      .from('view')
      .select('entity_type')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    const kind = (existing as { entity_type?: string } | null)?.entity_type
    if (!kind) return notFound('View not found')
    const layout = updates.layout
    if (kind === 'data_row' ? !isTableLayout(layout) : isTableLayout(layout) && layout !== 'board') {
      return badRequest(kind === 'data_row' ? 'A table’s view is a grid, a board, a calendar or a gallery' : `The ${String(layout)} layout is only for tables`)
    }
  }

  const { data, error } = await supabase
    .from('view')
    .update(updates)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ view: data })
}

// DELETE /api/account/views/[id] — Delete view
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  // count: 'exact' because view delete RLS (the creator, or an owner/admin for a
  // workspace view) skips a refused row without an error, which read as success.
  const { error, count } = await supabase
    .from('view')
    .delete({ count: 'exact' })
    .eq('id', id)
    .eq('workspace_id', workspaceId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!count) {
    const { data: visible } = await supabase
      .from('view')
      .select('id')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    return visible
      ? forbidden('Only the view’s creator, or a workspace owner or admin, can delete it')
      : notFound('View not found')
  }

  return NextResponse.json({ success: true })
}
