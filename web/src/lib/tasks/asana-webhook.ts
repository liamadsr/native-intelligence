import {
  createWebhook,
  deleteWebhook,
  getWebhook,
  webhookResourceGid,
  AsanaUnauthorizedError,
} from '@/lib/integrations/asana-api'
import { getValidTokenForAccount } from '@/lib/oauth/token-manager'
import {
  clearAsanaWebhookRegistration,
  listAsanaWebhookGidsForAccount,
  loadAsanaWebhookAuth,
  openAsanaWebhookPending,
  saveAsanaWebhookRegistration,
} from './asana-config'

/**
 * Asana webhook registration lifecycle — CONVERGENT, not event-sourced.
 *
 * `ensureAsanaWebhook` is a repeatable "make reality match config" call: it
 * inspects what Asana currently believes and what `task_sync_state` says the
 * destination is, and moves one step toward agreement. It is safe to call as
 * often as you like, from anywhere, which is why all three triggers just fire
 * the same event:
 *   - the asana-settings PATCH, whenever `project_gid` is set or changed;
 *   - the /api/cron/asana-sync tick, as unconditional self-heal;
 *   - (implicitly) a retry of either, since every path is idempotent.
 *
 * The states it converges:
 *   no project configured  → tear any registration down (the user cleared the
 *                            destination; a webhook watching a project we no
 *                            longer push to is pure noise).
 *   registered + healthy   → no-op. "Healthy" means Asana still has the gid AND
 *                            it watches the CONFIGURED project AND it delivers
 *                            to OUR receiver path — a project switch fails the
 *                            second test and a domain change the third.
 *   registered + unhealthy → CREATE-BEFORE-DELETE (see below), then delete the
 *                            old registration last.
 *   not registered         → create.
 *
 * The secret is NOT written here. `POST /webhooks` blocks until Asana's
 * handshake challenge has been answered by the receiver route, which is what
 * persists `webhook_secret` (see its CAS docblock). By the time create returns
 * 201 the secret is already in the row; this function only opens the window the
 * handshake claims, then stamps the gid.
 *
 * ── Why re-registration is CREATE-BEFORE-DELETE ─────────────────────────────
 * The obvious order — delete the old webhook, null the columns, create a new one
 * — drops coverage for the whole width of the re-registration: from the moment
 * the old gid is gone until the new handshake lands there is no live webhook and
 * no key to verify one with, and every change an Asana user makes in that window
 * is simply lost (Asana delivery is at-most-once). Worse, if the create then
 * fails, the row is left with nothing at all until a cron tick notices.
 *
 * So we keep the old gid AND its secret live, open the pending window, and let
 * the new handshake SWAP the secret in one statement
 * (claimAsanaWebhookSecret). Only after the new gid is safely persisted do we
 * delete the old webhook, best-effort and last.
 *
 * CRASH BETWEEN CREATE AND DELETE-OLD: the old webhook is orphaned on Asana's
 * side but is already harmless — the secret was swapped by the new handshake, so
 * its deliveries fail signature verification and are 401'd. Asana deletes a
 * webhook after 24h of failed deliveries, so the orphan collects itself; there
 * is nothing to clean up and nothing that can act on its payloads meanwhile.
 */

export type EnsureWebhookStatus =
  | 'no_sync_state'
  | 'no_token'
  | 'no_project'
  | 'torn_down'
  | 'healthy'
  | 'recreated'
  | 'created'
  | 'insecure_target'
  | 'create_failed'
  | 'unauthorized'

export interface EnsureWebhookResult {
  status: EnsureWebhookStatus
  webhookGid?: string | null
}

/** The receiver path for a sync state — the one URL shape Asana delivers to. */
export function asanaWebhookPath(syncStateId: string): string {
  return `/api/webhooks/asana/${syncStateId}`
}

/** App origin for the webhook target (same source as the action deep links). */
function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || 'https://dial8.ai').replace(/\/$/, '')
}

/**
 * Can Asana actually reach this target?
 *
 * Asana calls the target from its own infrastructure, so a localhost (or plain
 * http) origin is unreachable BY CONSTRUCTION — attempting the create would
 * simply hang until Asana gives up on the handshake and 4xx's, once per cron
 * tick, forever. We detect it and no-op loudly instead.
 *
 * For local development that means the webhook path is unavailable; use the
 * reconciliation sweep (which polls and needs no inbound connectivity) or point
 * NEXT_PUBLIC_APP_URL at an https tunnel — a tunnel URL passes this check
 * naturally, no flag needed. ASANA_ALLOW_INSECURE_WEBHOOK_TARGET=true is the
 * deliberate escape hatch for anything else.
 */
export function isReachableTarget(target: string): boolean {
  if (process.env.ASANA_ALLOW_INSECURE_WEBHOOK_TARGET === 'true') return true
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  return host !== 'localhost' && host !== '127.0.0.1' && host !== '0.0.0.0' && host !== '::1'
}

