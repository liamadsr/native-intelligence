import { NextResponse } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { serverError } from '@/lib/api-errors'
import { ASANA_PROVIDER, loadAsanaSyncState } from '@/lib/tasks/asana-config'
import {
  JIRA_PROVIDER,
  isJiraDestinationConfigured,
  loadJiraSyncState,
} from '@/lib/tasks/jira-config'
import {
  LINEAR_PROVIDER,
  isLinearDestinationConfigured,
  loadLinearSyncState,
} from '@/lib/tasks/linear-config'

/**
 * GET /api/account/task-destinations — where this workspace can push actions.
 *
 * The read behind the "Push to…" menu (src/components/tasks/push-to-tracker-menu.tsx).
 * It answers three questions in one shape, for every task tracker at once:
 *   - is a tracker CONNECTED at all? (a provider absent from the array is not)
 *   - is it CONFIGURED, i.e. is there somewhere for a push to land? (Asana is
 *     connected the moment OAuth completes, but a push 400s `not_configured`
 *     until an admin picks a project)
 *   - what should the menu SAY the destination is? (`destinationLabel`)
 *
 * Provider-GENERIC on purpose: the jira and linear rows join the same array with
 * the same four fields, so the menu never grows a per-provider branch. The
 * provider-specific part lives entirely in this route's collectors — which is
 * exactly what those two blocks below are, and the reason adding each one needed
 * no change to the response shape or to PushToTrackerMenu's rendering. Note how
 * differently the three answer "configured?" (one gid, a three-id triple, one
 * team id) while producing the identical row: that judgement is precisely what a
 * collector is for.
 *
 * Membership gate + service-role read: `task_sync_state` RLS mirrors
 * crm_sync_state (a user may SELECT only rows where `user_id = auth.uid()`), but
 * the destination is a WORKSPACE-level setting — a teammate who didn't run the
 * OAuth flow must still see where their pushes go. requireWorkspaceMember gates
 * on membership FIRST; loadAsanaSyncState then reads through the service client
 * and returns only the non-secret subset (never `webhook_secret`).
 */

export interface TaskDestination {
  /** Stable provider key — also the segment used in push/unlink routes. */
  provider: string
  /** Display name for the menu row. */
  name: string
  /** False when connected but no destination picked yet (a push would 400). */
  configured: boolean
  /** What the destination is called ("Engineering"), or null when unconfigured. */
  destinationLabel: string | null
}

export async function GET(): Promise<Response> {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { workspaceId } = auth

  try {
    const destinations: TaskDestination[] = []

    const asana = await loadAsanaSyncState(workspaceId)
    if (asana) {
      // `project_gid` is the gate, not `project_name`: the gid is what a push
      // resolves against, and the settings PATCH refuses to write one without
      // the other — so a name-less row is a hand-edited config, not a
      // destination.
      const projectGid = asana.config.project_gid
      destinations.push({
        provider: ASANA_PROVIDER,
        name: 'Asana',
        configured: !!projectGid,
        destinationLabel: projectGid ? (asana.config.project_name ?? null) : null,
      })
    }

    const jira = await loadJiraSyncState(workspaceId)
    if (jira) {
      // The gate is the FULL site+project+issue-type triple, not just the
      // project: `POST /issue` cannot be addressed without a cloudId and cannot
      // be built without an issue type, and switching project deliberately
      // clears the issue type — so a project-only config is a real, reachable
      // state in which a push still 400s. Reporting it as configured would put a
      // clickable row in the menu that fails the moment it's used.
      const configured = isJiraDestinationConfigured(jira.config)
      destinations.push({
        provider: JIRA_PROVIDER,
        name: 'Jira',
        configured,
        // Project name is the friendly label; the key ("ENG") is the fallback
        // because a Jira project always has one and a name may be missing from a
        // hand-written config.
        destinationLabel: configured
          ? (jira.config.project_name ?? jira.config.project_key ?? null)
          : null,
      })
    }

    const linear = await loadLinearSyncState(workspaceId)
    if (linear) {
      // The gate is `team_id` ALONE — narrower than either sibling's, and not an
      // oversight. A Linear issue belongs to a team; the project is optional and
      // `issueCreate` requires nothing beyond the team, so a team-only config is
      // a complete, pushable destination rather than the half-configured state
      // the same shape would mean for Jira.
      const configured = isLinearDestinationConfigured(linear.config)
      destinations.push({
        provider: LINEAR_PROVIDER,
        name: 'Linear',
        configured,
        // The team is the destination, so it is the label. The project refines
        // it when there is one, giving "Engineering › Q3 Launch"; the team key
        // ("ENG") is the fallback for a config written without a name.
        destinationLabel: configured
          ? [linear.config.team_name ?? linear.config.team_key ?? null, linear.config.project_name]
              .filter((part): part is string => !!part)
              .join(' › ') || null
          : null,
      })
    }

    return NextResponse.json({ destinations })
  } catch (err) {
    // An empty array MEANS "nothing connected" and renders a Connect CTA, so a
    // failed read must never degrade into one — that would tell a workspace with
    // Asana wired up that it has no integrations.
    console.error('[task-destinations] read failed:', err)
    return serverError()
  }
}
