import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows, inChunks } from '@/lib/supabase/paging'
import {
  resolveSince,
  resolveUntil,
  timeWindowParams,
  resolveEntityWorkspace,
  resolveCreateWorkspace,
  workspaceEcho,
  type CreateWorkspacePolicy,
} from './_shared'
import { customFieldDefsOrNone, withCustomFields } from '@/lib/crm/custom-fields'

const INITIATIVE_TIME_FIELDS = ['created_at', 'updated_at', 'target_date'] as const

export function createInitiativeTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  strictWorkspace = false,
  // Trailing positional after `strict`, as ./index.ts threads it. 'session'
  // keeps chat byte-identical; the MCP bridge passes 'explicit'.
  createWorkspacePolicy: CreateWorkspacePolicy = 'session',
) {
  return {
    list_initiatives: tool({
      description: "List the workspace's initiatives (strategic objectives/OKRs) with optional filters. Returns progress, project rollup, health, and labels. Use `since`/`until` with `time_field` for time-window queries (e.g. 'initiatives due this quarter').",
      inputSchema: z.object({
        filter: z
          .enum(['all', 'planned', 'active', 'completed', 'archived'])
          .optional()
          .default('active')
          .describe('Status filter'),
        owner_id: z.string().optional().describe('Filter by owner member ID'),
        health: z
          .enum(['on_track', 'at_risk', 'behind', 'not_started', 'completed'])
          .optional()
          .describe('Filter by health status'),
        label_ids: z.array(z.string()).optional().describe('Filter by label IDs'),
        include_archived: z.boolean().optional().default(false).describe('Include archived initiatives'),
        ...timeWindowParams,
        time_field: z
          .enum(INITIATIVE_TIME_FIELDS)
          .optional()
          .default('created_at')
          .describe(
            'Which date column `since`/`until` apply to. Defaults to `created_at`. ' +
              'Use `target_date` for "initiatives due in the next 30 days", `updated_at` for "recently changed".',
          ),
      }),
      execute: async ({ filter, owner_id, health, label_ids, include_archived, since, until, time_field }) => {
        const sinceISO = resolveSince(since)
        const untilISO = resolveUntil(until)
        const timeField = time_field ?? 'created_at'
        let query = supabase
          .from('initiative')
          .select(`
            id, name, description, status, target_date, color, icon, created_at, custom_fields,
            owner:member!owner_id(id, display_name, avatar_url)
          `)
          .eq('workspace_id', workspaceId)
          .order('sort_order', { ascending: true })

        if (filter && filter !== 'all') {
          query = query.eq('status', filter)
        }

        if (!include_archived && filter !== 'archived') {
          query = query.neq('status', 'archived')
        }

        if (owner_id) {
          query = query.eq('owner_id', owner_id)
        }

        if (sinceISO) query = query.gte(timeField, sinceISO)
        if (untilISO) query = query.lte(timeField, untilISO)

        // The workspace's own fields on initiatives (migration 496): one read for the list.
        const [{ data, error }, fieldDefs] = await Promise.all([query, customFieldDefsOrNone(supabase, workspaceId, 'initiative')])

        if (error) return { success: false, error: error.message }

        const initiativeIds = (data || []).map((i) => i.id)
        if (initiativeIds.length === 0) {
          return { success: true, initiatives: [], count: 0 }
        }

        // Parallel enrichment: projects + actions + labels
        const [projectsResult, labelsResult] = await Promise.all([
          supabase
            .from('projects')
            .select('id, initiative_id, status, target_date')
            .eq('workspace_id', workspaceId)
            .in('initiative_id', initiativeIds),
          supabase
            .from('initiative_label')
            .select('initiative_id, label:label!label_id(id, name, color)')
            .in('initiative_id', initiativeIds),
        ])

        // Project stats + action stats
        const projectsByInit: Record<string, { total: number; by_status: Record<string, number>; projectIds: string[] }> = {}
        if (projectsResult.data) {
          for (const p of projectsResult.data) {
            const iid = p.initiative_id as string
            if (!iid) continue
            if (!projectsByInit[iid]) projectsByInit[iid] = { total: 0, by_status: {}, projectIds: [] }
            projectsByInit[iid].total++
            projectsByInit[iid].by_status[p.status as string] = (projectsByInit[iid].by_status[p.status as string] || 0) + 1
            projectsByInit[iid].projectIds.push(p.id)
          }
        }

        const allProjectIds = Object.values(projectsByInit).flatMap((p) => p.projectIds)
        const actionRollup: Record<string, { total: number; completed: number; canceled: number }> = {}

        if (allProjectIds.length > 0) {
          const projectToInit: Record<string, string> = {}
          if (projectsResult.data) {
            for (const p of projectsResult.data) {
              if (p.initiative_id) projectToInit[p.id] = p.initiative_id as string
            }
          }

          // Paged and chunked: an initiative's projects can hold more than one
          // response (1000 rows) of actions, and every project id rides in the URL.
          const { data: actions } = await inChunks(allProjectIds, 100, (ids) =>
            fetchAllRows(() =>
              supabase
                .from('actions')
                .select('id, project_id, workflow_state:workflow_state!status_id(category)')
                .eq('workspace_id', workspaceId)
                .in('project_id', ids),
            ),
          )

          if (actions) {
            for (const a of actions) {
              const iid = projectToInit[a.project_id as string]
              if (!iid) continue
              if (!actionRollup[iid]) actionRollup[iid] = { total: 0, completed: 0, canceled: 0 }
              actionRollup[iid].total++
              const ws = a.workflow_state as unknown as { category: string } | null
              if (ws?.category === 'completed') actionRollup[iid].completed++
              if (ws?.category === 'canceled') actionRollup[iid].canceled++
            }
          }
        }

        // Labels
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

        // Build enriched list
        let initiatives = (data || []).map((i) => {
          const ownerData = i.owner as unknown as { id: string; display_name: string; avatar_url: string | null } | null
          const projStats = projectsByInit[i.id] || { total: 0, by_status: {} }
          const actStats = actionRollup[i.id] || { total: 0, completed: 0, canceled: 0 }
          const denom = actStats.total - actStats.canceled
          const percentage = denom > 0 ? Math.round((actStats.completed / denom) * 100) : 0

          // Health
          const status = i.status as string
          let initHealth: string
          if (status === 'completed') {
            initHealth = 'completed'
          } else if (actStats.total === 0 && projStats.total === 0) {
            initHealth = 'not_started'
          } else {
            // target_date is a date: overdue only once its day has passed
            // (`new Date('YYYY-MM-DD')` is UTC midnight, i.e. overdue on the day).
            const overdue = i.target_date && String(i.target_date).slice(0, 10) < new Date().toISOString().slice(0, 10)
            if (overdue && status !== 'completed') initHealth = 'behind'
            else if (overdue || (percentage < 25 && (projStats.by_status.active || 0) > 0)) initHealth = 'at_risk'
            else initHealth = 'on_track'
          }

          return {
            id: i.id,
            name: i.name,
            description: i.description,
            status: i.status,
            target_date: i.target_date,
            owner: ownerData ? { id: ownerData.id, display_name: ownerData.display_name } : null,
            projects: { total: projStats.total, by_status: projStats.by_status },
            progress: { total_actions: actStats.total, completed_actions: actStats.completed, percentage },
            labels: (labelsMap[i.id] || []).map((l) => ({ id: l.id, name: l.name })),
            health: initHealth,
            ...withCustomFields(fieldDefs, (i as { custom_fields?: unknown }).custom_fields),
          }
        })

        // Post-filter: health
        if (health) {
          initiatives = initiatives.filter((i) => i.health === health)
        }

        // Post-filter: label_ids
        if (label_ids && label_ids.length > 0) {
          initiatives = initiatives.filter((i) =>
            label_ids.some((lid) => i.labels.some((l) => l.id === lid)),
          )
        }

        return {
          success: true,
          initiatives,
          count: initiatives.length,
          ...(sinceISO || untilISO
            ? { time_field: timeField, since: sinceISO, until: untilISO }
            : {}),
        }
      },
    }),

    create_initiative: tool({
      description: 'Create a new initiative (strategic objective/OKR) for the workspace.',
      inputSchema: z.object({
        name: z.string().describe('Name of the initiative'),
        description: z.string().optional().describe('Description'),
        status: z.enum(['planned', 'active', 'completed', 'archived']).optional().describe('Status. Default planned.'),
        target_date: z.string().optional().describe('Target date (ISO 8601)'),
        color: z.string().optional().describe('Color hex code'),
        icon: z.string().optional().describe('Icon name or emoji'),
        owner_id: z.string().optional().describe('Member ID for the owner'),
        label_ids: z.array(z.string()).optional().describe('Label IDs to attach'),
        workspace_id: z
          .string()
          .optional()
          .describe('Workspace to create in. Defaults to the active workspace. Copy it from the workspace_id on rows you read, or from active_workspace.'),
      }),
      execute: async ({ name, description, status, target_date, color, icon, owner_id, label_ids, workspace_id }) => {
        // ROOT create — an initiative has no parent to route by, so the target is
        // the caller's explicit id, or whatever the policy will stand behind.
        const ws = await resolveCreateWorkspace(supabase, userId, workspaceId, workspace_id, {
          strictWorkspace,
          policy: createWorkspacePolicy,
        })
        if (!ws.ok) return ws.error
        const targetWs = ws.workspaceId

        // `owner_id` (a member id) and `label_ids` come from the caller already
        // resolved — this tool looks nothing up by name — so `targetWs` only has
        // to reach the insert below. Nothing else here reads the session
        // workspace.
        const insertData: Record<string, unknown> = {
          workspace_id: targetWs,
          name,
          status: status || 'planned',
        }
        if (description) insertData.description = description
        if (target_date) insertData.target_date = target_date
        if (color) insertData.color = color
        if (icon) insertData.icon = icon
        if (owner_id) insertData.owner_id = owner_id

        const { data, error } = await supabase
          .from('initiative')
          .insert(insertData)
          .select('id, name, status')
          .single()

        if (error) return { success: false, error: error.message }

        // Attach labels
        if (label_ids && label_ids.length > 0) {
          await supabase.from('initiative_label').insert(
            label_ids.map((lid) => ({ initiative_id: data.id, label_id: lid })),
          )
        }

        return {
          success: true,
          initiative: data,
          message: `Created initiative: "${data.name}"`,
          // Echoed so a mis-route shows up in THIS turn, next to the envelope's
          // active_workspace, instead of on the wrong board next week.
          ...workspaceEcho(targetWs, ws.workspaceName),
        }
      },
    }),

    update_initiative: tool({
      description: 'Update an initiative.',
      inputSchema: z.object({
        initiative_id: z.string().optional().describe('UUID of the initiative'),
        name_match: z.string().optional().describe('Initiative name (fuzzy match)'),
        name: z.string().optional().describe('New name'),
        description: z.string().optional().describe('New description'),
        status: z.enum(['planned', 'active', 'completed', 'archived']).optional().describe('New status'),
        target_date: z.string().optional().describe('New target date'),
        color: z.string().optional(),
        icon: z.string().optional(),
        owner_id: z.string().optional().describe('New owner member ID'),
        label_ids: z.array(z.string()).optional().describe('Replace labels with these IDs'),
      }),
      execute: async ({ initiative_id, name_match, name, description, status, target_date, color, icon, owner_id, label_ids }) => {
        let id = initiative_id

        if (!id && name_match) {
          const { data } = await supabase
            .from('initiative')
            .select('id')
            .eq('workspace_id', workspaceId)
            .ilike('name', `%${name_match}%`)
            .limit(1)
            .single()
          id = data?.id
        }

        if (!id) return { success: false, error: 'Initiative not found' }

        const wsResolved = await resolveEntityWorkspace(supabase, userId, 'initiative', id, workspaceId, strictWorkspace)
        if (!wsResolved) return { success: false, error: 'Initiative not found' }

        const updates: Record<string, unknown> = {}
        if (name !== undefined) updates.name = name
        if (description !== undefined) updates.description = description
        if (status !== undefined) updates.status = status
        if (target_date !== undefined) updates.target_date = target_date
        if (color !== undefined) updates.color = color
        if (icon !== undefined) updates.icon = icon
        if (owner_id !== undefined) updates.owner_id = owner_id || null

        if (Object.keys(updates).length > 0) {
          const { data, error } = await supabase
            .from('initiative')
            .update(updates)
            .eq('id', id)
            .eq('workspace_id', wsResolved.workspaceId)
            .select('id, name, status')
            .single()

          if (error) return { success: false, error: error.message }

          // Update labels if provided
          if (label_ids) {
            await supabase.from('initiative_label').delete().eq('initiative_id', id)
            if (label_ids.length > 0) {
              await supabase.from('initiative_label').insert(
                label_ids.map((lid) => ({ initiative_id: id!, label_id: lid })),
              )
            }
          }

          return { success: true, initiative: data, message: `Updated: "${data.name}"` }
        }

        // Labels-only update
        if (label_ids) {
          await supabase.from('initiative_label').delete().eq('initiative_id', id)
          if (label_ids.length > 0) {
            await supabase.from('initiative_label').insert(
              label_ids.map((lid) => ({ initiative_id: id!, label_id: lid })),
            )
          }
          return { success: true, message: 'Labels updated' }
        }

        return { success: false, error: 'No updates provided' }
      },
    }),

    get_initiative: tool({
      description: 'Get full details of an initiative including child projects with individual progress, action rollup, health, and labels.',
      inputSchema: z.object({
        initiative_id: z.string().optional().describe('UUID of the initiative'),
        name: z.string().optional().describe('Initiative name (fuzzy match)'),
      }),
      execute: async ({ initiative_id, name }) => {
        let id = initiative_id

        if (!id && name) {
          const { data } = await supabase
            .from('initiative')
            .select('id')
            .eq('workspace_id', workspaceId)
            .ilike('name', `%${name}%`)
            .limit(1)
            .single()
          id = data?.id
        }

        if (!id) return { success: false, error: 'Initiative not found' }

        const wsResolved = await resolveEntityWorkspace(supabase, userId, 'initiative', id, workspaceId, strictWorkspace)
        if (!wsResolved) return { success: false, error: 'Initiative not found' }

        const { data: initiative, error } = await supabase
          .from('initiative')
          .select(`
            id, name, description, status, target_date, color, icon, created_at, updated_at, custom_fields,
            owner:member!owner_id(id, display_name, avatar_url)
          `)
          .eq('id', id)
          .eq('workspace_id', wsResolved.workspaceId)
          .single()

        if (error) return { success: false, error: error.message }
        const fieldDefs = await customFieldDefsOrNone(supabase, wsResolved.workspaceId, 'initiative')

        // Get child projects + labels in parallel
        const [projectsResult, labelsResult] = await Promise.all([
          supabase
            .from('projects')
            .select('id, name, status, target_date, lead:member!lead_id(id, display_name)')
            .eq('initiative_id', id)
            .eq('workspace_id', wsResolved.workspaceId)
            .order('sort_order', { ascending: true }),
          supabase
            .from('initiative_label')
            .select('label:label!label_id(id, name, color)')
            .eq('initiative_id', id),
        ])

        const projects = projectsResult.data || []
        const projectIds = projects.map((p) => p.id)

        // Action stats per project
        let totalActions = 0
        let completedActions = 0
        let canceledActions = 0
        const projectDetails: Record<string, { total: number; completed: number; canceled: number }> = {}

        if (projectIds.length > 0) {
          const { data: actions } = await inChunks(projectIds, 100, (ids) =>
            fetchAllRows(() =>
              supabase
                .from('actions')
                .select('id, project_id, workflow_state:workflow_state!status_id(category)')
                .eq('workspace_id', wsResolved.workspaceId)
                .in('project_id', ids),
            ),
          )

          if (actions) {
            for (const a of actions) {
              const pid = a.project_id as string
              if (!projectDetails[pid]) projectDetails[pid] = { total: 0, completed: 0, canceled: 0 }
              projectDetails[pid].total++
              totalActions++
              const ws = a.workflow_state as unknown as { category: string } | null
              if (ws?.category === 'completed') { projectDetails[pid].completed++; completedActions++ }
              if (ws?.category === 'canceled') { projectDetails[pid].canceled++; canceledActions++ }
            }
          }
        }

        const denom = totalActions - canceledActions
        const percentage = denom > 0 ? Math.round((completedActions / denom) * 100) : 0

        // Health
        const status = initiative.status as string
        let health: string
        if (status === 'completed') health = 'completed'
        else if (totalActions === 0 && projects.length === 0) health = 'not_started'
        else {
          const overdue = initiative.target_date
            && String(initiative.target_date).slice(0, 10) < new Date().toISOString().slice(0, 10)
          const byStatus: Record<string, number> = {}
          for (const p of projects) byStatus[p.status as string] = (byStatus[p.status as string] || 0) + 1
          if (overdue && status !== 'completed') health = 'behind'
          else if (overdue || (percentage < 25 && (byStatus.active || 0) > 0)) health = 'at_risk'
          else health = 'on_track'
        }

        const ownerData = initiative.owner as unknown as { id: string; display_name: string; avatar_url: string | null } | null
        const labels = (labelsResult.data || [])
          .map((row) => row.label as unknown as { id: string; name: string; color: string } | null)
          .filter(Boolean)

        // Enriched projects
        const enrichedProjects = projects.map((p) => {
          const leadData = p.lead as unknown as { id: string; display_name: string } | null
          const pStats = projectDetails[p.id] || { total: 0, completed: 0, canceled: 0 }
          const pDenom = pStats.total - pStats.canceled
          return {
            id: p.id,
            name: p.name,
            status: p.status,
            target_date: p.target_date,
            lead: leadData ? leadData.display_name : null,
            progress: {
              total_actions: pStats.total,
              completed_actions: pStats.completed,
              percentage: pDenom > 0 ? Math.round((pStats.completed / pDenom) * 100) : 0,
            },
          }
        })

        return {
          success: true,
          initiative: {
            id: initiative.id,
            name: initiative.name,
            description: initiative.description,
            status: initiative.status,
            target_date: initiative.target_date,
            owner: ownerData ? { id: ownerData.id, display_name: ownerData.display_name } : null,
            health,
            progress: {
              total_actions: totalActions,
              completed_actions: completedActions,
              percentage,
            },
            projects: enrichedProjects,
            labels,
            // The workspace's own fields on initiatives (migration 496), the set ones, by name.
            ...withCustomFields(fieldDefs, (initiative as { custom_fields?: unknown }).custom_fields),
          },
        }
      },
    }),
  }
}
