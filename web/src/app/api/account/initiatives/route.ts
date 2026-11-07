import { requireWorkspace } from '@/lib/api-auth'
import { toIlikeSearchTerm } from '@/lib/crm/ilike-search-term'
import { NextResponse, type NextRequest } from 'next/server'

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

// ============================================================
// GET /api/account/initiatives
// ============================================================
// Query params:
//   ?status=active,planned         (comma-separated)
//   ?owner_id=uuid
//   ?label_ids=uuid,uuid
//   ?search=keyword
//   ?sort=name|status|target_date|created_at|progress|project_count
//   ?order=asc|desc
//   ?group_by=status|owner|none
//   ?include_archived=true
//   ?has_overdue_projects=true

export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { searchParams } = request.nextUrl
  const statusFilter = searchParams.get('status')
  const ownerId = searchParams.get('owner_id')
  const labelIds = searchParams.get('label_ids')
  const search = searchParams.get('search')
  const sortField = searchParams.get('sort') || 'sort_order'
  const sortOrder = searchParams.get('order') || 'asc'
  const groupBy = searchParams.get('group_by') || 'none'
  const includeArchived = searchParams.get('include_archived') === 'true'
  const hasOverdueProjects = searchParams.get('has_overdue_projects') === 'true'

  // ── Main query ─────────────────────────────────────────────
  let query = supabase
    .from('initiative')
    .select(`
      id, name, description, status, target_date, color, icon, sort_order, created_at, updated_at,
      owner:member!owner_id(id, display_name, avatar_url)
    `)
    .eq('workspace_id', workspaceId)

  if (!includeArchived) {
    query = query.neq('status', 'archived')
  }

  // Multi-status filter
  if (statusFilter) {
    const statuses = statusFilter.split(',').map((s) => s.trim()).filter(Boolean)
    if (statuses.length === 1) {
      query = query.eq('status', statuses[0])
    } else if (statuses.length > 1) {
      query = query.in('status', statuses)
    }
  }

  // Owner filter
  if (ownerId) {
    if (ownerId === '__none__') {
      query = query.is('owner_id', null)
    } else {
      query = query.eq('owner_id', ownerId)
    }
  }

  // Search by name + description (stripped of the chars .or() parses)
  const term = search ? toIlikeSearchTerm(search) : ''
  if (term) {
    query = query.or(`name.ilike.%${term}%,description.ilike.%${term}%`)
  }

  // Basic sort
  const ascending = sortOrder === 'asc'
  if (sortField === 'name') {
    query = query.order('name', { ascending })
  } else if (sortField === 'status') {
    query = query.order('status', { ascending })
  } else if (sortField === 'target_date') {
    query = query.order('target_date', { ascending, nullsFirst: !ascending })
  } else if (sortField === 'created_at') {
    query = query.order('created_at', { ascending })
  } else {
    // default: sort_order then created_at
    query = query.order('sort_order', { ascending: true })
    query = query.order('created_at', { ascending: false })
  }

  const { data, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const initiativeIds = (data || []).map((i) => i.id)

  if (initiativeIds.length === 0) {
    return NextResponse.json(groupBy !== 'none' ? { groups: [], total: 0 } : { initiatives: [], total: 0 })
  }

  // ── Parallel enrichment queries ────────────────────────────
  const [
    projectStatsResult,
    actionStatsResult,
    labelsResult,
  ] = await Promise.all([
    // 1. Project stats per initiative
    supabase
      .from('projects')
      .select('id, initiative_id, status, target_date')
      .in('initiative_id', initiativeIds),

    // 2. Action stats (via projects) — all actions for projects under these
    // initiatives, filtered through an inner join on the project's
    // initiative_id so this runs in the same parallel batch (previously a
    // placeholder query here plus a second sequential fetch after it).
    readAllPages((from, to) =>
      supabase
        .from('actions')
        .select('id, project_id, workflow_state:workflow_state!status_id(category), project:projects!project_id!inner(initiative_id)')
        .in('project.initiative_id', initiativeIds)
        .order('id')
        .range(from, to),
    ),

    // 3. Labels per initiative
    supabase
      .from('initiative_label')
      .select('initiative_id, label:label!label_id(id, name, color)')
      .in('initiative_id', initiativeIds),
  ])

  // target_date is a `date`: compare day strings, so a date is overdue only
  // once its day has passed (not from 00:00 UTC on the day itself).
  const today = new Date().toISOString().slice(0, 10)

  // ── Process project stats ──────────────────────────────────
  const projectsByInitiative: Record<string, {
    total: number
    by_status: Record<string, number>
    project_ids: string[]
    has_overdue: boolean
  }> = {}

  if (projectStatsResult.data) {
    for (const p of projectStatsResult.data) {
      const iid = p.initiative_id as string
      if (!iid) continue
      if (!projectsByInitiative[iid]) {
        projectsByInitiative[iid] = {
          total: 0,
          by_status: { planned: 0, active: 0, paused: 0, completed: 0, canceled: 0 },
          project_ids: [],
          has_overdue: false,
        }
      }
      projectsByInitiative[iid].total++
      projectsByInitiative[iid].by_status[p.status as string] = (projectsByInitiative[iid].by_status[p.status as string] || 0) + 1
      projectsByInitiative[iid].project_ids.push(p.id)
      if (p.target_date && p.target_date < today && p.status !== 'completed' && p.status !== 'canceled') {
        projectsByInitiative[iid].has_overdue = true
      }
    }
  }

  // ── Build action rollup per initiative ─────────────────────
  const actionRollup: Record<string, { total: number; completed: number; canceled: number }> = {}

  for (const a of actionStatsResult.data || []) {
    const iid = (a.project as unknown as { initiative_id: string | null } | null)?.initiative_id
    if (!iid) continue
    if (!actionRollup[iid]) actionRollup[iid] = { total: 0, completed: 0, canceled: 0 }
    actionRollup[iid].total++
    const ws = a.workflow_state as unknown as { category: string } | null
    if (ws?.category === 'completed') actionRollup[iid].completed++
    if (ws?.category === 'canceled') actionRollup[iid].canceled++
  }

  // ── Process labels ─────────────────────────────────────────
  const labelsMap: Record<string, { id: string; name: string; color: string }[]> = {}
  if (labelsResult.data) {
    for (const row of labelsResult.data) {
      const iid = row.initiative_id as string
      const label = row.label as unknown as { id: string; name: string; color: string } | null
      if (label) {
        if (!labelsMap[iid]) labelsMap[iid] = []
        labelsMap[iid].push(label)
      }
    }
  }

  // ── Filter by label_ids (post-query since it's a join table) ──
  let filteredData = data || []
  if (labelIds) {
    const ids = labelIds.split(',').map((s) => s.trim()).filter(Boolean)
    if (ids.length > 0) {
      filteredData = filteredData.filter((i) => {
        const iLabels = labelsMap[i.id] || []
        return ids.some((lid) => iLabels.some((l) => l.id === lid))
      })
    }
  }

  // ── Filter by has_overdue_projects ──────────────────────────
  if (hasOverdueProjects) {
    filteredData = filteredData.filter((i) => projectsByInitiative[i.id]?.has_overdue)
  }

  // ── Build enriched initiative list ─────────────────────────
  let initiatives = filteredData.map((i) => {
    const ownerData = i.owner as unknown as { id: string; display_name: string; avatar_url: string | null } | null
    const projStats = projectsByInitiative[i.id] || { total: 0, by_status: { planned: 0, active: 0, paused: 0, completed: 0, canceled: 0 }, project_ids: [], has_overdue: false }
    const actStats = actionRollup[i.id] || { total: 0, completed: 0, canceled: 0 }
    const denominator = actStats.total - actStats.canceled
    const percentage = denominator > 0 ? Math.round((actStats.completed / denominator) * 100) : 0

    // Compute health
    const status = i.status as string
    let health: string
    if (status === 'completed') {
      health = 'completed'
    } else if (actStats.total === 0 && projStats.total === 0) {
      health = 'not_started'
    } else {
      const overdue = i.target_date && i.target_date < today
      const lowProgress = percentage < 25
      const hasActive = projStats.by_status.active > 0

      if (overdue && status !== 'completed') {
        health = 'behind'
      } else if (overdue || (lowProgress && hasActive)) {
        health = 'at_risk'
      } else {
        health = 'on_track'
      }
    }

    return {
      id: i.id,
      name: i.name,
      description: i.description,
      status: i.status,
      target_date: i.target_date,
      color: i.color,
      icon: i.icon,
      sort_order: i.sort_order,
      created_at: i.created_at,
      updated_at: i.updated_at,

      owner: ownerData ? {
        id: ownerData.id,
        display_name: ownerData.display_name,
        avatar_url: ownerData.avatar_url,
      } : null,

      projects: {
        total: projStats.total,
        by_status: projStats.by_status,
      },

      progress: {
        total_actions: actStats.total,
        completed_actions: actStats.completed,
        canceled_actions: actStats.canceled,
        percentage,
      },

      labels: labelsMap[i.id] || [],

      health,

      // Backward compat
      owner_id: ownerData?.id || null,
      owner_name: ownerData?.display_name || null,
      owner_avatar: ownerData?.avatar_url || null,
      project_count: projStats.total,
      completed_project_count: projStats.by_status.completed || 0,
    }
  })

  // ── Client-side sort for progress + project_count ──────────
  if (sortField === 'progress') {
    initiatives.sort((a, b) => {
      const diff = a.progress.percentage - b.progress.percentage
      return ascending ? diff : -diff
    })
  } else if (sortField === 'project_count') {
    initiatives.sort((a, b) => {
      const diff = a.projects.total - b.projects.total
      return ascending ? diff : -diff
    })
  }

  // ── Health filter (client-side since it's computed) ─────────
  const healthFilter = searchParams.get('health')
  if (healthFilter) {
    const healthValues = healthFilter.split(',').map((s) => s.trim()).filter(Boolean)
    if (healthValues.length > 0) {
      initiatives = initiatives.filter((i) => healthValues.includes(i.health))
    }
  }

  // ── Grouping ───────────────────────────────────────────────
  if (groupBy !== 'none') {
    const groups = buildGroups(initiatives, groupBy)
    return NextResponse.json({ groups, total: initiatives.length })
  }

  return NextResponse.json({ initiatives, total: initiatives.length })
}

