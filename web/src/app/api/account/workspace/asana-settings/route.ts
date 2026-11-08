import { requireWorkspaceMember } from '@/lib/api-auth'
import { apiError, badRequest, forbidden, serverError } from '@/lib/api-errors'
import { inngest } from '@/lib/inngest/client'
import {
  loadAsanaSyncState,
  saveAsanaConfig,
  type AsanaDestinationConfig,
} from '@/lib/tasks/asana-config'
import { LIFECYCLE_BUCKETS, type SectionMap } from '@/lib/tasks/lifecycle'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * GET/PATCH /api/account/workspace/asana-settings
 *
 * Reads/writes the per-workspace Asana push DESTINATION, stored in
 * `task_sync_state.config` (see src/lib/tasks/asana-config.ts):
 *   - `asana_workspace_gid` / `asana_workspace_name` — which Asana workspace
 *     (a task create must resolve to exactly one).
 *   - `project_gid` / `project_name` — the project pushed actions land in.
 *     Without it a push fails 'not_configured'.
 *   - `section_map` — optional lifecycle-bucket → section gid map
 *     ({not_started, in_progress, done, canceled}); null = "don't move".
 *
 * Modeled on hubspot-settings/route.ts: any member may READ the destination
 * (their pushes go there, so they need to see it); only owner/admin may WRITE
 * (it re-points where the whole workspace's tasks land). The write
 * read-modify-writes `config` so a PATCH that only re-maps sections can't drop
 * the project, and vice versa — with TWO exceptions:
 *   - switching to a different project resets `section_map`, because section
 *     gids belong to the project they came from and mean nothing in another one;
 *   - `{ "project_gid": null }` ON ITS OWN is an explicit CLEAR ("stop pushing
 *     anywhere"), which removes the whole destination rather than merging.
 *     Merge semantics can only ever add a destination, so without this there is
 *     no way back out of one.
 *
 * Unlike the HubSpot flags — which live on `workspace.settings` and are
 * therefore member-readable through RLS — this row is service-role/owner-scoped
 * (task_sync_state RLS mirrors crm_sync_state), so the reads go through
 * loadAsanaSyncState's service client AFTER requireWorkspaceMember has gated on
 * membership.
 */

/** Every bucket explicitly mapped to null — "don't move" across the board. */
function emptySectionMap(): SectionMap {
  const map: SectionMap = {}
  for (const bucket of LIFECYCLE_BUCKETS) map[bucket] = null
  return map
}

/** Keys a PATCH may set. Anything else is rejected rather than silently kept. */
const ALLOWED_KEYS = new Set([
  'asana_workspace_gid',
  'asana_workspace_name',
  'project_gid',
  'project_name',
  'section_map',
  'include_dial8_attribution',
])

/** The four fields that together make up a destination. */
const DESTINATION_KEYS = [
  'project_gid',
  'project_name',
  'asana_workspace_gid',
  'asana_workspace_name',
] as const

export async function GET(): Promise<Response> {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { workspaceId } = auth

  const state = await loadAsanaSyncState(workspaceId)
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
  // land in the connected Asana workspace — an admin/owner decision.
  if (member.role !== 'owner' && member.role !== 'admin') {
    return forbidden('Only workspace admins can change Asana settings')
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

  // `{ project_gid: null }` and NOTHING else = "clear the destination". It has
  // to be its own shape: every other path merges, so there is otherwise no way
  // to remove a project once one is set — and a null project_gid alongside other
  // keys is far more likely a bug than an intention, so it stays an error.
  const payloadKeys = Object.keys(payload)
  const clearDestination =
    payloadKeys.length === 1 && payloadKeys[0] === 'project_gid' && payload.project_gid === null

  const patch: AsanaDestinationConfig = {}

  if (!clearDestination) {
    // The four destination strings. project_gid and asana_workspace_gid must
    // arrive with their display names (and each other): a half-written
    // destination renders as a picker with no label, and a project gid without
    // its workspace can't be validated against the token's workspaces later.
    const suppliedProjectKeys = DESTINATION_KEYS.filter((k) => payload[k] !== undefined)
    if (suppliedProjectKeys.length > 0) {
      if (suppliedProjectKeys.length !== DESTINATION_KEYS.length) {
        return badRequest(
          '`project_gid`, `project_name`, `asana_workspace_gid` and ' +
            '`asana_workspace_name` must be supplied together',
        )
      }
      for (const key of DESTINATION_KEYS) {
        const value = payload[key]
        if (typeof value !== 'string' || value.trim().length === 0) {
          return badRequest(`\`${key}\` must be a non-empty string`)
        }
        patch[key] = value.trim()
      }
    }

    if (payload.section_map !== undefined) {
      const raw = payload.section_map
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return badRequest('`section_map` must be an object')
      }
      const rawMap = raw as Record<string, unknown>
      const unknownBuckets = Object.keys(rawMap).filter(
        (k) => !LIFECYCLE_BUCKETS.includes(k as (typeof LIFECYCLE_BUCKETS)[number]),
      )
      if (unknownBuckets.length > 0) {
        return badRequest(`Unknown lifecycle bucket(s): ${unknownBuckets.join(', ')}`)
      }
      const map: SectionMap = {}
      for (const bucket of LIFECYCLE_BUCKETS) {
        const value = rawMap[bucket]
        if (value === undefined || value === null) {
          map[bucket] = null
          continue
        }
        if (typeof value !== 'string' || value.trim().length === 0) {
          return badRequest(`\`section_map.${bucket}\` must be a string or null`)
        }
        map[bucket] = value.trim()
      }
      patch.section_map = map
    }

    // Provider-level, and deliberately NOT part of any destination group: it may
    // arrive entirely on its own (the settings toggle sends exactly this), and
    // strictly as a boolean — a truthy string like "false" is the classic way a
    // client turns an opt-out into an opt-in, so it is rejected rather than
    // coerced.
    if (payload.include_dial8_attribution !== undefined) {
      if (typeof payload.include_dial8_attribution !== 'boolean') {
        return badRequest('`include_dial8_attribution` must be a boolean')
      }
      patch.include_dial8_attribution = payload.include_dial8_attribution
    }

    if (Object.keys(patch).length === 0) {
      return badRequest(
        'Expected `project_gid` + `project_name` + `asana_workspace_gid` + ' +
          '`asana_workspace_name`, `section_map`, `include_dial8_attribution`, or ' +
          '`project_gid: null` to clear',
      )
    }
  }

  const state = await loadAsanaSyncState(workspaceId)
  if (!state) {
    return apiError('Asana is not connected for this workspace', {
      status: 400,
      code: 'not_connected',
    })
  }

  let config: AsanaDestinationConfig

  if (clearDestination) {
    // Drop the destination outright — all four fields, not just the gid: a
    // lingering project_name would render as "currently pushing to …" for a
    // destination that no longer exists. The section map goes with it for the
    // same reason section gids are reset on a project switch.
    //
    // `include_dial8_attribution` deliberately SURVIVES: it is a preference
    // about Native Intelligence's own branding, not about where tasks land, so re-picking a
    // project later must not silently re-brand tasks the user opted out of.
    config = { ...state.config }
    for (const key of DESTINATION_KEYS) delete config[key]
    config.section_map = emptySectionMap()
  } else {
    // Read-modify-write so a section-only PATCH keeps the project (and a
    // project-only PATCH keeps the section map).
    config = { ...state.config, ...patch }

    // …EXCEPT when the destination moves to a different project. Section gids
    // are scoped to the project that owns them, so carrying the old map across
    // is worse than having none: the echo would try to file tasks into sections
    // of a project they aren't in. The client sends an explicit all-null map on
    // a project switch; this is the server-side backstop for any caller that
    // doesn't (the AI/MCP surfaces, a curl, an older client). An explicit
    // section_map in the SAME request is a deliberate choice and wins.
    if (
      patch.project_gid &&
      patch.project_gid !== state.config.project_gid &&
      patch.section_map === undefined
    ) {
      config.section_map = emptySectionMap()
    }
  }

  const { error } = await saveAsanaConfig(state.id, config)
  if (error) return serverError(error)

  // The webhook watches ONE Asana project, so the destination moving (or being
  // set for the first time, or cleared) is exactly when the registration has to
  // converge: re-point it, create it, or — on a clear, where the new
  // project_gid is undefined — tear it down. Fire-and-forget —
  // registering blocks on an Asana handshake round-trip, which no user should
  // wait on, and the 30-minute cron re-fires the same event as a self-heal if
  // this send is dropped. asanaEnsureWebhook is idempotent, so a redundant fire
  // costs one cheap GET.
  if (config.project_gid !== state.config.project_gid) {
    inngest
      .send({ name: 'tasks/asana-ensure-webhook', data: { syncStateId: state.id } })
      .catch((err) => {
        console.error('[asana-settings] ensure-webhook dispatch failed:', err)
      })
  }

  return NextResponse.json({
    connected: true,
    accountId: state.accountId,
    config,
  })
}
