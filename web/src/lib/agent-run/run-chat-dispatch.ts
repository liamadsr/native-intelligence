import { Client, ClientError } from 'eve/client'
import type { Client as EveClient, ClientSession, MessageResponse } from 'eve/client'
import { getServiceClient } from '@/lib/supabase/service'
import {
  AGENT_RUN_SECRET_HEADER,
  AGENT_RUN_TOKEN_HEADER,
  AGENT_RUN_WORKSPACE_HEADER,
  AGENT_RUN_USER_HEADER,
} from '@/lib/agent-run/agent-run-token'
import { EVE_SANDBOX_PREFIX } from '@/lib/agent-run/run-agent-eve'
import { eveDispatchOrigin } from '@/lib/eve/dispatch-origin'
import { mintRunToken } from '@/lib/flows/skill-run-token'
import { PLAN_HELPER_MODEL, planModelFromSlug, planModelSlug } from '@/lib/chatgpt/plan-models'
import { skillRunnerClient } from '@/lib/flows/run-skill-eve'
import type { SkillRunSessionRecord } from '@/lib/flows/skill-run-session'
import type { BuiltRunChatTurn } from './run-chat-turn'
import { parsePreviousSessions, type RunChatPreviousSession } from './run-chat-previous'

export { RUN_CHAT_MAX_PREVIOUS_SESSIONS, type RunChatPreviousSession } from './run-chat-previous'

/**
 * One turn on a run's parked eve session: the dispatch the run chats share
 * (bots v4 Phase A3, docs/plans/bots-v4.md "The main agent talks to the
 * bots"). Moved here, unchanged, from the two run chat routes, which keep
 * streaming through it:
 *
 *   /api/account/agent-runs/[id]/chat   a WORK run's follow-up chat
 *                                       (makeWorkAgentClient, the session
 *                                       cursor helpers);
 *   /api/account/activity/[id]/chat     a LOOP run's (attachLoopRunSession);
 *
 * and the main agent's relay (src/lib/bots/bot-relay.ts), which sends one
 * turn the same way and reads it to its end on the server. Both kinds take
 * dispatchChatTurn: a plain message (queued, never steered) or an answer to a
 * park.
 *
 * ── session_state contract (migration 200, shared across F1/W1) ──────────────
 *   { sessionId, streamIndex, settleStreamIndex? }
 *   - sessionId           — the durable eve session address (mirrors `sandbox_id`'s
 *                           `eve:` value). eve 0.31.0 removed continuation tokens;
 *                           the id plus the Client's auth headers IS the authority.
 *   - streamIndex         — the ADVANCING read cursor a follow-up turn resumes
 *                           streaming from (must move, else each turn replays the
 *                           previous one).
 *   - settleStreamIndex   — the FROZEN transcript boundary, stamped once at settle
 *                           (by W1's dispatcher). GET replay starts here so a
 *                           reloaded page reconstructs ALL follow-up turns; all
 *                           later persists PRESERVE it.
 *   - previous            — the chat's earlier sessions, oldest first, once its
 *                           session expired and the chat reopened in a new one
 *                           (run-chat-reopen.ts): each one's id and where its
 *                           follow-up turns start. GET replays them before the
 *                           current one; all later persists PRESERVE it.
 *   LEGACY: a row still carrying `continuationToken` predates the eve upgrade and
 *   is NOT resumable — `parseSessionState` rejects it and the caller answers
 *   NO_SESSION, the same as a run with no session at all.
 */

/** The named eve mount for the work-agent (mirrors run-work-eve.ts). */
export const WORK_AGENT_MOUNT = '/eve/work-agent'

/** The persisted follow-up-session cursor. Mirrors the migration-200 column.
 *  `sessionId` is the durable eve session address; `streamIndex` is the ADVANCING
 *  read cursor; `settleStreamIndex` is the FROZEN transcript boundary the GET
 *  replay starts from (stamped once at settle by W1's dispatcher, preserved by
 *  every later persist).
 *
 *  eve 0.31.0 removed continuation tokens, so there is no send capability in here
 *  any more — a row that still carries one predates the upgrade and is rejected by
 *  `parseSessionState()` as non-resumable. */
