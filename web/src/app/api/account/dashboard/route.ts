import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { getUpcomingCaptures } from '@/lib/integrations/calendar-sync'
import { NextResponse } from 'next/server'

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  // Get member record
  const { data: member } = await supabase
    .from('member')
    .select('id, display_name, avatar_url')
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .single()

  if (!member) return NextResponse.json({ error: 'Not a workspace member' }, { status: 403 })

  // Calendar sync disabled — captures are created manually by the user

  // Run all queries in parallel
  const [
    myActionsResult,
    pendingReviewResult,
    activeCyclesResult,
    recentCapturesResult,
    myProjectsResult,
    upcomingMeetingsResult,
  ] = await Promise.all([
    getMyActions(supabase, workspaceId, member.id),
    getPendingReview(supabase, workspaceId, user.id),
    getActiveCycles(supabase, workspaceId, user.id),
    getRecentCaptures(supabase, workspaceId, user.id),
    getMyProjects(supabase, workspaceId, member.id),
    getUpcomingCaptures(user.id, workspaceId).catch(() => []),
  ])

  // Get pending email draft count (non-blocking)
  let pendingDraftCount = 0
  try {
    const { count } = await supabase
      .from('email_draft')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('workspace_id', workspaceId)
      .eq('status', 'pending_review')
    pendingDraftCount = count || 0
  } catch {}

  return NextResponse.json({
    member: { id: member.id, display_name: member.display_name },
    my_actions: myActionsResult,
    pending_review: pendingReviewResult,
    active_cycles: activeCyclesResult,
    recent_captures: recentCapturesResult,
    my_projects: myProjectsResult,
    upcoming_meetings: upcomingMeetingsResult,
    pending_draft_count: pendingDraftCount,
  })
}

async function getMyActions(supabase: ReturnType<typeof createClient> extends Promise<infer T> ? T : never, workspaceId: string, memberId: string) {
  const now = new Date()
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

  // Only the rows the buckets use: open actions, plus those completed in the
  // last 7 days. Reading every assigned action (old completed ones included)
  // ran past PostgREST's 1000-row cap, which dropped the NEWEST rows. The inner
  // join makes the embedded category filter restrict the parent rows.
  const actionSelect = `
      id, identifier, title, priority, due_at, all_day, confirmation, created_at, updated_at,
      workflow_state:workflow_state!status_id!inner(id, name, category, color),
      team:team!team_id(name),
      project:projects!project_id(name),
      cycle:cycle!cycle_id(name)
    `
  const [{ data: openActions }, { data: completedActions }] = await Promise.all([
    supabase
      .from('actions')
      .select(actionSelect)
      .eq('assignee_id', memberId)
      .neq('confirmation', 'dismissed')
      .not('workflow_state.category', 'in', '(completed,canceled)')
      .order('created_at', { ascending: true }),
    supabase
      .from('actions')
      .select(actionSelect)
      .eq('assignee_id', memberId)
      .neq('confirmation', 'dismissed')
      .eq('workflow_state.category', 'completed')
      .gt('updated_at', sevenDaysAgo.toISOString())
      .order('created_at', { ascending: true }),
  ])

  if (!openActions && !completedActions) return { in_progress: [], upcoming: [], overdue: [], recently_completed: [] }
  const actions = [...(openActions ?? []), ...(completedActions ?? [])]

  const in_progress: typeof mapped = []
  const upcoming: typeof mapped = []
  const overdue: typeof mapped = []
  const recently_completed: typeof mapped = []

  const mapped = actions.map((a) => {
    const ws = a.workflow_state as unknown as { id: string; name: string; category: string; color: string } | null
    const team = a.team as unknown as { name: string } | null
    const project = a.project as unknown as { name: string } | null
    const cycle = a.cycle as unknown as { name: string } | null
    return {
      id: a.id,
      identifier: a.identifier,
      title: a.title,
      priority: a.priority,
      status_name: ws?.name || 'Unknown',
      status_category: ws?.category || 'backlog',
      status_color: ws?.color || '#6b7280',
      team_name: team?.name || '',
      project_name: project?.name || null,
      due_date: a.due_at,
      all_day: a.all_day,
      cycle_name: cycle?.name || null,
      confirmation: a.confirmation,
      created_at: a.created_at,
      updated_at: a.updated_at,
    }
  })

  for (const action of mapped) {
    const cat = action.status_category

    if (cat === 'completed') {
      if (action.updated_at && new Date(action.updated_at) > sevenDaysAgo) {
        recently_completed.push(action)
      }
      continue
    }

    if (cat === 'canceled') continue

    // Check overdue
    if (action.due_date && new Date(action.due_date) < now) {
      overdue.push(action)
      continue
    }

    if (cat === 'started') {
      in_progress.push(action)
    } else {
      upcoming.push(action)
    }
  }

  // Sort overdue by how overdue (most overdue first)
  overdue.sort((a, b) => new Date(a.due_date!).getTime() - new Date(b.due_date!).getTime())

  // Sort upcoming by priority then created_at
  const priorityOrder: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 }
  upcoming.sort((a, b) => {
    const pa = priorityOrder[a.priority] ?? 4
    const pb = priorityOrder[b.priority] ?? 4
    if (pa !== pb) return pa - pb
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  })

  // Sort recently completed by most recent first
  recently_completed.sort((a, b) =>
    new Date(b.updated_at || b.created_at).getTime() - new Date(a.updated_at || a.created_at).getTime()
  )

  return { in_progress, upcoming, overdue, recently_completed }
}