// ── Grouping helper ──────────────────────────────────────────
function buildGroups(
  initiatives: Record<string, unknown>[],
  groupBy: string,
) {
  type Initiative = (typeof initiatives)[number]
  const grouped = new Map<string, { label: string; initiatives: Initiative[] }>()

  const STATUS_ORDER = ['planned', 'active', 'completed', 'archived']
  const STATUS_LABELS: Record<string, string> = {
    planned: 'Planned',
    active: 'Active',
    completed: 'Completed',
    archived: 'Archived',
  }

  for (const i of initiatives) {
    let key: string
    let label: string

    if (groupBy === 'status') {
      key = i.status as string
      label = STATUS_LABELS[key] || key
    } else if (groupBy === 'owner') {
      const owner = i.owner as { id: string; display_name: string } | null
      key = owner?.id || '__none__'
      label = owner?.display_name || 'No Owner'
    } else {
      key = 'all'
      label = 'All Initiatives'
    }

    if (!grouped.has(key)) {
      grouped.set(key, { label, initiatives: [] })
    }
    grouped.get(key)!.initiatives.push(i)
  }

  let groupArray = Array.from(grouped.entries()).map(([key, val]) => ({
    key,
    label: val.label,
    initiatives: val.initiatives,
  }))

  if (groupBy === 'status') {
    groupArray.sort((a, b) => STATUS_ORDER.indexOf(a.key) - STATUS_ORDER.indexOf(b.key))
  } else {
    groupArray.sort((a, b) => {
      if (a.key === '__none__') return 1
      if (b.key === '__none__') return -1
      return a.label.localeCompare(b.label)
    })
  }

  return groupArray
}