export interface RunSessionState {
  sessionId: string
  streamIndex: number
  settleStreamIndex?: number
  /** The chat's earlier, expired sessions, oldest first (at most RUN_CHAT_MAX_PREVIOUS_SESSIONS). */
  previous?: RunChatPreviousSession[]
}

/**
 * The session a chat continues in after it reopened (it has earlier ones), or
 * undefined for the run's own session. Its model steps are billed under a key
 * of their own (work-run-usage.ts): eve numbers turns per session, so its
 * turn_0 would otherwise collide with the run's.
 */
export function reopenedChatSessionOf(state: RunSessionState): string | undefined {
  return state.previous?.length ? state.sessionId : undefined
}

/** One turn's input: a plain message, or answers to a park (eve's exclusive send/respond). */
export interface RunChatTurnInput {
  message?: string
  inputResponses?: { requestId: string; optionId?: string; text?: string }[]
}

/**
 * Dispatch ONE follow-up turn onto a parked session, honouring eve 0.31.0's
 * exclusive `send(message, options)` / `respond(inputResponses, options)` split.
 *
 * When the body carries `inputResponses`, the route MUST use `respond()`, which
 * carries no `message` at all: `createMessageBody` only emits a `message` key when
 * one was passed, and `respond()` never passes one. (eve's channel route would
 * reject the two together with HTTP 400, but the typed client cannot produce that
 * combination.) To keep the pre-0.31 behavior where a user's typed text accompanied
 * their approval, that text is folded into each response's `text` field (unless
 * the client already supplied its own) and additionally passed as `clientContext`,
 * which is rendered as user-role model context for exactly this turn.
 *
 * KNOWN GAP: `text` is durable only for a `question`-kind request. For a
 * `tool-approval` request — which is what run-chat.tsx's replayed-question path
 * always sends — buildApprovalToolResponseParts
 * (dist/src/harness/hitl/approval-input-requests.js) emits only
 * `{approvalId, approved, reason}` and never reads `text`, leaving `clientContext`
 * as the sole carrier. clientContext is never persisted to durable session history,
 * so the answer reaches the model on this turn but is absent from history on a
 * later compaction or follow-up turn.
 *
 * `opts.signal` (the relay's): aborts the send's POST and the turn's stream
 * read. The browser routes pass none (their Stop cancels by turn id instead).
 */
export function dispatchChatTurn(
  session: ClientSession,
  parsed: RunChatTurnInput,
  turn: BuiltRunChatTurn | null = null,
  opts: { signal?: AbortSignal } = {},
): Promise<MessageResponse> {
  const signal = opts.signal ? { signal: opts.signal } : {}
  if (parsed.inputResponses && parsed.inputResponses.length > 0) {
    const text = parsed.message
    const responses = parsed.inputResponses.map((r) => ({
      requestId: r.requestId,
      ...(r.optionId !== undefined ? { optionId: r.optionId } : {}),
      ...(r.text !== undefined ? { text: r.text } : text ? { text } : {}),
    }))
    // (Pure inputResponses never steer; turnPolicy only applies to a message.)
    return session.respond(responses, { ...(text ? { clientContext: text } : {}), ...signal })
  }

  // `queue`, not eve's default `steer`: this session is the run's one durable
  // session, so the message typed right after a Stop can reach eve while the
  // stopped turn is still winding down. `steer` could fold it INTO that turn,
  // which the Stop's cancel then ends — losing the new message. `queue` runs it
  // as its own turn once the stopped one settles. (The UI never sends while a
  // turn streams; a second tab's send, or a relay, also queues instead of
  // interleaving.) The composer's turn (bots v4): the message (text parts
  // only: the words and a note per file), and its one-turn context (the skill,
  // the files' content, the mentions).
  if (turn) {
    return session.send(turn.message, {
      turnPolicy: 'queue',
      ...(turn.clientContext.length > 0 ? { clientContext: turn.clientContext } : {}),
      ...signal,
    })
  }
  return session.send(parsed.message ?? '', { turnPolicy: 'queue', ...signal })
}

