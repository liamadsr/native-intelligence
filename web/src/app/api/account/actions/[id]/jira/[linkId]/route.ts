import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { JIRA_PROVIDER } from '@/lib/tasks/jira-config'
import {
  lensParseFailure,
  lensResponse,
  linkNotFound,
  loadLensLink,
  updateTaskDetails,
} from '@/lib/tasks/lens-route'
import { parseLensUpdate } from '@/lib/tasks/task-lens'

/**
 * DELETE /api/account/actions/[id]/jira/[linkId] — Unlink a Jira issue.
 *
 * NI-side ONLY: this drops the link row so the action stops echoing status
 * changes. The Jira issue itself is never touched — deleting someone's issue out
 * from under them because a Native Intelligence user tidied up a panel would be unrecoverable
 * (and, in most real Jira instances, wouldn't even be permitted).
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
    .eq('provider', JIRA_PROVIDER)
    .eq('workspace_id', workspaceId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}

/**
 * PATCH /api/account/actions/[id]/jira/[linkId] — Edit the linked Jira issue's
 * fields from the property lens.
 *
 * Body: `{ fields: { assignee_id?, priority_id?, due_date?, label_ids? } }`.
 * ABSENT means untouched, `null` means CLEAR, and `label_ids` is a full-replacement
 * array that is never null — the clearable-reader semantics push-overrides.ts
 * already established for the compose panel, applied to edits. See parseLensUpdate.
 *
 * WHAT THIS DELIBERATELY CANNOT WRITE, and why:
 *  - STATUS. It already has an owner — the Native Intelligence→Jira echo, which resolves a
 *    transition against the issue's live workflow graph — and a second write path
 *    would race the CAS the webhook read-back uses as its loop-breaker.
 *  - PROJECT and ISSUE TYPE. Both are identifier-rewriting, wizard-driven Jira
 *    operations (a project move goes through `POST /bulk/issues/move` and remaps
 *    fields; a type change can blank customs not on the new type's screen). The
 *    compose path treats project as the parent that invalidates everything below
 *    it for the same reason.
 *
 * Answers the SAME normalized body the GET does, read back from Jira after the
 * write, so the panel reconciles against real provider state rather than an echo of
 * what it sent. Coded failures: 400 `reconnect_required` / `not_connected` /
 * `not_configured` / `field_not_editable` / `too_many_labels`, 404
 * `link_not_found` / `task_missing`, 502 `provider_error`.
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

  // The body is parsed BEFORE the link lookup: a malformed payload is the caller's
  // to fix either way, and answering it without a database round trip keeps a
  // buggy panel cheap.
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON' }, { status: 400 })
  }
  const parsed = parseLensUpdate(body, 'jira')
  if (!parsed.ok) return lensParseFailure(parsed)

  const link = await loadLensLink({
    supabase,
    actionId,
    provider: 'jira',
    workspaceId,
    linkId,
  })
  if (!link) return linkNotFound('jira')

  return lensResponse(
    await updateTaskDetails({ provider: 'jira', workspaceId, link, update: parsed.value }),
  )
}
