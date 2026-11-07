import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { updateAppliedEntity, type AppliedEditFields } from '@/lib/proposed-changes/apply-engine'
import { isAssignableTeammate, FOREIGN_AI_MEMBER_ERROR } from '@/lib/workspace-fences'
import { NextResponse, type NextRequest } from 'next/server'

/** Writable fields that can be edited before applying */
const EDITABLE_FIELDS = [
  'title', 'description', 'priority', 'due_date', 'status_to',
  'assignee_name', 'assignee_member_id', 'assignee_contact_id',
  'team_id', 'project_id', 'entity_id', 'labels',
  'email_to_name', 'email_to_address', 'email_subject', 'email_context',
  'display_text',
] as const

/**
 * PATCH /api/account/captures/[id]/proposed-changes/[changeId]
 *
 * Pending proposals: update fields on the staged change (e.g. fix assignee
 * before applying). Applied proposals: reach through and edit the real entity
 * the proposal created, so the property pills keep working after auto-accept.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; changeId: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { id, changeId } = await params
  const body = await request.json()

  const { data: existing } = await supabase
    .from('proposed_change')
    .select('status, change_type, entity_type, result_entity_id, extra, assignee_member_id, assignee_contact_id')
    .eq('id', changeId)
    .eq('capture_id', id)
    .eq('workspace_id', workspaceId)
    .single()

  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (existing.status === 'dismissed') {
    return NextResponse.json({ error: 'Cannot edit a dismissed change' }, { status: 400 })
  }

  // Filter to only editable fields
  const updates: Record<string, unknown> = {}
  for (const field of EDITABLE_FIELDS) {
    if (field in body) {
      updates[field] = body[field]
    }
  }

  // Agent assignee isn't a proposed_change column — it rides in `extra`. It
  // is the DELEGATE beside the member (decision 9, as the apply engine writes
  // it): setting it keeps the member. An external contact can't sit beside
  // an agent, so a contact gives way.
  const editingAgent = 'assignee_ai_member_id' in body
  if (editingAgent) {
    const aiId = body.assignee_ai_member_id || null
    // Fence the teammate to this workspace (the FK only checks existence).
    if (aiId && !(await isAssignableTeammate(supabase, aiId, workspaceId))) {
      return NextResponse.json({ error: FOREIGN_AI_MEMBER_ERROR }, { status: 400 })
    }
    const prevExtra = (existing.extra as Record<string, unknown> | null) || {}
    updates.extra = { ...prevExtra, assignee_ai_member_id: aiId }
    if (aiId && existing.assignee_contact_id) {
      updates.assignee_contact_id = null
      if (!existing.assignee_member_id) updates.assignee_name = null
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
  }

  // ── Applied proposal: edit the real entity in place ──────────────
  if (existing.status === 'applied') {
    if (!existing.result_entity_id) {
      return NextResponse.json(
        { error: 'This applied change has no linked entity to edit' },
        { status: 400 },
      )
    }
    const fields: AppliedEditFields = {}
    if ('title' in updates) fields.title = updates.title as string | null
    if ('description' in updates) fields.description = updates.description as string | null
    if ('priority' in updates) fields.priority = updates.priority as string | null
    if ('due_date' in updates) fields.due_date = updates.due_date as string | null
    if ('status_to' in updates) fields.status_to = updates.status_to as string | null
    if ('assignee_member_id' in updates) fields.assignee_member_id = updates.assignee_member_id as string | null
    if (editingAgent) fields.assignee_ai_member_id = (body.assignee_ai_member_id as string | null) || null
    if ('team_id' in updates) fields.team_id = updates.team_id as string | null

    const result = await updateAppliedEntity(
      supabase,
      existing.entity_type,
      existing.result_entity_id,
      workspaceId,
      fields,
      // Attributes the status-change emit when this edit moves the status.
      user.id,
    )
    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }

    // Mirror the edit onto the proposal row too, so the card reflects it without
    // a refetch (and so a later Undo re-stages the latest values).
    await supabase
      .from('proposed_change')
      .update(updates)
      .eq('id', changeId)
      .eq('workspace_id', workspaceId)

    const { data: refreshed } = await supabase
      .from('proposed_change')
      .select()
      .eq('id', changeId)
      .eq('workspace_id', workspaceId)
      .single()

    return NextResponse.json({ change: refreshed })
  }

  // ── Pending proposal: edit the staged change ─────────────────────
  const { data, error } = await supabase
    .from('proposed_change')
    .update(updates)
    .eq('id', changeId)
    .eq('workspace_id', workspaceId)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ change: data })
}