/**
 * Build the eve Client for the work-agent mount, authenticated the SAME way the
 * dispatcher is (bearer = internal secret + the x-agent-run-* run-token headers).
 * `redirect: 'error'` keeps the credentialed headers from following a cross-origin
 * redirect. The host is an ABSOLUTE origin (`${eveDispatchOrigin()}${WORK_AGENT_MOUNT}`):
 * eve builds a relative URL for a non-absolute host, and server-side `fetch` has
 * no ambient origin, so a bare mount path would throw on every call. It is the
 * app's own address, exactly as the dispatcher's.
 *
 * The old `preserveCompletedSessions: true` option is GONE in eve 0.31.0 and needs
 * no replacement: it existed to stop the client discarding a continuation token at
 * a `session.completed` boundary, and continuation tokens no longer exist. A
 * 0.47.7 `ClientSession` is pinned to its id for life and its stream cursor
 * advances unconditionally (session.js `#i`'s finally always writes
 * `{ sessionId, streamIndex }`), so a follow-up turn that drives the session to
 * completion can no longer have its cursor reset out from under us. A session that
 * has genuinely ended now answers a further turn with HTTP 409
 * `session_not_active`, which the routes surface as the BUSY error event.
 */
export function makeWorkAgentClient(args: {
  secret: string
  runToken: string
  workspaceId: string
  userId: string
}): EveClient {
  return new Client({
    host: `${eveDispatchOrigin()}${WORK_AGENT_MOUNT}`,
    auth: { bearer: args.secret },
    headers: {
      [AGENT_RUN_SECRET_HEADER]: args.secret,
      [AGENT_RUN_TOKEN_HEADER]: args.runToken,
      [AGENT_RUN_WORKSPACE_HEADER]: args.workspaceId,
      [AGENT_RUN_USER_HEADER]: args.userId,
    },
    redirect: 'error',
  })
}

/** Which loop run's chat turn, for whom (attachLoopRunSession, loopRunChatClient). */
export interface LoopRunChatTarget {
  record: SkillRunSessionRecord
  teammateId: string
  relay?: boolean
  /**
   * The person runs on their own ChatGPT plan now (the free tier): a run that
   * started on Native Intelligence's models is handed the plan's model, so the skill-runner
   * moves its session onto the plan for this turn
   * (planAwareSessionModelEvents) rather than bill Native Intelligence.
   */
  chatgptPlan?: boolean
}

/**
 * A LOOP run's parked session (bots v3 Phase 4), attached at its read cursor
 * under a FRESH skill-run token: the run's facts plus a `chat` claim naming
 * the bot the row names, so the turn's tools are that bot's ATTENDED chat
 * ceiling, never the run's unattended one, and it gets the chat instructions
 * (skill-run-chat-ceiling.ts; the skill-runner re-resolves both on
 * turn.started). No verdict outputSchema rides it. `attach()` does no I/O.
 */
export function attachLoopRunSession(secret: string, ctx: LoopRunChatTarget): ClientSession {
  return loopRunChatClient(secret, ctx).sessions.attach(ctx.record.state.sessionId, { streamIndex: ctx.record.state.streamIndex })
}

/**
 * The skill-runner client a LOOP run's chat turn goes through (attachLoopRunSession):
 * the internal secret and that FRESH chat token. A chat that reopens after its
 * session expired (loop-run-chat-reopen.ts) creates its new session through the
 * same client, so the new session's first turn carries the same token as any
 * other turn would.
 */
