import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceIdOrResponse } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'
import { resolveMemberships } from '../scope'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceIdOrResponse()
  if (workspaceId instanceof Response) return workspaceId
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { id } = await params
  const body = await request.json()

  const updates: Record<string, unknown> = {}
  if (body.is_read !== undefined) {
    updates.is_read = body.is_read
    if (body.is_read === true) {
      updates.read_at = new Date().toISOString()
    } else {
      updates.read_at = null
    }
  }
  if (body.is_archived !== undefined) {
    updates.is_archived = body.is_archived
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No updates provided' }, { status: 400 })
  }

  // OWNERSHIP, WIDENED — not relaxed.
  //
  // This used to resolve the caller's member row in the ACTIVE workspace and
  // require the notification to be addressed to exactly it. That is wrong for a
  // row the user is looking at in the cross-workspace inbox: the same person is
  // a DIFFERENT member row in every workspace (migration 013), so clicking a
  // notification from workspace B while A is active failed the check and the
  // row silently stayed unread.
  //
  // The check still asks "is this addressed to me" — it just answers it with
  // every member row the caller holds instead of one. The set is resolved
  // server-side from the caller's own memberships (nothing in the request names
  // a workspace or a member), so widening reaches strictly the caller's own
  // notifications and never a stranger's: `notification_update`'s RLS
  // (migration 031) correlates per row on that row's workspace and would reject
  // anything else regardless.
  //
  // Unconditional rather than opt-in, because the caller cannot know which of
  // its member rows a given notification is addressed to — that is precisely
  // what it is asking the server to check.
  const memberships = await resolveMemberships(supabase, user.id)
  if (memberships instanceof Response) return memberships
  const recipientIds = memberships.map((m) => m.memberId)
  if (recipientIds.length === 0) return NextResponse.json({ error: 'Not a member' }, { status: 403 })

  const { data, error } = await supabase
    .from('notification')
    .update(updates)
    .eq('id', id)
    .in('recipient_id', recipientIds)
    .select('id, is_read, read_at, is_archived')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ notification: data })
}
