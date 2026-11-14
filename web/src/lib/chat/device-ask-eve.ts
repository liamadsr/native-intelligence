/**
 * /api/device/ask on eve — one question from the ESP32 device, answered by the
 * SAME chat-agent that runs the in-app chat, as a one-shot session (one turn,
 * read to its boundary, then retired: src/lib/eve/task-session.ts).
 *
 * ── Why the chat-agent (not a new agent) ────────────────────────────────────
 * The device has always been "the web chat, minus streaming": same prompt layers,
 * same tool registry, same edition ceiling, same connected MCP servers. The
 * chat-agent already resolves exactly that per turn from a chat-run token —
 * persona via GET /api/internal/chat/spec (buildChatSystemPrompt), tools as
 * proxies to POST /api/internal/chat/tool, which re-derives the ceiling from the
 * verified token on every dispatch (resolveChatCeiling, agent side null for the
 * device ⇒ edition ∪ external MCP, minus mcp_confirm_call: nobody on the device
 * can approve a gated external write — SURFACE_EXCLUDED_TOOLS in
 * chat-ceiling.ts). So the device mints a chat-run token with
 * `surface: 'device_ask'` and drives that mount; the spec rebuild applies the
 * device's model default, Gateway feature tag and device note from the surface.
 * No second agent root, no second copy of the ceiling.
 *
 * ── Why a one-shot (one turn, then retired) ─────────────────────────────────
 * The device request is stateless and must return one JSON answer inside the
 * route's 60s budget. eve 0.67 removed run modes: every session parks after
 * its turn at `session.waiting` and keeps the stream open, and eve holds a
 * turn open at `turn.waiting` on a question (0.69+), an approval or sign-in
 * (0.70+) or a token-limit prompt (0.78+).
 * So the read stops at the turn's boundary (createTaskSession), only a
 * completed turn answers the ask, a held turn (a prompt the device can never
 * answer) fails it and is cancelled, and the session is retired afterwards.
 * `ask_user` is a NATIVE chat-agent tool (advertised independently of the
 * spec's ceiling, so SURFACE_EXCLUDED_TOOLS cannot remove it), and on a browser
 * chat it parks the turn for the picker. On the device surface it does NOT
 * park: agents/chat-agent/tools/ask_user.ts reads the run token's surface, skips
 * the approval gate, and answers the call with a text result telling the model
 * no one can answer and to proceed on its best judgement — so a device ask that
 * reaches for a clarifying question still gets its answer, never the 500.
 *
 * ── Auth + session ownership (no internal-secret bypass) ────────────────────
 * The chat-agent channel is user-facing and enforces the session-ownership ACL
 * on every route that targets a session id (stream, cancel, continue). This
 * dispatch goes through that ACL exactly like a browser does:
 *   1. it RELAYS the caller's own credential — the device's `nid_` token (the
 *      channel's deviceTokenAuthWithAcl entry resolves it to the same user +
 *      active workspace this route resolved), or the caller's Supabase JWT /
 *      cookie — never a server secret;
 *   2. it creates a chat_conversations row owned by that user + workspace
 *      (owner derived from the authenticated identity, never the request body),
 *      mints the run token for THAT row, and writes the new eve session id onto
 *      it BEFORE opening the stream — the same `eve_session_id` registration the
 *      browser transport does via /api/account/chat/eve-session (the user's
 *      membership of the workspace is checked first). A device principal is bound to THIS ask: the channel requires the run
 *      token (sent on every request) to verify as a 'device_ask' token for the
 *      same user + workspace, and a targeted session to be registered on the
 *      row that token names — so a nid_ token reaches nothing else;
 *   3. when the ask ends (answered, capped, failed or timed out) the row is
 *      deleted, so the session id is unregistered and the ACL refuses it from
 *      then on. Nothing is persisted as chat history — the device ask stays
 *      one question, one answer.
 *
 * ── The 12-step cap ─────────────────────────────────────────────────────────
 * The in-process route ran `stopWhen: isStepCount(12)`; eve has no step-count
 * limit (its session limits are token/cost budgets), so the cap is counted HERE
 * on the stream: the 13th `step.started` (a 13th model call) ends the ask — the
 * session is cancelled (turn + tasks) and the answer is what the 12th step said
 * ('' when that step only called tools — eve emits no message.completed for a
 * step without text), exactly as generateText returned its final step's text at
 * the cap. The 12th step's tool calls have already run by then, as they did
 * under isStepCount. The 13th model call itself never runs: the chat-agent's
 * usage-limit-gate hook cancels the turn (`ctx.cancel()`, before that model
 * call; eve 0.68+ ignores a hook throw) on `step.started` at stepIndex 12 for
 * a device_ask token (agents/chat-agent/hooks/usage-limit-gate.ts,
 * DEVICE_ASK_MAX_STEPS pinned equal by a parity test), so nothing past the
 * 12 steps this read bills can spend. The cancel below is the backstop.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 * Summarized from the events THIS server read off the eve stream (never a
 * client-relayed number) by the chat's mapEveTurnUsage, the rule of record:
 * tokens (and cache reads/writes) SUMMED over every completed step — the legacy
 * route billed only `result.finalStep`, which under-billed every multi-step ask
 * (a web_search step, then the answer) — and eve's cost only when every
 * token-spending step carried a positive cost and no web_search result carried
 * Exa spend; otherwise null, so the log_ai_usage RPC list-prices the tokens.
 * The Exa spend is reported as webSearchCostUsd. The MODEL billed is the one
 * the final completed step actually ran on (`step.started.data.modelId`): when
 * the chat-agent's model resolver could not load the spec it falls back to its
 * FALLBACK_SELECTION (the main chat's model, Haiku 5.5, with its chat
 * policy), and the row must price that model, not the one asked for.
 *
 * ── The caller's bearer for the email-draft tools ───────────────────────────
 * The in-process route handed its bearer to createTools, which the two tools
 * that call back into the app as the user (generate_email_drafts,
 * draft_followup_email) need. When the caller authenticated with a Supabase
 * JWT, that JWT is sealed into the run token (chat-run-credential.ts) and the
 * internal tool route opens it for them. A `nid_` device token is never sealed
 * — the endpoints those tools call never accepted it, so the old route gained
 * nothing from it either.
 *
 * ── Timeout / failure ───────────────────────────────────────────────────────
 * Aborting our read does not stop a durable eve session. Any failure after the
 * session exists cancels it (turn + tasks). A create that answers AFTER the
 * wall is waited on for the cancel slice, registered and cancelled
 * (cancelLateCreate). The cancel is best-effort, so the hard stop is the
 * ownership row itself: the spec + tool routes admit a surface token only
 * while its row exists (surface-run-guard.ts), and the row is deleted when the
 * ask ends. A refused fetch alone would only DEGRADE the run (fallback model,
 * no workspace tools, native web tools still live), so the chat-agent's usage
 * gate (agents/chat-agent/hooks/usage-limit-gate.ts) makes it a hard stop: it probes
 * a surface run's liveness at turn.started and before EVERY model step, and on
 * 403 SURFACE_RUN_ENDED (or the surface token's 401) cancels the turn before
 * that model call (`ctx.cancel()`). So a session that could not be cancelled
 * (a create that never answered, a registration that did not land, a cancel
 * that failed) makes at most the model call already in flight — its tool
 * dispatches are refused — and stops at its next step. The token's
 * short `exp` (deviceAskTokenTtlMs) is the backstop for a row whose delete
 * itself failed: the gate treats a surface token's 401 as the same stop.
 *
 * ── The ephemeral row in chat history (accepted) ────────────────────────────
 * While an ask runs (≤ the route's 60s) its 'Device ask' row is a real
 * chat_conversations row, so it can show in the chat-history list for that
 * window. If the delete fails (or the function is killed first) an empty
 * 'Device ask' row is left behind; its session is dead (token expired) and
 * nothing reads it. Accepted for now — hiding it for sure needs a marker
 * column (a migration); tracked as a follow-up.
 */
