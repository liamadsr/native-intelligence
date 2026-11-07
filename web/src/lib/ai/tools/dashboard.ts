import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows, inChunks } from '@/lib/supabase/paging'
import { displayName, applyCaptureVisibility, captureRequester } from './_shared'
import { compareByUrgency } from '@/lib/actions/urgency'
import { filterOpenWork, isOpenWork, loadClosedStates, OPEN_WORK_ASSIGNEE_EMBED } from '@/lib/actions/open-work'

export function createDashboardTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  omitPrivateCaptures = false,
) {
  const requester = captureRequester(userId, omitPrivateCaptures)
  return {
    get_dashboard_summary: tool({
      description:
        "The current user's work at a glance: counts of their open actions (overdue, in progress, upcoming), what they finished this week, meetings with suggestions to review, the active cycles, and the first 10 overdue and first 10 in-progress actions. " +
        "Counts and the first few only: the full list is `list_actions` with `assignee: 'me'`. Use for a status overview or \"how am I doing\".",
      inputSchema: z.object({}),
      execute: async () => {
        // Get member
        const { data: member } = await supabase
          .from('member')
          .select('id, display_name')
          .eq('user_id', userId)
          .eq('workspace_id', workspaceId)
          .single()

        if (!member) return { success: false, error: 'User is not a workspace member' }

        const now = new Date()
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

        // The person's to-do list, the same set `list_actions` returns for
        // assignee 'me' + confirmation 'confirmed' (src/lib/actions/open-work.ts):
        // top level, accepted, in an open state, assigned through action_assignee.
        const closedStates = await loadClosedStates(supabase, workspaceId)
        const { data: actions } = await filterOpenWork(
          supabase
            .from('actions')
            .select(`
              id, identifier, title, priority, due_at, parent_id, confirmation,
              workflow_state:workflow_state!status_id(name, category),
              team:team!team_id(name),
              ${OPEN_WORK_ASSIGNEE_EMBED}
            `)
            .eq('workspace_id', workspaceId),
          { closedStateIds: closedStates.ids, confirmedOnly: true, memberId: member.id },
        )

        // Done this week: the same rows in a completed state, changed in the
        // last seven days (completion bumps updated_at; there's no completed_at).
        const { count: recentlyCompletedCount } =
          closedStates.completedIds.length > 0
            ? await supabase
                .from('actions')
                .select(`id, ${OPEN_WORK_ASSIGNEE_EMBED}`, { count: 'exact', head: true })
                .eq('workspace_id', workspaceId)
                .is('parent_id', null)
                .eq('confirmation', 'confirmed')
                .eq('assigned.member_id', member.id)
                .in('status_id', closedStates.completedIds)
                .gte('updated_at', sevenDaysAgo.toISOString())
            : { count: 0 }

        const overdue: { identifier: string; title: string; due_date: string; priority: string }[] = []
        const in_progress: { identifier: string; title: string; priority: string; team: string }[] = []
        let upcomingCount = 0

        // Most urgent first, then earliest due: each list below is capped at
        // 10, so the order decides which rows the model sees.
        for (const a of [...(actions || [])].sort(compareByUrgency)) {
          const ws = a.workflow_state as unknown as { name: string; category: string } | null
          // The query already filtered; this keeps the counts right when the
          // closed states couldn't be read.
          if (!isOpenWork({ parent_id: a.parent_id, confirmation: a.confirmation, category: ws?.category }, { confirmedOnly: true })) continue
          const team = a.team as unknown as { name: string } | null

          if (a.due_at && new Date(a.due_at) < now) {
            overdue.push({ identifier: a.identifier, title: a.title, due_date: a.due_at, priority: a.priority })
            continue
          }

          if (ws?.category === 'started') {
            in_progress.push({ identifier: a.identifier, title: a.title, priority: a.priority, team: team?.name || '' })
          } else {
            upcomingCount++
          }
        }

        // Get pending reviews (paged: a workspace can hold more than one
        // response of suggestions)
        const { data: suggestedActions } = await fetchAllRows(() =>
          supabase
            .from('actions')
            .select('id, source_capture_id')
            .eq('workspace_id', workspaceId)
            .eq('confirmation', 'suggested')
            .not('source_capture_id', 'is', null),
        )

        // `decision` has no workspace_id: scope through the capture IN SQL
        // (inner join), so this neither reads other tenants' rows nor loses
        // this workspace's behind the 1000-row response cap.
        const { data: suggestedDecisions } = await supabase
          .from('decision')
          .select('capture_id, capture:captures!capture_id!inner(workspace_id)')
          .eq('confirmation', 'suggested')
          .eq('capture.workspace_id', workspaceId)

        const filteredDecisions = (suggestedDecisions || []).filter((d) => {
          const capture = d.capture as unknown as { workspace_id: string } | null
          return capture?.workspace_id === workspaceId
        })
        const candidateCaptureIds = [
          ...new Set(
            [
              ...(suggestedActions || []).map((a) => a.source_capture_id),
              ...filteredDecisions.map((d) => d.capture_id),
            ].filter((id): id is string => Boolean(id)),
          ),
        ]

        // Suggestions inherit their source capture's visibility — a private
        // capture must not surface a review count to anyone but its creator.
        // This runs on service-role clients (RLS bypassed), so filter explicitly.
        let pendingCaptureIds = new Set<string>()
        if (candidateCaptureIds.length > 0) {
          // Chunked: suggestions spread over a few hundred captures overflowed
          // one `id=in.(…)` URL, the read failed and the summary said 0 reviews.
          const { data: visibleCaptures } = await inChunks(candidateCaptureIds, 100, (ids) =>
            applyCaptureVisibility(
              supabase
                .from('captures')
                .select('id')
                .eq('workspace_id', workspaceId)
                .in('id', ids),
              requester,
            ),
          )
          pendingCaptureIds = new Set(visibleCaptures.map((c) => c.id as string))
        }

        // Get active cycles — scope via team's workspace_id
        const { data: workspaceTeams } = await supabase
          .from('team')
          .select('id')
          .eq('workspace_id', workspaceId)
        const teamIds = (workspaceTeams || []).map((t) => t.id)

        const { data: cycles } = teamIds.length > 0
          ? await supabase
              .from('cycle')
              .select(`id, name, number, end_date, team:team!team_id(name)`)
              .in('team_id', teamIds)
              .eq('status', 'active')
          : { data: [] as never[] }

        const activeCycles = (cycles || [])
          .map((c) => {
            const team = c.team as unknown as { name: string } | null
            const daysRemaining = Math.max(0, Math.ceil((new Date(c.end_date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))
            // Drop the parenthetical entirely when the team name is empty —
            // an output of "Sprint 3 ()" is worse than just "Sprint 3".
            const cycleLabel = displayName(c.name, `Sprint ${c.number}`)
            const teamLabel = team?.name && team.name.trim().length > 0 ? team.name : null
            return {
              name: teamLabel ? `${cycleLabel} (${teamLabel})` : cycleLabel,
              days_remaining: daysRemaining,
            }
          })

        return {
          success: true,
          overdue_count: overdue.length,
          in_progress_count: in_progress.length,
          upcoming_count: upcomingCount,
          recently_completed_count: recentlyCompletedCount ?? 0,
          pending_review_count: pendingCaptureIds.size,
          active_cycles: activeCycles,
          overdue_actions: overdue.slice(0, 10),
          in_progress_actions: in_progress.slice(0, 10),
        }
      },
    }),
  }
}
