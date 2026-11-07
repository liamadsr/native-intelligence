import type { Client as EveClient, ClientSession, HandleMessageStreamEvent, MessageResponse } from 'eve/client'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireUser } from '@/lib/api-auth'
import { apiError, badRequest, forbidden, notFound, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { usageOnPlan } from '@/lib/chatgpt/plan-route'
import { internalSecret } from '@/lib/flows/skill-run-token'
import {
  advanceSkillRunCursor,
  readSkillRunSession,
  type SkillRunSessionRecord,
} from '@/lib/flows/skill-run-session'
import { logSkillRunChatUsage } from '@/lib/flows/skill-run-chat-usage'
import { encodeRunChatEvent, reduceStreamEvent, type RunChatEvent } from '@/lib/agent-run/run-chat-events'
import {
  dispatchChatTurn,
  isBusyError,
  isRunSessionGoneError,
  isStrandedSessionError,
  loopRunChatClient,
  reopenedChatSessionOf,
  type RunChatPreviousSession,
} from '@/lib/agent-run/run-chat-dispatch'
import { reopenLoopRunChatSession, type ReopenedLoopRunChat } from '@/lib/agent-run/loop-run-chat-reopen'
import { buildRunChatTurn, type BuiltRunChatTurn } from '@/lib/agent-run/run-chat-turn'
import { hasRunChatTurnExtras, parseRunChatTurnExtras, type RunChatTurnExtras } from '@/lib/agent-run/run-chat-turn-extras'
import { WORK_KINDS } from '@/lib/work/types'
import { callerCanReachTeammate } from '@/lib/chat/teammate-access'

/**
 * POST + GET /api/account/activity/[id]/chat — the exact chat for a LOOP run
 * (bots v3 Phase 4, docs/plans/bots-v3.md): a follow-up turn on the parked eve
 * session of the skill run behind ledger row `[id]` (tracked_job), the loop's
 * item a bot brought you. Modelled on /api/account/agent-runs/[id]/chat (the
 * work-run chat), and the same strict trust boundary: the browser never holds
 * a run token, the internal secret, the session id or a raw eve event.
 *
 * Who may chat: the row's OWNER, who must also be the run's run-as user (the
 * person the loop works as; the session's `run_facts`). Both checks, never
 * either: a widening of tracked_job's owner-only SELECT never widens this.
 *
 * Guards, each a 409 the bubble answers by falling back to the bot's own
 * thread plus the run's "about" section (lib/bots/item-run-chat.ts):
 *   NOT_TERMINAL  the run is still going;
 *   CANCELED      the run was cancelled;
 *   NO_SESSION    no parked session (a run from before this phase, a run
 *                 nobody fronts, a run that failed, timed out or was capped:
 *                 those cancel their session and never park), or a run whose
 *                 bot the caller can no longer reach (a private team they
 *                 aren't on): the turn would run on that bot's ceiling, so
 *                 the Assistant shows the item instead and its own thread
 *                 takes the message (lib/work/bot-owner.ts `owner_fallback`).
 *
 * ── POST: one follow-up turn ─────────────────────────────────────────────────
 *  1. The usage limit (a chat turn is billed).
 *  2. A FRESH skill-run token per call, carrying the run's facts plus a `chat`
 *     claim naming the bot the row names: the turn's tools are that bot's
 *     ATTENDED chat ceiling, never the run's unattended one, and the turn gets
 *     the chat instructions (skill-run-chat-ceiling.ts; the skill-runner
 *     re-resolves both on turn.started). No verdict outputSchema rides it.
 *  3. Attach the parked session at its read cursor (no I/O) and send ONE turn
 *     (`turnPolicy: 'queue'`, as the work-run chat), or answer a park.
 *  4. Stream the turn back as the reduced NDJSON vocabulary (run-chat-events),
 *     never raw events or tool inputs; generic error copy only.
 *  5. Bill the turn (usage source 'chat'), then advance the read cursor.
 *  6. Stop (the browser aborts): the accepted turn is cancelled by id and the
 *     stream drained, so the cursor still moves past it.
 *  7. A session eve says is GONE (isRunSessionGoneError: the 30-day session
 *     timeout's 409 `session_not_active`, a stranded session, or a stream
 *     whose history expired before any event) → the chat continues in a NEW
 *     session, registered on the loop's session record and led by a history
 *     primer (loop-run-chat-reopen.ts), and this turn streams from it, under
 *     the same fresh chat token. Another send that reopened first, or a
 *     locked session (423), → BUSY.
 *
 * ── GET: replay ─────────────────────────────────────────────────────────────
 * The follow-up turns from the frozen settle boundary (the run's own turn, an
 * internal task message, is before it), through the same reducer, closed on an
 * idle gap (a parked stream never closes on its own). A chat that reopened
 * replays its earlier sessions first (bounded reads), and a session whose
 * history eve no longer holds shows nothing rather than an error: the next
 * send reopens the chat.
 */

type RouteContext = { params: Promise<{ id: string }> }

const MAX_MESSAGE_LENGTH = 4000
const MAX_INPUT_RESPONSES = 8
const REPLAY_IDLE_CLOSE_MS = 1500
/** GET replay: a reopened chat's earlier sessions, read side by side for at most this long in all. */
const REPLAY_EARLIER_SESSIONS_MS = 5000
/** A gone session's reset before its turn reopens elsewhere (POST step 7), at most. */
const GONE_SESSION_RESET_MS = 5000

/** Ledger kinds a loop's skill run records. */
const LOOP_RUN_KINDS: ReadonlySet<string> = new Set([WORK_KINDS.flowRun, WORK_KINDS.skillRun])
/** A row still going: its chat isn't there yet. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(['queued', 'running', 'needs_input'])

interface LoopRunChatContext {
  userId: string
  teammateId: string
  record: SkillRunSessionRecord
}

type Loaded = { ok: true; ctx: LoopRunChatContext; supabase: SupabaseClient } | { ok: false; response: Response }

/** Auth + guards, shared by POST and GET (see the header). */
async function loadLoopRunChat(id: string): Promise<Loaded> {
  const auth = await requireUser()
  if (auth instanceof Response) return { ok: false, response: auth }
  const { supabase, user } = auth

  const { data: row, error } = await supabase
    .from('tracked_job')
    .select('id, workspace_id, member_id, kind, status, ai_team_member_id')
    .eq('id', id)
    .maybeSingle()
  if (error) return { ok: false, response: serverError(error.message) }
  if (!row) return { ok: false, response: notFound('Work item not found') }
  const item = row as { workspace_id: string; member_id: string | null; kind: string; status: string; ai_team_member_id: string | null }

  if (!(await isOwner(supabase, item.member_id, user.id))) {
    return { ok: false, response: forbidden('Only the person this loop works for can chat with its run') }
  }
  if (!LOOP_RUN_KINDS.has(item.kind)) {
    return { ok: false, response: apiError('Only a loop’s runs continue their chat here', { status: 400, code: 'INVALID_KIND' }) }
  }
  if (LIVE_STATUSES.has(item.status)) {
    return { ok: false, response: apiError('This run is not settled yet', { status: 409, code: 'NOT_TERMINAL' }) }
  }
  if (item.status === 'canceled') {
    return { ok: false, response: apiError('This run was cancelled', { status: 409, code: 'CANCELED' }) }
  }
  const noSession = () => ({ ok: false as const, response: apiError('This run has no chat session to continue', { status: 409, code: 'NO_SESSION' }) })
  if (!item.ai_team_member_id) return noSession()
  // Its bot must be one the caller can reach: the turn runs on that bot's attended ceiling.
  if (!(await reachesBot(supabase, user.id, item.workspace_id, item.ai_team_member_id, item.member_id))) return noSession()

  let record: SkillRunSessionRecord | null
  try {
    record = await readSkillRunSession(getServiceClient(), id, item.workspace_id)
  } catch (err) {
    return { ok: false, response: serverError(err instanceof Error ? err.message : 'Could not read the run’s session') }
  }
  if (!record) return noSession()
  // The run-as user too, not only the row's owner (see the header).
  if (record.facts.runAsUserId !== user.id) {
    return { ok: false, response: forbidden('Only the person this loop works for can chat with its run') }
  }
  return { ok: true, ctx: { userId: user.id, teammateId: item.ai_team_member_id, record }, supabase }
}

/**
 * The row's bot is one the caller may reach (the private-team rule,
 * callerCanReachTeammate; a teammate their RLS hides is not). A failed read
 * is "no".
 */
async function reachesBot(supabase: SupabaseClient, userId: string, workspaceId: string, teammateId: string, memberId: string | null): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('ai_team_member')
      .select('id, team_id, is_system')
      .eq('id', teammateId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (error || !data) return false
    const mate = data as { team_id: string | null; is_system: boolean | null }
    return await callerCanReachTeammate(supabase, {
      userId,
      workspaceId,
      teammate: { isSystem: mate.is_system === true, teamId: mate.team_id ?? null },
      memberId,
    })
  } catch {
    return false
  }
}

