import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { LINEAR_PROVIDER } from '@/lib/tasks/linear-config'
import {
  lensParseFailure,
  lensResponse,
  linkNotFound,
  loadLensLink,
  updateTaskDetails,
} from '@/lib/tasks/lens-route'
import { parseLensUpdate } from '@/lib/tasks/task-lens'

/**
 * DELETE /api/account/actions/[id]/linear/[linkId] — Unlink a Linear issue.
 *
 * Dial8-side ONLY: this drops the link row so the action stops echoing status
 * changes. The Linear issue itself is never touched — deleting someone's issue
 * out from under them because a Dial8 user tidied up a panel would be a
 * destructive answer to a bookkeeping request.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; linkId: string }> },
) {
  const { id: actionId, linkId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { error } = await supabase
    .from('action_external_task')
    .delete()
    .eq('id', linkId)
    .eq('action_id', actionId)
    .eq('provider', LINEAR_PROVIDER)
    .eq('workspace_id', workspaceId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}

/**
 * PATCH /api/account/actions/[id]/linear/[linkId] — Edit the linked Linear issue's
 * fields from the property lens.
 *
 * Body: `{ fields: { assignee_id?, priority_id?, due_date?, label_ids? } }`. ABSENT
 * means untouched, `null` means CLEAR, and `label_ids` is a full-replacement array
 * that is never null — the clearable-reader semantics push-overrides.ts established
 * for the compose panel, applied to edits. See parseLensUpdate.
 *
 * `priority_id` travels as the STRING "0".."4" (Linear's fixed workspace-wide
 * scale: 0 No priority, 1 Urgent, 2 High, 3 Medium, 4 Low), because every lens ref
 * id is a string for every provider. A cleared priority becomes 0 — Linear has no
 * way to unset the field itself.
 *
 * ONE mutation and no read-back call: `issueUpdate` takes every field at once and
 * returns the updated issue inline, which is the read-through body. That is why
 * this is the simplest of the three — Jira's PUT answers 204 and needs a re-GET,
 * Asana's tag endpoints land after its PUT and need one too.
 *
 * STATE and TEAM are not writable here. State belongs to the existing echo, and a
 * team move REWRITES the issue's user-facing identifier and invalidates the
 * team-scoped state_map the whole destination config is built on.
 *
 * Answers the SAME normalized body the GET does.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; linkId: string }> },
) {
  const { id: actionId, linkId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON' }, { status: 400 })
  }
  const parsed = parseLensUpdate(body, 'linear')
  if (!parsed.ok) return lensParseFailure(parsed)

  const link = await loadLensLink({
    supabase,
    actionId,
    provider: 'linear',
    workspaceId,
    linkId,
  })
  if (!link) return linkNotFound('linear')

  return lensResponse(
    await updateTaskDetails({ provider: 'linear', workspaceId, link, update: parsed.value }),
  )
}
