import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveSince, resolveUntil, timeWindowParams, workspaceEcho } from './_shared'
import type { CreateWorkspacePolicy } from './_shared'
import { orderByUrgency } from '@/lib/actions/urgency'

const CYCLE_TIME_FIELDS = ['start_date', 'end_date', 'created_at'] as const

/**
 * @param createWorkspacePolicy accepted so ./index.ts threads every create-bearing
 *   factory identically, and INERT here by construction: `create_cycle` is
 *   PARENT-anchored — its `team_id` names the workspace outright — so there is no
 *   ambiguous fallback for a policy to arbitrate. See {@link resolveTeamWorkspace}.
 */
export function createCycleTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  strictWorkspace = false,
  createWorkspacePolicy: CreateWorkspacePolicy = 'session',
) {
  /**
   * The workspace a team lives in, or null when the caller may not reach it.
   *
   * This is the routing anchor for every cycle tool: a `cycle` row carries no
   * workspace_id of its own (migration 024) — it inherits scope from its team —
   * so the team IS the tenant. Membership is checked on the `member` table
   * because these tools can run on a service-role client (MCP), where RLS
   * bypasses mean this probe is the only fence.
   *
   * `strictWorkspace` short-circuits the probe entirely: for a run fenced to one
   * workspace a foreign team must read as not-found, and even the probe's
   * timing would be an existence oracle for another tenant's team ids.
   */
  const resolveTeamWorkspace = async (teamId: string | null | undefined): Promise<string | null> => {
    if (!teamId) return null
    const { data: team } = await supabase
      .from('team')
      .select('workspace_id')
      .eq('id', teamId)
      .single()

    const teamWs = (team as { workspace_id?: string } | null)?.workspace_id
    if (!teamWs) return null
    if (teamWs === workspaceId) return teamWs
    if (strictWorkspace) return null

    const { data: membership } = await supabase
      .from('member')
      .select('id')
      .eq('user_id', userId)
      .eq('workspace_id', teamWs)
      .maybeSingle()

    return membership ? teamWs : null
  }

  /** Resolve the default team for the workspace */
  async function getDefaultTeamId() {
    const { data } = await supabase
      .from('team')
      .select('id')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: true })
      .limit(1)
      .single()
    return data?.id as string | undefined
  }

  return {
    list_cycles: tool({
      description: 'List cycles (sprints) for a team. Returns name, number, status, date range, and action stats. Use `since`/`until` with `time_field` for time-window queries (e.g. "cycles that started in the past 90 days").',
      inputSchema: z.object({
        team_id: z.string().optional().describe("UUID of the team. Defaults to user's first team."),
        status: z.enum(['upcoming', 'active', 'completed']).optional().describe('Filter by status'),
        ...timeWindowParams,
        time_field: z
          .enum(CYCLE_TIME_FIELDS)
          .optional()
          .default('start_date')
          .describe(
            'Which date column `since`/`until` apply to. Defaults to `start_date`. ' +
              'Use `end_date` for "cycles ending this week" or `created_at` for "recently planned".',
          ),
      }),
      execute: async ({ team_id, status, since, until, time_field }) => {
        const teamId = team_id || (await getDefaultTeamId())
        if (!teamId) return { success: false, error: 'No team found in workspace' }
        // A model-supplied team_id is the tenant anchor (cycle rows carry no
        // workspace_id): prove the caller may reach that team's workspace before
        // reading its cycles, as create/start/complete do.
        const teamWs = await resolveTeamWorkspace(teamId)
        if (!teamWs) return { success: false, error: 'Team not found' }

        const sinceISO = resolveSince(since)
        const untilISO = resolveUntil(until)
        const timeField = time_field ?? 'start_date'

        let query = supabase
          .from('cycle')
          .select('id, name, number, start_date, end_date, status, created_at')
          .eq('team_id', teamId)

        if (status) query = query.eq('status', status)
        if (sinceISO) query = query.gte(timeField, sinceISO)
        if (untilISO) query = query.lte(timeField, untilISO)
        query = query.order('number', { ascending: false })

        const { data: cycles, error } = await query
        if (error) return { success: false, error: error.message }

        // Compute stats
        const cycleIds = (cycles || []).map((c) => c.id)
        const statsMap: Record<string, { total: number; completed: number; in_progress: number; not_started: number }> = {}

        if (cycleIds.length > 0) {
          // Page past PostgREST's 1000-row cap: a long-running team's cycles
          // together easily hold more actions than one response returns.
          const PAGE = 1000
          const actions: Array<{ cycle_id: unknown; workflow_state: unknown }> = []
          for (let from = 0; ; from += PAGE) {
            const { data: page, error: statsError } = await supabase
              .from('actions')
              .select('id, cycle_id, workflow_state:workflow_state!status_id(category)')
              .eq('workspace_id', teamWs)
              .in('cycle_id', cycleIds)
              .neq('confirmation', 'dismissed')
              .order('id', { ascending: true })
              .range(from, from + PAGE - 1)
            if (statsError) return { success: false, error: statsError.message }
            actions.push(...(page || []))
            if (!page || page.length < PAGE) break
          }

          for (const a of actions) {
            const cid = a.cycle_id as string
            if (!statsMap[cid]) statsMap[cid] = { total: 0, completed: 0, in_progress: 0, not_started: 0 }
            statsMap[cid].total++
            const cat = (a.workflow_state as unknown as { category: string } | null)?.category
            if (cat === 'completed' || cat === 'canceled') statsMap[cid].completed++
            else if (cat === 'started') statsMap[cid].in_progress++
            else statsMap[cid].not_started++
          }
        }

        const result = (cycles || []).map((c) => ({
          ...c,
          total_actions: statsMap[c.id]?.total || 0,
          completed_actions: statsMap[c.id]?.completed || 0,
          in_progress_actions: statsMap[c.id]?.in_progress || 0,
          not_started_actions: statsMap[c.id]?.not_started || 0,
        }))

        return {
          success: true,
          cycles: result,
          count: result.length,
          ...(sinceISO || untilISO
            ? { time_field: timeField, since: sinceISO, until: untilISO }
            : {}),
        }
      },
    }),

    create_cycle: tool({
      description: 'Create a new cycle (sprint) for a team. Number and name are auto-generated if not provided.',
      inputSchema: z.object({
        team_id: z.string().describe('UUID of the team'),
        start_date: z.string().describe('Start date (YYYY-MM-DD)'),
        end_date: z.string().describe('End date (YYYY-MM-DD)'),
        name: z.string().optional().describe('Custom name (defaults to "Cycle N")'),
      }),
      execute: async ({ team_id, start_date, end_date, name }) => {
        // PARENT-ANCHORED CREATE: `team_id` already names the tenant, so this
        // create has nothing to disambiguate and takes no `workspace_id` param —
        // it simply acts in the team's workspace, once membership there is
        // proven. (`cycle` rows carry no workspace_id of their own, and the
        // insert below writes a caller-supplied team_id with no predicate at
        // all, so without this probe a service-role caller could plant a sprint
        // in any workspace whose team id it could name.)
        const teamWs = await resolveTeamWorkspace(team_id)
        if (!teamWs) return { success: false, error: 'Team not found' }

        if (new Date(end_date) <= new Date(start_date)) {
          return { success: false, error: 'end_date must be after start_date' }
        }

        const insertData: Record<string, unknown> = { team_id, start_date, end_date }
        if (name?.trim()) insertData.name = name.trim()

        const { data, error } = await supabase
          .from('cycle')
          .insert(insertData)
          .select()
          .single()

        if (error) return { success: false, error: error.message }
        // Echo the workspace the cycle actually landed in. A cycle row has no
        // workspace_id to carry it, so this echo is the ONLY in-band signal that
        // a create was routed rather than defaulted (compare it against
        // `active_workspace` on the envelope).
        return {
          success: true,
          cycle: data,
          message: `Created ${data.name} (${start_date} to ${end_date})`,
          ...workspaceEcho(teamWs),
        }
      },
    }),

    get_cycle: tool({
      description: 'Get cycle details with list of actions in the cycle.',
      inputSchema: z.object({
        cycle_id: z.string().describe('UUID of the cycle'),
      }),
      execute: async ({ cycle_id }) => {
        // Verify cycle belongs to a team in this workspace
        const { data: cycle, error } = await supabase
          .from('cycle')
          .select('id, team_id, name, number, start_date, end_date, status, team:team!team_id(workspace_id)')
          .eq('id', cycle_id)
          .single()

        if (error || !cycle) return { success: false, error: 'Cycle not found' }
        const teamData = cycle.team as unknown as { workspace_id: string } | null
        if (teamData?.workspace_id !== workspaceId) return { success: false, error: 'Cycle not found' }

        const { data: actions } = await orderByUrgency(
          supabase
            .from('actions')
            .select(`
            id, identifier, title, status_id, priority, due_at, assignee_id,
            workflow_state:workflow_state!status_id(name, category, color)
          `)
            .eq('cycle_id', cycle_id)
            .neq('confirmation', 'dismissed'),
        )

        const flatActions = (actions || []).map((a) => {
          const ws = a.workflow_state as unknown as { name: string; category: string; color: string } | null
          return {
            id: a.id,
            identifier: a.identifier,
            title: a.title,
            status: ws?.name || '',
            status_category: ws?.category || '',
            priority: a.priority,
            due_at: a.due_at,
          }
        })

        let total = 0, completed = 0, in_progress = 0, not_started = 0
        for (const a of flatActions) {
          total++
          if (a.status_category === 'completed' || a.status_category === 'canceled') completed++
          else if (a.status_category === 'started') in_progress++
          else not_started++
        }

        return {
          success: true,
          cycle: { ...cycle, total_actions: total, completed_actions: completed, in_progress_actions: in_progress, not_started_actions: not_started },
          actions: flatActions,
        }
      },
    }),

    start_cycle: tool({
      description: 'Start a cycle (set status to active). Only one cycle per team can be active at a time.',
      inputSchema: z.object({
        cycle_id: z.string().describe('UUID of the cycle to start'),
      }),
      execute: async ({ cycle_id }) => {
        // No `team:team!team_id(workspace_id)` embed any more: the workspace is
        // resolved (and membership-checked) by resolveTeamWorkspace, which the
        // embed could only duplicate.
        const { data: cycle } = await supabase
          .from('cycle')
          .select('team_id, status')
          .eq('id', cycle_id)
          .single()

        if (!cycle) return { success: false, error: 'Cycle not found' }
        // Route by the cycle's team: a cycle_id copied out of another workspace
        // the user belongs to is now actionable there instead of reading as
        // not-found. A team the user is NOT a member of keeps the same
        // 'Cycle not found' it always returned — the reply never distinguishes
        // "no such cycle" from "not yours".
        const teamWs = await resolveTeamWorkspace(cycle.team_id as string | null)
        if (!teamWs) return { success: false, error: 'Cycle not found' }
        if (cycle.status === 'active') return { success: false, error: 'Cycle is already active' }

        // Check no other active cycle
        const { data: existing } = await supabase
          .from('cycle')
          .select('id, name')
          .eq('team_id', cycle.team_id)
          .eq('status', 'active')
          .limit(1)

        if (existing && existing.length > 0) {
          return { success: false, error: `Team already has an active cycle: "${existing[0].name}"` }
        }

        const { data, error } = await supabase
          .from('cycle')
          .update({ status: 'active' })
          .eq('id', cycle_id)
          .eq('team_id', cycle.team_id)
          .select()
          .single()

        if (error) return { success: false, error: error.message }
        // Echoed for the same reason create_cycle echoes: the row itself names
        // no workspace, so a routed write would otherwise be invisible.
        return { success: true, cycle: data, message: `Started ${data.name}`, ...workspaceEcho(teamWs) }
      },
    }),

    complete_cycle: tool({
      description: 'Complete a cycle. Optionally roll unfinished actions to the next cycle.',
      inputSchema: z.object({
        cycle_id: z.string().describe('UUID of the cycle to complete'),
        roll_to_next: z.boolean().optional().default(true).describe('Move unfinished actions to next cycle (default true). Creates a new 2-week cycle if none exists.'),
      }),
      execute: async ({ cycle_id, roll_to_next }) => {
        const { data: cycle } = await supabase
          .from('cycle')
          .select('id, team_id, end_date, status')
          .eq('id', cycle_id)
          .single()

        if (!cycle) return { success: false, error: 'Cycle not found' }
        // Same routing as start_cycle — and it matters more here, because this
        // tool goes on to CREATE a follow-on cycle and re-home actions.
        const teamWs = await resolveTeamWorkspace(cycle.team_id as string | null)
        if (!teamWs) return { success: false, error: 'Cycle not found' }
        if (cycle.status === 'completed') return { success: false, error: 'Cycle is already completed' }

        // Mark completed
        const { data: updated, error: updateErr } = await supabase
          .from('cycle')
          .update({ status: 'completed' })
          .eq('id', cycle_id)
          .eq('team_id', cycle.team_id)
          .select()
          .single()

        if (updateErr) return { success: false, error: updateErr.message }

        let nextCycle = null
        let rolledCount = 0

        if (roll_to_next) {
          // Find or create next cycle
          const { data: upcoming } = await supabase
            .from('cycle')
            .select()
            .eq('team_id', cycle.team_id)
            .eq('status', 'upcoming')
            .order('start_date', { ascending: true })
            .limit(1)

          if (upcoming?.length) {
            nextCycle = upcoming[0]
          } else {
            const nextStart = new Date(cycle.end_date)
            nextStart.setDate(nextStart.getDate() + 1)
            const nextEnd = new Date(nextStart)
            nextEnd.setDate(nextEnd.getDate() + 14)

            const { data: created } = await supabase
              .from('cycle')
              .insert({
                team_id: cycle.team_id,
                start_date: nextStart.toISOString().split('T')[0],
                end_date: nextEnd.toISOString().split('T')[0],
                status: 'upcoming',
              })
              .select()
              .single()

            nextCycle = created
          }

          // Move unfinished actions. `actions` DOES carry a workspace_id, so the
          // roll is pinned to the resolved workspace on both halves — read and
          // write — rather than trusting cycle_id alone to stay in one tenant.
          const { data: cycleActions } = await supabase
            .from('actions')
            .select('id, workflow_state:workflow_state!status_id(category)')
            .eq('cycle_id', cycle_id)
            .eq('workspace_id', teamWs)
            .neq('confirmation', 'dismissed')

          const unfinishedIds = (cycleActions || [])
            .filter((a) => {
              const cat = (a.workflow_state as unknown as { category: string } | null)?.category
              return cat !== 'completed' && cat !== 'canceled'
            })
            .map((a) => a.id)

          if (unfinishedIds.length > 0 && nextCycle) {
            const { error: rollErr } = await supabase
              .from('actions')
              .update({ cycle_id: nextCycle.id })
              .in('id', unfinishedIds)
              .eq('workspace_id', teamWs)

            if (!rollErr) rolledCount = unfinishedIds.length
          }
        }

        return {
          success: true,
          cycle: updated,
          next_cycle: nextCycle,
          rolled_count: rolledCount,
          ...workspaceEcho(teamWs),
          message: roll_to_next
            ? `Completed ${updated.name}. ${rolledCount} unfinished actions moved to ${nextCycle?.name || 'next cycle'}.`
            : `Completed ${updated.name}.`,
        }
      },
    }),
  }
}
