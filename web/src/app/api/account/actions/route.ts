import { requireWorkspace, requireWorkspaceMember } from '@/lib/api-auth'
import { isAssignableTeammate, FOREIGN_AI_MEMBER_ERROR } from '@/lib/workspace-fences'
import { badRequest, forbidden, serverError } from '@/lib/api-errors'
import { checkDelegate } from '@/lib/actions/delegate'
import { trackServerEvent } from '@/lib/posthog'
import { NextResponse, type NextRequest } from 'next/server'

import { ACTION_LIST_SELECT } from '@/lib/views/action-list-select'
import { OPEN_WORK_ASSIGNEE_EMBED } from '@/lib/actions/open-work'
import { fetchAllRows, inChunks } from '@/lib/supabase/paging'
import { canMakeTaskAbout, linkTaskAbout, parseTaskAbout } from '@/lib/entities/task-about'

export async function GET(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId, member } = auth

  const { searchParams } = request.nextUrl
  const scope = searchParams.get('scope') || 'assigned' // 'assigned' | 'created' | 'all'
  const filter = searchParams.get('filter') || 'all'
  const status = searchParams.get('status') || 'active'
  const teamId = searchParams.get('team_id')
  const parentId = searchParams.get('parent_id')
  const projectId = searchParams.get('project_id')
  const milestoneId = searchParams.get('milestone_id')
  const cycleId = searchParams.get('cycle_id')
  const search = searchParams.get('search')

  // Resolve workflow-state IDs (for the status/filter params) and the member's
  // assigned-action IDs in parallel — they're independent, and a single
  // workflow_state fetch covers both params (previously `status` and `filter`
  // each ran their own sequential query before the main query could start).
  const needsStates =
    status === 'active' || status === 'completed' ||
    filter === 'overdue' || filter === 'completed'
  const needsAssignedIds = scope !== 'created' && scope !== 'all'

  const [statesRes, assignedRes] = await Promise.all([
    needsStates
      ? supabase
          .from('workflow_state')
          .select('id, category, team:team!team_id(workspace_id)')
          .in('category', ['backlog', 'unstarted', 'started', 'completed'])
      : Promise.resolve(null),
    // Only whether the member has ANY join-table assignment is needed: the
    // filter itself runs in SQL through an inner embed (below), never as an id
    // list, which overflowed the URL past a few hundred assignments and was cut
    // at 1000 rows.
    needsAssignedIds
      ? supabase
          .from('action_assignee')
          .select('action_id', { count: 'exact', head: true })
          .eq('member_id', member.id)
      : Promise.resolve(null),
  ])
  if (assignedRes?.error) {
    return serverError(assignedRes.error.message)
  }
  const assignedThroughJoin = (assignedRes?.count ?? 0) > 0

  const workspaceStates = (statesRes?.data || []).filter(
    (s) => (s.team as unknown as { workspace_id: string })?.workspace_id === workspaceId,
  )
  // "Canceled" is in neither set — it's excluded from both active and
  // completed filtering, matching the categories queried above.
  const nonDoneStateIds = workspaceStates.filter((s) => s.category !== 'completed').map((s) => s.id)
  const doneStateIds = workspaceStates.filter((s) => s.category === 'completed').map((s) => s.id)

  const statusIds: string[] | null =
    status === 'active' ? nonDoneStateIds
    : status === 'completed' ? doneStateIds
    : null

  const scopedByJoin = scope !== 'created' && scope !== 'all' && assignedThroughJoin
  let query = supabase
    .from('actions')
    // Typed as the base select: the extra embed only filters, nothing reads it.
    .select((scopedByJoin ? `${ACTION_LIST_SELECT}, ${OPEN_WORK_ASSIGNEE_EMBED}` : ACTION_LIST_SELECT) as typeof ACTION_LIST_SELECT)
    .eq('workspace_id', workspaceId)

  if (scope === 'created') {
    query = query.eq('user_id', user.id)
  } else if (scope !== 'all') {
    // Filter to actions where the current member is in action_assignee join table
    // Falls back to assignee_id for actions not yet migrated
    if (scopedByJoin) {
      query = query.eq('assigned.member_id', member.id)
    } else {
      query = query.eq('assignee_id', member.id)
    }
  }
  // scope=all: no user scoping — relies on workspace_id filter already applied

  if (teamId) {
    query = query.eq('team_id', teamId)
  }

  if (projectId) {
    query = query.eq('project_id', projectId)
  }

  if (milestoneId) {
    query = query.eq('milestone_id', milestoneId)
  }

  if (cycleId) {
    query = query.eq('cycle_id', cycleId)
  }

  // By default show top-level actions only; pass parent_id to get sub-actions
  if (parentId) {
    query = query.eq('parent_id', parentId)
  } else if (!search) {
    query = query.is('parent_id', null)
  }

  // Calendar range filters
  const dueAtMin = searchParams.get('due_at_min')
  const dueAtMax = searchParams.get('due_at_max')
  const timedOnly = searchParams.get('timed_only') === 'true'

  if (dueAtMin) query = query.gte('due_at', dueAtMin)
  if (dueAtMax) query = query.lte('due_at', dueAtMax)
  if (timedOnly) query = query.eq('all_day', false).not('due_at', 'is', null)

  // Full-text search — identifier pattern (e.g. "GEN-802") uses ilike, otherwise FTS
  if (search) {
    const trimmed = search.trim()
    if (/^[A-Za-z]+-\d+$/.test(trimmed)) {
      // previous_identifier: a cross-workspace move renumbers colliding
      // identifiers but keeps the old handle searchable (migration 221).
      query = query.or(
        `identifier.ilike.${trimmed},previous_identifier.ilike.${trimmed}`,
      )
    } else {
      const tsQuery = trimmed.split(/\s+/).join(' & ')
      query = query.textSearch('fts', tsQuery)
    }
  }

  if (statusIds !== null) {
    query = query.in('status_id', statusIds)
  }

  // Time filters
  const now = new Date()
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const endOfDay = new Date(startOfDay.getTime() + 86400000)

  if (filter === 'today') {
    query = query
      .gte('due_at', startOfDay.toISOString())
      .lt('due_at', endOfDay.toISOString())
  } else if (filter === 'this_week') {
    const endOfWeek = new Date(startOfDay.getTime() + 7 * 86400000)
    query = query
      .gte('due_at', startOfDay.toISOString())
      .lt('due_at', endOfWeek.toISOString())
  } else if (filter === 'overdue') {
    // Overdue = has due_at in the past AND status is not completed/canceled
    query = query.lt('due_at', now.toISOString()).in('status_id', nonDoneStateIds)
  } else if (filter === 'completed') {
    query = query.in('status_id', doneStateIds)
  }

  query = query
    .order('priority', { ascending: true })
    .order('due_at', { ascending: true })

  // Optional row cap — opt-in so existing consumers keep full results.
  const limitParam = parseInt(searchParams.get('limit') || '', 10)
  if (Number.isFinite(limitParam) && limitParam > 0) {
    query = query.limit(Math.min(limitParam, 500))
  }

  const { data, error } = await query

  if (error) {
    return serverError(error.message)
  }

  const actions = (data || []).map((a) => {
    const ws = a.workflow_state as unknown as { id: string; name: string; category: string; color: string } | null
    const actionLabels = (a.labels as unknown as { label: { id: string; name: string; color: string } }[] | null) || []
    const assigneeData = a.assignee as unknown as { id: string; display_name: string; avatar_url: string | null } | null
    const assigneesRaw = (a.assignees as unknown as { member: { id: string; display_name: string; avatar_url: string | null } }[] | null) || []
    const assignees = assigneesRaw.map((aa) => aa.member).filter(Boolean)
    const projectData = a.project as unknown as { id: string; name: string } | null
    const milestoneData = a.milestone as unknown as { id: string; name: string } | null
    const cycleData = (a as unknown as Record<string, unknown>).cycle as { id: string; name: string; number: number } | null
    const aiAssignee = a.assignee_ai_member as unknown as { id: string; name: string; avatar_url: string | null } | null
    // Use join table assignees if present, fall back to legacy assignee FK
    const primaryAssignee = assignees[0] || assigneeData
    return {
      id: a.id,
      identifier: a.identifier,
      title: a.title,
      description: a.description,
      status_id: a.status_id,
      status_name: ws?.name || '',
      status_category: ws?.category || '',
      status_color: ws?.color || '#6b7280',
      team_id: a.team_id,
      confirmation: a.confirmation,
      priority: a.priority,
      due_at: a.due_at,
      all_day: a.all_day,
      assignee_id: primaryAssignee?.id || null,
      assignee_name: primaryAssignee?.display_name || null,
      assignee_avatar: primaryAssignee?.avatar_url || null,
      assignees,
      assignee_ai_member_id: aiAssignee?.id || a.assignee_ai_member_id || null,
      assignee_ai_member_name: aiAssignee?.name || null,
      assignee_ai_member_avatar: aiAssignee?.avatar_url || null,
      agent_run_status: a.agent_run_status ?? 'idle',
      parent_id: a.parent_id,
      estimate: a.estimate,
      project_id: a.project_id,
      project_name: projectData?.name || null,
      milestone_id: a.milestone_id,
      milestone_name: milestoneData?.name || null,
      cycle_id: (a as unknown as Record<string, unknown>).cycle_id ?? null,
      cycle_name: cycleData?.name || null,
      cycle_number: cycleData?.number || null,
      created_at: a.created_at,
      is_overdue: a.due_at && new Date(a.due_at) < now && ws?.category !== 'completed',
      labels: actionLabels.map((al) => al.label).filter(Boolean),
    }
  })

  // Batch-fetch comment counts
  const actionIds = actions.map((a) => a.id)
  let commentCounts: Record<string, number> = {}
  const hasChildrenSet = new Set<string>()
  if (actionIds.length > 0) {
    // Chunked + paged: the list can hold up to 1000 ids (too many for one
    // URL) and the comment rows can exceed one 1000-row page. A failed read
    // is a 500, not every row silently showing 0 comments / no chevron.
    const [countsRes, childrenRes] = await Promise.all([
      inChunks(actionIds, 100, (chunkIds) =>
        fetchAllRows(() =>
          supabase
            .from('comment')
            .select('commentable_id')
            .eq('commentable_type', 'action')
            .in('commentable_id', chunkIds),
        ),
      ),
      // has_children hint: one row per parent that actually has sub-actions.
      // Consumers (e.g. list-view tree toggles) show the chevron only when true.
      inChunks(actionIds, 100, (chunkIds) =>
        fetchAllRows(() =>
          supabase
            .from('actions')
            .select('parent_id')
            .in('parent_id', chunkIds),
        ),
      ),
    ])
    const enrichError = countsRes.error ?? childrenRes.error
    if (enrichError) {
      return serverError(enrichError.message)
    }
    commentCounts = (countsRes.data || []).reduce((acc: Record<string, number>, c: { commentable_id: string }) => {
      acc[c.commentable_id] = (acc[c.commentable_id] || 0) + 1
      return acc
    }, {})
    for (const row of (childrenRes.data || []) as { parent_id: string | null }[]) {
      if (row.parent_id) hasChildrenSet.add(row.parent_id)
    }
  }

  const actionsWithCounts = actions.map((a) => ({
    ...a,
    comment_count: commentCounts[a.id] || 0,
    has_children: hasChildrenSet.has(a.id),
  }))

  return NextResponse.json({ actions: actionsWithCounts, count: actionsWithCounts.length })
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const body = await request.json()
  const { title, team_id, assignee_id, assignee_ids, assignee_ai_member_id, parent_id, priority, estimate, project_id, milestone_id, cycle_id } = body as {
    title?: string
    team_id?: string
    assignee_id?: string
    assignee_ids?: string[]
    assignee_ai_member_id?: string | null
    parent_id?: string
    priority?: string
    estimate?: number
    project_id?: string
    milestone_id?: string
    cycle_id?: string
  }

  if (!title?.trim()) {
    return badRequest('Title is required')
  }

  // "Make a task from this": the record the task is about, fenced for the
  // person before anything is written (src/lib/entities/task-about.ts).
  const about = parseTaskAbout((body as { about?: unknown }).about)
  if (about === 'invalid') return badRequest('about must name a record a task can be about')
  if (about && !(await canMakeTaskAbout(supabase, { workspaceId, userId: user.id }, about))) {
    return badRequest('about must be a record you can see in this workspace')
  }

  // Resolve team_id
  let resolvedTeamId = team_id
  if (!resolvedTeamId) {
    const { data: defaultTeam } = await supabase
      .from('team')
      .select('id')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: true })
      .limit(1)
      .single()

    if (!defaultTeam) {
      // Every workspace gets a default team on creation (DB trigger), so this
      // is almost certainly a wrong-workspace/scope issue rather than missing data.
      return badRequest(`No team found in workspace ${workspaceId}`)
    }
    resolvedTeamId = defaultTeam.id
  }

  // Look up the team's default workflow state
  const { data: defaultState } = await supabase
    .from('workflow_state')
    .select('id')
    .eq('team_id', resolvedTeamId)
    .eq('is_default', true)
    .single()

  if (!defaultState) {
    return serverError('No default workflow state for team')
  }

  // Validate caller-supplied FK fields belong to the caller's workspace/team
  // before inserting — the FKs only check row existence, so without this a
  // caller could attach the new action to another workspace's project/cycle/
  // milestone or parent. Only fields actually provided are checked. Team-scoped
  // relations (cycle) validate against the team the action is being created in;
  // workspace-scoped relations (project) validate against the workspace;
  // milestone validates via its project's workspace; parent must be an action
  // in the same workspace. (status_id is server-derived here, not caller-supplied.)
  if (cycle_id) {
    const { data: cycleRow } = await supabase
      .from('cycle')
      .select('id')
      .eq('id', cycle_id)
      .eq('team_id', resolvedTeamId)
      .maybeSingle()
    if (!cycleRow) {
      return badRequest('cycle_id does not belong to this team')
    }
  }

  if (project_id) {
    const { data: projectRow } = await supabase
      .from('projects')
      .select('id')
      .eq('id', project_id)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (!projectRow) {
      return badRequest('project_id does not belong to this workspace')
    }
  }

  if (milestone_id) {
    const { data: milestoneRow } = await supabase
      .from('milestone')
      .select('id, project:projects!project_id(workspace_id)')
      .eq('id', milestone_id)
      .maybeSingle()
    const milestoneWorkspaceId = (milestoneRow?.project as unknown as { workspace_id: string } | null)?.workspace_id
    if (!milestoneRow || milestoneWorkspaceId !== workspaceId) {
      return badRequest('milestone_id does not belong to this workspace')
    }
  }

  if (parent_id) {
    const { data: parentRow } = await supabase
      .from('actions')
      .select('id')
      .eq('id', parent_id)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (!parentRow) {
      return badRequest('parent_id does not belong to this workspace')
    }
  }

  // An AI teammate assignee must be one of THIS workspace's teammates (the FK
  // only checks existence) — the same fence PATCH /actions/[id] applies.
  // And one the caller can see: a private team's agents only for its members
  // (checkDelegate: callerCanReachTeammate).
  if (assignee_ai_member_id) {
    if (!(await isAssignableTeammate(supabase, assignee_ai_member_id, workspaceId))) {
      return badRequest(FOREIGN_AI_MEMBER_ERROR)
    }
    const agent = await checkDelegate(supabase, { userId: user.id, workspaceId, teammateId: assignee_ai_member_id })
    if (!agent.ok) return forbidden("You can't hand work to that agent")
  }

  // Resolve member record so quick-add auto-assigns to current user
  const { data: member } = await supabase
    .from('member')
    .select('id')
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .single()

  // Resolve assignee list: prefer assignee_ids array, fall back to single
  // assignee_id, then default to self. An AI teammate rides beside the person
  // as the delegate (decision 9, src/lib/actions/delegate.ts): the person stays
  // responsible, so a delegated action with nobody named is the creator's.
  const resolvedAssigneeIds: string[] =
    assignee_ids && assignee_ids.length > 0
      ? assignee_ids
      : assignee_id
        ? [assignee_id]
        : member?.id
          ? [member.id]
          : []

  // Explicit assignees must be members of this workspace (the FK only checks
  // existence, and action_assignee RLS only checks the action).
  const explicitAssigneeIds = resolvedAssigneeIds.filter((mid) => mid !== member?.id)
  if (explicitAssigneeIds.length > 0) {
    const { data: assigneeRows } = await supabase
      .from('member')
      .select('id')
      .eq('workspace_id', workspaceId)
      .in('id', explicitAssigneeIds)
    const found = new Set((assigneeRows || []).map((m: { id: string }) => m.id))
    if (explicitAssigneeIds.some((mid) => !found.has(mid))) {
      return badRequest('Invalid assignee_ids')
    }
  }

  const insertData: Record<string, unknown> = {
    user_id: user.id,
    workspace_id: workspaceId,
    title: title.trim(),
    status_id: defaultState.id,
    priority: priority || 'none',
    all_day: true,
    team_id: resolvedTeamId,
    assignee_id: resolvedAssigneeIds[0] || null,
    assignee_ai_member_id: assignee_ai_member_id || null,
  }
  if (parent_id) insertData.parent_id = parent_id
  if (estimate !== undefined) insertData.estimate = estimate
  if (project_id) insertData.project_id = project_id
  if (milestone_id) insertData.milestone_id = milestone_id
  if (cycle_id) insertData.cycle_id = cycle_id

  const { data, error } = await supabase
    .from('actions')
    .insert(insertData)
    .select(ACTION_LIST_SELECT)
    .single()

  if (error) {
    return serverError(error.message)
  }

  // Insert into action_assignee join table
  if (resolvedAssigneeIds.length > 0) {
    await supabase
      .from('action_assignee')
      .insert(resolvedAssigneeIds.map((mid) => ({ action_id: data.id, member_id: mid })))
  }

  // Fetch assignee details for response
  let assigneesResult: { id: string; display_name: string; avatar_url: string | null }[] = []
  if (resolvedAssigneeIds.length > 0) {
    const { data: memberData } = await supabase
      .from('member')
      .select('id, display_name, avatar_url')
      .in('id', resolvedAssigneeIds)
    assigneesResult = (memberData || []) as { id: string; display_name: string; avatar_url: string | null }[]
  }

  const aboutLinked = about
    ? await linkTaskAbout(supabase, { workspaceId, actionId: data.id, ref: about, memberId: member?.id ?? null })
    : false

  trackServerEvent('action_created', { userId: user.id, workspaceId, email: user.email }, {
    action_id: data.id,
    // A confirmed action created from a capture vs a manual quick-add — the
    // launch funnel cares about the capture→action conversion path.
    from_capture: Boolean((body as { source_capture_id?: string }).source_capture_id),
    has_project: Boolean(project_id),
    has_assignee: resolvedAssigneeIds.length > 0,
    priority: priority || 'none',
  })

  // Flatten response
  const dataRec = data as Record<string, unknown>
  const ws = dataRec.workflow_state as { id: string; name: string; category: string; color: string } | null
  const projectData = dataRec.project as { id: string; name: string } | null
  const milestoneData = dataRec.milestone as { id: string; name: string } | null
  const cycleData = dataRec.cycle as { id: string; name: string; number: number } | null
  const aiAssignee = dataRec.assignee_ai_member as { id: string; name: string; avatar_url: string | null } | null
  const primaryAssignee = assigneesResult[0] || null
  const result = {
    id: data.id,
    identifier: data.identifier,
    title: data.title,
    description: data.description,
    status_id: data.status_id,
    status_name: ws?.name || '',
    status_category: ws?.category || '',
    status_color: ws?.color || '#6b7280',
    team_id: data.team_id,
    confirmation: data.confirmation,
    priority: data.priority,
    due_at: data.due_at,
    all_day: data.all_day,
    assignee_id: primaryAssignee?.id || null,
    assignee_name: primaryAssignee?.display_name || null,
    assignee_avatar: primaryAssignee?.avatar_url || null,
    assignees: assigneesResult,
    assignee_ai_member_id: aiAssignee?.id || dataRec.assignee_ai_member_id || null,
    assignee_ai_member_name: aiAssignee?.name || null,
    assignee_ai_member_avatar: aiAssignee?.avatar_url || null,
    agent_run_status: (dataRec.agent_run_status as string) ?? 'idle',
    parent_id: data.parent_id,
    estimate: data.estimate,
    project_id: data.project_id,
    project_name: projectData?.name || null,
    milestone_id: data.milestone_id,
    milestone_name: milestoneData?.name || null,
    cycle_id: data.cycle_id ?? null,
    cycle_name: cycleData?.name || null,
    cycle_number: cycleData?.number || null,
    created_at: data.created_at,
    labels: [],
  }

  return NextResponse.json({ action: result, ...(about ? { about_linked: aboutLinked } : {}) })
}
