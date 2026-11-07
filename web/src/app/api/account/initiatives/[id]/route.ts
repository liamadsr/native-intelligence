import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { forbidden, notFound } from '@/lib/api-errors'
import { inngest } from '@/lib/inngest/client'
import { NextResponse, type NextRequest } from 'next/server'

type ServerClient = Awaited<ReturnType<typeof createClient>>

// PostgREST caps a response at 1000 rows (silently), so the action rollup is
// paged with .range() until a short page.
const PAGE_SIZE = 1000

async function readAllPages<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1)
    if (error) return { data: rows, error }
    rows.push(...(data ?? []))
    if ((data ?? []).length < PAGE_SIZE) return { data: rows, error: null }
  }
}

/**
 * Dedupe `rawIds` and check every one is a label of this workspace (the
 * junction's RLS only checks the initiative). Runs before any write, so a bad
 * id never leaves a half-applied PATCH.
 */
async function validateLabelIds(
  supabase: ServerClient,
  workspaceId: string,
  rawIds: unknown[],
): Promise<{ labelIds: string[] } | { error: NextResponse }> {
  const labelIds = [...new Set(rawIds.filter((v): v is string => typeof v === 'string'))]
  if (labelIds.length > 0) {
    const { data: valid, error } = await supabase
      .from('label')
      .select('id')
      .eq('workspace_id', workspaceId)
      .in('id', labelIds)
    if (error) return { error: NextResponse.json({ error: error.message }, { status: 500 }) }
    if ((valid ?? []).length !== labelIds.length) {
      return { error: NextResponse.json({ error: 'Invalid label_ids' }, { status: 400 }) }
    }
  }
  return { labelIds }
}

/**
 * Replace an initiative's labels with `labelIds` (already validated, full
 * replacement). New rows go in before old ones come out, so a failed write
 * never leaves the initiative label-less. Returns an error response, or null.
 */
