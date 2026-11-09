import {
  assertNumericJiraId,
  deleteWebhooks,
  isNumericJiraId,
  listWebhooks,
  refreshWebhooks,
  registerWebhooks,
  JiraUnauthorizedError,
  type JiraRegisteredWebhook,
} from '@/lib/integrations/jira-api'
import { getValidTokenForAccount } from '@/lib/oauth/token-manager'
import {
  clearJiraWebhookRegistration,
  listJiraWebhookRegistrationsForAccount,
  loadJiraWebhookState,
  saveJiraWebhookRegistration,
} from './jira-config'

/**
 * Jira dynamic-webhook registration lifecycle — CONVERGENT, not event-sourced.
 *
 * `ensureJiraWebhook` is a repeatable "make reality match config" call: it asks
 * Atlassian what it currently believes, compares that with the destination in
 * `task_sync_state`, and moves one step toward agreement. Safe to call as often
 * as you like, which is why all three triggers just fire the same event:
 *   - the jira-settings PATCH, whenever `project_id` is set or changed;
 *   - the /api/cron/jira-sync tick, as unconditional self-heal AND as the thing
 *     that keeps the registration from expiring (see EXPIRY below);
 *   - a retry of either.
 *
 * The states it converges:
 *   no destination        → tear any registration down.
 *   registered + healthy  → no-op, or a REFRESH when the clock says so.
 *   registered + unhealthy→ CREATE-BEFORE-DELETE, old id deleted last.
 *   not registered        → create.
 *
 * ── How this differs from the Asana sibling, and why ─────────────────────────
 *
 * NO HANDSHAKE, NO SECRET, NO CAS. Atlassian's dynamic webhooks are registered
 * with a plain POST that returns an id, and their deliveries are UNSIGNED —
 * there is no shared-secret mechanism for REST-registered webhooks at all
 * (Atlassian's own forum answer; the feature request is JRACLOUD-96162). So the
 * whole `openAsanaWebhookPending` / `claimAsanaWebhookSecret` window has no
 * analogue here. The receiver's trust comes from somewhere else entirely: it
 * treats every delivery as an unauthenticated wake-up and re-fetches the issue
 * over an authenticated call before believing anything.
 *
 * ONE GLOBAL URL. Atlassian allows "only a single URL per app", so the receiver
 * is `/api/webhooks/jira` with no per-sync-state segment. Deliveries therefore
 * do NOT identify their workspace, which is exactly why the read-back resolves
 * links by issue id across workspaces instead.
 *
 * EXPIRY IS THE MAIN EVENT. An Asana webhook lives until it fails; a Jira one
 * expires 30 days after its last create/refresh no matter how healthy it is. The
 * cron is therefore load-bearing rather than merely a self-heal: it refreshes at
 * a 7-day cadence, which tolerates three weeks of missed ticks before anything
 * goes dark.
 *
 * ── Why re-registration is CREATE-BEFORE-DELETE ─────────────────────────────
 * Delete-first would drop coverage for the width of the swap. Jira retries a
 * failed delivery (5 attempts over 5–15 min) but never re-sends one that had
 * nowhere to arrive, so changes made in that gap are simply missed — and a
 * 3LO app cannot even inspect what it missed (`GET /webhook/failed` is
 * Connect-apps-only). The reconcile sweep repairs it eventually; not creating
 * the gap is better.
 *
 * CRASH BETWEEN CREATE AND DELETE-OLD leaves one orphan against the
 * 5-per-app-per-user-per-tenant cap. It is picked up on the next convergence
 * pass only if it is still the stored id — an orphan whose id we already
 * overwrote is invisible to us and ages out after 30 days. That is accepted; see
 * the note on foreign registrations in the convergence code below.
 */

/** Delivery target. ONE url per app — there is no per-sync-state segment. */
export function jiraWebhookPath(): string {
  return '/api/webhooks/jira'
}

/** App origin for the webhook target (same source as the action deep links). */
function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || 'https://dial8.ai').replace(/\/$/, '')
}