import { Client, type MessageResponse, type MessageStreamEvent } from 'eve/client'
import { getServiceClient } from '@/lib/admin'
import { createTaskSession, cancelTaskSession, retireTaskSession } from '@/lib/eve/task-session'
import { classifyOneShot, createTurnBoundary } from '@/lib/eve/turn-boundary'
import { mapEveTurnUsage } from '@/lib/chat/eve-usage'
import { appModelIdForGatewaySlug } from '@/lib/ai/models'
import type { AuthenticatedVia } from '@/lib/ai/auth'
import { isDeviceToken } from '@/lib/device-tokens'
import { sealRunCredential } from '@/lib/chat/chat-run-credential'
import {
  internalSecret,
  mintChatRunToken,
  CHAT_RUN_TOKEN_HEADER,
  CHAT_RUN_CTX_HEADER,
} from '@/lib/chat/chat-run-token'

/** The chat-agent's named eve mount (see next.config.mjs; eve ≥0.58 → /eve/<name>/v1/*). */
const CHAT_AGENT_MOUNT = '/eve/chat-agent'

/** Kept in sync with WORKSPACE_HEADER in src/lib/workspace.ts and the chat-agent's lib/auth.ts. */
const WORKSPACE_HEADER = 'x-workspace-id'

/** The legacy route's `stopWhen: isStepCount(12)`. Mirrored (parity-tested) in the chat-agent's usage-limit-gate hook. */
export const DEVICE_ASK_MAX_STEPS = 12

