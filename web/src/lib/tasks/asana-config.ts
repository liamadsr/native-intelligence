/**
 * Asana destination config — the one place that reads `task_sync_state`.
 *
 * `task_sync_state` is the canonical workspace→Asana-account map (one row per
 * connected account, seeded at the OAuth callback), and its `config` jsonb holds
 * the push DESTINATION: which Asana workspace + project new tasks land in, and
 * an optional lifecycle-bucket → section map.
 *
 * Why the SERVICE client: the table's RLS mirrors crm_sync_state — a user may
 * SELECT only rows where `user_id = auth.uid()`. The destination is a
 * WORKSPACE-level setting though (every member's pushes go to the same project),
 * so a teammate who didn't run the OAuth flow would read nothing through their
 * own client and see a perpetually "not configured" integration. Callers gate on
 * workspace membership FIRST (requireWorkspaceMember) and then read through here;
 * the row is never exposed wholesale — `webhook_secret` in particular stays
 * server-side and is not part of AsanaSyncState.
 */
import { getServiceClient } from '@/lib/admin'
import type { LifecycleBucket, SectionMap } from './lifecycle'
import { LIFECYCLE_BUCKETS } from './lifecycle'

/** The only provider `task_sync_state` accepts today (see migration 212). */
export const ASANA_PROVIDER = 'asana'

/** Shape of `task_sync_state.config` for the asana provider. */
export interface AsanaDestinationConfig {
  asana_workspace_gid?: string
  asana_workspace_name?: string
  project_gid?: string
  project_name?: string
  section_map?: SectionMap
  /**
   * Put Native Intelligence's fingerprints on a pushed task's notes: the action identifier as
   * a heading, and the "Pushed from Native Intelligence" backlink at the bottom.
   *
   * ABSENT MEANS TRUE — every connection made before this setting existed keeps
   * behaving exactly as it did, byte for byte, without a backfill. Only an
   * explicit `false` strips them, and only from tasks pushed AFTERWARDS: already
   * pushed tasks are never rewritten, because the user's Asana project is theirs
   * and a settings change is not consent to edit its history.
   *
   * Provider-level, NOT destination-level — it survives a project switch and a
   * destination clear, since "don't brand my tasks" is a preference about Native Intelligence
   * rather than about where the tasks land.
   */
  include_dial8_attribution?: boolean
}

/**
 * Does this config want Native Intelligence attribution on pushed tasks?
 *
 * The default-on rule lives HERE, in one place, so no caller can accidentally
 * turn an absent key into "off" by reading the raw field. Both this and the Jira
 * twin exist for the same reason.
 */
export function includesAsanaAttribution(config: AsanaDestinationConfig): boolean {
  return config.include_dial8_attribution !== false
}

/** The subset of the row callers need. Deliberately omits webhook_secret. */
export interface AsanaSyncState {
  id: string
  accountId: string
  userId: string
  config: AsanaDestinationConfig
}

/**
 * Normalize an untrusted `config` jsonb into AsanaDestinationConfig.
 *
 * Everything is optional (a freshly-seeded row is `{}`) and every field is
 * type-checked, so a hand-edited or half-written row degrades to "not
 * configured" rather than throwing deep inside a push.
 */
export function parseAsanaConfig(raw: unknown): AsanaDestinationConfig {
  const source = (raw ?? {}) as Record<string, unknown>
  const config: AsanaDestinationConfig = {}

  for (const key of [
    'asana_workspace_gid',
    'asana_workspace_name',
    'project_gid',
    'project_name',
  ] as const) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) config[key] = value
  }

  const rawMap = source.section_map
  if (rawMap && typeof rawMap === 'object' && !Array.isArray(rawMap)) {
    const map: SectionMap = {}
    for (const bucket of LIFECYCLE_BUCKETS) {
      const value = (rawMap as Record<string, unknown>)[bucket]
      map[bucket] = typeof value === 'string' && value.length > 0 ? value : null
    }
    config.section_map = map
  }

  // Only a real boolean is carried through. A hand-edited `"false"` string is
  // left ABSENT rather than coerced, which lands on the safe default (on) — the
  // same degrade-to-today's-behaviour rule every other field here follows.
  if (typeof source.include_dial8_attribution === 'boolean') {
    config.include_dial8_attribution = source.include_dial8_attribution
  }

  return config
}

/**
 * Load the workspace's Asana sync state, or null when Asana isn't connected.
 *
 * A workspace can in principle carry more than one connected Asana account
 * (two members each ran the flow); the OLDEST row wins so the destination is
 * stable and doesn't flip based on who connected most recently — the same
 * tie-break hubspot-push-contact uses for crm_sync_state.
 */
export async function loadAsanaSyncState(
  workspaceId: string,
): Promise<AsanaSyncState | null> {
  const supabase = getServiceClient()
  const { data } = await supabase
    .from('task_sync_state')
    .select('id, account_id, user_id, config')
    .eq('workspace_id', workspaceId)
    .eq('provider', ASANA_PROVIDER)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!data) return null
  return {
    id: data.id as string,
    accountId: data.account_id as string,
    userId: data.user_id as string,
    config: parseAsanaConfig(data.config),
  }
}

