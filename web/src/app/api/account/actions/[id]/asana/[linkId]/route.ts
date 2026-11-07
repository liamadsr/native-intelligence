import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { ASANA_PROVIDER } from '@/lib/tasks/asana-config'
import {
  lensParseFailure,
  lensResponse,
  linkNotFound,
  loadLensLink,
  updateTaskDetails,
} from '@/lib/tasks/lens-route'
import { parseLensUpdate } from '@/lib/tasks/task-lens'

/**
 * DELETE /api/account/actions/[id]/asana/[linkId] — Unlink an Asana task.
 *
 * Dial8-side ONLY: this drops the link row so the action stops echoing status
 * changes. The Asana task itself is never touched — deleting someone's task out
 * from under them because a Dial8 user tidied up a panel would be unrecoverable.
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
    .eq('provider', ASANA_PROVIDER)
    .eq('workspace_id', workspaceId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}

/**
 * PATCH /api/account/actions/[id]/asana/[linkId] — Edit the linked Asana task's
 * fields from the property lens.
 *
 * Body: `{ fields: { assignee_id?, due_date?, label_ids? } }`. ABSENT means
 * untouched, `null` means CLEAR, and `label_ids` (Asana TAGS) is a full-replacement
 * array that is never null — the clearable-reader semantics push-overrides.ts
 * established for the compose panel, applied to edits. See parseLensUpdate.
 *
 * `priority_id` IS REJECTED BY NAME, not silently dropped: Asana has no native
 * priority field at all — it exists only as a per-project enum custom field Dial8
 * has no schema knowledge of — so the create path excludes it for the same reason.
 *
 * Tags are diffed rather than replaced wholesale, because Asana gives no choice:
 * `PUT /tasks/{gid}` does not accept a `tags` array, only the dedicated
 * `addTag`/`removeTag` endpoints. So a tags edit costs one extra read (the current
 * set) and one call per changed tag; an untouched `label_ids` costs neither.
 *
 * SECTION and PROJECT are not writable here. A project move loses the section
 * placement and would have to re-derive one from the config's section_map — which
 * is meaningless in a different project, the exact rule the push already encodes.
 *
 * Answers the SAME normalized body the GET does, read back after the write.
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
  const parsed = parseLensUpdate(body, 'asana')
  if (!parsed.ok) return lensParseFailure(parsed)

  const link = await loadLensLink({
    supabase,
    actionId,
    provider: 'asana',
    workspaceId,
    linkId,
  })
  if (!link) return linkNotFound('asana')

  return lensResponse(
    await updateTaskDetails({ provider: 'asana', workspaceId, link, update: parsed.value }),
  )
}
