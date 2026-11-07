import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/admin'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { getWorkspaceEmailAccountIds } from '@/lib/email/account-scope'
import { heldThreadCount } from '@/lib/email/held-threads'
import { NextResponse } from 'next/server'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  // Resolve workspace-scoped accounts via junction table
  // (self-heals an empty junction so counts aren't stuck at zero).
  const scopedAccountIds = await getWorkspaceEmailAccountIds(
    supabase,
    user.id,
    workspaceId,
  )

  if (scopedAccountIds.length === 0) {
    return NextResponse.json({
      inbox_unread: 0, inbox_total: 0, starred: 0, sent: 0,
      drafts: 0, spam: 0, trash: 0, needs_reply: 0,
    })
  }

  // get_email_folder_counts is a SECURITY DEFINER RPC revoked from the
  // authenticated role (migration 193) — call it on the service client. The
  // user + workspace + account scope above are already server-verified, and
  // p_user_id pins the RPC to this user's rows.
  const { data, error } = await getServiceClient().rpc('get_email_folder_counts', {
    p_user_id: user.id,
    p_workspace_id: workspaceId,
    p_account_ids: scopedAccountIds,
  })

  if (error) {
    console.error('get_email_folder_counts error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // "To review": the threads held beside a reply draft (src/lib/email/hold.ts).
  const review = await heldThreadCount(supabase, user.id, workspaceId)
  if (data) return NextResponse.json({ ...(data as Record<string, unknown>), review })

  return NextResponse.json({
    review,
    inbox_unread: 0,
    inbox_total: 0,
    starred: 0,
    sent: 0,
    drafts: 0,
    spam: 0,
    trash: 0,
    needs_reply: 0,
  })
}
