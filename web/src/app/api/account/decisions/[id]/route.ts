import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { createNotification, getMemberByUserId } from '@/lib/notifications'
import { getServiceClient } from '@/lib/admin'
import { NextResponse, type NextRequest } from 'next/server'

/** Verify a decision belongs to a capture owned by this user/workspace */
async function verifyDecisionOwnership(
  supabase: Awaited<ReturnType<typeof createClient>>,
  decisionId: string,
  userId: string,
  workspaceId: string,
): Promise<{ captureId: string } | null> {
  const { data: decision } = await supabase
    .from('decision')
    .select('id, capture_id')
    .eq('id', decisionId)
    .single()
  if (!decision) return null

  const { data: capture } = await supabase
    .from('captures')
    .select('id')
    .eq('id', decision.capture_id)
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .single()
  return capture ? { captureId: decision.capture_id } : null
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) {
    return NextResponse.json({ error: 'No workspace' }, { status: 400 })
  }

  const { id } = await params

  if (!(await verifyDecisionOwnership(supabase, id, user.id, workspaceId))) {
    return NextResponse.json({ error: 'Decision not found' }, { status: 404 })
  }

  const body = await request.json()

  const updates: Record<string, unknown> = {}
  if (body.content !== undefined) updates.content = body.content
  if (body.confirmation !== undefined) updates.confirmation = body.confirmation
  if (body.project_id !== undefined) updates.project_id = body.project_id || null
  if (body.decided_by !== undefined) updates.decided_by = body.decided_by || null

  const { data, error } = await supabase
    .from('decision')
    .update(updates)
    .eq('id', id)
    .select('id, capture_id, content, source_timestamp, project_id, confirmation, created_at')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Promote the matching decision_summary claim in lockstep. Match by capture
  // (via entity_link) + exact text so we promote *this* decision's mirror,
  // not every claim from the capture.
  if (body.confirmation === 'confirmed' && data.capture_id) {
    const { data: candidateLinks } = await supabase
      .from('entity_link')
      .select('source_id')
      .eq('workspace_id', workspaceId)
      .eq('source_type', 'claim')
      .eq('target_type', 'capture')
      .eq('target_id', data.capture_id)
      .eq('relation', 'cites')

    if (candidateLinks && candidateLinks.length > 0) {
      await supabase
        .from('claim')
        .update({ confirmation: 'confirmed', last_verified_at: new Date().toISOString() })
        .in('id', candidateLinks.map((l) => l.source_id as string))
        .eq('workspace_id', workspaceId)
        .eq('type', 'decision_summary')
        .eq('text', data.content)
        .eq('confirmation', 'suggested')
    }
  }

  // Notify when a decision is confirmed (non-blocking)
  if (body.confirmation === 'confirmed' && data.capture_id) {
    const service = getServiceClient()
    const actorMember = await getMemberByUserId(workspaceId, user.id)
    const actorName = actorMember?.display_name || 'Someone'
    const contentPreview = data.content.substring(0, 80)

    // Get capture participants who are workspace members
    const { data: capture } = await service
      .from('captures')
      .select('user_id, participants')
      .eq('id', data.capture_id)
      .single()

    if (capture) {
      const recipientIds = new Set<string>()
      // Capture creator
      if (capture.user_id) {
        const creatorMember = await getMemberByUserId(workspaceId, capture.user_id)
        if (creatorMember) recipientIds.add(creatorMember.id)
      }

      for (const recipientId of recipientIds) {
        createNotification({
          workspaceId,
          recipientId,
          type: 'decision_confirmed',
          title: `Decision confirmed: "${contentPreview}"`,
          body: data.content,
          actorId: actorMember?.id,
          targetType: 'decision',
          targetId: data.id,
          contextType: 'capture',
          contextId: data.capture_id,
        })
      }
    }
  }

  return NextResponse.json({ decision: data })
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) {
    return NextResponse.json({ error: 'No workspace' }, { status: 400 })
  }

  const { id } = await params

  const owned = await verifyDecisionOwnership(supabase, id, user.id, workspaceId)
  if (!owned) {
    return NextResponse.json({ error: 'Decision not found' }, { status: 404 })
  }

  // Scope the delete by the verified capture, not just the id, so it can never
  // touch a decision whose capture failed the ownership check.
  const { error } = await supabase
    .from('decision')
    .delete()
    .eq('id', id)
    .eq('capture_id', owned.captureId)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
