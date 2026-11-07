/**
 * Jira destination config — the jira half of `task_sync_state`.
 *
 * `task_sync_state` is the canonical workspace→connected-account map (one row
 * per connected account, seeded at the OAuth callback), and its `config` jsonb
 * holds the push DESTINATION: which Atlassian site, project and issue type new
 * issues land in, plus an optional lifecycle-bucket → status map.
 *
 * Sibling of asana-config.ts, with one structural simplification: there is NO
 * webhook-handshake machinery here. Asana's registration blocks on a challenge
 * and hands back a signing secret exactly once, which needs the single-use CAS
 * window (openAsanaWebhookPending/claimAsanaWebhookSecret). Atlassian's dynamic
 * webhooks do neither — registration is a plain POST that returns an id, and
 * deliveries are UNSIGNED. So a jira row's `webhook_secret` and
 * `webhook_pending_at` stay NULL forever, and the receiver derives its trust
 * from re-fetching the issue over an authenticated call instead.
 *
 * Why the SERVICE client (same reasoning as asana-config): the table's RLS lets
 * a user SELECT only rows where `user_id = auth.uid()`, but the destination is a
 * WORKSPACE-level setting — every member's pushes go to the same project, so a
 * teammate who didn't run the OAuth flow would otherwise see a perpetually "not
 * configured" integration. Callers gate on workspace membership FIRST
 * (requireWorkspaceMember) and then read through here.
 */
import { getServiceClient } from '@/lib/admin'
import { isOpenableUrl } from '@/lib/open-external'
import type { LifecycleBucket, StatusMap } from './lifecycle'
import { LIFECYCLE_BUCKETS } from './lifecycle'

/** The provider key for every jira row in task_sync_state / action_external_task. */
export const JIRA_PROVIDER = 'jira'

/**
 * Shape of `task_sync_state.config` for the jira provider.
 *
 * EXPLICIT PICKS ONLY. Nothing in here is ever written from a guess — not the
 * "obvious" single site, not a project named after the workspace, not the issue
 * type called "Task". The settings UI may PREFILL a selection for display, but
 * only a user's confirmed choice is persisted, so a push either goes exactly
 * where someone said it should or refuses with `not_configured`.
 */
export interface JiraDestinationConfig {
  /** accessible-resources `id`. Every API path is built from this. */
  cloud_id?: string
  /** Site display name ("Acme"). */
  site_name?: string
  /** `https://acme.atlassian.net` — used to build `/browse/{KEY}` permalinks. */
  site_url?: string
  /** Numeric project id as a string. The gate: no project_id → not configured. */
  project_id?: string
  /** Project key ("ENG"). Display + permalink only; can be RENAMED by an admin. */
  project_key?: string
  project_name?: string
  /** Issue type id, resolved per-project (team-managed types are project copies). */
  issue_type_id?: string
  issue_type_name?: string
  /** bucket → Jira status id. Absent/null buckets fall back to statusCategory. */
  status_map?: StatusMap
  /**
   * Put Dial8's fingerprints on a pushed issue's description: the action
   * identifier as a bold heading paragraph, and the "Pushed from Dial8"
   * backlink paragraph at the bottom.
   *
   * ABSENT MEANS TRUE — every connection made before this setting existed keeps
   * behaving exactly as it did, byte for byte, without a backfill. Only an
   * explicit `false` strips them, and only from issues pushed AFTERWARDS:
   * already pushed issues are never rewritten.
   *
   * Provider-level, NOT destination-level — it survives a site switch, a project
   * switch and a destination clear, all of which reset the ids beneath them.
   * Those resets exist because per-site ids resolve to unrelated objects on
   * another tenant; a preference about Dial8's own branding has no such problem.
   */
  include_dial8_attribution?: boolean
}

/**
 * Does this config want Dial8 attribution on pushed issues?
 *
 * The default-on rule lives HERE, in one place, so no caller can accidentally
 * turn an absent key into "off" by reading the raw field.
 */
export function includesJiraAttribution(config: JiraDestinationConfig): boolean {
  return config.include_dial8_attribution !== false
}

/** The subset of the row callers need. Deliberately omits the webhook columns. */
export interface JiraSyncState {
  id: string
  accountId: string
  userId: string
  config: JiraDestinationConfig
}

/**
 * Normalize an untrusted `config` jsonb into JiraDestinationConfig.
 *
 * Everything is optional (a freshly-seeded row is `{}`) and every field is
 * type-checked, so a hand-edited or half-written row degrades to "not
 * configured" rather than throwing deep inside a push.
 */
