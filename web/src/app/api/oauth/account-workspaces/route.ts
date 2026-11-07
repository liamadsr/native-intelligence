import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { reconcileThreadCopies } from '@/lib/email/account-scope'

/** GET /api/oauth/account-workspaces?account_id=X — list workspace IDs for an account */
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const accountId = request.nextUrl.searchParams.get('account_id')
  if (!accountId) return NextResponse.json({ error: 'account_id required' }, { status: 400 })

  // Verify user owns this account
  const { data: account } = await supabase
    .from('connected_account')
    .select('id')
    .eq('id', accountId)
    .eq('user_id', user.id)
    .maybeSingle()

  if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

  const { data: rows } = await supabase
    .from('connected_account_workspace')
    .select('workspace_id')
    .eq('account_id', accountId)

  return NextResponse.json({
    workspace_ids: (rows || []).map((r) => r.workspace_id),
  })
}

/** PUT /api/oauth/account-workspaces — replace workspace set for an account */
export async function PUT(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { account_id, workspace_ids: rawWorkspaceIds } = await request.json()
  if (
    !account_id ||
    !Array.isArray(rawWorkspaceIds) ||
    !rawWorkspaceIds.every((id: unknown) => typeof id === 'string' && id.length > 0)
  ) {
    return NextResponse.json({ error: 'account_id and workspace_ids[] required' }, { status: 400 })
  }
  // De-duped: a repeated id would trip UNIQUE(account_id, workspace_id).
  const workspace_ids: string[] = [...new Set(rawWorkspaceIds as string[])]

  // Verify user owns this account
  const { data: account } = await supabase
    .from('connected_account')
    .select('id')
    .eq('id', account_id)
    .eq('user_id', user.id)
    .maybeSingle()

  if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

  // Verify user is a member of all target workspaces
  if (workspace_ids.length > 0) {
    const { data: memberships } = await supabase
      .from('member')
      .select('workspace_id')
      .eq('user_id', user.id)
      .in('workspace_id', workspace_ids)

    const memberWorkspaceIds = new Set((memberships || []).map((m) => m.workspace_id))
    const unauthorized = workspace_ids.filter((id: string) => !memberWorkspaceIds.has(id))
    if (unauthorized.length > 0) {
      return NextResponse.json({ error: 'Not a member of all target workspaces' }, { status: 403 })
    }
  }

  // Add the new set first, then remove what is no longer in it, so a failed
  // write can never leave the account linked to no workspace at all.
  if (workspace_ids.length > 0) {
    const rows = workspace_ids.map((wsId) => ({
      account_id,
      workspace_id: wsId,
    }))
    const { error: upsertError } = await supabase
      .from('connected_account_workspace')
      .upsert(rows, { onConflict: 'account_id,workspace_id', ignoreDuplicates: true })
    if (upsertError) {
      console.error('[account-workspaces] link failed:', upsertError)
      return NextResponse.json({ error: 'Failed to update workspaces' }, { status: 500 })
    }
  }

  let removal = supabase
    .from('connected_account_workspace')
    .delete()
    .eq('account_id', account_id)
  if (workspace_ids.length > 0) {
    removal = removal.not('workspace_id', 'in', `(${workspace_ids.join(',')})`)
  }
  const { error: deleteError } = await removal
  if (deleteError) {
    console.error('[account-workspaces] unlink failed:', deleteError)
    return NextResponse.json({ error: 'Failed to update workspaces' }, { status: 500 })
  }

  // A mail account's threads are copied per linked workspace: the newly
  // linked get theirs, the unlinked lose theirs.
  await reconcileThreadCopies(account_id)

  return NextResponse.json({ ok: true, workspace_ids })
}