/** Title of the ephemeral ownership row (deleted when the ask ends). */
export const DEVICE_ASK_CONVERSATION_TITLE = 'Device ask'

/**
 * The caller's own credential, relayed to the chat-agent channel so its
 * session-ownership ACL sees the SAME principal the route authenticated: the
 * bearer the caller presented (a `nid_` device token or a Supabase JWT), else
 * its Supabase cookie.
 */
export type DeviceAskCredential = { bearer: string } | { cookie: string }

/**
 * Pick the credential to relay: the one that ACTUALLY authenticated the route
 * (`via`, from authenticateUser) — the bearer for a device token or JWT, the
 * cookie for a cookie session. Not merely the first one present: an invalid
 * or expired bearer falls through to the cookie in authenticateUser, and
 * relaying that dead bearer would 401 at the chat-agent. Null when the
 * credential `via` names is not on the request.
 */
export function deviceAskCredential(req: Request, via: AuthenticatedVia): DeviceAskCredential | null {
  if (via === 'cookie') {
    const cookie = req.headers.get('cookie')
    return cookie ? { cookie } : null
  }
  const authHeader = req.headers.get('authorization') || ''
  return authHeader.startsWith('Bearer ') && authHeader.length > 7 ? { bearer: authHeader.slice(7) } : null
}

/** What a device ask cost, read off the eve stream by this server. */
export interface DeviceAskUsage {
  /** Input tokens summed over EVERY completed step (includes cached input). */
  inputTokens: number
  /** Output tokens summed over every completed step. */
  outputTokens: number
  /** The cached share of inputTokens (reads / writes), summed; 0 when none. */
  cacheReadTokens: number
  cacheWriteTokens: number
  /** eve's summed cost per the rule (mapEveTurnUsage), else null → logUsage omits it → RPC list price. */
  costUsd: number | null
  /**
   * The Gateway model slug the FINAL completed step ran on
   * (`step.started.data.modelId`), null when no step completed. Differs from the
   * requested model when the chat-agent fell back to its FALLBACK_SELECTION
   * (Haiku 5.5).
   */
  modelId: string | null
  /** Completed model steps (step.completed). */
  steps: number
  /** Tool calls requested across the run (actions.requested). */
  toolCalls: number
  /** Exa spend from web-search tool results (output.costDollars.total), null when none. */
  webSearchCostUsd: number | null
  /**
   * Gateway generation ids of EVERY completed step (mapEveTurnUsage) — the
   * reconciliation key against the Gateway's own records, as on chat rows. Not
   * a billing input.
   */
  generationIds: string[]
}

/**
 * A device ask that did not produce an answer (timeout, failed session,
 * stream/create error). The session has already been asked to cancel. `usage`
 * is what the events received so far add up to — null when no session was
 * created — so the route can still meter the model spend a failed ask incurred.
 */
export class DeviceAskEveError extends Error {
  readonly usage: DeviceAskUsage | null
  constructor(message: string, usage: DeviceAskUsage | null, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'DeviceAskEveError'
    this.usage = usage
  }
}

