import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  resolveSince,
  resolveUntil,
  timeWindowParams,
  resolveEntityWorkspace,
  resolveCreateWorkspace,
  workspaceEcho,
  applyCaptureVisibility,
  captureRequester,
  readGrants,
  grantReader,
  FUZZY_MATCH_LIMIT,
  listMatches,
  soleMatch,
  type CreateWorkspacePolicy,
} from './_shared'
import { orderByUrgency } from '@/lib/actions/urgency'
import { customFieldDefsOrNone, withCustomFields } from '@/lib/crm/custom-fields'
import { toIlikeSearchTerm } from '@/lib/crm/ilike-search-term'
import { countsAsWork, filterOpenWork, loadClosedStates } from '@/lib/actions/open-work'

const PROJECT_TIME_FIELDS = ['created_at', 'updated_at', 'target_date', 'start_date'] as const

/** How many open actions `get_project_context` lists; the total rides alongside. */
const PROJECT_CONTEXT_ACTION_CAP = 20

/**
 * `list_projects` reads its projects' actions a page at a time (PostgREST
 * returns at most 1,000 rows a request) for their progress, up to this many in
 * all; past it the result says the counts are partial.
 */
export const PROJECT_STATS_PAGE = 1000
export const PROJECT_STATS_MAX_ROWS = 5000