/**
 * The webhook half of the row — SERVICE-ONLY, and deliberately a separate
 * reader from loadAsanaSyncState.
 *
 * `webhook_secret` is the shared HMAC key Asana hands us once during the
 * handshake and then never repeats; anyone holding it can forge a signed
 * delivery for this workspace. AsanaSyncState (which the settings GET, the push
 * and the echo all read) therefore omits it entirely, so there is no path by
 * which it can leak into a client-facing response by someone spreading a state
 * object into JSON. Exactly TWO callers may use this function: the webhook
 * receiver (to verify a signature) and the registration lib (to know whether a
 * registration already exists). Keep it that way.
 *
 * Returns null when the sync state id doesn't exist — the receiver treats an
 * unknown id as "no secret" and 401s rather than leaking the difference between
 * a wrong id and an unregistered one.
 */
export interface AsanaWebhookAuth {
  id: string
  workspaceId: string
  accountId: string
  userId: string
  webhookGid: string | null
  webhookSecret: string | null
  projectGid: string | null
}

export async function loadAsanaWebhookAuth(
  syncStateId: string,
): Promise<AsanaWebhookAuth | null> {
  const supabase = getServiceClient()
  const { data } = await supabase
    .from('task_sync_state')
    .select('id, workspace_id, account_id, user_id, config, webhook_gid, webhook_secret')
    .eq('id', syncStateId)
    .eq('provider', ASANA_PROVIDER)
    .maybeSingle()

  if (!data) return null
  const config = parseAsanaConfig(data.config)
  return {
    id: data.id as string,
    workspaceId: data.workspace_id as string,
    accountId: data.account_id as string,
    userId: data.user_id as string,
    webhookGid: (data.webhook_gid as string | null) ?? null,
    webhookSecret: (data.webhook_secret as string | null) ?? null,
    projectGid: config.project_gid ?? null,
  }
}

/**
 * Persist a merged `config` back onto the row. Read-modify-write is the
 * caller's job (the settings PATCH validates + merges); this is the bare write.
 */
export async function saveAsanaConfig(
  syncStateId: string,
  config: AsanaDestinationConfig,
): Promise<{ error: string | null }> {
  const supabase = getServiceClient()
  const { error } = await supabase
    .from('task_sync_state')
    .update({ config, updated_at: new Date().toISOString() })
    .eq('id', syncStateId)
  return { error: error?.message ?? null }
}

/**
 * Reconciliation view of the row. A SEPARATE reader from loadAsanaWebhookAuth
 * on purpose: the sweep needs `last_reconcile_at` but has no business holding
 * `webhook_secret`, and keeping the secret-bearing reader down to its two
 * callers is what makes that boundary auditable.
 */
export interface AsanaReconcileState {
  id: string
  workspaceId: string
  accountId: string
  userId: string
  lastReconcileAt: string | null
}