/**
 * The authenticated user is not a member of the workspace the route resolved
 * (e.g. a device token whose active_workspace_id outlived the membership).
 * Thrown BEFORE dispatch — nothing was created or run. The route answers 403.
 */
export class DeviceAskNotMemberError extends Error {
  constructor() {
    super('device ask: the user is not a member of the resolved workspace')
    this.name = 'DeviceAskNotMemberError'
  }
}

/**
 * The membership check itself failed (a DB error), so whether the user belongs
 * to the workspace is UNKNOWN — not a "no". Thrown BEFORE dispatch — nothing was
 * created or run. The route answers 500 MEMBERSHIP_LOOKUP_FAILED (retryable),
 * never the 403 that would tell the device to re-pick its workspace.
 */
export class DeviceAskMembershipLookupError extends Error {
  constructor(detail: string) {
    super(`device ask: the workspace membership check failed (${detail})`)
    this.name = 'DeviceAskMembershipLookupError'
  }
}

/**
 * Owner derivation for a device ask: is `userId` a member of `workspaceId`?
 * Read with the service role, because the workspace can come from a device
 * token's active_workspace_id, which is never membership-checked when it is
 * resolved. Throws {@link DeviceAskNotMemberError} for a non-member and
 * {@link DeviceAskMembershipLookupError} when the lookup itself fails. The
 * route calls this before it reads anything workspace-scoped (the model
 * default); runDeviceAskViaEve calls it again before it writes anything.
 */
export async function assertDeviceAskMembership(userId: string, workspaceId: string): Promise<void> {
  const { data: membership, error: memberError } = await getServiceClient()
    .from('member')
    .select('workspace_id')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .maybeSingle<{ workspace_id: string }>()
  if (memberError) throw new DeviceAskMembershipLookupError(memberError.message)
  if (!membership) throw new DeviceAskNotMemberError()
}

/** What one device ask produced. */
export interface DeviceAskEveResult {
  /** The answer ('' when the model produced none). */
  text: string
  usage: DeviceAskUsage
  /** 'step-cap' when the 12-step cap ended the run (the session was cancelled). */
  outcome: 'completed' | 'step-cap'
}

/**
 * The app's own origin for this server-to-server call — the SAME resolution the
 * chat-agent uses to call back into the internal routes (spec-client.ts
 * appBaseUrl): the configured app URL, else local dev.
 * Deliberately NEVER derived from the incoming request's Host / X-Forwarded-Host:
 * this request carries the caller's credential, and a spoofable header must not
 * pick where it goes.
 */
export function deviceAskAppBaseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
}

/**
 * Run one device question as a one-shot chat-agent session and read its turn to its end.
 * Throws before dispatch: {@link DeviceAskNotMemberError} when the user is not a
 * member of `workspaceId`, {@link DeviceAskMembershipLookupError} when that check
 * errored, a plain Error on a missing secret or an ownership row
 * that could not be created. Every failure AFTER dispatch — create/stream error, a session
 * that did not complete, a registration that did not land, the timeout — cancels
 * the eve session and throws {@link DeviceAskEveError} carrying the partial
 * usage. The ownership row is deleted in every case. The route maps every throw
 * to its 500 contract.
 */