export function createProjectTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  strictWorkspace = false,
  omitPrivateCaptures = false,
  // Trailing positional, after `strict` / `omitPrivate`, exactly as ./index.ts
  // threads the others. 'session' keeps chat byte-identical; the MCP bridge
  // passes 'explicit' so a create with no `workspace_id` refuses rather than
  // silently landing in a connector's months-old active workspace.
  createWorkspacePolicy: CreateWorkspacePolicy = 'session',
  // A guest's or a linked agent's turn (CreateToolsOptions.omitGrants): what
  // was shared with the person stays theirs, never their guest's.
  omitGrants = false,
) {
  // get_project_context reads captures on a service-role client (MCP / unattended
  // runs), so this requester — not RLS — is the real enforcement.
  const requester = captureRequester(userId, omitPrivateCaptures)
  return {
    list_projects: tool({
      description: "List the workspace's projects (everyone's, not just the user's) with progress, milestones, and lead info. Projects are workspace-scoped and can contain notes, actions, and milestones. Use this to answer questions like 'which projects are behind schedule?', 'what's the progress on X?', 'show active projects under initiative Y', 'which projects does someone lead?'. Use `since`/`until` with `time_field` for time-window queries (e.g. 'projects created in the past 30 days').",
      inputSchema: z.object({
        include_archived: z
          .boolean()
          .optional()
          .default(false)
          .describe('Include archived projects'),
        status: z
          .enum(['all', 'planned', 'active', 'paused', 'completed', 'canceled'])
          .optional()
          .default('all')
          .describe('Filter by project status'),
        initiative_id: z.string().optional().describe('Filter by initiative UUID'),
        lead_id: z.string().optional().describe('Filter by project lead (member UUID)'),
        search: z.string().optional().describe('Search project name or description'),
        ...timeWindowParams,
        time_field: z
          .enum(PROJECT_TIME_FIELDS)
          .optional()
          .default('created_at')
          .describe(
            'Which date column `since`/`until` apply to. Defaults to `created_at`. ' +
              'Use `target_date` for "projects due next month", `updated_at` for "recently updated", `start_date` for "started in".',
          ),
      }),
      execute: async ({ include_archived, status, initiative_id, lead_id, search, since, until, time_field }) => {
        const sinceISO = resolveSince(since)
        const untilISO = resolveUntil(until)
        const timeField = time_field ?? 'created_at'
        let query = supabase
          .from('projects')
          .select(`
            id, workspace_id, name, description, icon, color, is_pinned, is_archived, status, initiative_id, start_date, target_date, created_at, custom_fields,
            lead:member!lead_id(id, display_name, avatar_url),
            initiative:initiative!initiative_id(id, name)
          `)
          // Workspace-wide, not creator-scoped: every member may read every
          // project (RLS), so a teammate's project lists like the caller's own.
          .eq('workspace_id', workspaceId)
          .neq('name', '__default__')
          .order('is_pinned', { ascending: false })
          .order('name')

        if (!include_archived) {
          query = query.eq('is_archived', false)
        }

        if (status && status !== 'all') {
          query = query.eq('status', status)
        }

        if (initiative_id) {
          query = query.eq('initiative_id', initiative_id)
        }

        if (lead_id) {
          query = query.eq('lead_id', lead_id)
        }

        // Model-supplied text goes into a raw PostgREST `.or()` tree: strip the
        // characters that would end the condition or add new ones.
        const safeSearch = search ? toIlikeSearchTerm(search) : ''
        if (safeSearch) {
          query = query.or(`name.ilike.%${safeSearch}%,description.ilike.%${safeSearch}%`)
        }

        if (sinceISO) query = query.gte(timeField, sinceISO)
        if (untilISO) query = query.lte(timeField, untilISO)

        // The workspace's own fields on projects (migration 496): one read for the list.
        const [{ data, error }, fieldDefs] = await Promise.all([query, customFieldDefsOrNone(supabase, workspaceId, 'project')])

        if (error) return { success: false, error: error.message }

        const projectIds = (data || []).map(p => p.id)

        // Enrich with action progress: the projects' actions that count as
        // work (src/lib/actions/open-work.ts: top level, not dismissed, so a
        // sub-action or a rejected proposal never moves the bar), read a page
        // at a time in a stable order, up to PROJECT_STATS_MAX_ROWS.
        const actionStats: Record<string, { total: number; completed: number; canceled: number }> = {}
        let statsPartial = false
        if (projectIds.length > 0) {
          for (let from = 0; ; from += PROJECT_STATS_PAGE) {
            const { data: page, error: statsError } = await supabase
              .from('actions')
              .select('id, project_id, parent_id, confirmation, workflow_state:workflow_state!status_id(category)')
              .eq('workspace_id', workspaceId)
              .in('project_id', projectIds)
              .is('parent_id', null)
              .neq('confirmation', 'dismissed')
              .order('id', { ascending: true })
              .range(from, from + PROJECT_STATS_PAGE - 1)
            if (statsError || !page) break
            for (const a of page) {
              if (!countsAsWork(a)) continue
              const pid = a.project_id as string
              if (!actionStats[pid]) actionStats[pid] = { total: 0, completed: 0, canceled: 0 }
              actionStats[pid].total++
              const ws = a.workflow_state as unknown as { category: string } | null
              if (ws?.category === 'completed') actionStats[pid].completed++
              if (ws?.category === 'canceled') actionStats[pid].canceled++
            }
            if (page.length < PROJECT_STATS_PAGE) break
            if (from + PROJECT_STATS_PAGE >= PROJECT_STATS_MAX_ROWS) {
              statsPartial = true
              break
            }
          }
        }

        // Enrich with milestones summary
        let milestonesMap: Record<string, { total: number; completed: number; next: string | null }> = {}
        if (projectIds.length > 0) {
          const { data: milestones } = await supabase
            .from('milestone')
            .select('project_id, name, status, sort_order')
            .in('project_id', projectIds)
            .order('sort_order', { ascending: true })
          if (milestones) {
            for (const m of milestones) {
              const pid = m.project_id as string
              if (!milestonesMap[pid]) milestonesMap[pid] = { total: 0, completed: 0, next: null }
              milestonesMap[pid].total++
              if (m.status === 'completed') milestonesMap[pid].completed++
              if (!milestonesMap[pid].next && m.status !== 'completed') {
                milestonesMap[pid].next = m.name
              }
            }
          }
        }

        const projects = (data || []).map(p => {
          const leadData = p.lead as unknown as { id: string; display_name: string } | null
          const initData = p.initiative as unknown as { id: string; name: string } | null
          const stats = actionStats[p.id] || { total: 0, completed: 0, canceled: 0 }
          const denom = stats.total - stats.canceled
          const ms = milestonesMap[p.id] || { total: 0, completed: 0, next: null }
          const isOverdue = p.target_date && p.status !== 'completed' && p.status !== 'canceled' && String(p.target_date).slice(0, 10) < new Date().toISOString().slice(0, 10)

          return {
            id: p.id,
            // Each row names its own workspace — the active workspace is not a
            // safe inference for an agent holding a row.
            workspace_id: p.workspace_id,
            name: p.name,
            description: p.description,
            status: p.status,
            start_date: p.start_date,
            target_date: p.target_date,
            is_overdue: !!isOverdue,
            lead: leadData?.display_name || null,
            initiative: initData?.name || null,
            progress_pct: denom > 0 ? Math.round((stats.completed / denom) * 100) : 0,
            actions: `${stats.completed}/${stats.total} (${stats.canceled} canceled)`,
            milestones: `${ms.completed}/${ms.total}`,
            next_milestone: ms.next,
            is_pinned: p.is_pinned,
            ...withCustomFields(fieldDefs, (p as { custom_fields?: unknown }).custom_fields),
          }
        })

        return {
          success: true,
          projects,
          count: projects.length,
          ...(statsPartial
            ? {
                progress_partial: `Progress counts cover the first ${PROJECT_STATS_MAX_ROWS} actions across these projects. Narrow with search, status or lead_id, or read one project's actions with list_actions and its project_id.`,
              }
            : {}),
          ...(sinceISO || untilISO
            ? { time_field: timeField, since: sinceISO, until: untilISO }
            : {}),
        }
      },
    }),

    create_project: tool({
      description: 'Create a new project.',
      inputSchema: z.object({
        name: z.string().describe('Project name'),
        description: z.string().optional().describe('Project description'),
        icon: z.string().optional().describe('Emoji character for the project icon (e.g. "🚀", "📋"). Must be an actual emoji, not a text name.'),
        color: z.string().optional().describe('Color hex code'),
        initiative_id: z.string().optional().describe('UUID of parent initiative'),
        lead_id: z.string().optional().describe('UUID of project lead (member)'),
        status: z.enum(['planned', 'active', 'paused', 'completed', 'canceled']).optional().describe('Project status. Default active.'),
        start_date: z.string().optional().describe('Start date (ISO 8601)'),
        target_date: z.string().optional().describe('Target date (ISO 8601)'),
        label_ids: z
          .array(z.string())
          .optional()
          .describe('Label IDs to attach. Use list_labels (scope: "project") to find available labels.'),
        workspace_id: z
          .string()
          .optional()
          .describe('Workspace to create in. Defaults to the active workspace. Copy it from the workspace_id on rows you read, or from active_workspace.'),
      }),
      execute: async ({ name, description, icon, color, initiative_id, lead_id, status, start_date, target_date, label_ids, workspace_id }) => {
        // ROOT create: nothing existing routes this row, so the target is either
        // named by the caller or decided by the policy. Both failure modes
        // ('Workspace not found' for a non-member id, `needs_workspace` when an
        // 'explicit'-policy caller belongs to several) come back ready to return.
        const ws = await resolveCreateWorkspace(supabase, userId, workspaceId, workspace_id, {
          strictWorkspace,
          policy: createWorkspacePolicy,
        })
        if (!ws.ok) return ws.error
        const targetWs = ws.workspaceId

        // Nothing below needs re-pointing at `targetWs`: create_project resolves
        // NO name to an id of its own. `initiative_id`, `lead_id` and `label_ids`
        // arrive as ids the caller copied off rows it read, so there is no
        // session-scoped lookup here that could write a session-workspace FK onto
        // a row in another tenant (contrast create_action's default team / state).
        const insertData: Record<string, unknown> = {
          user_id: userId,
          workspace_id: targetWs,
          name,
          is_archived: false,
          status: status || 'active',
        }
        if (description) insertData.description = description
        if (icon) insertData.icon = icon
        if (color) insertData.color = color
        if (initiative_id) insertData.initiative_id = initiative_id
        if (lead_id) insertData.lead_id = lead_id
        if (start_date) insertData.start_date = start_date
        if (target_date) insertData.target_date = target_date

        const { data, error } = await supabase
          .from('projects')
          .insert(insertData)
          .select('id, name, status')
          .single()

        if (error) return { success: false, error: error.message }

        // Attach labels
        if (label_ids && label_ids.length > 0) {
          await supabase.from('project_label').insert(
            label_ids.map((lid) => ({ project_id: data.id, label_id: lid })),
          )
        }

        return {
          success: true,
          project: data,
          message: `Created project: "${data.name}"`,
          // Compare against `active_workspace` on the same response: that
          // difference is the only in-turn evidence of a routed (or mis-routed)
          // create.
          ...workspaceEcho(targetWs, ws.workspaceName),
        }
      },
    }),

    update_project: tool({
      description: 'Update a project.',
      inputSchema: z.object({
        project_id: z.string().optional().describe('UUID of the project'),
        name_match: z.string().optional().describe('Project name (fuzzy match)'),
        name: z.string().optional().describe('New name'),
        description: z.string().optional().describe('New description'),
        status: z.enum(['planned', 'active', 'paused', 'completed', 'canceled']).optional(),
        initiative_id: z.string().optional().describe('UUID of parent initiative (empty string to unlink)'),
        lead_id: z.string().optional().describe('UUID of project lead (empty string to unset)'),
        start_date: z.string().optional(),
        target_date: z.string().optional(),
        icon: z.string().optional(),
        color: z.string().optional(),
        label_ids: z
          .array(z.string())
          .optional()
          .describe('Replace all labels with these IDs. Pass an empty array to remove all labels. Omit to leave labels unchanged.'),
      }),
      execute: async ({ project_id, name_match, name, description, status, initiative_id, lead_id, start_date, target_date, icon, color, label_ids }) => {
        let id = project_id

        if (!id && name_match) {
          // Any member may update any project (RLS), so the name is matched
          // across the workspace. `__default__` is each person's hidden
          // catch-all project, never a name anyone means.
          const { data } = await supabase
            .from('projects')
            .select('id, name')
            .eq('workspace_id', workspaceId)
            .neq('name', '__default__')
            .ilike('name', `%${name_match}%`)
            .limit(FUZZY_MATCH_LIMIT)
          const rows = (data || []) as Array<{ id: string; name: string }>
          id = soleMatch(rows, (r) => r.name, name_match)?.id
          if (!id && rows.length > 1) {
            return {
              success: false,
              error: `"${name_match}" matches several projects: ${listMatches(rows.map((r) => `"${r.name}" (${r.id})`))}. Pass project_id.`,
            }
          }
        }

        if (!id) return { success: false, error: 'Project not found' }

        const wsResolved = await resolveEntityWorkspace(supabase, userId, 'projects', id, workspaceId, strictWorkspace)
        if (!wsResolved) return { success: false, error: 'Project not found' }

        const updates: Record<string, unknown> = {}
        if (name !== undefined) updates.name = name
        if (description !== undefined) updates.description = description
        if (status !== undefined) updates.status = status
        if (initiative_id !== undefined) updates.initiative_id = initiative_id || null
        if (lead_id !== undefined) updates.lead_id = lead_id || null
        if (start_date !== undefined) updates.start_date = start_date
        if (target_date !== undefined) updates.target_date = target_date
        if (icon !== undefined) updates.icon = icon
        if (color !== undefined) updates.color = color

        // Apply column updates only if there are any — a label-only update
        // would otherwise send an empty patch to Postgres.
        let project: { id: string; name: string; status: string } | null = null
        if (Object.keys(updates).length > 0) {
          const { data, error } = await supabase
            .from('projects')
            .update(updates)
            .eq('id', id)
            .eq('workspace_id', wsResolved.workspaceId)
            .select('id, name, status')
            .single()
          if (error) return { success: false, error: error.message }
          project = data
        } else {
          const { data, error } = await supabase
            .from('projects')
            .select('id, name, status')
            .eq('id', id)
            .eq('workspace_id', wsResolved.workspaceId)
            .single()
          if (error) return { success: false, error: error.message }
          project = data
        }

        // Replace labels if provided (omit = keep existing, [] = remove all,
        // [...] = replace). Mirrors update_action / update_initiative.
        if (label_ids !== undefined) {
          await supabase.from('project_label').delete().eq('project_id', id)
          if (label_ids.length > 0) {
            await supabase.from('project_label').insert(
              label_ids.map((lid) => ({ project_id: id!, label_id: lid })),
            )
          }
        }

        return { success: true, project, message: `Updated: "${project?.name}"` }
      },
    }),

    get_project_context: tool({
      description:
        'Get summary context for a project: the project, its milestones, its last 10 notes, and its open actions (the 20 most urgent, urgent first then earliest due, each with its `confirmation`, plus `open_actions_total`; `list_actions` with `project_id` lists the rest).',
      inputSchema: z.object({
        project_id: z.string().describe('UUID of the project'),
      }),
      execute: async ({ project_id }) => {
        const wsResolved = await resolveEntityWorkspace(supabase, userId, 'projects', project_id, workspaceId, strictWorkspace)
        if (!wsResolved) return { success: false, error: 'Project not found' }

        const [{ data: projectRow, error: projectError }, fieldDefs, grants] = await Promise.all([
          supabase
            .from('projects')
            .select('id, workspace_id, name, description, status, start_date, target_date, custom_fields')
            .eq('id', project_id)
            .eq('workspace_id', wsResolved.workspaceId)
            .single(),
          customFieldDefsOrNone(supabase, wsResolved.workspaceId, 'project'),
          // Private captures shared with the person (a grant, 492): a read.
          readGrants(supabase, grantReader(requester, omitGrants), wsResolved.workspaceId, ['capture']),
        ])

        if (projectError) return { success: false, error: projectError.message }
        // The workspace's own fields on projects (migration 496), the set ones, by name.
        const { custom_fields: projectFieldValues, ...projectFields } = (projectRow ?? {}) as Record<string, unknown>
        const project = projectRow ? { ...projectFields, ...withCustomFields(fieldDefs, projectFieldValues) } : projectRow

        // Get recent captures the requester may see (a private capture keeps its
        // project_id, so this predicate is what keeps its title out of the result).
        const { data: notes } = await applyCaptureVisibility(
          supabase
            .from('captures')
            .select('id, title, created_at')
            .eq('project_id', project_id)
            .eq('workspace_id', wsResolved.workspaceId)
            .neq('status', 'archived')
            .order('created_at', { ascending: false })
            .limit(10),
          requester,
          undefined,
          grants.capture,
        )

        // Get milestones
        const { data: milestones } = await supabase
          .from('milestone')
          .select('id, name, status, target_date')
          .eq('project_id', project_id)
          .order('sort_order', { ascending: true })

        // The project's open actions, the same set `list_actions {project_id}`
        // returns by default (src/lib/actions/open-work.ts: top level, not
        // dismissed, not in a closed state). The state filter runs in the
        // query, BEFORE the cap: filtering after a 20-row cap under-reported
        // open work whenever finished rows filled it. Excluding the closed
        // states, rather than an inner join on the open ones, keeps a row
        // whose state doesn't resolve.
        const closedStates = await loadClosedStates(supabase, wsResolved.workspaceId)
        const { data: actions, count: openTotal } = await orderByUrgency(
          filterOpenWork(
            supabase
              .from('actions')
              .select('id, identifier, title, priority, due_at, assignee_id, confirmation, workflow_state:workflow_state!status_id(name, category)', {
                count: 'exact',
              })
              .eq('workspace_id', wsResolved.workspaceId)
              .eq('project_id', project_id),
            { closedStateIds: closedStates.ids },
          ),
        ).limit(PROJECT_CONTEXT_ACTION_CAP)

        const activeActions = (actions || []).map((a) => ({
          id: a.id,
          identifier: a.identifier,
          title: a.title,
          priority: a.priority,
          due_at: a.due_at,
          assignee_id: a.assignee_id,
          status: (a.workflow_state as unknown as { name: string } | null)?.name || '',
          // A meeting's proposal nobody accepted yet is 'suggested'.
          confirmation: a.confirmation,
        }))
        const openActionsTotal = openTotal ?? activeActions.length

        return {
          success: true,
          project,
          recent_notes: notes || [],
          milestones: milestones || [],
          active_actions: activeActions,
          open_actions_total: openActionsTotal,
          ...(openActionsTotal > activeActions.length
            ? {
                more_open_actions: `Showing the ${activeActions.length} most urgent of ${openActionsTotal} open actions. list_actions with project_id ${project_id} lists them all.`,
              }
            : {}),
        }
      },
    }),

    list_milestones: tool({
      description: 'List milestones for a project.',
      inputSchema: z.object({
        project_id: z.string().describe('UUID of the project'),
      }),
      execute: async ({ project_id }) => {
        // `milestone` carries no workspace_id — the project is the only fence, and
        // this is an id-ANCHORED read (not a list with an active-workspace
        // default), so it routes by the parent like every other id-bearing tool.
        // Under strictWorkspace a project elsewhere reads as not-found.
        const parent = await resolveEntityWorkspace(supabase, userId, 'projects', project_id, workspaceId, strictWorkspace)
        if (!parent) return { success: false, error: 'Project not found' }

        const { data, error } = await supabase
          .from('milestone')
          .select('id, name, description, status, target_date, sort_order')
          .eq('project_id', project_id)
          .order('sort_order', { ascending: true })

        if (error) return { success: false, error: error.message }
        return {
          success: true,
          milestones: data,
          count: data?.length || 0,
          // The parent may live in another workspace the user belongs to; say so
          // rather than leaving the active one as the only inference.
          workspace_id: parent.workspaceId,
        }
      },
    }),

    create_milestone: tool({
      description: 'Create a milestone under a project.',
      inputSchema: z.object({
        name: z.string().describe('Milestone name'),
        project_id: z.string().optional().describe('UUID of the parent project'),
        project_name: z.string().optional().describe('Parent project name (fuzzy match)'),
        description: z.string().optional(),
        target_date: z.string().optional().describe('Target date (ISO 8601)'),
      }),
      execute: async ({ name, project_id, project_name, description, target_date }) => {
        let pid = project_id

        if (!pid && project_name) {
          // A NAME, unlike an id, stays pinned to the active workspace: "Apollo"
          // can exist in three tenants at once, so fanning the fuzzy match out
          // would pick one of them at random. Within the workspace it matches
          // everyone's projects except the hidden `__default__` ones.
          const { data } = await supabase
            .from('projects')
            .select('id, name')
            .eq('workspace_id', workspaceId)
            .neq('name', '__default__')
            .ilike('name', `%${project_name}%`)
            .limit(FUZZY_MATCH_LIMIT)
          const rows = (data || []) as Array<{ id: string; name: string }>
          pid = soleMatch(rows, (r) => r.name, project_name)?.id
          if (!pid && rows.length > 1) {
            return {
              success: false,
              error: `"${project_name}" matches several projects: ${listMatches(rows.map((r) => `"${r.name}" (${r.id})`))}. Pass project_id.`,
            }
          }
        }

        if (!pid) return { success: false, error: 'Project not found' }

        // PARENT-ANCHORED create: a milestone has no workspace_id column, it
        // inherits its tenant through project_id. So there is no `workspace_id`
        // param and no policy question — the PARENT decides, and routing it
        // through resolveEntityWorkspace is what stops a project id from another
        // workspace being adopted by the session's. Strict runs: not-found.
        const parent = await resolveEntityWorkspace(supabase, userId, 'projects', pid, workspaceId, strictWorkspace)
        if (!parent) return { success: false, error: 'Project not found' }

        const { data, error } = await supabase
          .from('milestone')
          .insert({
            project_id: pid,
            name,
            description: description || null,
            target_date: target_date || null,
            status: 'pending',
          })
          .select('id, name, status')
          .single()

        if (error) return { success: false, error: error.message }
        return {
          success: true,
          milestone: data,
          message: `Created milestone: "${data.name}"`,
          // The row itself names no workspace, so the echo is the ONLY way the
          // agent (or the MCP audit trail) can see which tenant it landed in.
          ...workspaceEcho(parent.workspaceId),
        }
      },
    }),

    update_milestone: tool({
      description: 'Update a milestone.',
      inputSchema: z.object({
        milestone_id: z.string().describe('UUID of the milestone'),
        name: z.string().optional(),
        description: z.string().optional(),
        target_date: z.string().optional(),
        status: z.enum(['pending', 'in_progress', 'completed']).optional(),
      }),
      execute: async ({ milestone_id, name, description, target_date, status }) => {
        // Route by the PARENT: `milestone` has no workspace_id, so the project is
        // both the fence and the router. This used to pin the parent to the
        // session workspace, which made a milestone the user can plainly see in
        // another workspace un-editable by id; resolveEntityWorkspace follows it
        // there after a membership check, and returns null (→ the same
        // not-found as a bogus id) under strictWorkspace or for a non-member.
        const { data: milestone } = await supabase
          .from('milestone')
          .select('id, project_id')
          .eq('id', milestone_id)
          .maybeSingle()
        if (!milestone?.project_id) return { success: false, error: 'Milestone not found' }

        const parent = await resolveEntityWorkspace(supabase, userId, 'projects', milestone.project_id as string, workspaceId, strictWorkspace)
        if (!parent) return { success: false, error: 'Milestone not found' }

        const updates: Record<string, unknown> = {}
        if (name !== undefined) updates.name = name
        if (description !== undefined) updates.description = description
        if (target_date !== undefined) updates.target_date = target_date
        if (status !== undefined) updates.status = status

        const { data, error } = await supabase
          .from('milestone')
          .update(updates)
          .eq('id', milestone_id)
          .select('id, name, status')
          .single()

        if (error) return { success: false, error: error.message }
        // No workspace column to re-scope on the write itself — `parent` IS the
        // scope check — so report where the edit actually landed.
        return { success: true, milestone: data, workspace_id: parent.workspaceId }
      },
    }),
  }
}