export function parseJiraConfig(raw: unknown): JiraDestinationConfig {
  const source = (raw ?? {}) as Record<string, unknown>
  const config: JiraDestinationConfig = {}

  for (const key of [
    'cloud_id',
    'site_name',
    'site_url',
    'project_id',
    'project_key',
    'project_name',
    'issue_type_id',
    'issue_type_name',
  ] as const) {
    const value = source[key]
    if (typeof value !== 'string' || value.length === 0) continue
    // `site_url` is the only field here that becomes a LINK rather than a path
    // segment: `{site_url}/browse/{KEY}` is copied onto every pushed action's
    // external_url and opened with openExternalUrl. A row carrying a
    // `javascript:` value (hand-edited, service-role written, or saved before
    // the settings PATCH checked the scheme) degrades to NO url here rather
    // than reaching a click — issueBrowseUrl and nativeCreateIssueUrl both
    // already return null for an absent site_url, so the cost is a permalink.
    if (key === 'site_url' && !isOpenableUrl(value)) continue
    config[key] = value
  }

  const rawMap = source.status_map
  if (rawMap && typeof rawMap === 'object' && !Array.isArray(rawMap)) {
    const map: StatusMap = {}
    for (const bucket of LIFECYCLE_BUCKETS) {
      const value = (rawMap as Record<string, unknown>)[bucket]
      map[bucket] = typeof value === 'string' && value.length > 0 ? value : null
    }
    config.status_map = map
  }

  // Only a real boolean is carried through — a hand-edited `"false"` string is
  // left ABSENT rather than coerced, landing on the safe default (on).
  if (typeof source.include_dial8_attribution === 'boolean') {
    config.include_dial8_attribution = source.include_dial8_attribution
  }

  return config
}

/**
 * Load the workspace's Jira sync state, or null when Jira isn't connected.
 *
 * A workspace can in principle carry more than one connected Jira account (two
 * members each ran the flow); the OLDEST row wins so the destination is stable
 * and doesn't flip based on who connected most recently — the same tie-break
 * loadAsanaSyncState and hubspot-push-contact use.
 */
export async function loadJiraSyncState(
  workspaceId: string,
): Promise<JiraSyncState | null> {
  const supabase = getServiceClient()
  const { data } = await supabase
    .from('task_sync_state')
    .select('id, account_id, user_id, config')
    .eq('workspace_id', workspaceId)
    .eq('provider', JIRA_PROVIDER)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!data) return null
  return {
    id: data.id as string,
    accountId: data.account_id as string,
    userId: data.user_id as string,
    config: parseJiraConfig(data.config),
  }
}

/**
 * The webhook half of the row — SERVICE-ONLY, and a SEPARATE reader from
 * loadJiraSyncState on purpose.
 *
 * Note what it does NOT select: `webhook_secret`. For a jira row that column is
 * permanently NULL (Atlassian's dynamic webhooks are unsigned — there is no
 * secret to store, and no API to set one), so selecting it would be harmless
 * today. It is excluded anyway, because `task_sync_state` is a SHARED table:
 * the Asana rows next door hold a live HMAC key, and keeping every jira reader
 * provably secret-free is what stops a later refactor from widening one of these
 * queries into a path that hands that key to a jira caller.
 *
 * `webhookId` is the Atlassian `createdWebhookId`, stored as text in the
 * shared `webhook_gid` column (Asana's gids are strings; Jira's ids are int64).
 * Callers convert at the API boundary.
 */
export interface JiraWebhookState {
  id: string
  workspaceId: string
  accountId: string
  userId: string
  webhookId: string | null
  /** Last successful register OR refresh — drives the 7-day refresh cadence. */
  webhookRegisteredAt: string | null
  cloudId: string | null
  projectId: string | null
}

export async function loadJiraWebhookState(
  syncStateId: string,
): Promise<JiraWebhookState | null> {
  const supabase = getServiceClient()
  const { data } = await supabase
    .from('task_sync_state')
    .select('id, workspace_id, account_id, user_id, config, webhook_gid, webhook_registered_at')
    .eq('id', syncStateId)
    .eq('provider', JIRA_PROVIDER)
    .maybeSingle()

  if (!data) return null
  const config = parseJiraConfig(data.config)
  return {
    id: data.id as string,
    workspaceId: data.workspace_id as string,
    accountId: data.account_id as string,
    userId: data.user_id as string,
    webhookId: (data.webhook_gid as string | null) ?? null,
    webhookRegisteredAt: (data.webhook_registered_at as string | null) ?? null,
    cloudId: config.cloud_id ?? null,
    projectId: config.project_id ?? null,
  }
}

/**
 * Record a registration (or a refresh, which only moves the clock).
 *
 * `registeredAt` exists so a REFRESH can stamp the same column without
 * pretending a new webhook was created: the 7-day cadence is measured from the
 * last time Atlassian's 30-day expiry was pushed out, whichever call did it.
 */
export async function saveJiraWebhookRegistration(
  syncStateId: string,
  webhookId: string,
  registeredAt: string = new Date().toISOString(),
): Promise<{ error: string | null }> {
  const supabase = getServiceClient()
  const { error } = await supabase
    .from('task_sync_state')
    .update({
      webhook_gid: webhookId,
      webhook_registered_at: registeredAt,
      updated_at: new Date().toISOString(),
    })
    .eq('id', syncStateId)
  return { error: error?.message ?? null }
}

/**
 * Forget a registration: null id + registered_at.
 *
 * TEARDOWN only — the caller has just deleted the webhook because the
 * destination was cleared. A RE-POINT does not come through here: it keeps the
 * old id until the replacement is registered and persisted (see
 * ensureJiraWebhook), exactly like the Asana sibling.
 *
 * `webhook_secret` / `webhook_pending_at` are deliberately not touched: they are
 * already NULL for every jira row and writing them would imply this provider has
 * a handshake it does not have.
 */