export async function loadAsanaReconcileState(
  syncStateId: string,
): Promise<AsanaReconcileState | null> {
  const supabase = getServiceClient()
  const { data } = await supabase
    .from('task_sync_state')
    .select('id, workspace_id, account_id, user_id, last_reconcile_at')
    .eq('id', syncStateId)
    .eq('provider', ASANA_PROVIDER)
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

/** Every Asana sync state in the fleet — the cron's dispatch list. */
export async function listAsanaSyncStates(): Promise<
  Array<{ id: string; workspaceId: string }>
> {
  const supabase = getServiceClient()
  const { data, error } = await supabase
    .from('task_sync_state')
    .select('id, workspace_id')
    .eq('provider', ASANA_PROVIDER)
  if (error) throw new Error(error.message)
  return (data ?? []).map((row) => ({
    id: row.id as string,
    workspaceId: row.workspace_id as string,
  }))
}

/**
 * How long a pending window stays claimable. Asana's handshake lands within the
 * lifetime of our own blocking `POST /webhooks` call (seconds), so this is
 * generous; it exists only so a create that dies before Asana ever calls back
 * can't leave the window open indefinitely.
 */
export const ASANA_WEBHOOK_PENDING_TTL_MS = 2 * 60 * 1000

/**
 * OPEN the single-use handshake window, immediately before `POST /webhooks`.
 *
 * Registration is a SWAP, not an append: the row keeps its current gid+secret
 * (so the outgoing webhook keeps delivering and verifying) right up until the
 * new handshake lands and claimAsanaWebhookSecret replaces the secret in one
 * statement. This call is what says "a handshake is expected now" — outside the
 * window the receiver has nothing to claim and refuses.
 */
export async function openAsanaWebhookPending(
  syncStateId: string,
): Promise<{ error: string | null }> {
  const supabase = getServiceClient()
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('task_sync_state')
    .update({ webhook_pending_at: now, updated_at: now })
    .eq('id', syncStateId)
    .eq('provider', ASANA_PROVIDER)
  return { error: error?.message ?? null }
}

/**
 * Persist the handshake secret — a SINGLE-USE, TIME-BOXED SWAP.
 *
 * This is the security boundary of the whole receiver (see the handshake
 * docblock in src/app/api/webhooks/asana/[syncStateId]/route.ts). The receiver
 * URL is not itself a secret — it is handed to Asana, sits in their config, and
 * is guessable to anyone who learns a sync state id — so without a gate this
 * endpoint would be a secret-OVERWRITE oracle: POST an `X-Hook-Secret` of your
 * choosing, replace the live verification key, sign forged deliveries.
 *
 * The gate is `webhook_pending_at`, and it has two halves, both in the WHERE:
 *   - IS NOT NULL — a window must be OPEN, i.e. we ourselves called
 *     openAsanaWebhookPending on our way into `POST /webhooks`.
 *   - newer than ASANA_WEBHOOK_PENDING_TTL_MS — a window nobody used ages out
 *     instead of lingering as a standing invitation.
 * The same statement NULLs `webhook_pending_at`, which makes it SINGLE-USE: the
 * first handshake consumes the window, and a second one (a stale re-handshake,
 * or an attacker racing it) matches 0 rows.
 *
 * It DELIBERATELY overwrites an existing secret — that is the swap. During a
 * re-registration the old webhook and its secret stay live and verifying until
 * the new handshake lands, so there is no window where a delivery arrives with
 * no key to check it against.
 *
 * NOTE: supabase-js cannot express `now() - interval '2 minutes'` in a filter,
 * so the freshness bound is computed here and sent as an ISO timestamp.
 *
 * Returns false when the CAS matched no row (no window open, an expired one, one
 * already claimed, or an unknown id) so the caller can answer 409 rather than
 * silently accepting.
 */
export async function claimAsanaWebhookSecret(
  syncStateId: string,
  secret: string,
): Promise<boolean> {
  const supabase = getServiceClient()
  const now = new Date()
  const freshestAllowed = new Date(now.getTime() - ASANA_WEBHOOK_PENDING_TTL_MS).toISOString()
  const { data, error } = await supabase
    .from('task_sync_state')
    .update({
      webhook_secret: secret,
      webhook_pending_at: null,
      updated_at: now.toISOString(),
    })
    .eq('id', syncStateId)
    .eq('provider', ASANA_PROVIDER)
    .not('webhook_pending_at', 'is', null)
    .gt('webhook_pending_at', freshestAllowed)
    .select('id')
  if (error) {
    console.error('[asana-config] webhook secret CAS failed:', error.message)
    return false
  }
  return (data?.length ?? 0) > 0
}

/** Record a completed registration (the secret landed during the handshake). */
export async function saveAsanaWebhookRegistration(
  syncStateId: string,
  webhookGid: string,
): Promise<{ error: string | null }> {
  const supabase = getServiceClient()
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('task_sync_state')
    .update({ webhook_gid: webhookGid, webhook_registered_at: now, updated_at: now })
    .eq('id', syncStateId)
  return { error: error?.message ?? null }
}

/**
 * Forget a registration entirely: null gid + secret + registered_at + any open
 * pending window.
 *
 * This is TEARDOWN, not re-registration — the caller has just deleted the Asana
 * webhook because the destination was cleared. A re-point does NOT come through
 * here: it keeps the old gid+secret live and lets the new handshake swap them
 * (see ensureAsanaWebhook). The four columns move together so a torn-down row
 * carries no stale verification key and no standing invitation to claim one.
 */
export async function clearAsanaWebhookRegistration(
  syncStateId: string,
): Promise<{ error: string | null }> {
  const supabase = getServiceClient()
  const { error } = await supabase
    .from('task_sync_state')
    .update({
      webhook_gid: null,
      webhook_secret: null,
      webhook_registered_at: null,
      webhook_pending_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', syncStateId)
  return { error: error?.message ?? null }
}

/**
 * Live webhook gids registered for one connected account.
 *
 * Used by the OAuth disconnect route: deleting a connected_account cascades its
 * task_sync_state row away, but the webhook on Asana's side survives and would
 * keep POSTing to a receiver that can no longer identify it. The gids have to be
 * read BEFORE the delete, while the rows still exist.
 */
export async function listAsanaWebhookGidsForAccount(
  accountId: string,
): Promise<string[]> {
  const supabase = getServiceClient()
  const { data } = await supabase
    .from('task_sync_state')
    .select('webhook_gid')
    .eq('account_id', accountId)
    .eq('provider', ASANA_PROVIDER)
    .not('webhook_gid', 'is', null)
  return (data ?? [])
    .map((row) => row.webhook_gid as string | null)
    .filter((gid): gid is string => typeof gid === 'string' && gid.length > 0)
}

/** Stamp the end of a full reconciliation walk (drives the 6-hour gate). */
export async function stampAsanaReconciledAt(
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

/** Convenience: the section gid mapped to a bucket, or null. */
export function sectionForBucket(
  config: AsanaDestinationConfig,
  bucket: LifecycleBucket,
): string | null {
  const value = config.section_map?.[bucket]
  return typeof value === 'string' && value.length > 0 ? value : null
}
