import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { claimAndApplyChange } from '@/lib/proposed-changes/claim-apply'
import type { ProposedChange } from '@/lib/proposed-changes/types'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * POST /api/account/captures/[id]/proposed-changes/apply-all
 * Apply all pending proposed changes for a capture in sort_order. A row
 * another request already claimed is reported as `skipped`.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { id } = await params

  const { data: member } = await supabase
    .from('member')
    .select('id')
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (!member) return NextResponse.json({ error: 'Not a workspace member' }, { status: 403 })

  // Fetch all pending changes
  const { data: changes, error } = await supabase
    .from('proposed_change')
    .select('*')
    .eq('capture_id', id)
    .eq('workspace_id', workspaceId)
    .eq('status', 'pending')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!changes || changes.length === 0) {
    return NextResponse.json({ applied: 0, failed: 0, results: [] })
  }

  const results: { id: string; status: 'applied' | 'failed' | 'skipped'; error?: string; entity_id?: string }[] = []
  let applied = 0
  let failed = 0

  // Each row is claimed before it is applied (claim-apply.ts), so a row a
  // concurrent Accept already took is skipped instead of applied twice.
  for (const change of changes) {
    const outcome = await claimAndApplyChange(supabase, change as ProposedChange, {
      workspaceId,
      memberId: member.id,
      userId: user.id,
    })

    if (outcome.ok) {
      results.push({ id: change.id, status: 'applied', entity_id: outcome.entity_id ?? undefined })
      applied++
    } else if (outcome.reason === 'not_pending') {
      results.push({ id: change.id, status: 'skipped' })
    } else {
      results.push({ id: change.id, status: 'failed', error: outcome.error })
      failed++
    }
  }

  return NextResponse.json({ applied, failed, results })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    const isAuth = /auth|session|jwt|token/i.test(message)
    return NextResponse.json(
      { error: isAuth ? 'Unauthorized' : 'Failed to apply changes' },
      { status: isAuth ? 401 : 500 },
    )
  }
}
