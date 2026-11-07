import { requireWorkspace, requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, forbidden, notFound, serverError } from '@/lib/api-errors'
import { createNotification } from '@/lib/notifications'
import { emitStatusChange } from '@/lib/flows/emit-status-change'
import { checkDelegate, responsibleAssigneeIds } from '@/lib/actions/delegate'
import { trackServerEvent } from '@/lib/posthog'
import { NextResponse, type NextRequest } from 'next/server'

// `source_capture` is the meeting this action was extracted from. Its FK still
// carries the pre-rename name (source_note_id → source_capture_id, migration
// 025), so the embed names the CONSTRAINT rather than the column — and note
// PostgREST select strings take no SQL comments, hence this sits out here.
const ACTION_FIELDS = `
  id, identifier, title, description, status_id, team_id, confirmation, ai_confidence, auto_accepted, priority, due_at, all_day, links, assignee_id, assignee_ai_member_id, agent_run_status, parent_id, estimate, project_id, milestone_id, cycle_id, source_capture_id, created_at, updated_at,
  workflow_state:workflow_state!status_id(id, name, category, color),
  source_capture:captures!actions_source_note_id_fkey(id, title),
  labels:action_label(label:label(id, name, color)),
  external_links:action_external_task(id, provider, external_id, external_url, external_title, completed),
  assignee:member!assignee_id(id, display_name, avatar_url),
  assignees:action_assignee(member:member(id, display_name, avatar_url)),
  assignee_ai_member:ai_team_member!assignee_ai_member_id(id, name, avatar_url),
  project:projects!project_id(id, name),
  milestone:milestone!milestone_id(id, name),
  cycle:cycle!cycle_id(id, name, number)
`

