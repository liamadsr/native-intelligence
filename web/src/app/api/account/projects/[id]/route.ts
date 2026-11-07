import { requireWorkspace, requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, forbidden, notFound, serverError } from '@/lib/api-errors'
import { createNotification, getMemberByUserId } from '@/lib/notifications'
import { inngest } from '@/lib/inngest/client'
import { NextResponse, type NextRequest } from 'next/server'

/** projects.environment_id's foreign key, named so the embed can't read as environment_default's link (migration 420). */
const PROJECT_ENVIRONMENT_FK = 'projects_environment_id_fkey'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { id } = await params

  // All five reads are independent — one parallel wave instead of four
  // sequential ones. The action stats used to select EVERY action row of the
  // project just to count it (perf audit finding 11.5); the counts are now
  // head-only count queries and the team inheritance is a single-row select.
  const [
    { data, error },
    { data: milestones },
    { count: totalCount },
    { count: completedCount },
    { data: teamRows },
  ] = await Promise.all([
    supabase
      .from('projects')
      .select(`
        id, name, description, icon, color, is_pinned, is_archived, sort_order, created_at, updated_at,
        initiative_id, status, start_date, target_date, github_repo, environment_id,
        lead:member!lead_id(id, display_name, avatar_url),
        initiative:initiative!initiative_id(id, name),
        environment:environment!${PROJECT_ENVIRONMENT_FK}(id, name, network_access)
      `)
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .single(),
    // Milestones
    supabase
      .from('milestone')
      .select('id, name, description, status, target_date, sort_order')
      .eq('project_id', id)
      .order('sort_order', { ascending: true }),
    // Action count — head-only, no rows shipped
    supabase
      .from('actions')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', id),
    // Completed-action count — the inner join makes the embedded category
    // filter restrict the parent rows being counted
    supabase
      .from('actions')
      .select('id, workflow_state:workflow_state!status_id!inner(category)', { count: 'exact', head: true })
      .eq('project_id', id)
      .eq('workflow_state.category', 'completed'),
    // team_id so the project inherits a team from its actions — projects
    // themselves are workspace-scoped, so the team is derived from the OLDEST
    // action linked to this project. The ORDER BY is load-bearing: `limit(1)`
    // without one lets Postgres early-exit from whichever plan it picks, so a
    // project whose actions span two teams could report a different team run to
    // run (after a VACUUM, or once an index on project_id appears). Null
    // team_ids are excluded so a teamless action can't shadow a real one.
    supabase
      .from('actions')
      .select('team_id')
      .eq('project_id', id)
      .not('team_id', 'is', null)
      .order('created_at', { ascending: true })
      .limit(1),
  ])

  // The project row decides the response — a missing/errored row wins over
  // whatever the side queries returned.
  if (error) {
    console.error('[projects/[id] GET]', { id, workspaceId, error })
    return serverError(error.message)
  }

  const leadData = data.lead as unknown as { id: string; display_name: string; avatar_url: string | null } | null
  const initiativeData = data.initiative as unknown as { id: string; name: string } | null
  const envData = data.environment as unknown as { id: string; name: string; network_access: string } | null

  const totalActions = totalCount || 0
  const completedActions = completedCount || 0

  return NextResponse.json({
    project: {
      id: data.id,
      name: data.name,
      description: data.description,
      icon: data.icon,
      color: data.color,
      is_pinned: data.is_pinned,
      is_archived: data.is_archived,
      sort_order: data.sort_order,
      initiative_id: data.initiative_id,
      initiative_name: initiativeData?.name || null,
      lead_id: leadData?.id || null,
      lead_name: leadData?.display_name || null,
      lead_avatar: leadData?.avatar_url || null,
      status: data.status,
      start_date: data.start_date,
      target_date: data.target_date,
      team_id: (teamRows?.[0] as { team_id?: string | null } | undefined)?.team_id ?? null,
      github_repo: data.github_repo,
      environment_id: data.environment_id,
      environment_name: envData?.name ?? null,
      environment_network_access: envData?.network_access ?? null,
      milestones: milestones || [],
      action_count: totalActions,
      completed_action_count: completedActions,
      created_at: data.created_at,
      updated_at: data.updated_at,
    },
  })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const { id } = await params
  const body = await request.json()

  // label_ids: deduped, and every id must be a label of this workspace
  // (project_label RLS only checks the project). Checked before any write.
  const labelIds: string[] | null = Array.isArray(body.label_ids)
    ? [...new Set((body.label_ids as unknown[]).filter((v): v is string => typeof v === 'string'))]
    : null
  if (labelIds && labelIds.length > 0) {
    const { data: validLabels } = await supabase
      .from('label')
      .select('id')
      .eq('workspace_id', workspaceId)
      .in('id', labelIds)
    if ((validLabels ?? []).length !== labelIds.length) {
      return badRequest('Invalid label_ids')
    }
  }

  // Fetch previous status for change detection. Use maybeSingle so a
  // workspace mismatch or missing row returns `null` cleanly instead of
  // throwing — the main update below also has the workspace_id filter and
  // will return its own error if the row really doesn't exist.
  let previousStatus: string | null = null
  if (body.status !== undefined) {
    const { data: prev } = await supabase
      .from('projects')
      .select('status')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    previousStatus = (prev?.status as string | null) ?? null
  }

  const updates: Record<string, unknown> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.description !== undefined) updates.description = body.description
  if (body.icon !== undefined) updates.icon = body.icon
  if (body.color !== undefined) updates.color = body.color
  if (body.is_pinned !== undefined) updates.is_pinned = body.is_pinned
  if (body.is_archived !== undefined) updates.is_archived = body.is_archived
  if (body.initiative_id !== undefined) updates.initiative_id = body.initiative_id || null
  if (body.lead_id !== undefined) updates.lead_id = body.lead_id || null
  if (body.status !== undefined) updates.status = body.status
  if (body.priority !== undefined) updates.priority = body.priority
  if (body.health !== undefined) updates.health = body.health
  if (body.start_date !== undefined) updates.start_date = body.start_date
  if (body.target_date !== undefined) updates.target_date = body.target_date
  if (body.sort_order !== undefined) updates.sort_order = body.sort_order
  if (body.github_repo !== undefined) {
    const repo = body.github_repo || null
    if (repo !== null && !/^[a-zA-Z0-9_.\-]+\/[a-zA-Z0-9_.\-]+$/.test(repo)) {
      return badRequest('Invalid github_repo format')
    }
    updates.github_repo = repo
  }
  // The project's environment (migration 420): a shared, live cloud
  // environment of this workspace, never a Mac. Empty/null unlinks. A non-null
  // id is checked here for a clean 400; migration 420's
  // projects_environment_check refuses anything else anyway.
  if (body.environment_id !== undefined) {
    const envId = body.environment_id || null
    if (envId) {
      const { data: env } = await supabase
        .from('environment')
        .select('id')
        .eq('id', envId)
        .eq('workspace_id', workspaceId)
        .eq('kind', 'cloud')
        .eq('shared', true)
        .is('archived_at', null)
        .maybeSingle()
      if (!env) {
        return badRequest('Invalid environment_id')
      }
    }
    updates.environment_id = envId
  }
  // Only update projects table if there are actual column changes
  let data
  if (Object.keys(updates).length > 0) {
    const result = await supabase
      .from('projects')
      .update(updates)
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .select(`id, name, description, icon, color, is_pinned, sort_order, initiative_id, status, start_date, target_date, github_repo, environment_id, created_at, updated_at, environment:environment!${PROJECT_ENVIRONMENT_FK}(id, name, network_access)`)
      .single()

    if (result.error) {
      return serverError(result.error.message)
    }
    data = result.data
  } else {
    // No project column changes — just fetch current state
    const result = await supabase
      .from('projects')
      .select(`id, name, description, icon, color, is_pinned, sort_order, initiative_id, status, start_date, target_date, github_repo, environment_id, created_at, updated_at, environment:environment!${PROJECT_ENVIRONMENT_FK}(id, name, network_access)`)
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .single()

    if (result.error) {
      return serverError(result.error.message)
    }
    data = result.data
  }

  // Update labels if provided (full replacement). Only run after we've
  // confirmed via `data` that the project exists in this workspace — the
  // .single() above errors out before we get here if the workspace_id check
  // fails, so reaching this point means we own the project. The label delete
  // itself isn't workspace-scoped (project_label has no workspace_id column),
  // but it's keyed by the project_id we just authorized.
  // New rows go in before old ones come out, so a failed write never leaves
  // the project label-less.
  if (data && labelIds) {
    const { data: current, error: readError } = await supabase
      .from('project_label')
      .select('label_id')
      .eq('project_id', id)
    if (readError) return serverError(readError.message)
    const have = new Set((current ?? []).map((r) => r.label_id as string))
    const keep = new Set(labelIds)
    const toAdd = labelIds.filter((lid) => !have.has(lid))
    const toRemove = [...have].filter((lid) => !keep.has(lid))
    if (toAdd.length > 0) {
      const { error: insertError } = await supabase
        .from('project_label')
        .insert(toAdd.map((lid) => ({ project_id: id, label_id: lid })))
      if (insertError) return serverError(insertError.message)
    }
    if (toRemove.length > 0) {
      const { error: deleteError } = await supabase
        .from('project_label')
        .delete()
        .eq('project_id', id)
        .in('label_id', toRemove)
      if (deleteError) return serverError(deleteError.message)
    }
  }

  // Notify on status change (non-blocking)
  if (body.status !== undefined && body.status !== previousStatus) {
    const actorMember = await getMemberByUserId(workspaceId, user.id)
    if (actorMember) {
      // Notify the project lead if different from actor
      const { data: project } = await supabase
        .from('projects')
        .select('lead_id')
        .eq('id', id)
        .single()

      if (project?.lead_id && project.lead_id !== actorMember.id) {
        createNotification({
          workspaceId,
          recipientId: project.lead_id,
          type: 'project_status_changed',
          title: `Project "${data.name}" is now ${body.status}`,
          actorId: actorMember.id,
          targetType: 'project',
          targetId: id,
          metadata: { new_status: body.status },
        })
      }
    }

    // Fire any Flows tied to this entity status transition. team_id is
    // null for project events — projects are workspace-scoped, not team-
    // scoped — so the matcher won't filter by team.
    inngest
      .send({
        name: 'flow/entity.status_changed',
        data: {
          entity_type: 'project',
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

  // Flatten the joined environment into the same shape GET returns, so the
  // project panel re-renders the linked env name/badge after a link change.
  const { environment: patchedEnv, ...projectRest } = data as typeof data & {
    environment?: { id: string; name: string; network_access: string } | null
  }
  const patchedEnvData = patchedEnv as { id: string; name: string; network_access: string } | null
  return NextResponse.json({
    project: {
      ...projectRest,
      environment_name: patchedEnvData?.name ?? null,
      environment_network_access: patchedEnvData?.network_access ?? null,
    },
  })
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId, member } = auth

  const { id } = await params

  // Deleting a project deletes its captures — but NEVER by a bare row delete.
  // claim_source.source_id and entity_link.{source,target}_id are polymorphic
  // bare UUIDs with NO foreign key (migration 109), so a raw capture delete
  // strands every claim learned only from that recording as evidence-orphaned
  // while its embeddings survive and keep surfacing in RAG. Each capture goes
  // through the same SECURITY DEFINER teardown RPC the single-capture DELETE
  // and the bulk route use (migration 178, re-signed in 237) — it partitions
  // sole-sourced claims from shared ones, hard-deletes the former, prunes the
  // latter's evidence + mirrored edges, and deletes the row, atomically.
  //
  // This ran as `.from('notes').delete()` until the knowledge-pulse fix: the
  // table was renamed to `captures` in migration 025, so the call errored
  // against a nonexistent relation and — with its error never checked —
  // silently no-opped. The captures teardown was really being done by the
  // DB-level `notes_project_id_fkey` ON DELETE CASCADE (the constraint name
  // outlived the rename), which raw-deleted every capture with zero
  // application involvement. The companion migration converts that FK to
  // ON DELETE SET NULL so the project delete below can no longer destroy a
  // capture behind this loop's back.
  //
  // Authorize BEFORE the teardown. projects_delete RLS (migration 028) allows
  // only an owner/admin or the project lead, while any member can see the
  // project; a refused delete matches 0 rows without an error, so checking
  // afterwards would have already destroyed the caller's captures.
  const { data: project, error: projectError } = await supabase
    .from('projects')
    .select('id, lead_id')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (projectError) return serverError(projectError.message)
  if (!project) return notFound('Project not found')
  const canDelete =
    member.role === 'owner' ||
    member.role === 'admin' ||
    (project as { lead_id: string | null }).lead_id === member.id
  if (!canDelete) {
    return forbidden('Only a workspace owner or admin, or the project lead, can delete a project')
  }

  const { data: captureRows, error: capturesError } = await supabase
    .from('captures')
    .select('id')
    .eq('project_id', id)
    .eq('workspace_id', workspaceId)

  if (capturesError) {
    return serverError(capturesError.message)
  }

  // One id's failure must not abort the batch or block the project delete, so
  // we tally per id rather than letting an error unwind the request.
  let capturesDeleted = 0
  let capturesFailed = 0
  for (const row of captureRows || []) {
    const { error: rpcError } = await supabase.rpc('delete_capture_with_knowledge', {
      p_capture_id: row.id,
      p_workspace_id: workspaceId,
      p_user_id: user.id,
    })
    if (!rpcError) {
      capturesDeleted++
      continue
    }
    // P0002 = the row is already gone — nothing left to tear down, not a failure.
    const code = (rpcError as { code?: string }).code
    if (code === 'P0002') continue
    capturesFailed++
    console.error('[projects/[id] DELETE] capture teardown failed', {
      captureId: row.id,
      projectId: id,
      code,
      message: rpcError.message,
    })
  }

  // count: 'exact' so a delete RLS still refused (a role change since the
  // check above) or a concurrent delete is not reported as success.
  const { error, count } = await supabase
    .from('projects')
    .delete({ count: 'exact' })
    .eq('id', id)
    .eq('workspace_id', workspaceId)

  if (error) {
    return serverError(error.message)
  }
  if (!count) {
    const { data: stillVisible } = await supabase
      .from('projects')
      .select('id')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    return stillVisible
      ? forbidden('Only a workspace owner or admin, or the project lead, can delete a project')
      : notFound('Project not found')
  }

  return NextResponse.json({
    success: true,
    captures_deleted: capturesDeleted,
    ...(capturesFailed > 0 ? { captures_failed: capturesFailed } : {}),
  })
}