async function getPendingReview(supabase: ReturnType<typeof createClient> extends Promise<infer T> ? T : never, workspaceId: string, userId: string) {
  // Get captures that have suggested actions or decisions. Private captures
  // ("Only me") are creator-only — filtering them here is what keeps the
  // downstream suggested-action/decision rollups private too, since both are
  // keyed on this already-filtered id list.
  const { data: captures } = await supabase
    .from('captures')
    .select(`
      id, title, updated_at, ai_processed
    `)
    .eq('workspace_id', workspaceId)
    .or(`visibility.eq.workspace,user_id.eq.${userId}`)
    // Eval captures (`is_eval`, migration 252) are synthetic mock meetings and
    // never belong in a real review queue. See docs/plans/evals.md §5.2.
    .neq('is_eval', true)
    .eq('ai_processed', true)
    .eq('status', 'active')
    .order('updated_at', { ascending: false })
    .limit(20)

  if (!captures?.length) return []

  const captureIds = captures.map((c) => c.id)

  // Batch fetch suggested action counts
  const { data: suggestedActions } = await supabase
    .from('actions')
    .select('source_capture_id')
    .in('source_capture_id', captureIds)
    .eq('confirmation', 'suggested')

  // Batch fetch suggested decision counts
  const { data: suggestedDecisions } = await supabase
    .from('decision')
    .select('capture_id')
    .in('capture_id', captureIds)
    .eq('confirmation', 'suggested')

  // Count per capture
  const actionCounts: Record<string, number> = {}
  const decisionCounts: Record<string, number> = {}
  for (const a of suggestedActions || []) {
    actionCounts[a.source_capture_id] = (actionCounts[a.source_capture_id] || 0) + 1
  }
  for (const d of suggestedDecisions || []) {
    decisionCounts[d.capture_id] = (decisionCounts[d.capture_id] || 0) + 1
  }

  return captures
    .filter((c) => (actionCounts[c.id] || 0) + (decisionCounts[c.id] || 0) > 0)
    .map((c) => {
      return {
        capture_id: c.id,
        capture_title: c.title,
        processed_at: c.updated_at,
        suggested_action_count: actionCounts[c.id] || 0,
        suggested_decision_count: decisionCounts[c.id] || 0,
      }
    })
}

async function getActiveCycles(supabase: ReturnType<typeof createClient> extends Promise<infer T> ? T : never, workspaceId: string, userId: string) {
  // Get active cycles for teams the user belongs to
  const { data: cycles } = await supabase
    .from('cycle')
    .select(`
      id, name, number, start_date, end_date, status,
      team:team!team_id(id, name, workspace_id)
    `)
    .eq('status', 'active')

  if (!cycles?.length) return []

  // Filter to workspace and get member's teams
  const { data: memberTeams } = await supabase
    .from('team_member')
    .select('team_id, member:member!member_id(user_id)')
    .eq('member.user_id', userId)

  const userTeamIds = new Set(
    (memberTeams || [])
      .filter((tm) => {
        const m = tm.member as unknown as { user_id: string } | null
        return m?.user_id === userId
      })
      .map((tm) => tm.team_id)
  )

  const workspaceCycles = cycles.filter((c) => {
    const team = c.team as unknown as { id: string; name: string; workspace_id: string } | null
    return team?.workspace_id === workspaceId && userTeamIds.has(team.id)
  })

  if (!workspaceCycles.length) return []

  // Get action counts per cycle
  const cycleIds = workspaceCycles.map((c) => c.id)
  const { data: allCycleActions } = await supabase
    .from('actions')
    .select('cycle_id, status_id, confirmation, workflow_state:workflow_state!status_id(category)')
    .in('cycle_id', cycleIds)
    .neq('confirmation', 'dismissed')

  const cycleTotals: Record<string, number> = {}
  const cycleCompleted: Record<string, number> = {}
  for (const a of allCycleActions || []) {
    if (!a.cycle_id) continue
    cycleTotals[a.cycle_id] = (cycleTotals[a.cycle_id] || 0) + 1
    const ws = a.workflow_state as unknown as { category: string } | null
    if (ws?.category === 'completed') {
      cycleCompleted[a.cycle_id] = (cycleCompleted[a.cycle_id] || 0) + 1
    }
  }

  const now = new Date()

  return workspaceCycles.map((c) => {
    const team = c.team as unknown as { id: string; name: string } | null
    const total = cycleTotals[c.id] || 0
    const completed = cycleCompleted[c.id] || 0
    const endDate = new Date(c.end_date)
    const daysRemaining = Math.max(0, Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))

    return {
      cycle_id: c.id,
      cycle_name: c.name || `Sprint ${c.number}`,
      cycle_number: c.number,
      team_name: team?.name || '',
      team_id: team?.id || '',
      start_date: c.start_date,
      end_date: c.end_date,
      total_actions: total,
      completed_actions: completed,
      progress_percent: total > 0 ? Math.round((completed / total) * 100) : 0,
      days_remaining: daysRemaining,
    }
  })
}