export function loopRunChatClient(secret: string, ctx: LoopRunChatTarget): EveClient {
  const { record, teammateId } = ctx
  const model =
    ctx.chatgptPlan && !planModelFromSlug(record.facts.model) ? planModelSlug(PLAN_HELPER_MODEL) : record.facts.model
  const runToken = mintRunToken({
    workspaceId: record.workspaceId,
    runAsUserId: record.facts.runAsUserId,
    skillId: record.facts.skillId,
    mode: record.facts.mode,
    hasCapture: record.facts.hasCapture,
    outputContract: record.facts.outputContract,
    model,
    originDepth: 1,
    workItemId: record.workItemId,
    // A relayed turn says so (A5): its message is the main agent's, never the person's words.
    chat: { teammateId, ...(ctx.relay ? { relay: true as const } : {}) },
  })
  return skillRunnerClient({ secret, runToken, workspaceId: record.workspaceId, userId: record.facts.runAsUserId })
}

/** A true busy/conflict from eve — a turn against a session that isn't waiting.
 *  eve 0.31.0 answers that with HTTP 409 `{ code: 'session_not_active' }` on the
 *  ID-addressed message route (423 kept for a locked session); nothing else
 *  (auth, mount, transport, the relative-URL TypeError) qualifies. The run
 *  chat routes check isRunSessionGoneError first: a session that can never
 *  take a turn again is replaced, not reported busy. */
export function isBusyError(err: unknown): boolean {
  return err instanceof ClientError && (err.status === 409 || err.status === 423)
}

/** eve's words for a session id it has no run for (eve 0.79 session stream route: a 404 with no code). */
const EVE_SESSION_NOT_FOUND = 'Session not found.'

/**
 * How long a gone session's reset may take before its turn reopens in a new
 * one (the run chat route and the relay, on a stream that expired after eve
 * took the send): bounded, so a reset eve never answers can't hold the turn.
 */
export const GONE_SESSION_RESET_MS = 5_000

/**
 * True when eve says a run's session can never take a turn again, so its chat
 * needs a new one (run-chat-reopen.ts), as the home thread's does
 * (home-turn-server.ts isSessionGoneError, eve-chat-transport.ts): on a send,
 * eve 0.79's 409 `session_not_active` (the session timed out and completed,
 * its run is gone or past retention; eve's own `retryable` case is
 * `session_not_ready`, never this) or 409 `session_stranded` (another eve
 * version built it); on a stream read, 410 `session_expired` (its history
 * passed the World's retention) or 404 "Session not found." (no run for that
 * id). Never a 423, a refusal of the caller (401 / 403), a 5xx, or a bare 404
 * without eve's words (a mount that isn't there): those keep the session.
 */
export function isRunSessionGoneError(err: unknown): boolean {
  if (!(err instanceof ClientError)) return false
  const body = parseErrorBody(err.body)
  const code = err.code ?? body.code
  if (err.status === 409) return code === 'session_not_active' || code === 'session_stranded'
  if (err.status === 410) return code === 'session_expired'
  return err.status === 404 && body.error === EVE_SESSION_NOT_FOUND
}

/**
 * eve's 409 `session_stranded`: another eve version built the session, so it
 * can't take a turn on this deployment. eve's docs say to reset it before
 * starting over; one of isRunSessionGoneError's cases.
 */
export function isStrandedSessionError(err: unknown): boolean {
  if (!(err instanceof ClientError) || err.status !== 409) return false
  return (err.code ?? parseErrorBody(err.body).code) === 'session_stranded'
}

/** An eve error body's `code` and `error`, when it has them. */
function parseErrorBody(body: unknown): { code?: string; error?: string } {
  if (typeof body !== 'string' || !body) return {}
  try {
    const parsed = JSON.parse(body) as { code?: unknown; error?: unknown } | null
    return {
      ...(typeof parsed?.code === 'string' ? { code: parsed.code } : {}),
      ...(typeof parsed?.error === 'string' ? { error: parsed.error } : {}),
    }
  } catch {
    return {}
  }
}

