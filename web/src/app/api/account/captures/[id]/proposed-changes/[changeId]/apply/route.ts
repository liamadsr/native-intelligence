import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { claimAndApplyChange } from '@/lib/proposed-changes/claim-apply'
import type { ProposedChange } from '@/lib/proposed-changes/types'
import { apiError } from '@/lib/api-errors'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * POST /api/account/captures/[id]/proposed-changes/[changeId]/apply
 * Execute the proposed change (create action, update project, etc.)
 *
 * Applying is CLAIM-then-execute, not read-then-execute-then-write. Two
 * concurrent POSTs for the same row (the card's Accept racing the "Push to…"
 * menu's confirm, two tabs, an Inngest retry) would otherwise both read
 * status='pending' and both run applyChange — two actions from one proposal,
 * with only the last writer's result_entity_id recorded. The conditional UPDATE
 * below is the arbiter: exactly one request can flip 'pending' → 'applied', and
 * the loser is told so (409 `already_applied`) instead of duplicating the work.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; changeId: string }> },
) {
  try {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  // A lapsed/invalid session is an auth failure, not a server error — return 401
  // so the client can transparently re-auth and retry, rather than surfacing a
  // generic 500. (getUser() can also throw on a torn-down session; the outer
  // try/catch below maps that to 401 too.)
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { id, changeId } = await params

  // Resolve current member. maybeSingle (not single) so a missing row returns a
  // clean 403 instead of throwing a PostgREST "no rows" error → 500.
  const { data: member } = await supabase
    .from('member')
    .select('id')
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (!member) return NextResponse.json({ error: 'Not a workspace member' }, { status: 403 })

  // Fetch the proposed change (maybeSingle → clean 404 on no match, never a throw)
  const { data: change } = await supabase
    .from('proposed_change')
    .select('*')
    .eq('id', changeId)
    .eq('capture_id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (change.status !== 'pending') {
    return NextResponse.json({ error: 'Change is not pending' }, { status: 400 })
  }

  // Claim, then execute (claim-apply.ts): exactly one request can flip
  // 'pending' → 'applied'; the loser is told so instead of duplicating the work.
  const outcome = await claimAndApplyChange(supabase, change as ProposedChange, {
    workspaceId,
    memberId: member.id,
    userId: user.id,
  })

  if (!outcome.ok && outcome.reason === 'not_pending') {
    // Someone else won between our read and the claim.
    return apiError('Already accepted', { status: 409, code: 'already_applied' })
  }
  if (!outcome.ok) {
    // Token-expired / connection-lost surfaces a structured envelope
    // so the UI can show a "Reconnect" CTA instead of a generic toast.
    if (outcome.code === 'MCP_TOKEN_EXPIRED' || outcome.code === 'MCP_SERVER_DISCONNECTED') {
      return NextResponse.json(
        { error: outcome.error, code: outcome.code },
        { status: 401 },
      )
    }
    return NextResponse.json({ error: outcome.error }, { status: 500 })
  }

  return NextResponse.json({ change: outcome.change, entity_id: outcome.entity_id ?? undefined })
  } catch (err) {
    // A torn-down/expired Supabase session can make auth.getUser() throw rather
    // than return null — treat that as 401 (re-auth), not 500. Any other
    // unexpected throw is a genuine server error.
    const message = err instanceof Error ? err.message : 'Unknown error'
    const isAuth = /auth|session|jwt|token/i.test(message)
    return NextResponse.json(
      { error: isAuth ? 'Unauthorized' : 'Failed to apply change' },
      { status: isAuth ? 401 : 500 },
    )
  }
}