/** The row's member is one of the caller's own (session client, `member`'s RLS). A failed read is "no". */
async function isOwner(supabase: SupabaseClient, memberId: string | null, userId: string): Promise<boolean> {
  if (!memberId) return false
  const { data, error } = await supabase.from('member').select('id').eq('id', memberId).eq('user_id', userId).maybeSingle()
  return !error && !!data
}

/** The skill-runner client under a fresh chat token for the bot the row names (run-chat-dispatch.ts). */
function chatClient(secret: string, ctx: LoopRunChatContext, chatgptPlan = false): EveClient {
  return loopRunChatClient(secret, { record: ctx.record, teammateId: ctx.teammateId, chatgptPlan })
}

// ── POST ─────────────────────────────────────────────────────────────────────

export async function POST(request: Request, { params }: RouteContext) {
  const { id } = await params
  const secret = internalSecret()
  if (!secret) return serverError('Follow-up chat is not configured (missing internal secret)')

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  const parsed = parseChatBody(body)
  if ('error' in parsed) return badRequest(parsed.error)

  const loaded = await loadLoopRunChat(id)
  if (!loaded.ok) return loaded.response
  const { ctx } = loaded

  // Opted in to the ChatGPT free tier: a person on their own plan chats on it.
  let chatgptPlan: boolean
  try {
    chatgptPlan = await usageOnPlan(ctx.userId)
  } catch (err) {
    if (err instanceof Response) return err
    throw err
  }

  // What the full composer added (bots v4: a skill, files, mentions),
  // checked and built here: a skill the caller can't use, a file that isn't
  // their own upload, or a photo (no file part ever reaches the skill-runner:
  // run-chat-turn.ts) is a 400 before anything is sent. The skill's tools
  // need nothing more: this turn already runs on the bot's attended chat
  // ceiling (skill-run-chat-ceiling.ts). Not on an answer to a park.
  let turn: BuiltRunChatTurn | null = null
  if (!parsed.inputResponses?.length && hasRunChatTurnExtras(parsed.extras)) {
    const built = await buildRunChatTurn({
      supabase: loaded.supabase,
      service: getServiceClient(),
      userId: ctx.userId,
      workspaceId: ctx.record.workspaceId,
      message: parsed.message ?? '',
      extras: parsed.extras,
      // A chat turn is attended, and its tools read the person's private
      // captures as a teammate chat's do (skill-run tool route), so the
      // mentions may hand their content over too.
      privateCaptures: true,
    })
    if ('error' in built) return apiError(built.error, { status: built.status, code: built.code })
    turn = built
  }

  // `attach()` does no I/O. The session and its record both change when eve
  // says this session is gone and the chat reopens (step 7); the client, and
  // so the turn's fresh chat token, stays.
  const client = chatClient(secret, ctx, chatgptPlan)
  let record = ctx.record
  let session = client.sessions.attach(record.state.sessionId, { streamIndex: record.state.streamIndex })
  const abortSignal = request.signal
  if (abortSignal.aborted) return new Response(null, { status: 499 })

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let terminalEmitted = false
      const enqueue = (event: RunChatEvent) => {
        if (event.type === 'done' || event.type === 'error') terminalEmitted = true
        try {
          controller.enqueue(encoder.encode(encodeRunChatEvent(event)))
        } catch {
          /* closed */
        }
      }
      let sent = false
      let stopped = false
      let response: MessageResponse | null = null
      const turnEvents: HandleMessageStreamEvent[] = []
      const onStop = () => {
        stopped = true
        if (response) requestTurnCancel(id, response)
      }
      abortSignal.addEventListener('abort', onStop, { once: true })
      // Step 7: the chat continues in a new session led by its history
      // (loop-run-chat-reopen.ts), at most once per turn. Null when it can't:
      // the caller rethrows the original failure, reported by `reopenRefused`
      // (BUSY when another send's new session won, else FAILED).
      let reopened = false
      const reopenRefused: { reason: Extract<ReopenedLoopRunChat, { ok: false }>['reason'] | null } = { reason: null }
      const reopen = async (): Promise<MessageResponse | null> => {
        reopened = true
        const result = await reopenLoopRunChatSession({
          client,
          service: getServiceClient(),
          record,
          input: parsed,
          turn,
          signal: abortSignal,
        })
        if (!result.ok) {
          console.warn(`[loop-run/chat] ${id}: the session is gone and the chat could not reopen (${result.reason})`)
          reopenRefused.reason = result.reason
          return null
        }
        session = result.session
        record = result.record
        return result.response
      }
      try {
        try {
          response = await dispatchChatTurn(session, parsed, turn)
        } catch (err) {
          // The 30-day session timeout (eve 0.79's 409 session_not_active), a
          // stranded session: this session never takes a turn again. Not after
          // Stop: no new session just to cancel its first turn.
          if (stopped || !isRunSessionGoneError(err)) throw err
          logSessionGone(id, err)
          // A stranded session (another eve version built it): reset it first,
          // as eve's docs say, so nothing it holds keeps running.
          if (isStrandedSessionError(err)) await resetGoneSession(session, 'the session was stranded; the chat reopened in a new session')
          const next = await reopen()
          if (!next) throw err
          response = next
        }
        sent = true
        if (stopped) requestTurnCancel(id, response)
        for (;;) {
          let sawEvent = false
          try {
            for await (const ev of response) {
              sawEvent = true
              turnEvents.push(ev)
              if (stopped) continue
              for (const reduced of reduceStreamEvent(ev)) enqueue(reduced)
            }
            break
          } catch (err) {
            // eve 0.79: a session whose stream history passed the World's
            // retention may take the POST, then answer its stream with 410
            // session_expired. Before any event, the turn goes to a new session
            // instead, and whatever the POST started there is stopped first
            // (its output is unreadable), so the words never run in both.
            if (sawEvent || reopened || stopped || !isRunSessionGoneError(err)) throw err
            logSessionGone(id, err)
            await resetGoneSession(session, 'stream history expired; the chat reopened in a new session')
            const next = await reopen()
            if (!next) throw err
            response = next
            // Stop while the chat reopened: cancel the turn it just started.
            if (stopped) requestTurnCancel(id, response)
          }
        }
      } catch (err) {
        if (reopenRefused.reason === 'stopped' || (stopped && !sent && isRunSessionGoneError(err))) {
          // Stopped while the gone session's turn was moving to a new one:
          // nothing failed, and nobody is left to tell.
          console.info(`[loop-run/chat] ${id}: stopped while the gone session was replaced; nothing was sent`)
        } else {
          logChatError(id, sent, err)
          enqueue(reopenRefused.reason === 'lost_race' ? BUSY_EVENT : reopenRefused.reason ? FAILED_EVENT : reduceChatError(err, sent))
        }
      } finally {
        abortSignal.removeEventListener('abort', onStop)
      }
      // The send stream ending IS the turn boundary: always hand the browser a terminal.
      if (!terminalEmitted) enqueue({ type: 'done' })

      await logSkillRunChatUsage({
        userId: ctx.userId,
        workspaceId: record.workspaceId,
        workItemId: record.workItemId,
        // A reopened chat's session numbers its turns from turn_0 again.
        sessionId: reopenedChatSessionOf(record.state),
        skillId: record.facts.skillId,
        teammateId: ctx.teammateId,
        model: record.facts.model,
        events: turnEvents,
      })
      await advanceSkillRunCursor(getServiceClient(), record, session.state?.streamIndex)

      try {
        controller.close()
      } catch {
        /* closed */
      }
    },
  })
  return new Response(stream, {
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
  })
}

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(_request: Request, { params }: RouteContext) {
  const { id } = await params
  const secret = internalSecret()
  if (!secret) return serverError('Follow-up chat is not configured (missing internal secret)')

  const loaded = await loadLoopRunChat(id)
  if (!loaded.ok) return loaded.response
  const { ctx } = loaded
  const client = chatClient(secret, ctx)
  const session = client.sessions.attach(ctx.record.state.sessionId, { streamIndex: ctx.record.state.streamIndex })
  const startIndex = ctx.record.state.settleStreamIndex

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (event: RunChatEvent) => {
        try {
          controller.enqueue(encoder.encode(encodeRunChatEvent(event)))
        } catch {
          /* closed */
        }
      }
      // A chat that reopened after its session expired: its earlier sessions'
      // turns first, oldest session first. Read side by side under one
      // deadline, so a chat with several costs its reader one wait, not one each.
      const earlier = ctx.record.state.previous ?? []
      if (earlier.length > 0) {
        const deadline = AbortSignal.timeout(REPLAY_EARLIER_SESSIONS_MS)
        const replays = await Promise.all(earlier.map((e) => readEarlierSession(id, client, e, deadline)))
        for (const events of replays) for (const event of events) enqueue(event)
      }
      // A parked stream never closes on its own: abort the read on an idle gap
      // (a bare return() while next() is blocked would deadlock).
      const ac = new AbortController()
      try {
        const events = session.stream({ startIndex, signal: ac.signal })[Symbol.asyncIterator]()
        for (;;) {
          let idleTimer: ReturnType<typeof setTimeout> | undefined
          const next = await Promise.race([
            events.next(),
            new Promise<'idle'>((resolve) => {
              idleTimer = setTimeout(() => resolve('idle'), REPLAY_IDLE_CLOSE_MS)
            }),
          ])
          clearTimeout(idleTimer)
          if (next === 'idle') {
            ac.abort()
            void events.return?.(undefined)?.catch(() => {})
            break
          }
          if (next.done) break
          for (const reduced of reduceStreamEvent(next.value)) enqueue(reduced)
        }
      } catch (err) {
        // Nor a session whose history eve no longer holds: the chat opens
        // without it, and the next send reopens it in a new session (step 7).
        if (!ac.signal.aborted && !isRunSessionGoneError(err)) {
          logChatError(id, true, err)
          enqueue(reduceChatError(err, true))
        }
      }
      try {
        controller.close()
      } catch {
        /* closed */
      }
    },
  })
  return new Response(stream, {
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
  })
}