export async function runDeviceAskViaEve(args: {
  userId: string
  workspaceId: string
  question: string
  /** The model the ask runs on (bare app id, SURFACE_MODELS.device_ask): billed when no step reports its own. */
  model: string
  /**
   * The person runs on their own ChatGPT plan (the free tier): the token says
   * so, as the browser mint's does, so the turn stays on their plan even when
   * the chat agent can't read its spec, never Native Intelligence's fallback model.
   */
  chatgptPlan?: boolean
  timeoutMs: number
  credential: DeviceAskCredential
  /** Overridable for tests; defaults to {@link deviceAskAppBaseUrl}. */
  appBaseUrl?: string
}): Promise<DeviceAskEveResult> {
  if (!internalSecret()) throw new Error('device ask: CHAT_INTERNAL_SECRET is not set')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('device ask: timed out')), args.timeoutMs)
  const aborted = abortRejection(controller.signal)

  const service = getServiceClient()
  // Owner derivation, not caller trust: the row and the token below are written
  // with the service role, so the (user, workspace) pair is checked against a
  // real membership first. A device whose active_workspace_id is stale (the user
  // left that workspace), or a mixed-credential request, is refused here —
  // before anything runs. The route runs the same check before it reads
  // anything workspace-scoped; this is the second line, for any other caller.
  try {
    await assertDeviceAskMembership(args.userId, args.workspaceId)
  } catch (err) {
    clearTimeout(timer)
    throw err
  }

  // The ownership row: owner = the AUTHENTICATED user + the workspace the route
  // resolved for them, never anything from the request body.
  const { data: row, error: rowError } = await service
    .from('chat_conversations')
    .insert({ user_id: args.userId, workspace_id: args.workspaceId, title: DEVICE_ASK_CONVERSATION_TITLE })
    .select('id')
    .single<{ id: string }>()
  if (rowError || !row) {
    clearTimeout(timer)
    throw new Error(`device ask: could not create the session owner row (${rowError?.message ?? 'no row'})`)
  }
  const conversationId = row.id

  let client: Client | undefined
  let response: MessageResponse | undefined
  let created: Promise<MessageResponse> | undefined
  const createController = new AbortController()
  // Collected as they arrive so a timeout / failure still has the events
  // already received — the partial usage the route logs.
  const events: MessageStreamEvent[] = []
  try {
    const binding = { conversationId, workspaceId: args.workspaceId, userId: args.userId }
    // The caller's Supabase JWT (never a nid_ device token, never a cookie) for
    // the tools that call back into the app as the user — see the header.
    const jwt = 'bearer' in args.credential && !isDeviceToken(args.credential.bearer) ? args.credential.bearer : null
    const token = mintChatRunToken(
      {
        ...binding,
        surface: 'device_ask',
        ...(jwt ? { cred: sealRunCredential(jwt, binding) } : {}),
        ...(args.chatgptPlan ? { chatgptPlan: true as const } : {}),
      },
      // NOT the chat's 60 min: the token dies shortly after this ask's budget,
      // so a session that outlives a failed cancel (or a killed function) is
      // refused by the spec and tool routes on the verified `exp`.
      { ttlMs: deviceAskTokenTtlMs(args.timeoutMs) },
    )
    // The per-turn ctx the spec route decodes: empty (the device has no screen,
    // selection or attachments, and its model is fixed: routeChatTurn's
    // 'device' kind).
    const ctx = Buffer.from(JSON.stringify({}), 'utf8').toString('base64url')

    client = new Client({
      host: `${args.appBaseUrl ?? deviceAskAppBaseUrl()}${CHAT_AGENT_MOUNT}`,
      ...('bearer' in args.credential ? { auth: { bearer: args.credential.bearer } } : {}),
      headers: {
        ...('cookie' in args.credential ? { cookie: args.credential.cookie } : {}),
        // The Supabase entry trusts this only after a membership check; the
        // device entry ignores it (the token's own active workspace wins — the
        // same one this route resolved).
        [WORKSPACE_HEADER]: args.workspaceId,
        [CHAT_RUN_TOKEN_HEADER]: token,
        [CHAT_RUN_CTX_HEADER]: ctx,
      },
      // Never let the credential-bearing headers follow a redirect elsewhere.
      redirect: 'error',
    })

    // The create POST gets its OWN signal, not the wall's: if the wall fires
    // while it is in flight, the server may already have started the session,
    // and only the POST's response can tell us its id to cancel it
    // (cancelLateCreate). The stream still uses the wall's signal.
    created = createTaskSession(client, {
      message: args.question,
      signal: controller.signal,
      createSignal: createController.signal,
    })
    created.catch(() => {})
    response = await Promise.race([created, aborted])

    await registerSession(conversationId, args, response.sessionId)

    const read = await readDeviceTurn(response, aborted, events)
    if (read.status === 'step-cap') {
      // A 13th model call is starting: stop it (and anything it spawned).
      await cancelDeviceAskSession(client, response.sessionId)
      return { text: read.stepText ?? '', usage: summarizeDeviceAskUsage(events), outcome: 'step-cap' }
    }
    // Only a turn that completed (turn.completed, then the session parks; eve
    // 0.67+ has no task mode) answered the question. 'waiting' means the turn
    // parked on a prompt nobody can answer (nothing fails closed any more), and
    // a stream that ended with no boundary never finished: both fail the ask.
    if (read.status !== 'completed') throw new Error(`device ask: eve session ${read.status}`)
    return { text: read.finalText ?? '', usage: summarizeDeviceAskUsage(events), outcome: 'completed' }
  } catch (err) {
    // Aborting only closed OUR read — the durable session keeps running
    // server-side (model calls + tool dispatches) after the device has been told
    // the ask failed. Cancel it.
    if (client && response) await cancelDeviceAskSession(client, response.sessionId)
    else if (client && created && controller.signal.aborted) {
      await cancelLateCreate(client, created, createController, conversationId, args)
    }
    const reason = controller.signal.aborted ? 'device ask: timed out' : err instanceof Error ? err.message : String(err)
    throw new DeviceAskEveError(reason, response ? summarizeDeviceAskUsage(events) : null, { cause: err })
  } finally {
    clearTimeout(timer)
    // A create still in flight is abandoned now (cancelLateCreate gave up on it).
    createController.abort()
    // eve 0.67+ parks every session after its turn, for the chat agent's 30-day
    // session timeout: retire this one-shot now, while its registration (the
    // ACL that admits the reset) still stands. Short and best-effort.
    if (client && response) await retireTaskSession(client, response.sessionId, { timeoutMs: RETIRE_TIMEOUT_MS })
    await releaseOwnerRow(conversationId, args.userId)
  }
}

