import { requireWorkspace } from '@/lib/api-auth'
import { toIlikeSearchTerm } from '@/lib/crm/ilike-search-term'
import { trackServerEvent } from '@/lib/posthog'
import { NextResponse, type NextRequest } from 'next/server'

// PostgREST caps a response at 1000 rows (silently), so the per-project
// action and capture reads are paged with .range() until a short page.
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
// GET /api/account/projects
// ============================================================
// Query params:
//   ?status=active,planned         (comma-separated)
//   ?initiative_id=uuid
//   ?lead_id=uuid
//   ?label_ids=uuid,uuid
//   ?team_id=uuid                  (inferred from actions)
//   ?search=keyword
//   ?sort=name|status|target_date|created_at|progress|updated_at
//   ?order=asc|desc
//   ?group_by=initiative|status|team|none
//   ?include_archived=true

export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { searchParams } = request.nextUrl
  const statusFilter = searchParams.get('status')
  const initiativeId = searchParams.get('initiative_id')
  const leadId = searchParams.get('lead_id')
  const labelIds = searchParams.get('label_ids')
  const teamId = searchParams.get('team_id')
  const search = searchParams.get('search')
  const sortField = searchParams.get('sort') || 'created_at'
  const sortOrder = searchParams.get('order') || 'desc'
  const groupBy = searchParams.get('group_by') || 'none'
  const includeArchived = searchParams.get('include_archived') === 'true'

  // ── Main query ─────────────────────────────────────────────
  let query = supabase
    .from('projects')
    .select(`
      id, name, description, icon, color, is_pinned, is_archived, sort_order, created_at, updated_at, github_repo,
      initiative_id, status, start_date, target_date,
      lead:member!lead_id(id, display_name, avatar_url),
      initiative:initiative!initiative_id(id, name, color, icon)
    `)
    .eq('workspace_id', workspaceId)
    .neq('name', '__default__')

  if (!includeArchived) {
    query = query.eq('is_archived', false)
  }

  // Multi-status filter (comma-separated)
  if (statusFilter) {
    const statuses = statusFilter.split(',').map((s) => s.trim()).filter(Boolean)
    if (statuses.length === 1) {
      query = query.eq('status', statuses[0])
    } else if (statuses.length > 1) {
      query = query.in('status', statuses)
    }
  }

  if (initiativeId) {
    if (initiativeId === '__none__') {
      query = query.is('initiative_id', null)
    } else {
      query = query.eq('initiative_id', initiativeId)
    }
  }

  if (leadId) {
    if (leadId === '__none__') {
      query = query.is('lead_id', null)
    } else {
      query = query.eq('lead_id', leadId)
    }
  }

  // Search by name + description (stripped of the chars .or() parses)
  const term = search ? toIlikeSearchTerm(search) : ''
  if (term) {
    query = query.or(`name.ilike.%${term}%,description.ilike.%${term}%`)
  }

  // Basic sort (progress sort is done client-side after enrichment)
  const ascending = sortOrder === 'asc'
  if (sortField === 'name') {
    query = query.order('name', { ascending })
  } else if (sortField === 'status') {
    query = query.order('status', { ascending })
  } else if (sortField === 'target_date') {
    query = query.order('target_date', { ascending, nullsFirst: !ascending })
  } else if (sortField === 'updated_at') {
    query = query.order('updated_at', { ascending })
  } else {
    // default: created_at
    query = query.order('created_at', { ascending })
  }

  // Secondary sort: pinned first, then by name
  query = query.order('is_pinned', { ascending: false })

  const { data, error } = await query

  if (error) {
    console.error('[GET /api/account/projects] main query error:', error.message, error.details, error.hint)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const projectIds = (data || []).map((p) => p.id)

  // Minimal mode — pickers (action/capture detail panels) only need the base
  // rows, so skip the five enrichment queries below entirely.
  if (searchParams.get('minimal') === '1') {
    return NextResponse.json({ projects: data || [], total: projectIds.length })
  }

  if (projectIds.length === 0) {
    return NextResponse.json(groupBy !== 'none' ? { groups: [], total: 0 } : { projects: [], total: 0 })
  }

  // ── Parallel enrichment queries ────────────────────────────
  const [
    actionStatsResult,
    milestonesResult,
    labelsResult,
    noteCountsResult,
    teamInferResult,
  ] = await Promise.all([
    // 1. Action progress per project (with canceled count)
    readAllPages((from, to) =>
      supabase
        .from('actions')
        .select('id, project_id, team_id, workflow_state:workflow_state!status_id(category)')
        .in('project_id', projectIds)
        .order('id')
        .range(from, to),
    ),

    // 2. Milestones per project
    supabase
      .from('milestone')
      .select('id, project_id, name, status, target_date, sort_order')
      .in('project_id', projectIds)
      .order('sort_order', { ascending: true }),

    // 3. Labels per project
    supabase
      .from('project_label')
      .select('project_id, label:label!label_id(id, name, color)')
      .in('project_id', projectIds),

    // 4. Capture counts (workspace-shared — count all teammates' captures)
    readAllPages((from, to) =>
      supabase
        .from('captures')
        .select('id, project_id')
        .eq('workspace_id', workspaceId)
        .in('project_id', projectIds)
        .neq('status', 'archived')
        .order('id')
        .range(from, to),
    ),

    // 5. Teams (for inferred team from actions)
    supabase
      .from('team')
      .select('id, name, icon')
      .eq('workspace_id', workspaceId),
  ])

  // ── Process action stats ───────────────────────────────────
  const actionStats: Record<string, { total: number; completed: number; canceled: number }> = {}
  // Also build team inference: most common team_id per project
  const projectTeamCounts: Record<string, Record<string, number>> = {}

  if (actionStatsResult.data) {
    for (const a of actionStatsResult.data) {
      const pid = a.project_id as string
      if (!actionStats[pid]) actionStats[pid] = { total: 0, completed: 0, canceled: 0 }
      actionStats[pid].total++
      const ws = a.workflow_state as unknown as { category: string } | null
      if (ws?.category === 'completed') actionStats[pid].completed++
      if (ws?.category === 'canceled') actionStats[pid].canceled++

      // Team inference
      if (a.team_id) {
        if (!projectTeamCounts[pid]) projectTeamCounts[pid] = {}
        projectTeamCounts[pid][a.team_id] = (projectTeamCounts[pid][a.team_id] || 0) + 1
      }
    }
  }

  // Build team lookup
  const teamsById: Record<string, { id: string; name: string; icon: string | null }> = {}
  if (teamInferResult.data) {
    for (const t of teamInferResult.data) {
      teamsById[t.id] = t
    }
  }

  // Resolve inferred team per project (most common team_id from actions)
  const inferredTeam: Record<string, { id: string; name: string; icon: string | null } | null> = {}
  for (const pid of projectIds) {
    if (projectTeamCounts[pid]) {
      const counts = projectTeamCounts[pid]
      let maxTeamId = ''
      let maxCount = 0
      for (const [tid, count] of Object.entries(counts)) {
        if (count > maxCount) {
          maxCount = count
          maxTeamId = tid
        }
      }
      inferredTeam[pid] = maxTeamId && teamsById[maxTeamId] ? teamsById[maxTeamId] : null
    } else {
      inferredTeam[pid] = null
    }
  }

  // ── Process milestones ─────────────────────────────────────
  const milestonesMap: Record<string, {
    total: number
    completed: number
    next_milestone: { id: string; name: string; target_date: string | null; status: string } | null
  }> = {}

  if (milestonesResult.data) {
    for (const m of milestonesResult.data) {
      const pid = m.project_id as string
      if (!milestonesMap[pid]) milestonesMap[pid] = { total: 0, completed: 0, next_milestone: null }
      milestonesMap[pid].total++
      if (m.status === 'completed') milestonesMap[pid].completed++
      // First non-completed milestone by sort_order
      if (!milestonesMap[pid].next_milestone && m.status !== 'completed') {
        milestonesMap[pid].next_milestone = {
          id: m.id,
          name: m.name,
          target_date: m.target_date,
          status: m.status,
        }
      }
    }
  }

  // ── Process labels ─────────────────────────────────────────
  const labelsMap: Record<string, { id: string; name: string; color: string }[]> = {}
  if (labelsResult.data) {
    for (const row of labelsResult.data) {
      const pid = row.project_id as string
      const label = row.label as unknown as { id: string; name: string; color: string } | null
      if (label) {
        if (!labelsMap[pid]) labelsMap[pid] = []
        labelsMap[pid].push(label)
      }
    }
  }

  // ── Process note counts ────────────────────────────────────
  const noteCounts: Record<string, number> = {}
  if (noteCountsResult.data) {
    for (const row of noteCountsResult.data) {
      noteCounts[row.project_id] = (noteCounts[row.project_id] || 0) + 1
    }
  }

  // ── Filter by label_ids (post-query since it's a join table) ──
  let filteredData = data || []
  if (labelIds) {
    const ids = labelIds.split(',').map((s) => s.trim()).filter(Boolean)
    if (ids.length > 0) {
      filteredData = filteredData.filter((p) => {
        const pLabels = labelsMap[p.id] || []
        return ids.some((lid) => pLabels.some((l) => l.id === lid))
      })
    }
  }

  // ── Filter by team_id (inferred from actions) ──────────────
  if (teamId) {
    filteredData = filteredData.filter((p) => {
      const it = inferredTeam[p.id]
      if (teamId === '__none__') return !it
      return it?.id === teamId
    })
  }

  // ── Build enriched project list ────────────────────────────
  let projects = filteredData.map((p) => {
    const leadData = p.lead as unknown as { id: string; display_name: string; avatar_url: string | null } | null
    const initiativeData = p.initiative as unknown as { id: string; name: string; color: string | null; icon: string | null } | null
    const stats = actionStats[p.id] || { total: 0, completed: 0, canceled: 0 }
    const denominator = stats.total - stats.canceled
    const percentage = denominator > 0 ? Math.round((stats.completed / denominator) * 100) : 0

    return {
      id: p.id,
      name: p.name,
      description: p.description,
      icon: p.icon,
      color: p.color,
      status: p.status as string,
      is_pinned: p.is_pinned,
      is_archived: p.is_archived,
      start_date: p.start_date,
      target_date: p.target_date,
      created_at: p.created_at,
      updated_at: p.updated_at,
      sort_order: p.sort_order,

      lead: leadData ? {
        id: leadData.id,
        display_name: leadData.display_name,
        avatar_url: leadData.avatar_url,
      } : null,

      initiative: initiativeData ? {
        id: initiativeData.id,
        name: initiativeData.name,
        color: initiativeData.color,
        icon: initiativeData.icon,
      } : null,

      progress: {
        total_actions: stats.total,
        completed_actions: stats.completed,
        canceled_actions: stats.canceled,
        percentage,
      },

      milestones: milestonesMap[p.id] || { total: 0, completed: 0, next_milestone: null },

      labels: labelsMap[p.id] || [],

      inferred_team: inferredTeam[p.id] || null,

      note_count: noteCounts[p.id] || 0,

      // Backward compat fields (flat)
      initiative_id: p.initiative_id,
      lead_id: leadData?.id || null,
      lead_name: leadData?.display_name || null,
      lead_avatar: leadData?.avatar_url || null,
      action_count: stats.total,
      completed_action_count: stats.completed,
    }
  })

  // ── Client-side sort for progress ──────────────────────────
  if (sortField === 'progress') {
    projects.sort((a, b) => {
      const diff = a.progress.percentage - b.progress.percentage
      return ascending ? diff : -diff
    })
  }

  // ── Grouping ───────────────────────────────────────────────
  if (groupBy !== 'none') {
    const groups = buildGroups(projects, groupBy, teamsById)
    return NextResponse.json({ groups, total: projects.length })
  }

  return NextResponse.json({ projects, total: projects.length })
}