/**
 * Refresh once the registration is older than this. Atlassian expires a webhook
 * 30 days after create/refresh; a 7-day cadence off a 30-minute cron leaves
 * three weeks of slack for outages, deploys and paused projects.
 */
export const WEBHOOK_REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000

/** The events we subscribe to. See ensureJiraWebhook for why these two. */
export const JIRA_WEBHOOK_EVENTS = ['jira:issue_updated', 'jira:issue_deleted'] as const

/** Pages of `GET /webhook` we will walk. The (app, user, tenant) cap is 5. */
const MAX_LIST_PAGES = 3

/**
 * Can Atlassian actually reach this target?
 *
 * Jira calls the target from its own infrastructure, so a localhost (or plain
 * http) origin is unreachable BY CONSTRUCTION: the registration would succeed,
 * every delivery would fail, and we'd have burned a slot against the 5-webhook
 * cap for nothing. We detect it and no-op loudly instead.
 *
 * For local development that means the webhook path is unavailable; use the
 * reconciliation sweep (which polls and needs no inbound connectivity) or point
 * NEXT_PUBLIC_APP_URL at an https tunnel — a tunnel URL passes naturally.
 * JIRA_ALLOW_INSECURE_WEBHOOK_TARGET=true is the deliberate escape hatch.
 *
 * COPIED rather than hoisted from asana-webhook.ts. The two are byte-identical
 * apart from the env var, but sharing them would mean renaming the Asana flag
 * (breaking anyone's local setup) or teaching one helper about two flags —
 * churn in a shipped provider to save nine lines. The rule-of-three extraction
 * belongs with the Linear adapter, when there is a third caller to design for.
 */
export function isReachableTarget(target: string): boolean {
  if (process.env.JIRA_ALLOW_INSECURE_WEBHOOK_TARGET === 'true') return true
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

/**
 * The JQL a registration filters on. Only `project = <id>` — see below.
 *
 * The id is VALIDATED, not escaped, because there is no escaping available: the
 * value is interpolated into a query string Atlassian parses. `project = 10000
 * OR assignee != null` is inside the restricted subset webhooks accept, so it
 * registers cleanly and then delivers every issue in the tenant instead of one
 * project — and `isHealthy` compares the stored filter for equality, so the
 * widened filter reads as healthy forever. The settings route rejects a
 * non-numeric project id at the boundary; this is the backstop for a row that
 * predates it.
 */
export function jiraWebhookJql(projectId: string): string {
  return `project = ${assertNumericJiraId('projectId', projectId)}`
}

export type EnsureJiraWebhookStatus =
  | 'no_sync_state'
  | 'no_token'
  | 'no_project'
  /** The stored project id isn't an Atlassian id — refuse to build JQL from it. */
  | 'invalid_project'
  | 'torn_down'
  | 'healthy'
  | 'refreshed'
  | 'recreated'
  | 'created'
  | 'insecure_target'
  | 'create_failed'
  | 'unauthorized'

export interface EnsureJiraWebhookResult {
  status: EnsureJiraWebhookStatus
  webhookId?: string | null
}

/** Walk `GET /webhook` for the registration we believe we own. */
async function findRegisteredWebhook(
  token: string,
  cloudId: string,
  webhookId: string,
): Promise<JiraRegisteredWebhook | null> {
  const wanted = Number(webhookId)
  if (!Number.isFinite(wanted)) return null

  let startAt = 0
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const { webhooks, nextStartAt } = await listWebhooks(token, cloudId, { startAt })
    const found = webhooks.find((w) => w.id === wanted)
    if (found) return found
    if (nextStartAt === null) return null
    startAt = nextStartAt
  }
  return null
}