export async function ensureAsanaWebhook(args: {
  syncStateId: string
}): Promise<EnsureWebhookResult> {
  const { syncStateId } = args

  const state = await loadAsanaWebhookAuth(syncStateId)
  if (!state) return { status: 'no_sync_state' }

  const resolved = await getValidTokenForAccount(state.accountId)
  if (!resolved) {
    // Disconnected/expired: nothing to do until the user reconnects. Leave the
    // existing registration alone — it may well still be valid, and tearing it
    // down would lose deliveries a reconnect would have kept.
    return { status: 'no_token' }
  }
  const token = resolved.token

  // ── No destination configured ───────────────────────────────────────────
  if (!state.projectGid) {
    if (!state.webhookGid) return { status: 'no_project' }
    await deleteWebhook(token, state.webhookGid)
    await clearAsanaWebhookRegistration(syncStateId)
    return { status: 'torn_down' }
  }

  const target = `${appBaseUrl()}${asanaWebhookPath(syncStateId)}`

  // ── Existing registration: is it still the RIGHT one? ────────────────────
  // A stale one is NOT torn down here. It stays live — gid saved, secret still
  // verifying — until the replacement is registered and persisted below.
  let staleWebhookGid: string | null = null
  if (state.webhookGid) {
    let existing
    try {
      existing = await getWebhook(token, state.webhookGid)
    } catch (err) {
      if (err instanceof AsanaUnauthorizedError) return { status: 'unauthorized' }
      throw err
    }

    const healthy =
      !!existing &&
      existing.active !== false &&
      webhookResourceGid(existing) === state.projectGid &&
      typeof existing.target === 'string' &&
      existing.target.endsWith(asanaWebhookPath(syncStateId))

    if (healthy) {
      return { status: 'healthy', webhookGid: state.webhookGid }
    }

    // Dead, missing, watching the wrong project, or pointing at an old domain.
    staleWebhookGid = state.webhookGid
  }

  // ── Create ──────────────────────────────────────────────────────────────
  if (!isReachableTarget(target)) {
    console.warn(
      `[asana-webhook] skipping registration for sync state ${syncStateId}: ` +
        `target ${target} is not reachable from Asana (needs a public https URL). ` +
        'Read-back falls back to the reconciliation sweep.',
    )
    return { status: 'insecure_target' }
  }

  // Open the single-use handshake window IMMEDIATELY before the create — it is
  // the only thing that lets the receiver accept the secret Asana is about to
  // POST, and it is time-boxed so an abandoned attempt closes itself.
  await openAsanaWebhookPending(syncStateId)

  try {
    // The receiver answers Asana's handshake WHILE this call is in flight and
    // swaps the secret in; we only get here (201) once that has happened.
    const created = await createWebhook(token, {
      resource: state.projectGid,
      target,
      // completed-only: the single field the read-back acts on. A narrow filter
      // is also what keeps our own section moves from echoing back at us.
      filters: [{ resource_type: 'task', action: 'changed', fields: ['completed'] }],
    })

    if (!created?.gid) {
      return { status: 'create_failed' }
    }

    const { error } = await saveAsanaWebhookRegistration(syncStateId, created.gid)
    if (error) {
      // We registered on Asana's side but can't remember the gid, so nothing
      // will ever verify or tear it down. Undo the create rather than leak a
      // webhook that delivers to a receiver which cannot identify it; the next
      // cron tick retries the whole thing from a clean state.
      console.warn(
        `[asana-webhook] could not persist registration for sync state ${syncStateId} ` +
          `(${error}); rolling the Asana webhook back.`,
      )
      await deleteWebhook(token, created.gid)
      return { status: 'create_failed' }
    }

    // LAST, and best-effort: the replacement is live and persisted, so the old
    // registration is now pure noise (its secret was swapped out from under it).
    // Its own try/catch — deleteWebhook is contractually non-throwing, but this
    // is a tidy-up AFTER the thing that mattered succeeded, and letting it reach
    // the outer catch would report a completed registration as create_failed and
    // send the next cron tick round again. An orphan is harmless: Asana collects
    // it after 24h of 401'd deliveries.
    if (staleWebhookGid) {
      try {
        await deleteWebhook(token, staleWebhookGid)
      } catch (err) {
        console.warn(
          `[asana-webhook] could not delete the replaced webhook ${staleWebhookGid} ` +
            `for sync state ${syncStateId}:`,
          err instanceof Error ? err.message : String(err),
        )
      }
    }

    return {
      status: staleWebhookGid ? 'recreated' : 'created',
      webhookGid: created.gid,
    }
  } catch (err) {
    if (err instanceof AsanaUnauthorizedError) return { status: 'unauthorized' }
    // Never throw: a workspace that can't register (project archived, scope
    // revoked) must not accrete failing runs every 30 minutes. The old
    // registration — if any — is deliberately still in place and still covering
    // us, and the pending window ages out on its own.
    console.warn(
      `[asana-webhook] create failed for sync state ${syncStateId}:`,
      err instanceof Error ? err.message : String(err),
    )
    return { status: 'create_failed' }
  }
}

/**
 * Delete every Asana webhook registered for a connected account — the OAuth
 * disconnect hook.
 *
 * Deleting a `connected_account` cascades its `task_sync_state` row away, which
 * takes the gid and the secret with it but leaves Asana happily POSTing to a
 * receiver that can no longer identify the delivery. Those POSTs 401 and Asana
 * gives up after 24h, so this is tidiness rather than correctness — which is
 * exactly why it is BEST-EFFORT: it must never block, slow or fail a disconnect.
 * The gids have to be read before the account row goes away.
 */
export async function tearDownAsanaWebhooksForAccount(accountId: string): Promise<void> {
  try {
    const gids = await listAsanaWebhookGidsForAccount(accountId)
    if (gids.length === 0) return

    const resolved = await getValidTokenForAccount(accountId)
    if (!resolved) return // Already unusable; Asana's 24h sweep gets them.

    for (const gid of gids) {
      await deleteWebhook(resolved.token, gid)
    }
  } catch (err) {
    console.warn(
      `[asana-webhook] best-effort webhook teardown failed for account ${accountId}:`,
      err instanceof Error ? err.message : String(err),
    )
  }
}