// ── Helpers (the work-run chat's choreography: agent-runs/[id]/chat; the turn's
// dispatch is shared with it and the main agent's relay: run-chat-dispatch.ts) ─

type ChatBody = {
  message?: string
  inputResponses?: { requestId: string; optionId?: string; text?: string }[]
  /** What the full composer added (bots v4; parseRunChatTurnExtras). */
  extras: RunChatTurnExtras
}

function requestTurnCancel(workItemId: string, response: MessageResponse): void {
  void response.cancel().catch((err: unknown) => {
    console.warn(`[loop-run/chat] Stop: turn cancel failed for ${workItemId}:`, err instanceof Error ? err.message : String(err))
  })
}

/**
 * Read one of a reopened chat's earlier sessions for its replay: a bounded
 * catch-up read (`follow: false`, it ends at the session's tail) from where its
 * follow-up turns start, through the same reducer, until `deadline` (shared by
 * all of them). What it read stands: a session whose history eve no longer
 * holds adds nothing, and any other failure is logged and skipped, never the
 * whole replay's error.
 */
async function readEarlierSession(
  workItemId: string,
  client: EveClient,
  earlier: RunChatPreviousSession,
  deadline: AbortSignal,
): Promise<RunChatEvent[]> {
  const events: RunChatEvent[] = []
  try {
    const session = client.sessions.attach(earlier.sessionId, { streamIndex: earlier.startIndex })
    for await (const ev of session.stream({
      startIndex: earlier.startIndex,
      follow: false,
      signal: deadline,
      streamReconnectPolicy: { reconnect: false },
    })) {
      events.push(...reduceStreamEvent(ev))
    }
  } catch (err) {
    if (!deadline.aborted && !isRunSessionGoneError(err)) logChatError(workItemId, true, err)
  }
  return events
}

