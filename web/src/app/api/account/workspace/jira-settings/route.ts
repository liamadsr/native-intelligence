import { requireWorkspaceMember } from '@/lib/api-auth'
import { apiError, badRequest, forbidden, serverError } from '@/lib/api-errors'
import { inngest } from '@/lib/inngest/client'
import { isNumericJiraId, isValidJiraCloudId } from '@/lib/integrations/jira-api'
import { isOpenableUrl } from '@/lib/open-external'
import {
  clearJiraWebhookRegistration,
  loadJiraSyncState,
  loadJiraWebhookState,
  saveJiraConfig,
  type JiraDestinationConfig,
} from '@/lib/tasks/jira-config'
import { LIFECYCLE_BUCKETS, type StatusMap } from '@/lib/tasks/lifecycle'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * GET/PATCH /api/account/workspace/jira-settings
 *
 * Reads/writes the per-workspace Jira push DESTINATION, stored in
 * `task_sync_state.config` (see src/lib/tasks/jira-config.ts):
 *   - `cloud_id` / `site_name` / `site_url` — which Atlassian SITE. `cloud_id`
 *     is not cosmetic: every API path is built from it, so nothing can be read
 *     or written without one.
 *   - `project_id` / `project_key` / `project_name` — the project pushed actions
 *     land in.
 *   - `issue_type_id` / `issue_type_name` — `POST /issue` requires an issue
 *     type, and in team-managed projects the ids are per-PROJECT copies.
 *   - `status_map` — optional lifecycle-bucket → Jira status id map; null means
 *     "no explicit status, fall back to matching on statusCategory" (NOT Asana's
 *     "don't move" — Jira always transitions).
 *
 * Modeled on asana-settings/route.ts: any member may READ the destination (their
 * pushes go there); only owner/admin may WRITE (it re-points where the whole
 * workspace's issues land). The write read-modify-writes `config`, so a PATCH
 * that only re-maps statuses can't drop the project — with THREE exceptions:
 *   - switching to a different SITE resets the whole destination below it:
 *     project, issue type and status map. Every one of those ids is minted
 *     per-site and Atlassian starts each site's sequence at the same number
 *     (10000), so they do not merely go stale across a switch — they silently
 *     resolve to a DIFFERENT, real object on the new tenant. Comparing the
 *     project id alone (as this route and the client both used to) cannot see
 *     that, because the colliding id compares equal. The webhook is re-pointed
 *     at the same time, and the outgoing site's registration retired.
 *   - switching to a different project resets `status_map` AND clears the issue
 *     type. Both are scoped to the project they came from: a status id belongs
 *     to that project's workflow, and a team-managed project's issue types are
 *     its own copies, so carrying either across is worse than having none.
 *   - `{ "project_id": null }` ON ITS OWN is an explicit CLEAR ("stop pushing
 *     anywhere"). Merge semantics can only ever add a destination, so without
 *     this there is no way back out of one.
 *
 * Every id is also FORMAT-CHECKED here (`cloud_id` UUID-ish, the numeric ids
 * digits-only): they are interpolated into request paths and into the webhook's
 * JQL filter downstream, where neither escaping nor encoding is available.
 *
 * The three field GROUPS travel together (id + display names) because a
 * half-written destination renders as a picker with no label, and because
 * `isJiraDestinationConfigured` gates the push on the whole cloud/project/type
 * triple — a partially written row is silently un-pushable.
 *
 * Unlike the HubSpot flags — which live on `workspace.settings` and are
 * member-readable through RLS — this row is service-role/owner-scoped
 * (task_sync_state RLS mirrors crm_sync_state), so the reads go through
 * loadJiraSyncState's service client AFTER requireWorkspaceMember has gated on
 * membership.
 */

/** Every bucket explicitly unmapped — "fall back to statusCategory" across the board. */
function emptyStatusMap(): StatusMap {
  const map: StatusMap = {}
  for (const bucket of LIFECYCLE_BUCKETS) map[bucket] = null
  return map
}

/** Keys a PATCH may set. Anything else is rejected rather than silently kept. */
const ALLOWED_KEYS = new Set([
  'cloud_id',
  'site_name',
  'site_url',
  'project_id',
  'project_key',
  'project_name',
  'issue_type_id',
  'issue_type_name',
  'status_map',
  'include_dial8_attribution',
])

/** The site triple — which Atlassian tenant every call is addressed to. */
const SITE_KEYS = ['cloud_id', 'site_name', 'site_url'] as const
/** The project triple — where issues land. */
const PROJECT_KEYS = ['project_id', 'project_key', 'project_name'] as const
/** The issue-type pair — what kind of issue is created. */
const ISSUE_TYPE_KEYS = ['issue_type_id', 'issue_type_name'] as const

/**
 * Keys a CLEAR removes.
 *
 * Deliberately NOT the site: unlike Asana's workspace (which is part of the task
 * create and is dropped on a clear), a cloudId is the API ADDRESS rather than
 * the destination. Keeping it means "stop pushing" doesn't also make the user
 * re-pick the tenant they are obviously still connected to, and it is inert on
 * its own — `isJiraDestinationConfigured` needs all three of site, project and
 * issue type, so a site-only config reads as unconfigured everywhere.
 */
const CLEARED_KEYS = [...PROJECT_KEYS, ...ISSUE_TYPE_KEYS] as const

/**
 * Keys that may be explicitly NULL inside their group.
 *
 * Only `site_url`, and only because Atlassian genuinely may not report one:
 * `accessible-resources` documents `url` as best-effort. It is used for exactly
 * one thing — building `{site_url}/browse/{KEY}` permalinks — and
 * `issueBrowseUrl` already degrades to null rather than emitting a broken URL.
 * Forcing the client to invent a value here is what produced the
 * `https://api.atlassian.com/ex/jira/{cloudId}/browse/ENG-42` permalinks stored
 * on every link of such a site: a URL that looks real, is not browsable, and
 * outlives the config it came from because it is copied onto each row.
 */
const NULLABLE_KEYS = new Set<string>(['site_url'])

/**
 * Per-key format rules for the values that get interpolated downstream.
 *
 * `site_url` is here for a different reason than the ids: it is not a path
 * segment, it is a LINK BASE. `{site_url}/browse/{KEY}` is copied onto every
 * pushed action's `external_url` and the compose panel builds its
 * native-create deep link the same way; both are handed to openExternalUrl. A
 * `javascript:` value written here by one admin therefore executes in every
 * OTHER member's session in the app's own origin — stored XSS, not self-XSS.
 * Requiring an absolute http(s) URL is the boundary check; parseJiraConfig
 * repeats it for rows written before this existed, and open-external repeats it
 * for every caller.
 */
const ID_FORMATS: Record<string, { ok: (v: string) => boolean; expected: string }> = {
  cloud_id: { ok: isValidJiraCloudId, expected: 'an Atlassian cloud id (a UUID)' },
  project_id: { ok: isNumericJiraId, expected: 'a numeric Jira project id' },
  issue_type_id: { ok: isNumericJiraId, expected: 'a numeric Jira issue type id' },
  site_url: { ok: isOpenableUrl, expected: 'an absolute http(s) URL' },
}

/**
 * Validate + copy one all-or-nothing group of string fields into the patch.
 *
 * A key listed in NULLABLE_KEYS may arrive as `null`, which means "this site has
 * no browsable url" — recorded in `clear` so the caller drops it from the merged
 * config rather than keeping a value from the previous site.
 */
function readGroup(
  payload: Record<string, unknown>,
  keys: readonly string[],
  patch: JiraDestinationConfig,
  clear: Set<string>,
): Response | null {
  const supplied = keys.filter((k) => payload[k] !== undefined)
  if (supplied.length === 0) return null
  if (supplied.length !== keys.length) {
    return badRequest(`\`${keys.join('`, `')}\` must be supplied together`)
  }
  for (const key of keys) {
    const value = payload[key]
    if (value === null && NULLABLE_KEYS.has(key)) {
      clear.add(key)
      continue
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
      return badRequest(
        NULLABLE_KEYS.has(key)
          ? `\`${key}\` must be a non-empty string or null`
          : `\`${key}\` must be a non-empty string`,
      )
    }
    const trimmed = value.trim()
    const format = ID_FORMATS[key]
    if (format && !format.ok(trimmed)) {
      return badRequest(`\`${key}\` must be ${format.expected}`)
    }
    ;(patch as Record<string, string>)[key] = trimmed
  }
  return null
}

export async function GET(): Promise<Response> {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { workspaceId } = auth

  const state = await loadJiraSyncState(workspaceId)
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
  // land in the connected Jira site — an admin/owner decision.
  if (member.role !== 'owner' && member.role !== 'admin') {
    return forbidden('Only workspace admins can change Jira settings')
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

  // `{ project_id: null }` and NOTHING else = "clear the destination". It has to
  // be its own shape: every other path merges, so there is otherwise no way to
  // remove a project once one is set — and a null project_id alongside other
  // keys is far more likely a bug than an intention, so it stays an error.
  const payloadKeys = Object.keys(payload)
  const clearDestination =
    payloadKeys.length === 1 && payloadKeys[0] === 'project_id' && payload.project_id === null

  const patch: JiraDestinationConfig = {}
  /** Keys the patch explicitly NULLs (see NULLABLE_KEYS). */
  const cleared = new Set<string>()

  if (!clearDestination) {
    for (const keys of [SITE_KEYS, PROJECT_KEYS, ISSUE_TYPE_KEYS]) {
      const rejected = readGroup(payload, keys, patch, cleared)
      if (rejected) return rejected
    }

    if (payload.status_map !== undefined) {
      const raw = payload.status_map
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return badRequest('`status_map` must be an object')
      }
      const rawMap = raw as Record<string, unknown>
      const unknownBuckets = Object.keys(rawMap).filter(
        (k) => !LIFECYCLE_BUCKETS.includes(k as (typeof LIFECYCLE_BUCKETS)[number]),
      )
      if (unknownBuckets.length > 0) {
        return badRequest(`Unknown lifecycle bucket(s): ${unknownBuckets.join(', ')}`)
      }
      const map: StatusMap = {}
      for (const bucket of LIFECYCLE_BUCKETS) {
        const value = rawMap[bucket]
        if (value === undefined || value === null) {
          map[bucket] = null
          continue
        }
        if (typeof value !== 'string' || value.trim().length === 0) {
          return badRequest(`\`status_map.${bucket}\` must be a string or null`)
        }
        // Status ids are Atlassian-minted integers and are compared against
        // transition targets; anything else is a typo or an injection attempt.
        if (!isNumericJiraId(value.trim())) {
          return badRequest(`\`status_map.${bucket}\` must be a numeric Jira status id`)
        }
        map[bucket] = value.trim()
      }
      patch.status_map = map
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

    if (Object.keys(patch).length === 0 && cleared.size === 0) {
      return badRequest(
        'Expected `cloud_id` + `site_name` + `site_url`, `project_id` + `project_key` + ' +
          '`project_name`, `issue_type_id` + `issue_type_name`, `status_map`, ' +
          '`include_dial8_attribution`, or `project_id: null` to clear',
      )
    }
  }

  const state = await loadJiraSyncState(workspaceId)
  if (!state) {
    return apiError('Jira is not connected for this workspace', {
      status: 400,
      code: 'not_connected',
    })
  }

  /**
   * Is this PATCH re-pointing the workspace at a different Atlassian tenant?
   *
   * The one comparison the old code never made — it asked only whether the
   * PROJECT id changed, which is blind precisely when it matters, since the
   * equivalent project on another site routinely carries the SAME numeric id.
   */
  const siteChanged =
    !clearDestination && !!patch.cloud_id && patch.cloud_id !== state.config.cloud_id

  let config: JiraDestinationConfig

  if (clearDestination) {
    // Drop the project and issue type outright — the display names too: a
    // lingering project_name would render as "currently pushing to …" for a
    // destination that no longer exists. The status map goes with them for the
    // same reason status ids are reset on a project switch.
    //
    // `include_dial8_attribution` deliberately SURVIVES this, and the site and
    // project switches below. Those resets exist because per-site ids resolve to
    // real-but-unrelated objects on another tenant; a preference about Dial8's
    // own branding has no such failure mode, and silently re-branding issues on
    // a re-point is the opposite of what the user asked for.
    config = { ...state.config }
    for (const key of CLEARED_KEYS) delete config[key]
    config.status_map = emptyStatusMap()
  } else {
    // Read-modify-write so a status-only PATCH keeps the project (and a
    // project-only PATCH keeps the map).
    config = { ...state.config, ...patch }
    for (const key of cleared) delete config[key as keyof JiraDestinationConfig]

    // …EXCEPT when the destination moves. Two nested invalidations, widest
    // first. An explicit value in the SAME request is a deliberate choice and
    // wins over both.
    //
    // SITE. Project ids, issue-type ids and status ids are all minted per-site,
    // and Atlassian starts every site's sequence at 10000 — so after a site
    // switch they don't dangle, they RESOLVE, to unrelated objects on the new
    // tenant. `isJiraDestinationConfigured` would keep reporting a working
    // destination while every push landed in a stranger's project. Nothing below
    // the site survives it.
    if (siteChanged) {
      if (patch.project_id === undefined) for (const key of PROJECT_KEYS) delete config[key]
      if (patch.issue_type_id === undefined) {
        for (const key of ISSUE_TYPE_KEYS) delete config[key]
      }
      if (patch.status_map === undefined) config.status_map = emptyStatusMap()
    } else if (patch.project_id && patch.project_id !== state.config.project_id) {
      // PROJECT. Status ids belong to the workflow of the project that owns
      // them, and in a team-managed project so do the ISSUE TYPE ids — both
      // resolve to nothing in another project, and a push against a stale issue
      // type id 400s. The client sends explicit resets on a project switch; this
      // is the server-side backstop for any caller that doesn't (the AI/MCP
      // surfaces, a curl, an older client).
      if (patch.status_map === undefined) config.status_map = emptyStatusMap()
      if (patch.issue_type_id === undefined) {
        for (const key of ISSUE_TYPE_KEYS) delete config[key]
      }
    }

    // A project can never be addressed without a site. This is reachable in
    // practice — a caller may PATCH a project against a config whose site was
    // never chosen — and letting it through would store a destination that reads
    // as configured in the UI and fails on every push.
    if (config.project_id && !config.cloud_id) {
      return badRequest('Pick a Jira site (`cloud_id`) before choosing a project')
    }
  }

  // A registration lives on ONE site and can only be deleted through that site,
  // so the outgoing pair has to be captured BEFORE the new cloudId is stored —
  // afterwards there is nothing left that knows where it lives. Read only on a
  // site switch; every other PATCH leaves the registration exactly where it is.
  const outgoing = siteChanged ? await loadJiraWebhookState(state.id) : null
  const retireWebhook =
    outgoing?.webhookId && outgoing.cloudId
      ? { webhookId: outgoing.webhookId, cloudId: outgoing.cloudId }
      : null

  const { error } = await saveJiraConfig(state.id, config)
  if (error) return serverError(error)

  // Forget the registration we are retiring, so the convergence pass sees "not
  // registered" and CREATES on the new site rather than hunting for an id that
  // exists on the old one (and then issuing its cleanup DELETE against the
  // wrong tenant). The old registration is deleted afterwards, by the ensure
  // function, using the pair captured above — create-before-delete.
  if (retireWebhook) await clearJiraWebhookRegistration(state.id)

  // The webhook filters on ONE project of ONE site (`jqlFilter: project = <id>`,
  // registered per-site), so the destination moving — either half of it — or
  // being set for the first time, or cleared, is exactly when the registration
  // has to converge: re-point it, create it, or tear it down. Fire-and-forget:
  // registration is an Atlassian round-trip no user should wait on, and the
  // 30-minute cron re-fires the same event as a self-heal if this send is
  // dropped. jiraEnsureWebhook is idempotent, so a redundant fire costs one
  // cheap list call.
  if (config.project_id !== state.config.project_id || siteChanged) {
    inngest
      .send({
        name: 'tasks/jira-ensure-webhook',
        data: { syncStateId: state.id, ...(retireWebhook ? { retireWebhook } : {}) },
      })
      .catch((err) => {
        console.error('[jira-settings] ensure-webhook dispatch failed:', err)
      })
  }

  return NextResponse.json({
    connected: true,
    accountId: state.accountId,
    config,
  })
}
