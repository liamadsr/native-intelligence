/**
 * Linear destination config — the linear half of `task_sync_state`.
 *
 * `task_sync_state` is the canonical workspace→connected-account map (one row
 * per connected account, seeded at the OAuth callback), and its `config` jsonb
 * holds the push DESTINATION: which Linear team (and optionally project) new
 * issues land in, plus the derived lifecycle-bucket → workflow-state map.
 *
 * Sibling of jira-config.ts and asana-config.ts, with the webhook machinery of
 * BOTH removed. Asana needs a challenge/response handshake and a single-use CAS
 * window to capture its signing secret; Jira needs a registration id and an
 * expiry clock to refresh against. Linear needs neither: its webhooks are
 * APP-level — one URL and one signing secret configured in the OAuth app
 * console, auto-provisioned by Linear for each organization that authorizes the
 * app. So there is no register/refresh/teardown lifecycle, no per-row secret,
 * and consequently no linear-webhook.ts at all. Every webhook column on a linear
 * row stays NULL forever, and this file never reads or writes one.
 *
 * (That absence is also why the "rule of three" extraction a reader might expect
 * here — a shared webhook-lifecycle module across the providers — never
 * materialized: the third caller does not exist.)
 *
 * Why the SERVICE client (same reasoning as its siblings): the table's RLS lets
 * a user SELECT only rows where `user_id = auth.uid()`, but the destination is a
 * WORKSPACE-level setting — every member's pushes go to the same team, so a
 * teammate who didn't run the OAuth flow would otherwise see a perpetually "not
 * configured" integration. Callers gate on workspace membership FIRST
 * (requireWorkspaceMember) and then read through here.
 */
import { getServiceClient } from '@/lib/admin'
import { revokeToken } from '@/lib/integrations/linear-api'
import { getValidTokenForAccount } from '@/lib/oauth/token-manager'
import type { LifecycleBucket, LinearStateMap, LinearStateRef } from './lifecycle'
import { LIFECYCLE_BUCKETS } from './lifecycle'

/** The provider key for every linear row in task_sync_state / action_external_task. */
export const LINEAR_PROVIDER = 'linear'

/**
 * Shape of `task_sync_state.config` for the linear provider.
 *
 * The destination ids are EXPLICIT PICKS — the team (and project) come from a
 * user's confirmed choice, never from a guess, the same rule the Jira config
 * states. `state_map` is the deliberate exception: it is DERIVED from the
 * chosen team's workflow states rather than picked, because Linear's state
 * `type` makes the mapping a fact rather than a preference. It is still only
 * ever written server-side at destination-save time, so it cannot drift from the
 * team it describes.
 */
export interface LinearDestinationConfig {
  /**
   * The Linear organization the token belongs to. Stored for the webhook
   * read-back's sanity check (a delivery carries `organizationId`) rather than
   * for addressing: unlike a Jira cloudId, nothing in the API path needs it —
   * an OAuth token belongs to exactly one organization by construction.
   */
  organization_id?: string
  organization_name?: string
  /**
   * THE gate: no team_id → not configured. A Linear issue belongs to a team, and
   * `issueCreate` requires nothing else.
   */
  team_id?: string
  /** Team key ("ENG") — the prefix issue identifiers are built from. Display. */
  team_key?: string
  team_name?: string
  /**
   * OPTIONAL. A Linear issue may live directly under its team, so this refines
   * the destination rather than completing it — the structural difference from
   * Jira, where an issue cannot exist outside a project.
   */
  project_id?: string
  project_name?: string
  /**
   * bucket → {id, name} of the team's workflow state for that bucket.
   *
   * DERIVED, not picked (see deriveLinearStateMap in lifecycle.ts). A bucket is
   * ABSENT when the team has no state of a suitable type — a team with no
   * canceled-type state is ordinary, not broken — and the echo declines that
   * bucket rather than writing a guessed state.
   */
  state_map?: LinearStateMap
  /**
   * Put Dial8's fingerprints on a pushed issue's description: the action
   * identifier as a bold heading line, and the "Pushed from Dial8" backlink at
   * the bottom.
   *
   * ABSENT MEANS TRUE — every connection made before this setting existed keeps
   * behaving exactly as it did, byte for byte, without a backfill. Only an
   * explicit `false` strips them, and only from issues pushed AFTERWARDS:
   * already pushed issues are never rewritten.
   *
   * Provider-level, NOT destination-level — it survives a team switch, a project
   * switch and a destination clear, all of which reset the ids beneath them.
   */
  include_dial8_attribution?: boolean
}

/**
 * Does this config want Dial8 attribution on pushed issues?
 *
 * The default-on rule lives HERE, in one place, so no caller can accidentally
 * turn an absent key into "off" by reading the raw field.
 */
export function includesLinearAttribution(config: LinearDestinationConfig): boolean {
  return config.include_dial8_attribution !== false
}

/** The subset of the row callers need. Deliberately omits the webhook columns. */
export interface LinearSyncState {
  id: string
  accountId: string
  userId: string
  config: LinearDestinationConfig
}

/**
 * Normalize an untrusted `config` jsonb into LinearDestinationConfig.
 *
 * Everything is optional (a freshly-seeded row is `{}`) and every field is
 * type-checked, so a hand-edited or half-written row degrades to "not
 * configured" rather than throwing deep inside a push.
 */
