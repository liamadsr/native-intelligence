import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'
import { apiError, forbidden, notFound } from '@/lib/api-errors'

/** Postgres `restrict_violation`: migration 311 refuses deleting the team that holds the last of the system teammates. */
const RESTRICT_VIOLATION = '23001'
/** A concurrent team delete: the move's target went in the same moment (foreign_key_violation), or two crossing moves deadlocked. Nothing was lost; trying again works. */
const RACED = new Set(['23503', '40P01'])
const ONLY_TEAM_MESSAGE = "Can't delete the workspace's only team. Create another team first."

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
    .from('team')
    .select('*')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ team: data })
}

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
  if (body.slug !== undefined) updates.slug = body.slug
  if (body.icon !== undefined) updates.icon = body.icon
  if (body.color !== undefined) updates.color = body.color
  if (body.issue_prefix !== undefined) updates.issue_prefix = body.issue_prefix
  if (body.timezone !== undefined) updates.timezone = body.timezone
  if (body.is_private !== undefined) updates.is_private = body.is_private

  const { data, error } = await supabase
    .from('team')
    .update(updates)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ team: data })
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

  // Refuse to delete a workspace's last team. Every workspace must keep at least
  // one team: action/board creation resolves the "default team" (the oldest one)
  // and a teamless workspace makes the agent report "No team found in workspace"
  // (see getDefaultTeamId in lib/ai/tools/actions.ts). count: 'exact', head: true
  // returns just the count without rows.
  const { count } = await supabase
    .from('team')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)

  if ((count ?? 0) <= 1) {
    return apiError(ONLY_TEAM_MESSAGE, { status: 409, code: 'LAST_TEAM' })
  }

  // count: 'exact' because the team delete RLS (owner/admin only, migration
  // 017) skips a refused row without an error, which read as success.
  const { error, count: deleted } = await supabase
    .from('team')
    .delete({ count: 'exact' })
    .eq('id', id)
    .eq('workspace_id', workspaceId)

  if (error) {
    // Migration 311's team_keep_system_teammates: the workspace's system
    // teammates (the Assistant among them) move to another team when theirs is
    // deleted, and the database refuses when no other team is left (a race
    // past the count above). Same answer as the count's.
    if (error.code === RESTRICT_VIOLATION) {
      return apiError(ONLY_TEAM_MESSAGE, { status: 409, code: 'LAST_TEAM' })
    }
    if (error.code && RACED.has(error.code)) {
      return apiError('Another team was changed at the same moment. Try again.', { status: 409, code: 'TEAM_CHANGED' })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!deleted) {
    const { data: visible } = await supabase
      .from('team')
      .select('id')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    return visible
      ? forbidden('Only a workspace owner or admin can delete a team')
      : notFound('Team not found')
  }

  return NextResponse.json({ success: true })
}