async function getRecentCaptures(supabase: ReturnType<typeof createClient> extends Promise<infer T> ? T : never, workspaceId: string, userId: string) {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const { data: captures } = await supabase
    .from('captures')
    .select(`
      id, title, started_at, ended_at, ai_processed, created_at,
      participants
    `)
    .eq('workspace_id', workspaceId)
    .or(`visibility.eq.workspace,user_id.eq.${userId}`)
    // Eval captures (`is_eval`, migration 252) never surface as recent
    // meetings. See docs/plans/evals.md §5.2.
    .neq('is_eval', true)
    .eq('status', 'active')
    .gte('created_at', sevenDaysAgo)
    .order('created_at', { ascending: false })
    .limit(10)

  if (!captures?.length) return []

  // Batch fetch action counts
  const captureIds = captures.map((c) => c.id)
  const { data: actionRows } = await supabase
    .from('actions')
    .select('source_capture_id')
    .in('source_capture_id', captureIds)

  const actionCounts: Record<string, number> = {}
  for (const a of actionRows || []) {
    if (a.source_capture_id) {
      actionCounts[a.source_capture_id] = (actionCounts[a.source_capture_id] || 0) + 1
    }
  }

  return captures.map((c) => {
    const participantCount = Array.isArray(c.participants) ? c.participants.length : 0

    return {
      id: c.id,
      title: c.title,
      started_at: c.started_at,
      ended_at: c.ended_at,
      created_at: c.created_at,
      ai_processed: c.ai_processed,
      source_action_count: actionCounts[c.id] || 0,
      participant_count: participantCount,
    }
  })
}

async function getMyProjects(supabase: ReturnType<typeof createClient> extends Promise<infer T> ? T : never, workspaceId: string, memberId: string) {
  // Projects where user is lead
  const { data: ledProjects } = await supabase
    .from('projects')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('lead_id', memberId)
    .in('status', ['planned', 'active', 'in_progress'])

  // Projects where user has assigned actions
  const { data: actionProjects } = await supabase
    .from('actions')
    .select('project_id')
    .eq('assignee_id', memberId)
    .not('project_id', 'is', null)
    .neq('confirmation', 'dismissed')

  const projectIdSet = new Set<string>()
  for (const p of ledProjects || []) projectIdSet.add(p.id)
  for (const a of actionProjects || []) {
    if (a.project_id) projectIdSet.add(a.project_id)
  }

  if (projectIdSet.size === 0) return []

  const { data: projects } = await supabase
    .from('projects')
    .select('id, name, status')
    .in('id', Array.from(projectIdSet))
    .in('status', ['planned', 'active', 'in_progress'])
    .order('updated_at', { ascending: false })
    .limit(10)

  if (!projects?.length) return []

  const projectIds = projects.map((p) => p.id)

  // Batch fetch milestone counts
  const { data: milestones } = await supabase
    .from('milestone')
    .select('project_id, status')
    .in('project_id', projectIds)

  // Batch fetch action counts
  const { data: projectActions } = await supabase
    .from('actions')
    .select('project_id, due_at, confirmation, workflow_state:workflow_state!status_id(category)')
    .in('project_id', projectIds)
    .neq('confirmation', 'dismissed')

  const now = new Date()
  const milestoneTotals: Record<string, number> = {}
  const milestoneCompleted: Record<string, number> = {}
  const openActionCounts: Record<string, number> = {}
  const overdueActionCounts: Record<string, number> = {}

  for (const m of milestones || []) {
    milestoneTotals[m.project_id] = (milestoneTotals[m.project_id] || 0) + 1
    if (m.status === 'completed') {
      milestoneCompleted[m.project_id] = (milestoneCompleted[m.project_id] || 0) + 1
    }
  }

  for (const a of projectActions || []) {
    if (!a.project_id) continue
    const ws = a.workflow_state as unknown as { category: string } | null
    const cat = ws?.category
    if (cat === 'completed' || cat === 'canceled') continue

    openActionCounts[a.project_id] = (openActionCounts[a.project_id] || 0) + 1
    if (a.due_at && new Date(a.due_at) < now) {
      overdueActionCounts[a.project_id] = (overdueActionCounts[a.project_id] || 0) + 1
    }
  }

  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    status: p.status,
    milestone_progress: {
      total: milestoneTotals[p.id] || 0,
      completed: milestoneCompleted[p.id] || 0,
    },
    open_action_count: openActionCounts[p.id] || 0,
    overdue_action_count: overdueActionCounts[p.id] || 0,
  }))
}