export function parseLinearConfig(raw: unknown): LinearDestinationConfig {
  const source = (raw ?? {}) as Record<string, unknown>
  const config: LinearDestinationConfig = {}

  for (const key of [
    'organization_id',
    'organization_name',
    'team_id',
    'team_key',
    'team_name',
    'project_id',
    'project_name',
  ] as const) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) config[key] = value
  }

  const rawMap = source.state_map
  if (rawMap && typeof rawMap === 'object' && !Array.isArray(rawMap)) {
    const map: LinearStateMap = {}
    for (const bucket of LIFECYCLE_BUCKETS) {
      const entry = (rawMap as Record<string, unknown>)[bucket]
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      const { id, name } = entry as { id?: unknown; name?: unknown }
      // Both halves required: an entry with no id is not a write target, and an
      // entry with no name cannot be rendered in the read-only mapping. A
      // half-written bucket is dropped rather than half-kept — ABSENT is a
      // meaningful value here ("this team has no such state"), so degrading to
      // it is exactly right.
      if (typeof id !== 'string' || id.length === 0) continue
      if (typeof name !== 'string' || name.length === 0) continue
      map[bucket] = { id, name }
    }
    // An empty object is still recorded: it distinguishes "derived, and this
    // team expresses no bucket" from "never derived".
    config.state_map = map
  }

  // Only a real boolean is carried through — a hand-edited `"false"` string is
  // left ABSENT rather than coerced, landing on the safe default (on).
  if (typeof source.include_dial8_attribution === 'boolean') {
    config.include_dial8_attribution = source.include_dial8_attribution
  }

  return config
}

/**
 * Load the workspace's Linear sync state, or null when Linear isn't connected.
 *
 * A workspace can in principle carry more than one connected Linear account (two
 * members each ran the flow); the OLDEST row wins so the destination is stable
 * and doesn't flip based on who connected most recently — the same tie-break
 * loadJiraSyncState and loadAsanaSyncState use.
 */
export async function loadLinearSyncState(
  workspaceId: string,
): Promise<LinearSyncState | null> {
  const supabase = getServiceClient()
  const { data } = await supabase
    .from('task_sync_state')
    .select('id, account_id, user_id, config')
    .eq('workspace_id', workspaceId)
    .eq('provider', LINEAR_PROVIDER)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!data) return null
  return {
    id: data.id as string,
    accountId: data.account_id as string,
    userId: data.user_id as string,
    config: parseLinearConfig(data.config),
  }
}

/**
 * Persist a merged `config` back onto the row. Read-modify-write is the
 * caller's job (the settings PATCH validates, derives the state map and
 * merges); this is the bare write.
 */
export async function saveLinearConfig(
  syncStateId: string,
  config: LinearDestinationConfig,
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
 * ONE id — the team. Deliberately narrower than the Jira gate (site + project +
 * issue type) because `issueCreate` needs nothing else: a project is optional,
 * there is no issue-type concept, and the state map only refines WHERE in the
 * team's workflow the issue starts. A team-only config pushes successfully.
 */
export function isLinearDestinationConfigured(config: LinearDestinationConfig): boolean {
  return !!config.team_id
}

/** Convenience: the {id, name} mapped to a bucket, or null. */
export function stateForBucket(
  config: LinearDestinationConfig,
  bucket: LifecycleBucket,
): LinearStateRef | null {
  const mapped = config.state_map?.[bucket]
  if (!mapped || typeof mapped.id !== 'string' || mapped.id.length === 0) return null
  return mapped
}

/**
 * Reconciliation view of the row — a separate, narrower reader, mirroring
 * loadJiraReconcileState.
 *
 * Deliberately does NOT carry the organization id, unlike the Jira sibling's
 * cloudId. The webhook read-back checks the org because a DELIVERY names one and
 * the delivery is outside input; the sweep has no such input — it walks one
 * row's own links and reads them with that row's own token, so an org check here
 * would only compare the row against itself.
 */
export interface LinearReconcileState {
  id: string
  workspaceId: string
  accountId: string
  userId: string
  lastReconcileAt: string | null
}

export async function loadLinearReconcileState(
  syncStateId: string,
): Promise<LinearReconcileState | null> {
  const supabase = getServiceClient()
  const { data } = await supabase
    .from('task_sync_state')
    .select('id, workspace_id, account_id, user_id, config, last_reconcile_at')
    .eq('id', syncStateId)
    .eq('provider', LINEAR_PROVIDER)
    .maybeSingle()

  if (!data) return null
  return {
    id: data.id as string,
    workspaceId: data.workspace_id as string,
    accountId: data.account_id as string,
    userId: data.user_id as string,
    lastReconcileAt: (data.last_reconcile_at as string | null) ?? null,
  }
}

/** Every linear sync state in the fleet — the cron's dispatch list. */
export async function listLinearSyncStates(): Promise<
  Array<{ id: string; workspaceId: string }>
> {
  const supabase = getServiceClient()
  const { data, error } = await supabase
    .from('task_sync_state')
    .select('id, workspace_id')
    .eq('provider', LINEAR_PROVIDER)
  if (error) throw new Error(error.message)
  return (data ?? []).map((row) => ({
    id: row.id as string,
    workspaceId: row.workspace_id as string,
  }))
}

/** Stamp the end of a full reconciliation walk (drives the 6-hour gate). */
export async function stampLinearReconciledAt(
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
 * Resolve a connected account's Linear access token for the disconnect-path
 * revoke.
 *
 * Lives here rather than in the disconnect route so the route keeps its shape:
 * one best-effort provider call per branch, each owned by that provider's
 * module. NEVER throws — a disconnect must complete regardless.
 */
export async function revokeLinearTokenForAccount(accountId: string): Promise<void> {
  try {
    const resolved = await getValidTokenForAccount(accountId)
    if (!resolved) return // Already unusable; nothing to revoke.
    await revokeToken(resolved.token)
  } catch (err) {
    console.warn(
      `[linear-config] best-effort token revoke failed for account ${accountId}:`,
      err instanceof Error ? err.message : String(err),
    )
  }
}