/** Strip the `eve:` prefix off `sandbox_id` to recover the eve session id. */
export function extractSessionId(sandboxId: string | null): string | null {
  if (!sandboxId) return null
  if (!sandboxId.startsWith(EVE_SANDBOX_PREFIX)) return null
  const id = sandboxId.slice(EVE_SANDBOX_PREFIX.length).trim()
  return id.length > 0 ? id : null
}

/**
 * Validate the persisted session_state jsonb into a typed cursor, or null.
 *
 * Returns null for a LEGACY (pre-eve-0.31) blob carrying a `continuationToken`:
 * continuation tokens were removed with no replacement, so such a session can
 * never be re-addressed and the caller must degrade into its NO_SESSION path.
 * `fallbackSessionId` (from `sandbox_id`'s `eve:` prefix) supplies the address for
 * post-upgrade rows written before `sessionId` was mirrored into the blob.
 */
export function parseSessionState(raw: unknown, fallbackSessionId: string): RunSessionState | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  if (typeof s.continuationToken === 'string' && s.continuationToken.length > 0) return null

  const streamIndex = s.streamIndex
  if (typeof streamIndex !== 'number') return null
  const sessionId =
    typeof s.sessionId === 'string' && s.sessionId.length > 0 ? s.sessionId : fallbackSessionId
  if (!sessionId) return null

  const settleStreamIndex = s.settleStreamIndex
  const previous = parsePreviousSessions(s.previous)
  return {
    sessionId,
    streamIndex,
    ...(typeof settleStreamIndex === 'number' ? { settleStreamIndex } : {}),
    ...(previous.length > 0 ? { previous } : {}),
  }
}

/**
 * After the turn drains, advance the READ cursor (`streamIndex`) so the next turn
 * resumes streaming PAST this turn's boundary rather than replaying it. Reads the
 * advanced index off the session's own state getter (eve's response generator sets
 * it to `startIndex + events.length` in its finally, once the stream drains to the
 * turn boundary). Preserves the durable `sessionId`, the frozen
 * `settleStreamIndex` and the earlier sessions (`previous`). A no-op when the
 * index didn't move (BUSY / an immediate error left it unchanged).
 *
 * This is the ONLY session_state write on a follow-up turn's path: eve 0.31.0
 * removed continuation tokens, so there is no send capability to stamp before
 * streaming.
 *
 * Only while the run still names THIS session (`sandbox_id`): a turn that
 * drains after another send reopened the chat in a new session
 * (run-chat-reopen.ts) must never write the old session's cursor over the new
 * one's.
 */
export async function persistAdvancedCursor(
  agentRunId: string,
  workspaceId: string,
  session: ClientSession,
  prev: RunSessionState,
): Promise<void> {
  const advancedIndex = session.state.streamIndex
  if (typeof advancedIndex !== 'number' || advancedIndex <= prev.streamIndex) return
  const next: RunSessionState = {
    sessionId: prev.sessionId,
    streamIndex: advancedIndex,
    ...(prev.settleStreamIndex !== undefined
      ? { settleStreamIndex: prev.settleStreamIndex }
      : {}),
    ...(prev.previous?.length ? { previous: prev.previous } : {}),
  }
  await writeSessionState(agentRunId, workspaceId, next)
}

/** Low-level write of the session_state cursor via the SERVICE client (bypasses
 *  RLS; pinned to the run id + workspace, and to the session it describes). */
async function writeSessionState(
  agentRunId: string,
  workspaceId: string,
  next: RunSessionState,
): Promise<void> {
  const service = getServiceClient()
  await service
    .from('agent_run')
    .update({ session_state: next })
    .eq('id', agentRunId)
    .eq('workspace_id', workspaceId)
    .eq('sandbox_id', `${EVE_SANDBOX_PREFIX}${next.sessionId}`)
}