/**
 * Does a live registration still match what we would register today?
 *
 * The url is compared for FULL equality against the target we would register
 * now — ORIGIN INCLUDED. A suffix match (`endsWith('/api/webhooks/jira')`) was
 * the bug: the path is a global constant for this provider, so every stale
 * origin satisfies it. A registration made from an old domain, a preview
 * deployment or a dev tunnel would then be declared healthy forever, refreshed
 * every 7 days so it never even expired out, while every delivery went
 * somewhere we don't run — read-back silently degrading to the 6-hourly sweep
 * with `status: 'healthy'` in every log line. (The Asana sibling gets away with
 * a suffix test because its path embeds a unique syncStateId.)
 */
function isHealthy(
  webhook: JiraRegisteredWebhook,
  args: { target: string; projectId: string },
): boolean {
  if (webhook.url !== args.target) return false
  if (webhook.jqlFilter !== jiraWebhookJql(args.projectId)) return false
  const events = webhook.events ?? []
  return JIRA_WEBHOOK_EVENTS.every((event) => events.includes(event))
}

export async function ensureJiraWebhook(args: {
  syncStateId: string
}): Promise<EnsureJiraWebhookResult> {
  const { syncStateId } = args

  const state = await loadJiraWebhookState(syncStateId)
  if (!state) return { status: 'no_sync_state' }

  const resolved = await getValidTokenForAccount(state.accountId)
  if (!resolved) {
    // Disconnected/expired: nothing to do until the user reconnects. The
    // existing registration is left alone — it may well still be delivering,
    // and tearing it down would lose changes a reconnect would have kept.
    return { status: 'no_token' }
  }
  const token = resolved.token

  // ── No destination configured ───────────────────────────────────────────
  // Both halves are required: without a cloudId there is no site to address the
  // call to, and without a project there is nothing to filter on.
  if (!state.projectId || !state.cloudId) {
    if (!state.webhookId || !state.cloudId) return { status: 'no_project' }
    await deleteWebhooks(token, state.cloudId, [Number(state.webhookId)])
    await clearJiraWebhookRegistration(syncStateId)
    return { status: 'torn_down' }
  }

  const cloudId = state.cloudId
  const projectId = state.projectId
  const target = `${appBaseUrl()}${jiraWebhookPath()}`

  // A project id that isn't an Atlassian id cannot be turned into JQL (it would
  // widen the filter to the whole tenant — see jiraWebhookJql). Refuse loudly
  // rather than register something we can't reason about; the settings route
  // rejects such a value at the boundary, so this only fires for a row written
  // before that check existed.
  if (!isNumericJiraId(projectId)) {
    console.warn(
      `[jira-webhook] sync state ${syncStateId} holds a non-numeric project id; ` +
        'refusing to build a JQL filter from it.',
    )
    return { status: 'invalid_project' }
  }

  // ── Existing registration: is it still the RIGHT one? ────────────────────
  // A stale one is NOT torn down here. It stays live and delivering until the
  // replacement is registered and persisted below.
  let staleWebhookId: string | null = null
  if (state.webhookId) {
    let existing: JiraRegisteredWebhook | null
    try {
      existing = await findRegisteredWebhook(token, cloudId, state.webhookId)
    } catch (err) {
      if (err instanceof JiraUnauthorizedError) return { status: 'unauthorized' }
      throw err
    }

    if (existing && isHealthy(existing, { target, projectId })) {
      // Healthy — but a Jira webhook dies of old age even when nothing is wrong.
      const age = state.webhookRegisteredAt
        ? Date.now() - new Date(state.webhookRegisteredAt).getTime()
        : Number.POSITIVE_INFINITY
      if (!Number.isFinite(age) || age >= WEBHOOK_REFRESH_AFTER_MS) {
        try {
          // The response's `expirationDate` is deliberately NOT stored. The
          // column means "last registered/refreshed", and writing an expiry 30
          // days in the future into it would invert the cadence: the age
          // computed above would be negative for a month and then cross 7 days
          // only a week AFTER the webhook had already died. Stamping when the
          // refresh happened keeps "refresh weekly" meaning what it says.
          await refreshWebhooks(token, cloudId, [Number(state.webhookId)])
          await saveJiraWebhookRegistration(syncStateId, state.webhookId)
          return { status: 'refreshed', webhookId: state.webhookId }
        } catch (err) {
          if (err instanceof JiraUnauthorizedError) return { status: 'unauthorized' }
          // A failed refresh is not urgent — there are ~23 days of slack — so
          // report healthy and let the next tick try again rather than
          // re-registering and burning a cap slot.
          console.warn(
            `[jira-webhook] refresh failed for sync state ${syncStateId}:`,
            err instanceof Error ? err.message : String(err),
          )
          return { status: 'healthy', webhookId: state.webhookId }
        }
      }
      return { status: 'healthy', webhookId: state.webhookId }
    }

    // Gone (expired past recovery, deleted, never really created), watching the
    // wrong project, or pointing at an old domain — the last of which the url
    // comparison in isHealthy now actually detects.
    staleWebhookId = state.webhookId
  }

  // ── Create ──────────────────────────────────────────────────────────────
  if (!isReachableTarget(target)) {
    console.warn(
      `[jira-webhook] skipping registration for sync state ${syncStateId}: ` +
        `target ${target} is not reachable from Jira (needs a public https URL). ` +
        'Read-back falls back to the reconciliation sweep.',
    )
    return { status: 'insecure_target' }
  }

  let created: number | null = null
  try {
    const results = await registerWebhooks(token, cloudId, {
      url: target,
      webhooks: [
        {
          events: [...JIRA_WEBHOOK_EVENTS],
          // `project = <id>` is inside the restricted JQL subset webhooks accept,
          // and the numeric id is used rather than the key because an admin can
          // rename a key out from under a registration.
          jqlFilter: jiraWebhookJql(projectId),
          // issue_updated fires on ANY edit unless filtered; status is the only
          // field the read-back acts on. (Ignored for issue_deleted, which has
          // no changelog — that event arrives regardless, which is what we want.)
          fieldIdsFilter: ['status'],
        },
      ],
    })

    // PARTIAL SUCCESS IS THE DOCUMENTED SHAPE: each entry carries either an id
    // or its own errors, and a 200 says nothing about either.
    const first = results[0]
    if (first?.errors?.length) {
      console.warn(
        `[jira-webhook] registration rejected for sync state ${syncStateId}: ` +
          first.errors.join('; '),
      )
      return { status: 'create_failed' }
    }
    created = typeof first?.createdWebhookId === 'number' ? first.createdWebhookId : null
  } catch (err) {
    if (err instanceof JiraUnauthorizedError) return { status: 'unauthorized' }
    // Never throw: a workspace that can't register (project archived, scope
    // revoked, a JQL clause Atlassian stopped supporting) must not accrete
    // failing runs every 30 minutes. Any old registration is deliberately still
    // in place and still covering us.
    console.warn(
      `[jira-webhook] create failed for sync state ${syncStateId}:`,
      err instanceof Error ? err.message : String(err),
    )
    return { status: 'create_failed' }
  }

  if (created === null) return { status: 'create_failed' }
  const createdId = String(created)

  const { error } = await saveJiraWebhookRegistration(syncStateId, createdId)
  if (error) {
    // Registered on Atlassian's side but unrecorded here: nothing will ever
    // refresh it or tear it down, and it holds a slot against the 5-webhook cap
    // until it expires. Undo the create and let the next tick retry cleanly.
    console.warn(
      `[jira-webhook] could not persist registration for sync state ${syncStateId} ` +
        `(${error}); rolling the Jira webhook back.`,
    )
    await deleteWebhooks(token, cloudId, [created])
    return { status: 'create_failed' }
  }

  // LAST, and best-effort: the replacement is live and persisted, so the old
  // registration is now pure noise. Its own try/catch — deleteWebhooks is
  // contractually non-throwing, but letting a tidy-up failure reach the outer
  // path would report a completed registration as create_failed and send the
  // next tick round to replace a perfectly good webhook.
  //
  // NOTE we delete ONLY our own stored id, never every webhook on this site
  // pointing at our receiver URL. `GET /webhook` is scoped to (app, USER,
  // tenant), and one Atlassian user can legitimately be connected to two Native Intelligence
  // workspaces — each with its own registration, each delivering to the same
  // global URL. A "sweep everything that looks like ours" convergence would
  // silently unregister the other workspace.
  if (staleWebhookId) {
    try {
      await deleteWebhooks(token, cloudId, [Number(staleWebhookId)])
    } catch (err) {
      console.warn(
        `[jira-webhook] could not delete the replaced webhook ${staleWebhookId} ` +
          `for sync state ${syncStateId}:`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  return {
    status: staleWebhookId ? 'recreated' : 'created',
    webhookId: createdId,
  }
}

/**
 * Delete a registration that belongs to a site we are no longer pointing at.
 *
 * `DELETE /webhook` is addressed to a SITE, so once the destination's cloudId
 * has moved on, `ensureJiraWebhook` can no longer clean up after itself: it
 * would issue the delete against the NEW tenant, where the id means nothing,
 * and leave the old site's registration delivering (and holding one of its five
 * per-app/user/site slots) for up to 30 days. The settings PATCH therefore
 * captures the outgoing (webhookId, cloudId) pair before it saves and hands it
 * here, and the Inngest function runs this AFTER the convergence pass so the
 * replacement exists first (create-before-delete).
 *
 * Best-effort by contract, exactly like every other teardown in this file: the
 * worst case is one orphan that expires by itself.
 */
export async function retireJiraWebhook(args: {
  syncStateId: string
  webhookId: string
  cloudId: string
}): Promise<{ status: 'retired' | 'skipped' }> {
  const { syncStateId, webhookId, cloudId } = args
  const numeric = Number(webhookId)
  if (!Number.isFinite(numeric) || !cloudId) return { status: 'skipped' }

  try {
    const state = await loadJiraWebhookState(syncStateId)
    if (!state) return { status: 'skipped' }
    const resolved = await getValidTokenForAccount(state.accountId)
    if (!resolved) return { status: 'skipped' }
    await deleteWebhooks(resolved.token, cloudId, [numeric])
    return { status: 'retired' }
  } catch (err) {
    console.warn(
      `[jira-webhook] could not retire webhook ${webhookId} on site ${cloudId} ` +
        `for sync state ${syncStateId}:`,
      err instanceof Error ? err.message : String(err),
    )
    return { status: 'skipped' }
  }
}

/**
 * Delete every Jira webhook registered for a connected account — the OAuth
 * disconnect hook.
 *
 * Dropping a `connected_account` cascades its `task_sync_state` row away, which
 * takes the webhook id with it but leaves Jira POSTing to a receiver that can no
 * longer resolve the issue to anything. Those deliveries are harmless (the
 * receiver finds no links and stops), so this is tidiness plus cap hygiene
 * rather than correctness — which is exactly why it is BEST-EFFORT: it must
 * never block, slow or fail a disconnect. The ids have to be read before the
 * account row goes away.
 *
 * Each registration carries its own cloudId because `DELETE /webhook` is
 * addressed to a SITE — an id on its own cannot be deleted anywhere. A row whose
 * config lost its cloudId is skipped rather than guessed at; its registration
 * expires within 30 days on its own.
 */
export async function tearDownJiraWebhooksForAccount(accountId: string): Promise<void> {
  try {
    const registrations = await listJiraWebhookRegistrationsForAccount(accountId)
    if (registrations.length === 0) return

    const resolved = await getValidTokenForAccount(accountId)
    if (!resolved) return // Already unusable; the registration expires in ≤30 days.

    for (const registration of registrations) {
      const numeric = Number(registration.webhookId)
      if (!Number.isFinite(numeric) || !registration.cloudId) continue
      await deleteWebhooks(resolved.token, registration.cloudId, [numeric])
    }
  } catch (err) {
    console.warn(
      `[jira-webhook] best-effort webhook teardown failed for account ${accountId}:`,
      err instanceof Error ? err.message : String(err),
    )
  }
}
