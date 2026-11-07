import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { NextResponse, type NextRequest } from 'next/server'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { id: projectId } = await params

  // The workspace ownership check and the milestone list are independent —
  // fetch in parallel. A failed ownership check still decides the response
  // (the milestone rows are discarded, never returned).
  const [{ data: project }, { data: milestones, error }] = await Promise.all([
    supabase
      .from('projects')
      .select('id')
      .eq('id', projectId)
      .eq('workspace_id', workspaceId)
      .single(),
    supabase
      .from('milestone')
      .select('id, name, description, status, target_date, sort_order, created_at, updated_at')
      .eq('project_id', projectId)
      .order('sort_order', { ascending: true }),
  ])

  if (!project) {
    return notFound('Project not found')
  }

  if (error) {
    return serverError(error.message)
  }

  // Compute action progress per milestone. This used to select EVERY action
  // row (with its workflow_state join) just to count them client-side.
  //
  // Counting now happens in Postgres: two head-only `count: 'exact'` queries
  // PER MILESTONE. Per-milestone rather than one grouped pair because PostgREST
  // has no GROUP BY — a grouped pair has to ship one row per action to be
  // bucketed here, and each leg is then independently truncated at the max-rows
  // cap (1000 on hosted Supabase). Two independently-truncated row sets cannot
  // guarantee `completed <= total`, so a project with >1000 milestone-linked
  // actions could render "14/9 actions" at >100% progress. head:true ships ZERO
  // rows and returns an uncapped exact count, so the invariant is structural
  // again and the payload is smaller than the row scan it replaces.
  const milestoneIds = (milestones || []).map((m) => m.id as string)
  const actionStats: Record<string, { total: number; completed: number }> = {}

  // Milestone counts are unbounded (nothing caps how many a user creates), so
  // the fan-out is issued in bounded waves rather than all at once — a project
  // with 200 milestones would otherwise open 400 simultaneous connections.
  const COUNT_CONCURRENCY = 12

  for (let start = 0; start < milestoneIds.length; start += COUNT_CONCURRENCY) {
    const batch = milestoneIds.slice(start, start + COUNT_CONCURRENCY)
    const counts = await Promise.all(
      batch.map((mid) =>
        Promise.all([
          supabase
            .from('actions')
            .select('id', { count: 'exact', head: true })
            .eq('milestone_id', mid),
          // The inner join makes the embedded category filter restrict the
          // parent rows being counted.
          supabase
            .from('actions')
            .select('id, workflow_state:workflow_state!status_id!inner(category)', {
              count: 'exact',
              head: true,
            })
            .eq('milestone_id', mid)
            .eq('workflow_state.category', 'completed'),
        ]),
      ),
    )

    batch.forEach((mid, i) => {
      const [{ count: total }, { count: completed }] = counts[i]
      actionStats[mid] = { total: total || 0, completed: completed || 0 }
    })
  }

  const result = (milestones || []).map((m) => {
    const stats = actionStats[m.id] || { total: 0, completed: 0 }
    return {
      ...m,
      action_count: stats.total,
      completed_action_count: stats.completed,
    }
  })

  return NextResponse.json({ milestones: result })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { id: projectId } = await params

  // Verify project belongs to workspace
  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('workspace_id', workspaceId)
    .single()

  if (!project) {
    return notFound('Project not found')
  }

  const body = await request.json()
  const { name, description, status, target_date } = body as {
    name?: string
    description?: string
    status?: string
    target_date?: string
  }

  if (!name?.trim()) {
    return badRequest('Name is required')
  }

  const { data, error } = await supabase
    .from('milestone')
    .insert({
      project_id: projectId,
      name: name.trim(),
      description: description || null,
      status: status || 'pending',
      target_date: target_date || null,
    })
    .select('id, name, description, status, target_date, sort_order, created_at')
    .single()

  if (error) {
    return serverError(error.message)
  }

  return NextResponse.json({ milestone: { ...data, action_count: 0, completed_action_count: 0 } })
}
