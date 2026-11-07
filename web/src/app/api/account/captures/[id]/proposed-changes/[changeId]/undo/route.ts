import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { undoAppliedProposal } from '@/lib/proposed-changes/undo-applied'
import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * POST /api/account/captures/[id]/proposed-changes/[changeId]/undo
 *
 * Un-apply a proposal that was already applied (manually or auto-accepted).
 * Deletes the entity the proposal created and re-stages the proposal as
 * `pending` so the user can edit, dismiss, or re-apply it.
 *
 * Only `create:*` proposals can be undone: those spawned a fresh entity that we
 * can safely delete. `update`/`assign` proposals mutated a pre-existing entity,
 * which we cannot reverse without recorded prior state — those are refused.
 * The logic is undoAppliedProposal (src/lib/proposed-changes/undo-applied.ts),
 * shared with Extraction's undo of one pass.
 *
 * The workspace is the active one, unless the body names the change's own
 * (`{ workspace_id }`: the home thread's Undo on what a call added, P13,
 * which can be viewed from another workspace). A named one must be the
 * caller's: their member row there is checked first (403 otherwise).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; changeId: string }> },
) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json().catch(() => ({}))) as { workspace_id?: unknown }
    const named = typeof body?.workspace_id === 'string' && UUID_RE.test(body.workspace_id) ? body.workspace_id : null
    if (named) {
      const { data: member } = await supabase.from('member').select('id').eq('workspace_id', named).eq('user_id', user.id).maybeSingle()
      if (!member) return NextResponse.json({ error: 'Not a member of that workspace', code: 'NOT_MEMBER' }, { status: 403 })
    }
    const workspaceId = named ?? (await getCurrentWorkspaceId())
    if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

    const { id, changeId } = await params
    const result = await undoAppliedProposal(supabase as unknown as SupabaseClient, { workspaceId, changeId, captureId: id })
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, ...(result.code ? { code: result.code } : {}) },
        { status: result.status },
      )
    }
    return NextResponse.json({ change: result.change })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    const isAuth = /auth|session|jwt|token/i.test(message)
    return NextResponse.json(
      { error: isAuth ? 'Unauthorized' : 'Failed to undo change' },
      { status: isAuth ? 401 : 500 },
    )
  }
}