/** Reset a gone session before its turn reopens elsewhere, within GONE_SESSION_RESET_MS. Best-effort. */
async function resetGoneSession(session: ClientSession, reason: string): Promise<void> {
  try {
    await session.reset({ reason, signal: AbortSignal.timeout(GONE_SESSION_RESET_MS) })
  } catch {
    /* best-effort: eve answers a reset of an inactive session no_active_session */
  }
}

/** Log, with the item id, that eve said the run's session is gone (status and code only, never the body). */
function logSessionGone(workItemId: string, err: unknown): void {
  const { status, code } = err as { status?: unknown; code?: unknown }
  console.warn(`[loop-run/chat] ${workItemId}: the session is gone (${String(status)}${typeof code === 'string' ? ` ${code}` : ''}); reopening the chat`)
}

/** Generic copy only (the raw eve body is logged, never forwarded). */
function reduceChatError(err: unknown, sent: boolean): RunChatEvent {
  return !sent && isBusyError(err) ? BUSY_EVENT : FAILED_EVENT
}

const BUSY_EVENT: RunChatEvent = { type: 'error', message: 'The agent could not be reached', code: 'BUSY' }
const FAILED_EVENT: RunChatEvent = { type: 'error', message: 'The turn failed', code: 'FAILED' }

function logChatError(workItemId: string, sent: boolean, err: unknown): void {
  console.error(
    `[loop-run/chat] ${sent ? 'stream' : 'send'} failed for ${workItemId}:`,
    err instanceof Error ? `${err.name}: ${err.message}` : String(err),
  )
}