// ── Grouping helper ──────────────────────────────────────────
function buildGroups(
  projects: ReturnType<typeof Array.prototype.map>,
  groupBy: string,
  teamsById: Record<string, { id: string; name: string; icon: string | null }>,
) {
  type Project = (typeof projects)[number] & Record<string, unknown>
  const grouped = new Map<string, { label: string; icon?: string; color?: string; projects: Project[] }>()

  const STATUS_ORDER = ['planned', 'active', 'paused', 'completed', 'canceled']
  const STATUS_LABELS: Record<string, string> = {
    planned: 'Planned',
    active: 'Active',
    paused: 'Paused',
    completed: 'Completed',
    canceled: 'Canceled',
  }

  for (const p of projects as Project[]) {
    let key: string
    let label: string
    let icon: string | undefined
    let color: string | undefined

    if (groupBy === 'initiative') {
      const init = p.initiative as { id: string; name: string; color?: string | null; icon?: string | null } | null
      key = init?.id || '__none__'
      label = init?.name || 'No Initiative'
      icon = init?.icon ?? undefined
      color = init?.color ?? undefined
    } else if (groupBy === 'status') {
      key = p.status as string
      label = STATUS_LABELS[key] || key
    } else if (groupBy === 'team') {
      const team = p.inferred_team as { id: string; name: string; icon?: string | null } | null
      key = team?.id || '__none__'
      label = team?.name || 'No Team'
      icon = team?.icon ?? undefined
    } else {
      key = 'all'
      label = 'All Projects'
    }

    if (!grouped.has(key)) {
      grouped.set(key, { label, icon, color, projects: [] })
    }
    grouped.get(key)!.projects.push(p)
  }

  // Convert to array with stable ordering
  let groupArray = Array.from(grouped.entries()).map(([key, val]) => ({
    key,
    label: val.label,
    icon: val.icon,
    color: val.color,
    projects: val.projects,
  }))

  // Sort groups
  if (groupBy === 'status') {
    groupArray.sort((a, b) => STATUS_ORDER.indexOf(a.key) - STATUS_ORDER.indexOf(b.key))
  } else {
    // Put __none__ last, then alphabetical
    groupArray.sort((a, b) => {
      if (a.key === '__none__') return 1
      if (b.key === '__none__') return -1
      return a.label.localeCompare(b.label)
    })
  }

  return groupArray
}