/**
 * Write the eve session id onto the ownership row — the registration the
 * chat-agent's ACL admits the stream, cancel and continue on. Scoped to the
 * owner, so it can only ever claim the row this ask created. Throws when it
 * does not land.
 */
async function registerSession(
  conversationId: string,
  owner: { userId: string; workspaceId: string },
  sessionId: string,
): Promise<void> {
  const { error, count } = await getServiceClient()
    .from('chat_conversations')
    .update({ eve_session_id: sessionId }, { count: 'exact' })
    .eq('id', conversationId)
    .eq('user_id', owner.userId)
    .eq('workspace_id', owner.workspaceId)
  if (error || !count) {
    throw new Error(`device ask: session registration failed (${error?.message ?? 'no row'})`)
  }
}

/**
 * The wall fired while the create POST was still in flight. The server may
 * already be running the session, so keep the POST alive a little longer
 * (within the cancel budget the route reserved) to learn its id; if it
 * arrives, register it on the still-live ownership row (the cancel is ACL'd
 * on that registration) and cancel it. If it does not arrive in time the POST
 * is aborted — and the session, if any, is stopped anyway: deleting the row
 * in `finally` revokes its token at the spec + tool routes
 * (surface-run-guard.ts). Nothing was read off such a session, so there is no
 * usage to report for it. Never throws.
 */
async function cancelLateCreate(
  client: Client,
  created: Promise<MessageResponse>,
  createController: AbortController,
  conversationId: string,
  owner: { userId: string; workspaceId: string },
): Promise<void> {
  const deadline = Date.now() + CANCEL_TIMEOUT_MS
  let wait: ReturnType<typeof setTimeout> | undefined
  const sessionId = await Promise.race([
    created.then(
      (r) => r.sessionId,
      () => null,
    ),
    new Promise<null>((resolve) => {
      wait = setTimeout(() => resolve(null), CANCEL_TIMEOUT_MS)
    }),
  ])
  clearTimeout(wait)
  if (!sessionId) {
    createController.abort()
    return
  }
  try {
    await registerSession(conversationId, owner, sessionId)
  } catch (err) {
    console.warn('[device-ask] late-created session could not be registered for cancel', { sessionId, err })
    return
  }
  await cancelDeviceAskSession(client, sessionId, Math.max(250, deadline - Date.now()))
}

/**
 * Delete the ephemeral ownership row. Its `eve_session_id` goes with it, so the
 * chat-agent's ACL refuses that session from now on (fail closed on an
 * unregistered id). Best-effort: a failure is logged, never thrown over the
 * ask's own outcome.
 */
async function releaseOwnerRow(conversationId: string, userId: string): Promise<void> {
  try {
    const { error } = await getServiceClient()
      .from('chat_conversations')
      .delete()
      .eq('id', conversationId)
      .eq('user_id', userId)
    if (error) console.warn('[device-ask] could not delete the session owner row', { conversationId, error: error.message })
  } catch (err) {
    console.warn('[device-ask] could not delete the session owner row', { conversationId, err })
  }
}

