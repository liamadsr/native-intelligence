import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * GET /api/account/captures/[id]/actions
 * Returns all actions extracted from a specific capture.
 * Ordered: confirmed first, then suggested, then dismissed. Within each group by ai_confidence desc.
 */
export async function GET(
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

  const { data, error } = await supabase
    .from('actions')
    .select(`
      id, identifier, title, description, confirmation, ai_confidence, context_data, auto_accepted,
      priority, due_at, all_day, status_id, assignee_id, project_id,
      workflow_state:workflow_state!status_id(id, name, category, color),
      assignee:member!assignee_id(id, display_name, avatar_url)
    `)
    .eq('source_capture_id', id)
    .eq('workspace_id', workspaceId)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Sort: confirmed > suggested > dismissed, then by confidence desc
  const confirmationOrder: Record<string, number> = { confirmed: 0, suggested: 1, dismissed: 2 }

  const actions = (data || [])
    .sort((a, b) => {
      const aOrder = confirmationOrder[a.confirmation || 'suggested'] ?? 1
      const bOrder = confirmationOrder[b.confirmation || 'suggested'] ?? 1
      if (aOrder !== bOrder) return aOrder - bOrder
      return (b.ai_confidence || 0) - (a.ai_confidence || 0)
    })
    .map((a) => {
      const ws = a.workflow_state as unknown as { id: string; name: string; category: string; color: string } | null
      const assignee = a.assignee as unknown as { id: string; display_name: string; avatar_url: string | null } | null
      return {
        id: a.id,
        identifier: a.identifier,
        title: a.title,
        description: a.description,
        confirmation: a.confirmation,
        ai_confidence: a.ai_confidence,
        auto_accepted: a.auto_accepted,
        context_data: a.context_data,
        priority: a.priority,
        due_at: a.due_at,
        all_day: a.all_day,
        status_id: a.status_id,
        status_name: ws?.name || '',
        status_category: ws?.category || '',
        status_color: ws?.color || '#6b7280',
        assignee_id: a.assignee_id,
        assignee_name: assignee?.display_name || null,
        assignee_avatar: assignee?.avatar_url || null,
        project_id: a.project_id,
      }
    })

  return NextResponse.json({ actions, count: actions.length })
}