async function replaceInitiativeLabels(
  supabase: ServerClient,
  initiativeId: string,
  labelIds: string[],
): Promise<NextResponse | null> {
  const { data: current, error: readError } = await supabase
    .from('initiative_label')
    .select('label_id')
    .eq('initiative_id', initiativeId)
  if (readError) return NextResponse.json({ error: readError.message }, { status: 500 })

  const have = new Set((current ?? []).map((r) => r.label_id as string))
  const keep = new Set(labelIds)
  const toAdd = labelIds.filter((lid) => !have.has(lid))
  const toRemove = [...have].filter((lid) => !keep.has(lid))

  if (toAdd.length > 0) {
    const { error } = await supabase
      .from('initiative_label')
      .insert(toAdd.map((lid) => ({ initiative_id: initiativeId, label_id: lid })))
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (toRemove.length > 0) {
    const { error } = await supabase
      .from('initiative_label')
      .delete()
      .eq('initiative_id', initiativeId)
      .in('label_id', toRemove)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return null
}

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
    .from('initiative')
    .select(`
      id, name, description, status, target_date, color, icon, sort_order, created_at, updated_at,
      owner:member!owner_id(id, display_name, avatar_url)
    `)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Parallel: child projects, labels, action stats
  const [projectsResult, labelsResult] = await Promise.all([
    supabase
      .from('projects')
      .select('id, name, status, priority, health, target_date, lead:member!lead_id(id, display_name, avatar_url)')
      .eq('initiative_id', id)
      .eq('workspace_id', workspaceId)
      .order('sort_order', { ascending: true }),

    supabase
      .from('initiative_label')
      .select('label:label!label_id(id, name, color)')
      .eq('initiative_id', id),
  ])

  const projects = projectsResult.data || []
  const projectIds = projects.map((p) => p.id)

  // Get action stats for all child projects
  let actionStats = { total: 0, completed: 0, canceled: 0 }
  const projectActionStats: Record<string, { total: number; completed: number; canceled: number }> = {}

  if (projectIds.length > 0) {
    const { data: actions } = await readAllPages((from, to) =>
      supabase
        .from('actions')
        .select('id, project_id, workflow_state:workflow_state!status_id(category)')
        .in('project_id', projectIds)
        .order('id')
        .range(from, to),
    )

    if (actions) {
      for (const a of actions) {
        const pid = a.project_id as string
        if (!projectActionStats[pid]) projectActionStats[pid] = { total: 0, completed: 0, canceled: 0 }
        projectActionStats[pid].total++
        actionStats.total++
        const ws = a.workflow_state as unknown as { category: string } | null
        if (ws?.category === 'completed') {
          projectActionStats[pid].completed++
          actionStats.completed++
        }
        if (ws?.category === 'canceled') {
          projectActionStats[pid].canceled++
          actionStats.canceled++
        }
      }
    }
  }

  const denominator = actionStats.total - actionStats.canceled
  const percentage = denominator > 0 ? Math.round((actionStats.completed / denominator) * 100) : 0

  // Build enriched projects list
  const enrichedProjects = projects.map((p) => {
    const leadData = p.lead as unknown as { id: string; display_name: string; avatar_url: string | null } | null
    const pStats = projectActionStats[p.id] || { total: 0, completed: 0, canceled: 0 }
    const pDenom = pStats.total - pStats.canceled
    const pPct = pDenom > 0 ? Math.round((pStats.completed / pDenom) * 100) : 0

    return {
      id: p.id,
      name: p.name,
      status: p.status,
      priority: (p as Record<string, unknown>).priority || 'none',
      health: (p as Record<string, unknown>).health || 'not_started',
      target_date: p.target_date,
      lead: leadData ? {
        id: leadData.id,
        display_name: leadData.display_name,
        avatar_url: leadData.avatar_url,
      } : null,
      progress: {
        total_actions: pStats.total,
        completed_actions: pStats.completed,
        canceled_actions: pStats.canceled,
        percentage: pPct,
      },
    }
  })

  // Labels
  const labels = (labelsResult.data || [])
    .map((row) => row.label as unknown as { id: string; name: string; color: string } | null)
    .filter(Boolean)

  // Project status breakdown
  const projectsByStatus: Record<string, number> = { planned: 0, active: 0, paused: 0, completed: 0, canceled: 0 }
  for (const p of projects) {
    projectsByStatus[p.status as string] = (projectsByStatus[p.status as string] || 0) + 1
  }

  const ownerData = data.owner as unknown as { id: string; display_name: string; avatar_url: string | null } | null

  // Compute health
  const status = data.status as string
  let health: string
  if (status === 'completed') {
    health = 'completed'
  } else if (actionStats.total === 0 && projects.length === 0) {
    health = 'not_started'
  } else {
    // target_date is a `date`: overdue only once its day has passed.
    const overdue = data.target_date && data.target_date < new Date().toISOString().slice(0, 10)
    const lowProgress = percentage < 25
    const hasActive = projectsByStatus.active > 0
    if (overdue && status !== 'completed') {
      health = 'behind'
    } else if (overdue || (lowProgress && hasActive)) {
      health = 'at_risk'
    } else {
      health = 'on_track'
    }
  }

  return NextResponse.json({
    initiative: {
      id: data.id,
      name: data.name,
      description: data.description,
      status: data.status,
      target_date: data.target_date,
      color: data.color,
      icon: data.icon,
      sort_order: data.sort_order,
      created_at: data.created_at,
      updated_at: data.updated_at,

      owner: ownerData ? {
        id: ownerData.id,
        display_name: ownerData.display_name,
        avatar_url: ownerData.avatar_url,
      } : null,

      projects_list: enrichedProjects,

      projects: {
        total: projects.length,
        by_status: projectsByStatus,
      },

      progress: {
        total_actions: actionStats.total,
        completed_actions: actionStats.completed,
        canceled_actions: actionStats.canceled,
        percentage,
      },

      labels,
      health,

      // Backward compat
      owner_id: ownerData?.id || null,
      owner_name: ownerData?.display_name || null,
      owner_avatar: ownerData?.avatar_url || null,
      project_count: projects.length,
      completed_project_count: projectsByStatus.completed || 0,
    },
  })
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
  const body = await request.json()

  // Validate labels before any write, so a bad id never half-applies a PATCH.
  let labelIds: string[] | null = null
  if (Array.isArray(body.label_ids)) {
    const checked = await validateLabelIds(supabase, workspaceId, body.label_ids)
    if ('error' in checked) return checked.error
    labelIds = checked.labelIds
  }

  // Fetch previous status if a status change is part of this update —
  // needed to emit `flow/entity.status_changed` only on actual transitions.
  let previousStatus: string | null = null
  if (body.status !== undefined) {
    const { data: prev } = await supabase
      .from('initiative')
      .select('status')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    previousStatus = (prev?.status as string | null) ?? null
  }

  const updates: Record<string, unknown> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.description !== undefined) updates.description = body.description
  if (body.owner_id !== undefined) updates.owner_id = body.owner_id || null
  if (body.status !== undefined) updates.status = body.status
  if (body.target_date !== undefined) updates.target_date = body.target_date
  if (body.color !== undefined) updates.color = body.color
  if (body.icon !== undefined) updates.icon = body.icon
  if (body.sort_order !== undefined) updates.sort_order = body.sort_order

  if (Object.keys(updates).length > 0) {
    const { data, error } = await supabase
      .from('initiative')
      .update(updates)
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .select('id, name, description, status, target_date, color, icon, sort_order, created_at, updated_at')
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Update labels if provided (full replacement). A write error is
    // returned after the status-change emit below: the fields are saved.
    const labelError = labelIds ? await replaceInitiativeLabels(supabase, id, labelIds) : null

    // Fire any Flows tied to this entity status transition. team_id is
    // null for initiative events — initiatives are workspace-scoped.
    if (body.status !== undefined && body.status !== previousStatus) {
      inngest
        .send({
          name: 'flow/entity.status_changed',
          data: {
            entity_type: 'initiative',
            entity_id: id,
            workspace_id: workspaceId,
            team_id: null,
            from_status_id: previousStatus,
            to_status_id: body.status,
            actor_user_id: user.id,
            fired_at: new Date().toISOString(),
          },
        })
        .catch((err) => {
          console.error('[flows] inngest.send failed', err)
        })
    }

    if (labelError) return labelError
    return NextResponse.json({ initiative: data })
  }

  // Labels-only update (no field changes)
  if (labelIds) {
    const { data: initiative } = await supabase
      .from('initiative')
      .select('id')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (!initiative) {
      return NextResponse.json({ error: 'Initiative not found' }, { status: 404 })
    }
    const labelError = await replaceInitiativeLabels(supabase, id, labelIds)
    if (labelError) return labelError
    return NextResponse.json({ success: true })
  }

  return NextResponse.json({ initiative: null })
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

  // count: 'exact' because the initiative delete RLS (owner/admin only, migration
  // 023) skips a refused row without an error, which read as success.
  const { error, count } = await supabase
    .from('initiative')
    .delete({ count: 'exact' })
    .eq('id', id)
    .eq('workspace_id', workspaceId)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!count) {
    const { data: visible } = await supabase
      .from('initiative')
      .select('id')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    return visible
      ? forbidden('Only a workspace owner or admin can delete an initiative')
      : notFound('Initiative not found')
  }

  return NextResponse.json({ success: true })
}
