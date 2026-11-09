import { requireWorkspaceMember } from '@/lib/api-auth'
import { apiError, badRequest, forbidden, serverError } from '@/lib/api-errors'
import { listTeamStates, LinearUnauthorizedError } from '@/lib/integrations/linear-api'
import { getValidTokenForAccount } from '@/lib/oauth/token-manager'
import { deriveLinearStateMap } from '@/lib/tasks/lifecycle'
import {
  loadLinearSyncState,
  saveLinearConfig,
  type LinearDestinationConfig,
} from '@/lib/tasks/linear-config'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * GET/PATCH /api/account/workspace/linear-settings
 *
 * Reads/writes the per-workspace Linear push DESTINATION, stored in
 * `task_sync_state.config` (see src/lib/tasks/linear-config.ts):
 *   - `team_id` / `team_key` / `team_name` — THE destination. A Linear issue
 *     belongs to a team, and `issueCreate` needs nothing else.
 *   - `project_id` / `project_name` — OPTIONAL refinement. Unlike a Jira
 *     project, this is not part of the gate.
 *   - `organization_id` / `organization_name` — which Linear org the connection
 *     belongs to. Not used to address any call (a token belongs to exactly one
 *     org); stored so the webhook read-back can sanity-check a delivery.
 *   - `state_map` — DERIVED SERVER-SIDE, never accepted from the client.
 *
 * Modeled on jira-settings/route.ts: any member may READ the destination (their
 * pushes go there); only owner/admin may WRITE (it re-points where the whole
 * workspace's issues land). The write read-modify-writes `config`, so a PATCH
 * that only flips attribution can't drop the team — with two exceptions:
 *   - switching to a different TEAM re-derives `state_map` (the old map's ids
 *     belong to the outgoing team's workflow and resolve to nothing in the new
 *     one) and clears the project (a project is scoped to its teams).
 *   - `{ "team_id": null }` ON ITS OWN is an explicit CLEAR ("stop pushing
 *     anywhere"). Merge semantics can only ever add a destination, so without
 *     this there is no way back out of one.
 *
 * ── Why state_map is derived here rather than sent ──────────────────────────
 *
 * The bucket→state mapping is a FUNCTION of the chosen team's workflow states,
 * folded on the stable `WorkflowState.type` enum (see deriveLinearStateMap).
 * Deriving it server-side at save time buys three things a client-sent map
 * could not:
 *   - it cannot disagree with the team it describes (a client could POST a map
 *     of another team's state ids, which would push issues into states that
 *     don't exist on the destination);
 *   - every caller gets it — the AI/MCP surfaces and a curl, not just the
 *     settings UI;
 *   - the honest empty case survives. A bucket the team cannot express (a team
 *     with no canceled-type state is ordinary) stays ABSENT, and the echo
 *     declines it rather than writing a guessed state.
 *
 * A derivation failure does NOT fail the save: the destination is still valid
 * without a map (the push falls back to the team's default state and the echo
 * declines), and refusing to store a team the user just picked because Linear
 * was briefly unavailable would be worse. The reconcile/echo paths re-derive.
 *
 * Unlike the HubSpot flags — which live on `workspace.settings` and are
 * member-readable through RLS — this row is service-role/owner-scoped
 * (task_sync_state RLS mirrors crm_sync_state), so the reads go through
 * loadLinearSyncState's service client AFTER requireWorkspaceMember has gated on
 * membership.
 */

/** Keys a PATCH may set. Anything else is rejected rather than silently kept. */
const ALLOWED_KEYS = new Set([
  'organization_id',
  'organization_name',
  'team_id',
  'team_key',
  'team_name',
  'project_id',
  'project_name',
  'include_dial8_attribution',
])

/** The org pair — which Linear workspace the connection belongs to. */
const ORG_KEYS = ['organization_id', 'organization_name'] as const
/** The team triple — where issues land. */
const TEAM_KEYS = ['team_id', 'team_key', 'team_name'] as const
/** The project pair — an optional refinement of the team. */
const PROJECT_KEYS = ['project_id', 'project_name'] as const

/**
 * Keys a CLEAR removes.
 *
 * The team and the project, plus the derived map that describes them. The ORG is
 * deliberately kept: it is not a destination but a fact about the connection
 * (which Linear workspace this token belongs to), it is inert on its own —
 * `isLinearDestinationConfigured` gates on `team_id` — and it is still needed by
 * the webhook read-back for links pushed before the clear.
 */
const CLEARED_KEYS = [...TEAM_KEYS, ...PROJECT_KEYS] as const

/**
 * Validate + copy one all-or-nothing group of string fields into the patch.
 *
 * All-or-nothing because a half-written group renders as a picker with no label:
 * an id with no name shows an empty destination, and a name with no id is a
 * destination nothing can be pushed to.
 */
function readGroup(
  payload: Record<string, unknown>,
  keys: readonly string[],
  patch: LinearDestinationConfig,
): Response | null {
  const supplied = keys.filter((k) => payload[k] !== undefined)
  if (supplied.length === 0) return null
  if (supplied.length !== keys.length) {
    return badRequest(`\`${keys.join('`, `')}\` must be supplied together`)
  }
  for (const key of keys) {
    const value = payload[key]
    if (typeof value !== 'string' || value.trim().length === 0) {
      return badRequest(`\`${key}\` must be a non-empty string`)
    }
    ;(patch as Record<string, string>)[key] = value.trim()
  }
  return null
}

export async function GET(): Promise<Response> {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { workspaceId } = auth

  const state = await loadLinearSyncState(workspaceId)
  return NextResponse.json({
    connected: !!state,
    accountId: state?.accountId ?? null,
    config: state?.config ?? {},
  })
}

export async function PATCH(request: NextRequest): Promise<Response> {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  const { workspaceId, member } = auth

  // Re-pointing the destination changes where EVERY member's pushed actions
  // land in the connected Linear organization — an admin/owner decision.
  if (member.role !== 'owner' && member.role !== 'admin') {
    return forbidden('Only workspace admins can change Linear settings')
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  const payload = (body ?? {}) as Record<string, unknown>

  const unknownKeys = Object.keys(payload).filter((k) => !ALLOWED_KEYS.has(k))
  if (unknownKeys.length > 0) {
    return badRequest(`Unknown setting(s): ${unknownKeys.join(', ')}`)
  }

  // `{ team_id: null }` and NOTHING else = "clear the destination". It has to be
  // its own shape: every other path merges, so there is otherwise no way to
  // remove a team once one is set — and a null team_id alongside other keys is
  // far more likely a bug than an intention, so it stays an error.
  const payloadKeys = Object.keys(payload)
  const clearDestination =
    payloadKeys.length === 1 && payloadKeys[0] === 'team_id' && payload.team_id === null

  // A project cleared on its own ("push to the team, not a project") — the
  // project is optional, so unlike the team this is a refinement being removed
  // rather than the destination being torn down.
  const clearProject =
    !clearDestination && payload.project_id === null && payload.project_name === undefined

  const patch: LinearDestinationConfig = {}

  if (!clearDestination && !clearProject) {
    for (const keys of [ORG_KEYS, TEAM_KEYS, PROJECT_KEYS]) {
      const rejected = readGroup(payload, keys, patch)
      if (rejected) return rejected
    }

    // Provider-level, and deliberately NOT one of the all-or-nothing groups
    // above: it may arrive entirely on its own (the settings toggle sends
    // exactly this), and strictly as a boolean — a truthy string like "false" is
    // the classic way a client turns an opt-out into an opt-in.
    if (payload.include_dial8_attribution !== undefined) {
      if (typeof payload.include_dial8_attribution !== 'boolean') {
        return badRequest('`include_dial8_attribution` must be a boolean')
      }
      patch.include_dial8_attribution = payload.include_dial8_attribution
    }

    if (Object.keys(patch).length === 0) {
      return badRequest(
        'Expected `organization_id` + `organization_name`, `team_id` + `team_key` + ' +
          '`team_name`, `project_id` + `project_name`, `include_dial8_attribution`, ' +
          '`project_id: null` to clear the project, or `team_id: null` to clear the ' +
          'destination',
      )
    }
  }

  const state = await loadLinearSyncState(workspaceId)
  if (!state) {
    return apiError('Linear is not connected for this workspace', {
      status: 400,
      code: 'not_connected',
    })
  }

  /** Is this PATCH re-pointing the workspace at a different team? */
  const teamChanged =
    !clearDestination && !!patch.team_id && patch.team_id !== state.config.team_id

  let config: LinearDestinationConfig

  if (clearDestination) {
    // Drop the team, the project and the derived map — the display names too: a
    // lingering team_name would render as "currently pushing to …" for a
    // destination that no longer exists.
    //
    // `include_dial8_attribution` deliberately SURVIVES this and the team switch
    // below. Those resets exist because the ids beneath a destination resolve to
    // nothing (or to something else) once it moves; a preference about Native Intelligence's
    // own branding has no such failure mode, and silently re-branding issues on
    // a re-point is the opposite of what the user asked for.
    config = { ...state.config }
    for (const key of CLEARED_KEYS) delete config[key]
    delete config.state_map
  } else if (clearProject) {
    // The team and its state map stay — only the optional refinement goes.
    config = { ...state.config }
    for (const key of PROJECT_KEYS) delete config[key]
  } else {
    // Read-modify-write so an attribution-only PATCH keeps the team (and a
    // team-only PATCH keeps the attribution preference).
    config = { ...state.config, ...patch }

    // A project belongs to the teams it is shared with, so it cannot survive a
    // team switch. An explicit project in the SAME request is a deliberate
    // choice and wins.
    if (teamChanged && patch.project_id === undefined) {
      for (const key of PROJECT_KEYS) delete config[key]
    }
  }

  // Derive the state map from the DESTINATION TEAM whenever one is in play.
  //
  // Re-derived on every team-bearing PATCH rather than only on a change: states
  // are edited in Linear all the time (renamed, added, deleted), and a save is
  // the natural moment to resync a map that describes them. On a team SWITCH it
  // is mandatory — the outgoing team's state ids resolve to nothing on the new
  // one, and keeping them would make every echo fail.
  if (config.team_id && !clearDestination) {
    const derived = await deriveStateMapForTeam(state.accountId, config.team_id)
    if (derived.unauthorized) {
      return apiError('Reconnect Linear to continue', {
        status: 400,
        code: 'reconnect_required',
      })
    }
    if (derived.stateMap) {
      config.state_map = derived.stateMap
    } else if (teamChanged) {
      // Could not read the new team's states, and the stored map describes the
      // OLD team. Dropping it is the only safe option: a map whose ids belong to
      // a different team would send every echo to a state that doesn't exist.
      // An absent map simply means the push uses the team's default state and
      // the echo declines until a later save or sweep re-derives.
      delete config.state_map
    }
  }

  const { error } = await saveLinearConfig(state.id, config)
  if (error) return serverError(error)

  // NOTE for anyone comparing this with jira-settings: there is no
  // ensure-webhook dispatch here, and none is missing. Linear's webhooks are
  // app-level — one URL and one signing secret in the OAuth app console,
  // auto-provisioned per authorizing organization — so a destination change has
  // no registration to converge. The client calls notifyTaskDestinationsChanged
  // after a successful PATCH, exactly as the asana/jira funnels do.
  return NextResponse.json({
    connected: true,
    accountId: state.accountId,
    config,
  })
}

/**
 * Fetch a team's workflow states and fold them into a bucket→state map.
 *
 * Separated from the PATCH body so the failure modes stay legible. The three
 * outcomes are deliberately distinct:
 *   - `{ stateMap }`      — derived (possibly EMPTY, if the team expresses no
 *                           bucket at all; empty is a real answer, not a failure).
 *   - `{ unauthorized }`  — the token was rejected, which the caller turns into
 *                           `reconnect_required` rather than silently saving a
 *                           destination it could not verify.
 *   - `{}`                — a transient read failure. The caller keeps going: a
 *                           destination without a map still pushes.
 */
async function deriveStateMapForTeam(
  accountId: string,
  teamId: string,
): Promise<{ stateMap?: ReturnType<typeof deriveLinearStateMap>; unauthorized?: boolean }> {
  try {
    const resolved = await getValidTokenForAccount(accountId)
    if (!resolved) return { unauthorized: true }
    const states = await listTeamStates(resolved.token, teamId)
    return { stateMap: deriveLinearStateMap(states) }
  } catch (err) {
    if (err instanceof LinearUnauthorizedError) return { unauthorized: true }
    console.warn(
      `[linear-settings] could not derive the state map for team ${teamId} ` +
        '(saving the destination without one) —',
      err instanceof Error ? err.message : String(err),
    )
    return {}
  }
}