// ============================================================
// POST /api/account/projects
// ============================================================

export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const body = await request.json()
  const name = (body.name || '').trim()

  if (!name) {
    return NextResponse.json({ error: 'Name is required' }, { status: 400 })
  }

  // Labels must be this workspace's (project_label RLS only checks the
  // project); dedupe so a repeated id can't fail the junction insert.
  const labelIds: string[] = Array.isArray(body.label_ids)
    ? [...new Set((body.label_ids as unknown[]).filter((v): v is string => typeof v === 'string'))]
    : []
  if (labelIds.length > 0) {
    const { data: validLabels } = await supabase
      .from('label')
      .select('id')
      .eq('workspace_id', workspaceId)
      .in('id', labelIds)
    if ((validLabels ?? []).length !== labelIds.length) {
      return NextResponse.json({ error: 'Invalid label_ids' }, { status: 400 })
    }
  }

  // Get max sort_order so new project goes to the end (workspace-wide)
  const { data: existing } = await supabase
    .from('projects')
    .select('sort_order')
    .eq('workspace_id', workspaceId)
    .order('sort_order', { ascending: false })
    .limit(1)

  const nextSortOrder = existing && existing.length > 0 ? existing[0].sort_order + 1 : 0

  const insertData: Record<string, unknown> = {
    user_id: user.id,
    workspace_id: workspaceId,
    name,
    sort_order: nextSortOrder,
  }
  if (body.description) insertData.description = body.description
  if (body.icon) insertData.icon = body.icon
  if (body.color) insertData.color = body.color
  if (body.initiative_id) insertData.initiative_id = body.initiative_id
  if (body.lead_id) insertData.lead_id = body.lead_id
  if (body.status) insertData.status = body.status
  if (body.start_date) insertData.start_date = body.start_date
  if (body.target_date) insertData.target_date = body.target_date

  const { data, error } = await supabase
    .from('projects')
    .insert(insertData)
    .select('id, name, description, icon, color, is_pinned, sort_order, initiative_id, status, start_date, target_date, created_at')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  trackServerEvent('project_created', { userId: user.id, workspaceId, email: user.email }, { project_id: data.id })

  // If label_ids provided, insert them
  if (labelIds.length > 0) {
    const labelRows = labelIds.map((lid) => ({
      project_id: data.id,
      label_id: lid,
    }))
    const { error: labelError } = await supabase.from('project_label').insert(labelRows)
    // The project exists either way; report it rather than fail the create
    // (a retry would make a second project).
    if (labelError) console.error('[POST /api/account/projects] label insert failed:', labelError.message)
  }

  return NextResponse.json({
    project: {
      ...data,
      lead: null,
      initiative: null,
      progress: { total_actions: 0, completed_actions: 0, canceled_actions: 0, percentage: 0 },
      milestones: { total: 0, completed: 0, next_milestone: null },
      labels: [],
      inferred_team: null,
      note_count: 0,
      // Backward compat
      lead_id: null,
      lead_name: null,
      lead_avatar: null,
      action_count: 0,
      completed_action_count: 0,
    },
  })
}