// ============================================================
// POST /api/account/initiatives
// ============================================================

export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const body = await request.json()
  const { name, description, owner_id, status, target_date, color, icon } = body as {
    name?: string
    description?: string
    owner_id?: string
    status?: string
    target_date?: string
    color?: string
    icon?: string
  }

  if (!name?.trim()) {
    return NextResponse.json({ error: 'Name is required' }, { status: 400 })
  }

  const insertData: Record<string, unknown> = {
    workspace_id: workspaceId,
    name: name.trim(),
  }
  if (description !== undefined) insertData.description = description
  if (owner_id) insertData.owner_id = owner_id
  if (status) insertData.status = status
  if (target_date) insertData.target_date = target_date
  if (color) insertData.color = color
  if (icon) insertData.icon = icon

  const { data, error } = await supabase
    .from('initiative')
    .insert(insertData)
    .select('id, name, description, status, target_date, color, icon, sort_order, created_at')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // If label_ids provided, insert them
  if (Array.isArray(body.label_ids) && body.label_ids.length > 0) {
    const labelRows = body.label_ids.map((lid: string) => ({
      initiative_id: data.id,
      label_id: lid,
    }))
    await supabase.from('initiative_label').insert(labelRows)
  }

  return NextResponse.json({
    initiative: {
      ...data,
      owner: null,
      projects: { total: 0, by_status: { planned: 0, active: 0, paused: 0, completed: 0, canceled: 0 } },
      progress: { total_actions: 0, completed_actions: 0, canceled_actions: 0, percentage: 0 },
      labels: [],
      health: 'not_started',
      // Backward compat
      project_count: 0,
      completed_project_count: 0,
    },
  })
}