/** Bound on the best-effort cancel so the route still answers inside maxDuration. */
export const CANCEL_TIMEOUT_MS = 3_000

/**
 * Bound on retiring the session after its turn (retireTaskSession: eve 0.67+
 * parks every session for the agent's session timeout). Best-effort.
 */
export const RETIRE_TIMEOUT_MS = 1_500

/**
 * What the route keeps back from its maxDuration AFTER the eve budget and the
 * cancel: the session retire (RETIRE_TIMEOUT_MS), the owner-row delete, the
 * usage-log RPC and the JSON reply.
 */
export const DEVICE_ASK_LOG_MARGIN_MS = 3_000 + RETIRE_TIMEOUT_MS

/** Floor for the eve budget when a slow prelude has eaten almost everything. */
export const DEVICE_ASK_MIN_EVE_BUDGET_MS = 1_000

/** Grace on the device token past its ask's budget + cancel (clock skew, in-flight call). */
export const DEVICE_ASK_TOKEN_GRACE_MS = 15_000

/**
 * The eve wall budget for a device ask, taken out of what is LEFT of the route's
 * maxDuration — not a constant counted from dispatch — so auth, the usage gate
 * and workspace/model resolution (all before dispatch) are paid for, and the
 * timeout's cancel + failed-usage row still fit before the platform kill:
 *   startTime + maxDuration − now − CANCEL_TIMEOUT_MS − DEVICE_ASK_LOG_MARGIN_MS
 * floored at DEVICE_ASK_MIN_EVE_BUDGET_MS.
 */
export function deviceAskEveBudgetMs(args: {
  startTime: number
  maxDurationMs: number
  now?: number
}): number {
  const now = args.now ?? Date.now()
  const left = args.startTime + args.maxDurationMs - now - CANCEL_TIMEOUT_MS - DEVICE_ASK_LOG_MARGIN_MS
  return Math.max(DEVICE_ASK_MIN_EVE_BUDGET_MS, left)
}

/** The device-ask chat-run token's lifetime: the ask's budget + cancel + grace. */
export function deviceAskTokenTtlMs(timeoutMs: number): number {
  return timeoutMs + CANCEL_TIMEOUT_MS + DEVICE_ASK_TOKEN_GRACE_MS
}

/**
 * Cooperatively cancel a device-ask session's active turn AND its tasks
 * (cancelTaskSession: session-level, so it works even when the stream was cut
 * before `turn.started` reached us). Goes through the same ACL'd channel as the
 * stream, as the same principal, while the session is still registered.
 * Best-effort: never throws (a cancel failure must not mask the original
 * error), bounded by CANCEL_TIMEOUT_MS — the slice the route reserved for it.
 */
async function cancelDeviceAskSession(
  client: Client,
  sessionId: string,
  timeoutMs: number = CANCEL_TIMEOUT_MS,
): Promise<void> {
  if (!(await cancelTaskSession(client, sessionId, { timeoutMs }))) {
    console.warn('[device-ask] eve session cancel failed', { sessionId })
  }
}

interface DeviceTurnRead {
  status: 'completed' | 'failed' | 'waiting' | 'incomplete' | 'step-cap'
  /** The last assistant message that is not a tool-call hand-off (result() semantics). */
  finalText: string | null
  /**
   * The text of the LAST STARTED step only — the cap's answer. Reset on every
   * step.started: eve emits message.completed only for a step with non-empty
   * text, so a 12th step that just called tools leaves this null ('' to the
   * device), exactly generateText's final-step `result.text` at isStepCount(12)
   * — never an earlier step's narration.
   */
  stepText: string | null
}

/**
 * Read the session's events into `events` up to its terminal boundary
 * (session.completed / .failed / .waiting) and stop there — the live stream
 * stays open for seconds after it (see run-utility.ts readToBoundary). Every
 * read is raced against the timeout, so a stream that ignores the abort still
 * ends. Counts `step.started`: the (DEVICE_ASK_MAX_STEPS + 1)th ends the read as
 * 'step-cap' (not recorded — that step never finished).
 */