export async function clearJiraWebhookRegistration(
  syncStateId: string,
): Promise<{ error: string | null }> {
  const supabase = getServiceClient()
  const { error } = await supabase
    .from('task_sync_state')
    .update({
      webhook_gid: null,
      webhook_registered_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', syncStateId)
  return { error: error?.message ?? null }
}

/**
 * Live webhook registrations for one connected account, each WITH the site it
 * lives on.
 *
 * Read by the OAuth disconnect route BEFORE the delete: dropping a
 * `connected_account` cascades its `task_sync_state` row away, but the
 * registration on Atlassian's side survives and keeps POSTing to a receiver that
 * can no longer resolve it.
 *
 * The cloudId travels with the id because `DELETE /webhook` is addressed to a
 * SITE — an id alone is not enough to delete anything, which is the one place
 * the Asana sibling's flat gid list doesn't carry over.
 */
export async function listJiraWebhookRegistrationsForAccount(
  accountId: string,
): Promise<Array<{ webhookId: string; cloudId: string | null }>> {
  const supabase = getServiceClient()
  const { data } = await supabase
    .from('task_sync_state')
    .select('webhook_gid, config')
    .eq('account_id', accountId)
    .eq('provider', JIRA_PROVIDER)
    .not('webhook_gid', 'is', null)
  return (data ?? [])
    .map((row) => ({
      webhookId: (row.webhook_gid as string | null) ?? '',
      cloudId: parseJiraConfig(row.config).cloud_id ?? null,
    }))
    .filter((row) => row.webhookId.length > 0)
}

/**
 * Reconciliation view of the row — a THIRD reader, again scoped to exactly what
 * the sweep needs. It additionally carries `cloudId`, because unlike Asana every
 * Jira read has to be addressed to a site before it can be made at all.
 */
export interface JiraReconcileState {
  id: string
  workspaceId: string
  accountId: string
  userId: string
  cloudId: string | null
  lastReconcileAt: string | null
}

export async function loadJiraReconcileState(
  syncStateId: string,
): Promise<JiraReconcileState | null> {
  const supabase = getServiceClient()
  const { data } = await supabase
    .from('task_sync_state')
    .select('id, workspace_id, account_id, user_id, config, last_reconcile_at')
    .eq('id', syncStateId)
    .eq('provider', JIRA_PROVIDER)
    .maybeSingle()

  if (!data) return null
  return {
    id: data.id as string,
    workspaceId: data.workspace_id as string,
    accountId: data.account_id as string,
    userId: data.user_id as string,
    cloudId: parseJiraConfig(data.config).cloud_id ?? null,
    lastReconcileAt: (data.last_reconcile_at as string | null) ?? null,
  }
}

/** Every jira sync state in the fleet — the cron's dispatch list. */
export async function listJiraSyncStates(): Promise<
  Array<{ id: string; workspaceId: string }>
> {
  const supabase = getServiceClient()
  const { data, error } = await supabase
    .from('task_sync_state')
    .select('id, workspace_id')
    .eq('provider', JIRA_PROVIDER)
  if (error) throw new Error(error.message)
  return (data ?? []).map((row) => ({
    id: row.id as string,
    workspaceId: row.workspace_id as string,
  }))
}

/** Stamp the end of a full reconciliation walk (drives the 6-hour gate). */
export async function stampJiraReconciledAt(
  syncStateId: string,
): Promise<{ error: string | null }> {
  const supabase = getServiceClient()
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('task_sync_state')
    .update({ last_reconcile_at: now, updated_at: now })
    .eq('id', syncStateId)
  return { error: error?.message ?? null }
}

/**
 * Persist a merged `config` back onto the row. Read-modify-write is the
 * caller's job (the settings PATCH validates + merges); this is the bare write.
 */
export async function saveJiraConfig(
  syncStateId: string,
  config: JiraDestinationConfig,
): Promise<{ error: string | null }> {
  const supabase = getServiceClient()
  const { error } = await supabase
    .from('task_sync_state')
    .update({ config, updated_at: new Date().toISOString() })
    .eq('id', syncStateId)
  return { error: error?.message ?? null }
}

/**
 * Is this config complete enough for a push to land?
 *
 * All THREE of cloud_id / project_id / issue_type_id are required, and the gate
 * is deliberately all-or-nothing: `POST /issue` needs a project AND an issue
 * type, and the request can't even be addressed without a cloudId. A partially
 * configured row (site picked, project not) reads as unconfigured everywhere.
 */
export function isJiraDestinationConfigured(config: JiraDestinationConfig): boolean {
  return !!config.cloud_id && !!config.project_id && !!config.issue_type_id
}

/** Convenience: the Jira status id mapped to a bucket, or null. */
export function statusForBucket(
  config: JiraDestinationConfig,
  bucket: LifecycleBucket,
): string | null {
  const value = config.status_map?.[bucket]
  return typeof value === 'string' && value.length > 0 ? value : null
}