/** { message } and/or { inputResponses }, capped, and the composer's extras (parseRunChatTurnExtras). */
function parseChatBody(body: unknown): ChatBody | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Body must be an object' }
  const b = body as Record<string, unknown>
  const extras = parseRunChatTurnExtras(b)
  if ('error' in extras) return extras
  const message = typeof b.message === 'string' ? b.message.trim() : ''
  if (message.length > MAX_MESSAGE_LENGTH) return { error: `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer` }
  const raw = Array.isArray(b.inputResponses) ? b.inputResponses : null
  if (raw && raw.length > MAX_INPUT_RESPONSES) return { error: `inputResponses may have at most ${MAX_INPUT_RESPONSES} entries` }
  const inputResponses: NonNullable<ChatBody['inputResponses']> = []
  for (const entry of raw ?? []) {
    if (!entry || typeof entry !== 'object') continue
    const r = entry as Record<string, unknown>
    if (typeof r.requestId !== 'string' || !r.requestId) continue
    inputResponses.push({
      requestId: r.requestId,
      ...(typeof r.optionId === 'string' ? { optionId: r.optionId } : {}),
      ...(typeof r.text === 'string' ? { text: r.text } : {}),
    })
  }
  if (!message && inputResponses.length === 0) return { error: 'Body must include a non-empty message or inputResponses' }
  return { ...(message ? { message } : {}), ...(inputResponses.length ? { inputResponses } : {}), extras }
}