async function readDeviceTurn(
  response: AsyncIterable<MessageStreamEvent>,
  aborted: Promise<never>,
  events: MessageStreamEvent[],
): Promise<DeviceTurnRead> {
  let status: DeviceTurnRead['status'] = 'incomplete'
  let finalText: string | null = null
  let stepText: string | null = null
  let stepsStarted = 0
  const endsTurn = createTurnBoundary()
  const iterator = response[Symbol.asyncIterator]()
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), aborted])
      if (next.done) break
      const ev = next.value
      if (ev.type === 'step.started') {
        stepsStarted += 1
        if (stepsStarted > DEVICE_ASK_MAX_STEPS) {
          status = 'step-cap'
          break
        }
        stepText = null
      }
      events.push(ev)
      if (ev.type === 'message.completed') {
        stepText = ev.data.message ?? null
        if (ev.data.finishReason !== 'tool-calls') finalText = ev.data.message ?? null
      }
      if (endsTurn(ev)) {
        // eve 0.67+ parks the session after the turn: read how the turn ended.
        status = classifyOneShot(ev, events)?.status ?? 'incomplete'
        break
      }
    }
  } finally {
    // Release the stream (a hung one may never settle — don't await it).
    void Promise.resolve(iterator.return?.()).catch(() => {})
  }
  return { status, finalText, stepText }
}

/**
 * The device ask's usage from the events this server read — the chat's own
 * mapper (mapEveTurnUsage), so a device ask bills on the same basis as every
 * other eve surface: tokens summed over every completed step, eve's cost only
 * when the whole run carried a positive cost and no Exa spend (else null → list
 * price), the Exa spend from web_search results as webSearchCostUsd, and the
 * Gateway generation ids of every step (the reconciliation key). The model is
 * the one the final completed step ran on (the `step.started` before it).
 */
export function summarizeDeviceAskUsage(events: readonly MessageStreamEvent[]): DeviceAskUsage {
  const mapped = mapEveTurnUsage(events)
  let startedModel: string | null = null
  let finalModel: string | null = null
  for (const ev of events) {
    if (ev.type === 'step.started') {
      // eve names the chat's browser-dispatch Gateway model `gateway/<slug>`
      // (agents/chat-agent/lib/turn-usage.ts gatewaySlugOf): bill on the slug.
      startedModel =
        typeof ev.data.modelId === 'string' && ev.data.modelId ? ev.data.modelId.replace(/^gateway\//, '') : null
    } else if (ev.type === 'step.completed') {
      finalModel = startedModel
    }
  }
  return {
    inputTokens: mapped.inputTokens,
    outputTokens: mapped.outputTokens,
    cacheReadTokens: mapped.cacheReadTokens,
    cacheWriteTokens: mapped.cacheWriteTokens,
    costUsd: mapped.costUsd,
    modelId: finalModel,
    steps: mapped.steps,
    toolCalls: mapped.toolCalls,
    webSearchCostUsd: mapped.webSearchCostUsd,
    generationIds: mapped.generationIds,
  }
}

/**
 * The model to bill: the one the final step ACTUALLY ran on (read off the eve
 * stream by this server — `usage.modelId`, a Gateway slug), mapped back to its
 * app id. It differs from the requested model when the chat-agent's model
 * resolver could not load the spec and fell back to its FALLBACK_SELECTION
 * (Haiku 5.5).
 * The requested model when no step completed or the slug is not a catalog
 * model (then there is no app id to price it under).
 */
export function deviceAskBilledModel(requested: string, usage: DeviceAskUsage): string {
  return (usage.modelId && appModelIdForGatewaySlug(usage.modelId)) || requested
}

/**
 * A promise that rejects when `signal` aborts (never resolves). Raced against
 * every await so a create or a stream that ignores the signal still times out.
 * Pre-caught so an un-raced rejection is never "unhandled".
 */
function abortRejection(signal: AbortSignal): Promise<never> {
  const p = new Promise<never>((_resolve, reject) => {
    const fail = () => reject(new Error('device ask: timed out'))
    if (signal.aborted) fail()
    else signal.addEventListener('abort', fail, { once: true })
  })
  p.catch(() => {})
  return p
}