function flattenAction(data: Record<string, unknown>) {
  const ws = data.workflow_state as { id: string; name: string; category: string; color: string } | null
  const actionLabels = (data.labels as { label: { id: string; name: string; color: string } }[] | null) || []
  // Linked external tasks (Asana/Jira/Linear) embedded here so the detail
  // panel doesn't probe the three per-provider link routes on every open.
  const externalLinks = (data.external_links as {
    id: string
    provider: string
    external_id: string
    external_url: string | null
    external_title: string | null
    completed: boolean
  }[] | null) || []
  const assigneeData = data.assignee as { id: string; display_name: string; avatar_url: string | null } | null
  const assigneesRaw = (data.assignees as { member: { id: string; display_name: string; avatar_url: string | null } }[] | null) || []
  const assignees = assigneesRaw.map((aa) => aa.member).filter(Boolean)
  const primaryAssignee = assignees[0] || assigneeData
  const aiAssignee = data.assignee_ai_member as { id: string; name: string; avatar_url: string | null } | null
  const projectData = data.project as { id: string; name: string } | null
  const milestoneData = data.milestone as { id: string; name: string } | null
  const cycleData = data.cycle as { id: string; name: string; number: number } | null
  const sourceCapture = data.source_capture as { id: string; title: string | null } | null
  return {
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
    ai_confidence: data.ai_confidence ?? null,
    auto_accepted: data.auto_accepted ?? false,
    // Provenance: the meeting this action was extracted from, so the detail
    // panel's Activity can link back to it.
    source_capture_id: (data.source_capture_id as string) ?? null,
    source_capture_title: sourceCapture?.title ?? null,
    priority: data.priority,
    due_at: data.due_at,
    all_day: data.all_day,
    links: data.links,
    external_links: externalLinks,
    assignee_id: primaryAssignee?.id || null,
    assignee_name: primaryAssignee?.display_name || null,
    assignee_avatar: primaryAssignee?.avatar_url || null,
    assignees,
    assignee_ai_member_id: aiAssignee?.id || data.assignee_ai_member_id || null,
    assignee_ai_member_name: aiAssignee?.name || null,
    assignee_ai_member_avatar: aiAssignee?.avatar_url || null,
    agent_run_status: (data.agent_run_status as string) ?? 'idle',
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
    updated_at: data.updated_at,
    labels: actionLabels.map((al) => al.label).filter(Boolean),
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { id } = await params

  // The action row and its comment count are independent — fetch in parallel.
  const [{ data, error }, { count: commentCount }] = await Promise.all([
    supabase
      .from('actions')
      .select(ACTION_FIELDS)
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .single(),
    supabase
      .from('comment')
      .select('*', { count: 'exact', head: true })
      .eq('commentable_type', 'action')
      .eq('commentable_id', id),
  ])

  // The action result decides the response — a missing/errored row wins over
  // whatever the comment count said.
  if (error) {
    return serverError(error.message)
  }

  return NextResponse.json({
    action: { ...flattenAction(data as Record<string, unknown>), comment_count: commentCount || 0 },
  })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // The member row (notification actor) rides along with auth resolution —
  // one member query instead of the old getUser → workspace → member chain.
  const auth = await requireWorkspaceMember({ select: 'id, display_name' })
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const member = auth.member as { id: string; display_name?: string | null }

  const { id } = await params
  const body = await request.json()

  // Fetch previous state for change detection (notifications)
  const [{ data: previousData }, { data: previousAssignees }] = await Promise.all([
    supabase
      .from('actions')
      .select('assignee_id, status_id, priority, team_id')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .single(),
    supabase
      .from('action_assignee')
      .select('member_id')
      .eq('action_id', id),
  ])
  const previousAssigneeIds = new Set((previousAssignees || []).map((a) => a.member_id))

  const updates: Record<string, unknown> = {}

  // Handle toggle_complete: resolve to the correct workflow state
  if (body.toggle_complete !== undefined) {
    const { data: action } = await supabase
      .from('actions')
      .select('team_id')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .single()

    if (!action) {
      return notFound('Action not found')
    }

    if (body.toggle_complete === true) {
      const { data: doneState } = await supabase
        .from('workflow_state')
        .select('id')
        .eq('team_id', action.team_id)
        .eq('category', 'completed')
        .order('sort_order', { ascending: true })
        .limit(1)
        .single()

      if (doneState) {
        updates.status_id = doneState.id
      }
    } else {
      const { data: defaultState } = await supabase
        .from('workflow_state')
        .select('id')
        .eq('team_id', action.team_id)
        .eq('is_default', true)
        .single()

      if (defaultState) {
        updates.status_id = defaultState.id
      }
    }
  }

  // Handle direct status_id changes
  if (body.status_id !== undefined) {
    updates.status_id = body.status_id
  }

  if (body.title !== undefined) updates.title = body.title
  if (body.description !== undefined) updates.description = body.description
  if (body.priority !== undefined) updates.priority = body.priority
  if (body.due_at !== undefined) updates.due_at = body.due_at
  if (body.all_day !== undefined) updates.all_day = body.all_day
  if (body.links !== undefined) updates.links = body.links
  if (body.confirmation !== undefined) updates.confirmation = body.confirmation
  // The delegate model (decision 9, src/lib/actions/delegate.ts): the person
  // slot and the agent slot coexist. The person stays responsible and the
  // agent works the action as the delegate; neither write clears the other.
  // Setting an agent when no person holds the action makes the delegator
  // (the caller) the person responsible.
  const assigningAgent = body.assignee_ai_member_id !== undefined && !!body.assignee_ai_member_id
  if (body.assignee_ai_member_id !== undefined) {
    const memberId = body.assignee_ai_member_id || null
    if (memberId) {
      // Validate the AI member belongs to this workspace before linking — the FK
      // only checks existence, so without this a foreign-workspace agent id could
      // be written (loadAgentPersona fails closed later, but reject early).
      // A system teammate (row 4) is a loop's attribution, and a work bot
      // (fronts_only, bots-v3 Phase 3) speaks for loops: neither is an assignee.
      // And a private team's agent only for that team's members
      // (checkDelegate: callerCanReachTeammate), so it can't be delegated from
      // the UI by someone who can't see it.
      const agent = await checkDelegate(supabase, { userId: user.id, workspaceId, teammateId: memberId, memberId: member?.id ?? null })
      if (!agent.ok) {
        return agent.reason === 'not_visible'
          ? forbidden("You can't hand work to that agent")
          : badRequest('Invalid assignee_ai_member_id')
      }
    }
    updates.assignee_ai_member_id = memberId
  }
  // Support both assignee_ids (multi) and assignee_id (single, backward compat).
  const requestedAssigneeIds: string[] | undefined =
    body.assignee_ids !== undefined
      ? (body.assignee_ids as string[])
      : body.assignee_id !== undefined
        ? (body.assignee_id ? [body.assignee_id] : [])
        : undefined
  const newAssigneeIds = responsibleAssigneeIds({
    delegating: assigningAgent,
    requested: requestedAssigneeIds,
    current: [...previousAssigneeIds],
    delegatorMemberId: member?.id ?? null,
  })
  if (newAssigneeIds !== undefined) {
    // Keep assignee_id column in sync (first assignee or null)
    updates.assignee_id = newAssigneeIds[0] || null
  }
  if (body.agent_run_status !== undefined) {
    const allowed = ['idle', 'starting', 'working', 'pr_open', 'failed']
    if (body.agent_run_status === null || allowed.includes(body.agent_run_status)) {
      updates.agent_run_status = body.agent_run_status || 'idle'
    }
  }
  if (body.parent_id !== undefined) updates.parent_id = body.parent_id
  if (body.estimate !== undefined) updates.estimate = body.estimate
  if (body.project_id !== undefined) updates.project_id = body.project_id || null
  if (body.milestone_id !== undefined) updates.milestone_id = body.milestone_id || null
  if (body.cycle_id !== undefined) updates.cycle_id = body.cycle_id || null

  // Validate that any FK fields being written point at rows in the caller's
  // workspace (mirrors the assignee_ai_member_id check above). The FK
  // constraints only enforce existence, so without these a client could
  // attach another workspace's status/project/milestone/cycle/parent to the
  // action. status_id and cycle_id are team-scoped in the schema, so they must
  // match the action's team; project_id is workspace-scoped directly;
  // milestone_id is validated via its project's workspace; parent_id must be
  // an action in the same workspace.
  const actionTeamId = previousData?.team_id as string | undefined

  if (updates.status_id) {
    const { data: state } = await supabase
      .from('workflow_state')
      .select('id, team_id')
      .eq('id', updates.status_id as string)
      .maybeSingle()
    if (!state || (actionTeamId && state.team_id !== actionTeamId)) {
      return badRequest('Invalid status_id')
    }
  }

  if (updates.cycle_id) {
    const { data: cycle } = await supabase
      .from('cycle')
      .select('id, team_id')
      .eq('id', updates.cycle_id as string)
      .maybeSingle()
    if (!cycle || (actionTeamId && cycle.team_id !== actionTeamId)) {
      return badRequest('Invalid cycle_id')
    }
  }

  if (updates.project_id) {
    const { data: project } = await supabase
      .from('projects')
      .select('id')
      .eq('id', updates.project_id as string)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (!project) {
      return badRequest('Invalid project_id')
    }
  }

  if (updates.milestone_id) {
    // milestone has no workspace_id — it inherits scope from its project.
    const { data: milestone } = await supabase
      .from('milestone')
      .select('id, project:projects!project_id(workspace_id)')
      .eq('id', updates.milestone_id as string)
      .maybeSingle()
    const milestoneProject = milestone?.project as
      | { workspace_id: string }
      | { workspace_id: string }[]
      | null
    const milestoneWorkspaceId = Array.isArray(milestoneProject)
      ? milestoneProject[0]?.workspace_id
      : milestoneProject?.workspace_id
    if (!milestone || milestoneWorkspaceId !== workspaceId) {
      return badRequest('Invalid milestone_id')
    }
  }

  if (updates.parent_id) {
    const { data: parent } = await supabase
      .from('actions')
      .select('id')
      .eq('id', updates.parent_id as string)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (!parent) {
      return badRequest('Invalid parent_id')
    }
  }

  // Newly added assignees must be members of this workspace (the FK only
  // checks existence, and action_assignee RLS only checks the action).
  if (newAssigneeIds !== undefined) {
    const added = [...new Set(newAssigneeIds)].filter(
      (mid) => !previousAssigneeIds.has(mid) && mid !== member?.id,
    )
    if (added.length > 0) {
      const { data: assigneeRows } = await supabase
        .from('member')
        .select('id')
        .eq('workspace_id', workspaceId)
        .in('id', added)
      const found = new Set((assigneeRows || []).map((m) => m.id))
      if (added.some((mid) => !found.has(mid))) {
        return badRequest('Invalid assignee_ids')
      }
    }
  }

  const { data, error } = await supabase
    .from('actions')
    .update(updates)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select(ACTION_FIELDS)
    .single()

  if (error) {
    return serverError(error.message)
  }

  // Sync action_assignee join table if assignees changed
  if (newAssigneeIds !== undefined) {
    const newSet = new Set(newAssigneeIds)
    const toRemove = [...previousAssigneeIds].filter((mid) => !newSet.has(mid))
    const toAdd = newAssigneeIds.filter((mid) => !previousAssigneeIds.has(mid))

    if (toRemove.length > 0) {
      await supabase.from('action_assignee').delete().eq('action_id', id).in('member_id', toRemove)
    }
    if (toAdd.length > 0) {
      await supabase.from('action_assignee').insert(toAdd.map((mid) => ({ action_id: id, member_id: mid })))
    }
  }

  // Re-fetch to get updated assignees from join table
  const { data: refetched } = await supabase
    .from('actions')
    .select(ACTION_FIELDS)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .single()

  const flattened = flattenAction((refetched || data) as Record<string, unknown>)

  // Fire notifications (non-blocking)
  if (member && previousData) {
    const actorName = member.display_name || 'Someone'
    const actionIdentifier = flattened.identifier as string
    const actionTitle = flattened.title as string

    // Assignee changes — notify newly added and removed assignees
    if (newAssigneeIds !== undefined) {
      const newSet = new Set(newAssigneeIds)
      // Notify newly assigned members
      for (const mid of newAssigneeIds) {
        if (!previousAssigneeIds.has(mid) && mid !== member.id) {
          createNotification({
            workspaceId,
            recipientId: mid,
            type: 'action_assigned',
            title: `${actorName} assigned you ${actionIdentifier}`,
            body: actionTitle,
            actorId: member.id,
            targetType: 'action',
            targetId: id,
            metadata: { action_identifier: actionIdentifier, action_title: actionTitle },
          })
        }
      }
      // Notify unassigned members
      for (const mid of previousAssigneeIds) {
        if (!newSet.has(mid) && mid !== member.id) {
          createNotification({
            workspaceId,
            recipientId: mid,
            type: 'action_unassigned',
            title: `${actorName} unassigned you from ${actionIdentifier}`,
            body: actionTitle,
            actorId: member.id,
            targetType: 'action',
            targetId: id,
            metadata: { action_identifier: actionIdentifier },
          })
        }
      }
    }

    // Status changed — notify all assignees for meaningful transitions
    const newStatusId = updates.status_id as string | undefined
    if (newStatusId && newStatusId !== previousData.status_id) {
      const newCategory = flattened.status_category as string
      // Track completion specifically — the launch dashboard's "actions
      // completed" metric and the create→complete throughput ratio depend on
      // this. Fires only on the transition INTO completed (guarded by the
      // status-changed check above), not on every PATCH of an already-done action.
      if (newCategory === 'completed') {
        trackServerEvent('action_completed', { userId: user.id, workspaceId, email: user.email }, {
          action_id: id,
        })
      }
      if (newCategory === 'completed' || newCategory === 'started') {
        const assigneeList = (flattened.assignees as { id: string }[]) || []
        for (const a of assigneeList) {
          if (a.id !== member.id) {
            createNotification({
              workspaceId,
              recipientId: a.id,
              type: 'action_status_changed',
              title: newCategory === 'completed'
                ? `${actorName} completed ${actionIdentifier}`
                : `${actorName} reopened ${actionIdentifier}`,
              body: actionTitle,
              actorId: member.id,
              targetType: 'action',
              targetId: id,
              metadata: {
                action_identifier: actionIdentifier,
                new_status: flattened.status_name,
                new_category: newCategory,
              },
            })
          }
        }
      }

      // Fire any Flows tied to this entity status transition via the shared
      // emit helper (GEN-112) — the single place every status writer funnels
      // through. The Inngest function filters by entity_type + workspace +
      // team + from/to, performs the HTTP call, and writes a flow_run row per
      // attempt. Fire-and-forget so the API response isn't slowed.
      emitStatusChange({
        entityType: 'action',
        entityId: id,
        workspaceId,
        teamId: flattened.team_id as string | undefined,
        fromStatusId: previousData.status_id,
        toStatusId: newStatusId,
        actorUserId: user.id,
      })
    }
  }

  return NextResponse.json({ action: flattened })
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { id } = await params

  // count: 'exact' because actions_delete RLS (owner/admin only, migration
  // 028) skips a refused row without an error, which read as success.
  const { error, count } = await supabase
    .from('actions')
    .delete({ count: 'exact' })
    .eq('id', id)
    .eq('workspace_id', workspaceId)

  if (error) {
    return serverError(error.message)
  }
  if (!count) {
    const { data: visible } = await supabase
      .from('actions')
      .select('id')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    return visible
      ? forbidden('Only a workspace owner or admin can delete an action')
      : notFound('Action not found')
  }

  return NextResponse.json({ success: true })
}
