'use client'

/**
 * A `ChatTransport` (AI SDK v6) that drives the in-app chat through a DURABLE eve
 * session on the `chat-agent` mount — the ONLY cloud chat runtime (the legacy
 * `POST /api/ai/chat` streamText route is gone).
 *
 * Its surface: `sendMessages` / `reconnectToStream` / `resetSession` /
 * `disposeAll` / `answerPermission`, one long-lived eve session per chatId, and
 * an eve-events → `UIMessageChunk` translation that `chat-message.tsx` renders
 * (text + tool parts + the ask_user picker). The main chat, the teammate
 * chats and the live chat all run on it.
 *
 * ── Wire flow per turn ──────────────────────────────────────────────────────
 *  1. Ensure a durable `chat_conversations` row exists (the eve session's owner)
 *     and mint a short-lived chat-run token for it (Supabase-authed helper). The
 *     token carries only the DURABLE facts (conversationId, workspaceId, userId,
 *     agentId?, skillId?); the eve runtime re-derives the prompt/tools/model from
 *     it on the internal spec/tool routes.
 *  2. Base64url-encode the PER-TURN context (systemContext, and the routing
 *     signals of the message, src/lib/ai/model-route.ts) into a single `ctx` string — NOT in the token; it changes turn to
 *     turn. The token + ctx ride as `x-chat-run-token` / `x-chat-run-ctx` headers
 *     to the eve mount (the chat-agent channel stamps them onto the principal).
 *  3. Create (first turn) or continue (later turns via the stored continuation
 *     token) the eve session with `eve/client`, authenticated with the user's
 *     Supabase bearer (the chat-agent channel authenticates the Supabase session
 *     + enforces the ownership ACL).
 *  4. The INSTANT eve mints the session id (available synchronously off the POST
 *     response), register it on the conversation's `eve_session_id` BEFORE any
 *     continue/stream targets it — the ownership ACL fails CLOSED otherwise.
 *  5. Stream the eve NDJSON events, hand-translating each into `UIMessageChunk`s.
 *  A blank chat's first turn can do 1, 3 and 4 early: `prewarm` mints, creates
 *  the session message-free and registers it while the user types, so at Enter
 *  only the send POST and the stream remain.
 *
 * ── Invariants (see the design doc) ─────────────────────────────────────────
 *  - `sendAutomaticallyWhen` is FALSE (chat-panel gates it): eve continues the
 *    turn server-side, so a client auto-resend would steal the turn and wedge
 *    `streaming` — a documented, already-fixed bug class.
 *  - NEVER mutate settled message parts in place. Each turn owns its own
 *    emit/close/fail stream closures so a stale event
 *    from a prior turn can never touch a later turn's stream, and the whole
 *    message object is replaced per frame (chat-message.tsx memoizes on the parts
 *    ref — only the actively-streaming message may get a new ref).
 *  - Tool calls emit as `dynamic:true` parts with `toolName` set, so the existing
 *    chip/proposal rendering works unchanged.
 *  - HITL: an `input.requested` whose action is `ask_user` (or display select/
 *    text) becomes a `tool-input-available` dynamic part with toolName 'ask_user'
 *    (the existing picker). A confirmation-shaped request likewise surfaces as a
 *    tool part the picker renders. The parked `ask_user` is answered over the same
 *    eve session (see chat-panel's handleAnswerQuestion eve branch) — the
 *    ignoreIncompleteToolCalls-equivalent: an unanswered server-written ask_user
 *    is left input-available, never force-completed.
 */

import { browserTimeZone } from '@/lib/chat-cards/calendar'
import { currentSurroundings } from '@/lib/sky/surroundings'
import { turnRouteSignals, type TurnRouteSignals } from '@/lib/ai/model-route'
import type { ChatTransport, UIMessage, UIMessageChunk, UserContent } from 'ai'
import { Client as EveClient } from 'eve/client'
import type {
  Client,
  ClientSession,
  HandleMessageStreamEvent,
  InputRequest,
  MessageResponse,
} from 'eve/client'
import { EVE_WRITTEN_METADATA_KEY, type EveMessagePart } from '@/lib/chat/eve-message-writer'
import type { ChatTurnTimings, TurnTimingMsKey } from '@/lib/chat/turn-timings'
import {
  ASK_USER_TOOL_NAME,
  EVE_REPLY_ID_PREFIX,
  applyEveTurnEvent,
  inputRequestCallId,
  resultProducingActionName,
} from '@/lib/chat/eve-turn-parts'
import type { AnswerPermissionOptions } from './agent-question'
import { parseTeammateAboutRef, type TeammateAboutRef } from '@/lib/chat/teammate-about-ref'
import { cardReplyNote, parseCardReplyRef } from '@/lib/chat/card-reply'
import { messageReplyNote, parseMessageReplyRef } from '@/lib/chat/message-reply'
import { REACTION_TURN_KIND } from '@/lib/chat/message-reactions'
import { stampCreatedAt } from '@/lib/chat/message-time'
import type { SteerOutcome, SteerTelemetry } from '@/lib/chat/steer-telemetry'
import { steerOpening, type SteerOpeningFacts, type SteerOpeningReason } from './steer-opening'
import { registerReloadBlocker, reloadForStaleStream } from '@/lib/deploy-reload'

/** The named eve mount for the chat-agent (see next.config.mjs `agents:` map);
 *  eve 0.58+ serves it at /eve/chat-agent/v1/*. */
const CHAT_AGENT_MOUNT = '/eve/chat-agent'

/** Header names — kept in sync with src/lib/chat/chat-run-token.ts + chat-agent/lib/auth.ts. */
const CHAT_RUN_TOKEN_HEADER = 'x-chat-run-token'
/** Re-mint a run token that expires within this window before a HITL respond. */
const RUN_TOKEN_REFRESH_MARGIN_MS = 2 * 60 * 1000
/**
 * How long a send waits for its chat's prewarm to finish before giving up on it
 * and taking the ordinary mint → create → register path.
 */
const PREWARM_WAIT_MS = 3_000
/** How long a first send waits for a conversation the panel is creating (getPendingConversation). */
const PENDING_CONVERSATION_WAIT_MS = 5_000
/**
 * A send runs on its prewarm's run token (and skips its own mint) only when the
 * prewarm minted it at most this long ago, on the access token the send holds
 * now (see sendMessages). The mint is more than a token: it is the chat's
 * primary usage-limit check, and it seals the caller's Supabase JWT into the
 * token for the tools that call back into the app as the user. Skipping it
 * trades a usage check up to this old, sealed with a JWT that is still the live
 * one, for one less round trip at Enter; the chat-agent's usage-limit-gate
 * hook still blocks a turn whose limit was crossed inside the window. An older
 * prewarm re-mints and keeps its session, which is most of the win anyway. A
 * token this young also has ample life left for the turn (a mint gives 60 min).
 */
const PREWARM_REUSE_MAX_AGE_MS = 2 * 60 * 1000
/**
 * At most one typing presence ping per conversation this often (see presence):
 * the server's idle-compaction timer is 10 minutes, so a minute is plenty.
 */
export const PRESENCE_PING_INTERVAL_MS = 60_000

/**
 * The `exp` (epoch ms) a chat-run token claims, read WITHOUT verification (the
 * browser has no secret) — only to decide whether to re-mint. null when the
 * token is absent or malformed (→ re-mint).
 */
export function runTokenExpiresAt(token: string): number | null {
  const dot = token.indexOf('.')
  if (dot <= 0) return null
  try {
    const b64 = token.slice(0, dot).replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const claims = JSON.parse(atob(padded)) as { exp?: unknown }
    return typeof claims.exp === 'number' && Number.isFinite(claims.exp) ? claims.exp : null
  } catch {
    return null
  }
}
const CHAT_RUN_CTX_HEADER = 'x-chat-run-ctx'
/**
 * The id of the reply a send starts or continues (TurnState.messageId). The
 * chat-agent's reply backup writes its own copy of the reply under it, so a
 * reply survives this page dying mid-turn (src/lib/chat/reply-backup.ts).
 * Kept in sync with CHAT_REPLY_ID_HEADER in src/lib/chat/chat-run-token.ts.
 */
export const CHAT_REPLY_ID_HEADER = 'x-chat-reply-id'

/**
 * The workspace override header (kept in sync with WORKSPACE_HEADER in
 * src/lib/workspace.ts, which this client module can't import: it pulls in
 * next/headers). Sent only when the host names a workspace
 * (EveChatTransportOptions.workspaceId).
 */
const WORKSPACE_HEADER = 'x-workspace-id'

/**
 * `promise`'s value, or null when it rejects or has not settled within `ms`.
 * The timer is always cleared, so nothing outlives the wait.
 */
function settleWithin<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      },
    )
  })
}

/** Refresh a Supabase access token that expires within this window before using it. */
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 60 * 1000

/** The copy a send fails with once a refresh + retry could not restore the session. */
const SESSION_EXPIRED_RELOAD_COPY = 'Your session expired — reload the page and try again.'

/**
 * True when a Supabase access token (a JWT) is past its `exp`, or within
 * `marginMs` of it. Reads the base64url payload WITHOUT verifying the signature
 * (the browser has no key) — only to decide whether to refresh before use. A
 * token that cannot be decoded, or carries no numeric `exp`, is NOT reported as
 * expiring: it is not ours to judge, and the server's 401 path still covers it.
 */
export function jwtExpiresSoon(
  token: string,
  nowMs: number = Date.now(),
  marginMs: number = ACCESS_TOKEN_REFRESH_MARGIN_MS,
): boolean {
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[1]) return false
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const claims = JSON.parse(atob(padded)) as { exp?: unknown }
    if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) return false
    return claims.exp * 1000 - nowMs <= marginMs
  } catch {
    return false
  }
}

/**
 * Codes the chat-agent channel answers when the CALLER'S credentials, not the
 * caller, are the problem (agents/chat-agent/lib/auth.ts + channels/eve.ts):
 * `session_expired` (401, an expired Supabase JWT), `chat_run_token_required`
 * (a missing/expired run token) and `session_forbidden` (the ownership ACL —
 * which a stale JWT used to trip by resolving the wrong workspace).
 */
const EVE_SESSION_AUTH_CODES = new Set(['session_expired', 'chat_run_token_required', 'session_forbidden'])

/**
 * True when an eve request failed on the caller's session credentials: any
 * HTTP 401, or a 403 whose code is one of EVE_SESSION_AUTH_CODES. Duck-typed on
 * eve's ClientError shape (`status` + `code`, parsed from the
 * `{ ok: false, code, error }` body) so an injected client's errors match too.
 * The cure is the same for all of them: refresh the JWT, re-mint, retry once.
 */
export function isEveSessionAuthError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const { status, code } = err as { status?: unknown; code?: unknown }
  if (status === 401) return true
  return status === 403 && typeof code === 'string' && EVE_SESSION_AUTH_CODES.has(code)
}

/**
 * True when eve answered a session's stream with 410 `session_expired`: its
 * history passed the World's retention (eve 0.79). Not a credentials error
 * (the chat-agent's own `session_expired` is a 401/403, isEveSessionAuthError).
 */
export function isEveHistoryExpiredError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const { status, code } = err as { status?: unknown; code?: unknown }
  return status === 410 && code === 'session_expired'
}

/** status + code of a failed eve request, for logs (never a token). */
function describeEveError(err: unknown): { status?: unknown; code?: unknown } {
  if (typeof err !== 'object' || err === null) return {}
  const { status, code } = err as { status?: unknown; code?: unknown }
  return { status, code }
}

/** The cookie-authed wrapper route the transport POSTs a finalized turn to. */
const EVE_PERSIST_ROUTE = '/api/account/chat/eve-persist'

/**
 * The durable claims a token is minted for. workspaceId/userId are derived
 * server-side (never trusted from the client), so the transport only supplies
 * the conversation identity + the active persona/skill.
 */
export interface ChatRunMintClaims {
  conversationId: string
  agentId?: string
  skillId?: string
}

/** What the mint helper returns: a signed run token for the conversation. */
export interface ChatRunMintResult {
  token: string
  /** Echoed for observability; the token is authoritative. */
  conversationId: string
  /**
   * The eve session already registered on this conversation, if any. A chat
   * with no live session handle (reload, Stop, a loaded chat, a restored tab)
   * RE-ATTACHES to it, so the durable session's history carries on.
   */
  eveSessionId?: string | null
  /**
   * Only when asked (`wantHistory`): a bounded "conversation so far" block built
   * server-side from the conversation's messages, or null when it has none. The
   * transport prepends it to the FIRST message of a NEW eve session (no session
   * registered, or the registered one can no longer take a turn).
   */
  historyPrimer?: string | null
}

export interface EveChatTransportOptions {
  /**
   * Ensure a durable conversation exists + mint a chat-run token for it. Given
   * the chatId + the active persona/skill, returns { token, conversationId }.
   * Server-side (Supabase-authed) — the token is HMAC-signed with a server-only
   * secret, so the browser can never mint it directly. Defaults to POSTing
   * `/api/account/chat/eve-session` with `{ action: 'mint', ... }`.
   */
  mintRunToken?: (args: {
    chatId: string
    conversationId: string | null
    agentId?: string
    skillId?: string
    accessToken: string | null
    /** Also return eveSessionId + historyPrimer (first send without a live handle). */
    wantHistory?: boolean
    /**
     * A teammate chat's item (bots v3 1d: the send's `body.teammateAbout`,
     * ids only). The default mint sends it as `about`; the route checks it's
     * the caller's own and signs it into the token, and the spec rebuild
     * attaches the item as the "About this item" section.
     */
    about?: TeammateAboutRef | null
    /**
     * A new conversation's focus (one-agent S3, getFocusArea): the default
     * mint sends it as `focusArea`. The route stamps it on a conversation it
     * creates and ignores it for an existing one (a focus is fixed).
     */
    focusArea?: string
  }) => Promise<ChatRunMintResult>
  /**
   * Register the minted eve session id onto its conversation's `eve_session_id`
   * so the ownership ACL can authorize continue/stream. MUST resolve before the
   * next continue/stream call. Defaults to POSTing `/api/account/chat/eve-session`
   * with `{ action: 'register', conversationId, sessionId, previousSessionId }`.
   * `previousSessionId` is the session the transport knew the row held (null:
   * none): the write lands only while the row still holds it, so a second
   * window that forked a session can't overwrite this one (A3, the home
   * thread). A loss throws an {@link EveSessionConflictError}.
   */
  registerEveSession?: (args: {
    conversationId: string
    sessionId: string
    accessToken: string | null
    previousSessionId: string | null
  }) => Promise<void>
  /**
   * The usage check alone (default: POST /api/account/chat/eve-session with
   * `{ action: 'usage' }`; its 429 opens the usage-limit dialog through the
   * /api fetch watch). 'blocked' on a 429 / 503 BILLING_UNAVAILABLE,
   * 'unknown' when the check itself failed. Asked when a sent turn is
   * cancelled with no answer and no Stop (eve 0.68+: the usage-limit-gate
   * hook cancels a blocked turn, it can't throw), and before an ask_user
   * answer resumes a held turn (eve 0.70+: no new turn.started, so the hook's
   * turn-start check never runs for it).
   */
  checkUsage?: () => Promise<'ok' | 'blocked' | 'unknown'>
  /** The user's current Supabase access token (for the eve mount + helper auth). */
  getAccessToken?: () => string | null
  /**
   * Refresh the Supabase access token and return the new one (or null if it
   * couldn't be refreshed). Called ONCE when a mint 401s with SESSION_EXPIRED —
   * the cached token the sync getAccessToken hands out went stale (a machine/tab
   * that slept past the JWT's expiry), so we refresh, retry the mint once with
   * the fresh token, and thread that fresh token through the rest of the send
   * (ensureSession / register / persist). The implementation MUST also update
   * whatever cached ref getAccessToken reads, so later sends use the fresh token.
   * Optional; without it a mint failure surfaces as before (no retry).
   *
   * Also called (deduped — one refresh in flight at a time) BEFORE any mint or
   * eve request whose token is expired or within a minute of expiring
   * (jwtExpiresSoon), and when an eve request is refused on its credentials
   * (isEveSessionAuthError: refresh → re-mint → retry once).
   */
  refreshAccessToken?: () => Promise<string | null>
  /**
   * The durable conversation id the panel currently tracks, read live. Used ONLY
   * as a fallback on the FIRST turn of a chat whose per-send body omitted the id
   * (the eve delegate receives only what `sendMessage(..., { body })` passed —
   * which never includes conversationId). Once this chat's eve session exists, its own
   * resolved id wins over this. Null on a fresh chat → the mint route creates the
   * row. Optional; a no-op if omitted (the transport falls through to null).
   */
  getConversationId?: () => string | null
  /**
   * A conversation the panel is creating right now, or null: the client's
   * first save of a chat that so far holds only a page opened from `/`
   * (useChatAutoSave.pendingCreate), resolving to its id (null if it failed).
   * A send that finds one waits for it, briefly, and mints against that row,
   * never claiming a prewarm made for another (the `/` keystroke prewarms).
   */
  getPendingConversation?: () => Promise<string | null> | null
  /**
   * The chat's cards on screen (pages in the chat: CardContextEntry[]), read
   * at send time and added to the turn's systemContext as `cards`, so the
   * agent hears about the person's changes by hand and read_card can re-run a
   * card. Optional; nothing is added when it is omitted or returns none.
   */
  getCardContext?: () => unknown[]
  /**
   * Whether the host panel names its own chats (its /api/account/chat/title
   * request, synced onto the row by the autosave), read live at persist time.
   * When true, each persist says so (`panelTitles`) and the server's first-turn
   * title backfill stands down — otherwise a fast first turn's persist can read
   * the row before the panel's name lands and write a placeholder over it.
   * Omitted/false → the server backfill gives the chat its first-message
   * fallback name (headless, no tab strip).
   */
  panelNamesChats?: () => boolean
  /**
   * The workspace this transport's conversations live in, sent as
   * `x-workspace-id` on the default mint, register and persist requests and on
   * every eve request (the client's seed headers and each turn's). A string,
   * or a getter read at request time. Omitted → the transport sends no
   * workspace header and the window's fetch interceptor (workspace-fetch.ts)
   * adds the active workspace, as before.
   *
   * WHY: a bots v2 teammate chat lives in the TEAMMATE's workspace, which can
   * differ from the one the window is on. The mint stamps the token with that
   * workspace, and the chat-agent channel refuses a turn whose token
   * workspace differs from the one it resolves (assertTurnRunToken: header →
   * cookie → first membership, membership-checked); register and the history
   * read scope by the resolved workspace too. The interceptor only fills the
   * header when the caller has not, so this one wins.
   */
  workspaceId?: string | (() => string | null)
  /**
   * A bots v2 teammate chat: the AI teammate (`ai_team_member` id) the
   * conversation is with. The default mint sends it, and the route answers
   * with the caller's ONE thread with that teammate (ignoring the
   * conversation id) and a token carrying the teammate.
   */
  teammateId?: string
  /**
   * A main-chat conversation focused on an area (one-agent plan S3, migration
   * 318): the area key this chat's conversation is focused on, read at every
   * mint, or null for none. The default mint sends it as `focusArea`; the
   * route stamps a conversation it creates with it (an existing one keeps its
   * own). It is still the main agent: no teammate. A session or prewarm made
   * for another focus (or none) is never reused for it. Ignored with
   * `teammateId`.
   */
  getFocusArea?: () => string | null
  /** The eve mount base URL. Defaults to same-origin (''), so it works in the
   *  browser without a host. Overridable for tests. */
  host?: string
  /** Test seam: inject an eve Client factory instead of importing eve/client. */
  createClient?: (opts: {
    host: string
    /** The access token at creation time (a snapshot — see getBearer). */
    accessToken: string | null
    /**
     * Resolves the CURRENT bearer before every eve HTTP call (eve's
     * `auth.bearer` accepts a per-request resolver): the live getAccessToken
     * value, refreshed first when it is expired or about to expire. This is
     * what keeps a long-lived cached client off a stale JWT.
     */
    getBearer: () => Promise<string | null>
    token: string
    ctx: string
    /** The workspace header the client is seeded with (opts.workspaceId), or null. */
    workspaceId?: string | null
  }) => Client
  /** Called after a fresh session mints an id (persist for resume / debugging). */
  onSessionMinted?: (chatId: string, eveSessionId: string) => void
  /**
   * Called with the DURABLE conversation id the mint resolved for this chat, the
   * FIRST time it's known (the mint creates the row when the client had none, so
   * on a fresh chat this is the ONLY place the client learns the id). The panel
   * feeds it into the auto-save so the user message + any later client saves land
   * on the SAME `chat_conversations` row the eve session + assistant projection
   * are keyed to — fixing the conversation split (mint row A vs client row B).
   * Called once per chat (deduped by a per-chat guard); a no-op if omitted.
   */
  onConversationEnsured?: (chatId: string, conversationId: string) => void
  /**
   * Persist a finalized assistant turn (projection + knowledge hook; the usage it
   * carries is display-only — billing is server-side) via
   * the cookie-authed wrapper route. Best-effort by contract — a rejection must
   * not break the visible turn. Defaults to POSTing EVE_PERSIST_ROUTE with the
   * chat-run token header. Overridable for tests.
   */
  persistTurn?: (args: {
    token: string
    accessToken: string | null
    body: EvePersistBody
  }) => Promise<void>
  /** Overrides for the steering and persist bounds (tests only; see the *_MS constants). */
  timeouts?: {
    /** How long a flush waits for a steer's POST still in flight (STEER_POST_WAIT_MS). */
    steerPostWaitMs?: number
    /** Send now while posted: how long the steer may take to show up (SEND_NOW_FIRST_EVENT_MS). */
    sendNowFirstEventMs?: number
    /** How long a persist waits for the chat's previous one (PERSIST_CHAIN_CAP_MS). */
    persistChainCapMs?: number
    /** How long an accepted send may show no event before the session's health is read (TURN_START_STALL_MS). */
    turnStartStallMs?: number
    /** How long that health read may take (SESSION_HEALTH_READ_MS). */
    sessionHealthReadMs?: number
    /** The pause that ends a health read's tail (SESSION_HEALTH_TAIL_IDLE_MS). */
    sessionHealthTailIdleMs?: number
    /** How long a send waits behind a compaction before the session reads as dead (COMPACTION_WAIT_MS). */
    compactionWaitMs?: number
    /** How often the health is read again while it compacts (COMPACTION_POLL_MS). */
    compactionPollMs?: number
    /** How long the one register retry waits (REGISTER_RETRY_DELAY_MS). */
    registerRetryMs?: number
  }
  /**
   * The chat's session is busy with something other than a turn, so a send
   * waits behind it: `'compacting'` while eve compacts the conversation (an
   * idle compaction the send arrived during; eve can't cancel it, and the
   * message runs right after), then `null` once the reply starts or the wait
   * ends. The panel shows SESSION_TIDYING_COPY in place of a stall meanwhile.
   * Synchronous; a throw is swallowed.
   */
  onSessionBusy?: (chatId: string, state: SessionBusyState | null) => void
}

/** What a send can wait behind before its turn starts (EveChatTransportOptions.onSessionBusy). */
export type SessionBusyState = 'compacting'

/** The quiet line the panel shows while a send waits behind a compaction. */
export const SESSION_TIDYING_COPY = 'Tidying up the conversation…'

/** A flush waits at most this long for a steer's POST still in flight (then: send it plainly if eve refused it, else an error). */
const STEER_POST_WAIT_MS = 20_000
/**
 * Send now while a steer is posted: if the steer's own response shows nothing
 * of it this long after the cancel, the words go once more as a plain turn.
 * eve keeps a queued message across a turn cancel (see openTurnStream), so this
 * is a guard, not the path.
 */
const SEND_NOW_FIRST_EVENT_MS = 20_000
/**
 * An accepted send whose stream shows NO event for this long gets its
 * session's health read (sessionHealth): a session bound to a retired
 * deployment accepts the message (202) and then never starts a turn, and the
 * home thread, which never starts over, must not hang on it forever.
 */
const TURN_START_STALL_MS = 45_000
/** The health read (a snapshot of the session's durable stream) gives up after this long: no answer reads as dead. */
const SESSION_HEALTH_READ_MS = 10_000
/**
 * A send that found its session compacting (an unclosed `compaction.requested`:
 * eve's compact-only pass emits no `turn.started`, and a queued message emits
 * nothing until its turn starts) waits this long for the compaction to end
 * before the session reads as dead. A 540K-token compaction takes a minute or
 * two; one still open after five belongs to a run that will never finish (a
 * retired deployment's), never to a live one.
 */
const COMPACTION_WAIT_MS = 5 * 60_000
/** While it compacts, the health is read again this often (the first event usually comes first). */
const COMPACTION_POLL_MS = 15_000
/** What the person reads when a send's session stopped answering (with a Retry that sends it again, once, in a fresh session). */
export const SESSION_STALLED_COPY = 'Your message didn’t reach the agent: its session stopped answering. Retry sends it again in a fresh session.'
/** A Retry that found the old session busy again (compacting or running a turn): nothing sent, nothing registered over it. */
export const SESSION_BUSY_COPY = 'The agent is still finishing up in this conversation, so nothing was sent again. Try again in a minute if no reply appears.'
/** A turn's persist waits at most this long for the chat's previous one, so one slow write never holds back the rest. */
const PERSIST_CHAIN_CAP_MS = 5_000
/** The default persist request gives up after this long. */
const PERSIST_FETCH_TIMEOUT_MS = 15_000
/** The adopted turn's error when a steer's POST never confirmed (it is not re-sent: eve may have it). */
const STEER_UNCONFIRMED_COPY = 'Couldn’t confirm your message reached the agent. Check the reply before sending it again.'

/** A fetch signal that aborts after `ms`, where the runtime has AbortSignal.timeout. */
function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined
}

/** The body the transport POSTs to the eve-persist wrapper at turn completion. */
export interface EvePersistBody {
  messageId: string
  /**
   * 'user' when the body is a user message alone: written the moment it is
   * sent (persistUserMessageNow), or a turn stopped before anything rendered
   * (persistUserMessageAlone).
   */
  role: 'assistant' | 'user'
  parts: EveMessagePart[]
  metadata: Record<string, unknown>
  usage: {
    events: HandleMessageStreamEvent[]
    wallMs: number
  }
  /**
   * The user message that started this turn (client id + parts), so the server
   * writes it BEFORE the assistant row. Without it, the client autosave (which
   * only saves at turn end) races the persist and the assistant row wins
   * created_at ordering — a reload then renders the reply above the question.
   * The autosave's own upsert of the same ui_message_id dedups into this row.
   */
  userMessage?: {
    messageId: string
    parts: EveMessagePart[]
    /** `steer`: this message steered a running reply (UI-2) — 'applied' | 'next_turn'. */
    metadata?: Record<string, unknown>
  }
  /** Present (true) when the panel names this chat itself — see panelNamesChats. */
  panelTitles?: true
  /**
   * The user message alone, written the moment it was sent
   * (persistUserMessageNow). The server then leaves the knowledge hook to the
   * reply's write, so a turn still feeds extraction once.
   */
  onSend?: true
  /**
   * The turn's time-to-first-token phases (deriveTurnTimings), for the route's
   * `ttft_*` analytics properties and its `[chat-ttft]` log line. Analytics only.
   */
  timings?: ChatTurnTimings
  /** The turn adopted a steer (UI-2): how it landed and waited. Analytics only. */
  steer?: SteerTelemetry
}

/**
 * Where a held message is (UI-2, requestSteer): held (not sent; Edit still
 * works) → posting → posted (eve has it) → applied (eve took it into the
 * running turn) | next_turn (the running turn ended first). `failed`: the mint
 * or POST was refused, so it waits for the end and goes as an ordinary send.
 * `lost`: the POST failed in a way that leaves it unknown whether eve has it,
 * and `dropped`: the chat's session handle was dropped (an agent switch, a
 * reset) while eve has it. Neither is ever re-sent: the panel removes the row.
 */
export type SteerPhase = 'held' | 'posting' | 'posted' | 'applied' | 'next_turn' | 'failed' | 'lost' | 'dropped'

/** A held message the panel asks the transport to steer the running turn with. */
export interface SteerRequest {
  /** The panel's id for it; the flush's send names it as `body.steerId`. */
  id: string
  /** The words (plain text only: no files, mentions, skill or selection). */
  text: string
  /** The send body the panel would send it with (model, systemContext, agentId). */
  body?: unknown
  /** Each phase change, synchronously. */
  onState?: (phase: SteerPhase) => void
}

/**
 * The one steer a chat may have in flight (ActiveSession.pendingSteer). The
 * transport POSTs it beside useChat — never as a second useChat request, which
 * is what duplicated replies (#681) — and keeps eve's response unread until the
 * panel's flush adopts it (sendMessages with `body.steerId`).
 */
interface PendingSteer {
  id: string
  /** What eve receives (text only). */
  message: string
  /** The per-turn ctx the POST carries (used if eve runs it as the next turn). */
  ctx: string
  /**
   * The id the adopted turn renders its reply under, minted with the steer so
   * its POST names the reply it continues (CHAT_REPLY_ID_HEADER).
   */
  replyId: string
  agentId?: string
  skillId?: string
  /** The running turn it steers. */
  prior: TurnState
  phase: 'held' | 'posting' | 'posted' | 'withdrawn' | 'failed'
  /** Its own run token (a mint per steer: the same usage check as a send). */
  token: string | null
  /** The POST in flight (settles when it lands or fails; never rejects). */
  post: Promise<void> | null
  /** A failed POST: eve answered and refused it ('no'), or nobody knows ('unknown'). */
  postAccepted: 'no' | 'unknown' | null
  /** eve's response to the POST, unread until adopted. */
  response: MessageResponse | null
  /** What the prior turn saw: it settled at the steer point, or ended first. */
  landed: SteerOutcome | null
  /** Send now while posted: the prior was stopped (cancelled by its turn id). */
  priorStopped: boolean
  /** The prior's eve turn id when the POST went. */
  priorTurnId: string | null
  requestedAt: number
  postedAt: number | null
  opening: SteerOpeningReason | null
  onState: (phase: SteerPhase) => void
}

/** What an adopted turn (TurnState.adoptedSteer) knows of the steer it renders. */
interface AdoptedSteer {
  priorTurnId: string | null
  priorStopped: boolean
  priorAnswerStarted: boolean
  priorSteersInTurn: number
  landed: SteerOutcome | null
  requestedAt: number
  postedAt: number | null
  opening: SteerOpeningReason | null
}

/** The picker of a question skipped because a steer landed on its park (UI-2). */
export const STEER_SKIPPED_QUESTION_COPY = 'Skipped: you sent a new message'

/** Per-turn open stream state — its OWN closures so a stale event can't cross turns. */
interface TurnState {
  /**
   * The stable id of the assistant message THIS turn renders. Minted per turn and
   * emitted on the `start` chunk (messageId) so useChat's assembled message uses
   * it as its top-level id, which maps 1:1 onto the STORED `ui_message_id` the
   * persist writer dedups on. The persist body's messageId is THIS value.
   */
  messageId: string
  textId: string | null
  textClosed: boolean
  /**
   * The model's reasoning/thinking block, mirrors textId/textClosed exactly —
   * same open/close lifecycle, one block at a time. eve emits it as a SEPARATE
   * event stream (`reasoning.appended`) from the visible reply
   * (`message.appended`), ahead of it: the model reasons first, then answers,
   * so a reasoning block is always closed before its matching text block opens
   * (see closeReasoningIfOpen(), called everywhere closeTextIfOpen() is).
   */
  reasoningId: string | null
  reasoningClosed: boolean
  started: boolean
  settled: boolean
  /** callIds we've already announced tool-input-available for (idempotency). */
  announcedTools: Set<string>
  /** requestIds of open input.requested we surfaced (answered over the session). */
  openInputRequests: Set<string>
  /**
   * Maps the picker part's toolCallId (the eve action callId we surfaced) → the
   * eve requestId that `inputResponses` must answer. The two differ (a tool call
   * has its own callId; the HITL pause has a requestId), so answerPermission
   * looks the requestId up by the toolCallId the picker hands back.
   */
  inputRequestIdByCallId: Map<string, string>
  /**
   * Per open requestId, the facts answerPermission needs to resume it correctly:
   *  - `callId` — the tool part's toolCallId (for flipping the accumulated part).
   *  - `isApproval` — whether eve gated this as an APPROVAL request (options
   *    approve/cancel, `display: 'confirmation'`). Native Intelligence's `ask_user` is gated with
   *    `approval: always()`, so its pause IS an approval request. eve's
   *    `resolveApprovalOutcome` (harness/input-request-resolution.js) will NOT
   *    resolve an approval unless the response's `optionId` picks one of the
   *    request's own options — any other value lands on `status: 'invalid'` and the
   *    turn is DEFERRED forever (the stall). So the resume MUST carry the actual
   *    approve/cancel option id FROM THE REQUEST, never blind-hardcoded.
   *  - `approveOptionId` / `cancelOptionId` — the option ids taken verbatim from the
   *    request's own `options` (eve 0.47.7–0.66.3 emit [{id:'approve'},{id:'cancel'}] —
   *    the negative verb was renamed from 'deny' in 0.32.0; captured here so a
   *    schema change can't desync us). The resume picks approveOptionId for a
   *    genuine answer (a picked option or words typed in the composer),
   *    cancelOptionId for a dismiss.
   *  - `questions` — the ask_user's question texts, so a typed reply can tell
   *    the model which question(s) it answers.
   *
   * The user's structured answers do NOT ride on the approval response at all —
   * eve's `buildToolResponsePartsForRequest` discards a `text` field on an approval
   * (it emits only `{approvalId, approved}`), so the model would never see the
   * choice. Instead answerPermission threads the answers as a follow-up `message`
   * in the SAME `send()`: eve's `resolvePendingInput` resolves the approval AND
   * queues the message (`queueDeferredStepInput`) to replay to the model as the
   * next user turn — the sanctioned answer-to-model path (docs/tools/human-in-the-
   * loop.md §"How pause and resume works").
   */
  inputRequestMeta: Map<
    string,
    {
      callId: string
      isApproval: boolean
      /** eve's session-limit prompt (Continue / Stop): answered by option id, never a message to the model. */
      isSessionLimit: boolean
      approveOptionId: string
      cancelOptionId: string
      questions: string[]
    }
  >
  /**
   * callId → the user-visible answer output ({ answers } / { response }) for an
   * ask_user this turn already answered. eve's resume stream follows up with an
   * action.result for that callId carrying the tool's EXECUTE output (the
   * internal "the answers arrive next" note) — projecting THAT would clobber the
   * answers the panel flipped in, and chat-message's extractQuestionAnswers
   * (which renders the answered summary from { answers }/{ response }, cloud
   * parity) would find nothing → the submitted answers vanish from the thread.
   * action.result consults this map and keeps the answers instead.
   */
  askUserAnswered: Map<string, unknown>
  /** The user message that started this turn (id + parts), included in the
   *  persist body so the server writes it BEFORE the assistant row (ordering). */
  userMessage: { messageId: string; parts: EveMessagePart[]; metadata?: Record<string, unknown> } | null
  /**
   * The rendered assistant message's parts, accumulated as chunks are emitted, in
   * the same shape useChat assembles (text parts + dynamic-tool parts). This is
   * what the persist projection writes into chat_messages so a reload renders the
   * same bubble the client showed. The tool-part index lets a later result flip
   * the matching part to output-available in place.
   */
  parts: EveMessagePart[]
  /** toolCallId → index in `parts`, so action.result updates the right tool part. */
  toolPartIndex: Map<string, number>
  /**
   * The turn's USAGE-RELEVANT eve stream events (`step.completed` +
   * `actions.requested` — see isUsageRelevantEvent), collected for the persist
   * body's usage mapping at completion. Deliberately NOT every event: recording
   * the whole stream meant one retained object per `message.appended` text
   * delta — O(deltas) memory held for the life of the turn (and POSTed to the
   * persist route) for an accounting pass that never reads them.
   */
  events: HandleMessageStreamEvent[]
  /** Turn wall-clock start (ms) — the persist usage's durationMs source. */
  startedAt: number
  /**
   * This turn's time-to-first-token marks (see TurnTimingMarks), derived into
   * the persist body's `timings` once, when the turn persists.
   */
  timings: TurnTimingMarks
  /** Guards against double-persisting one turn (completed + a resumed close). */
  persisted: boolean
  /** The user message was written when it was sent (persistUserMessageNow). */
  userPersisted: boolean
  /**
   * Resolves the instant the ACTIVE send's stream has been fully drained to the
   * eve turn boundary (`session.waiting` on a HITL park, or completed/failed).
   * Crucially, `ClientSession.state` — the durable stream cursor — is only
   * advanced (in the stream generator's `finally`) once that drain reaches the
   * boundary. eve itself ACCEPTS a respond into a still-active turn (pure
   * `inputResponses` deliveries never steer — they stay available to the pending
   * request they address; the 409 `session_not_active` is only for an unknown or
   * TERMINAL session id). What racing breaks here is OUR bookkeeping: responding
   * before the drain advances `ClientSession.state` means the resume send re-attaches
   * from a stale cursor and replays/loses stream events. `answerPermission` awaits
   * this gate so the cursor is always current. Re-armed by every dispatch (initial
   * send + each resume) via `armDrainGate`.
   */
  drained: Promise<void>
  /** Resolver for `drained`, called when the current send's drain loop exits. */
  resolveDrained: () => void
  /**
   * True while an answerPermission is in flight for this turn (from the moment it
   * consumes the request until its resume send + drain completes). `runTurn`'s
   * post-loop honors this: it must NOT close/persist a parked turn whose answer is
   * mid-flight, or it would settle the turn (and free the drain gate) out from
   * under the resume send — the resume would then see `turn.settled` and bail,
   * silently dropping the answer (a race between the park drain and the click).
   */
  answering: boolean
  /**
   * The eve `meta.deliveryIds` of the durable turn this TurnState renders,
   * learned from the first stamped event it consumes (null until then). eve
   * stamps every event of a turn with the ids of the accepted messages that own
   * it, and a message steered INTO a running turn is appended to that set (eve
   * 0.57+: steering continues the SAME turn, same turnId). An event carrying an
   * id outside this set therefore belongs to a later, steering send.
   */
  ownDeliveryIds: Set<string> | null
  /**
   * Set when a later `sendMessages` steers while this turn is still live. From
   * then on, the first event whose deliveryIds include an id outside
   * `ownDeliveryIds` is the steer point: this turn settles there and the
   * steering send's own response (which eve's client starts at exactly that
   * event) renders the rest. See runTurn's turnPolicy comment.
   */
  superseded: boolean
  /**
   * The eve turn id this TurnState is rendering (`data.turnId`, stamped on every
   * turn-scoped event), learned from the events it claims — so Stop can cancel
   * exactly that durable turn. Updated as it goes; reset to null when a HITL
   * resume is sent (the resume runs on a NEW eve turn id). null until the first
   * turn-scoped event of the current send.
   */
  eveTurnId: string | null
  /**
   * Set by Stop. The turn is already settled for the UI, but the send's response
   * keeps being drained (output discarded) until it names the durable turn it
   * started or steered, so Stop can cancel exactly that turn. See drainStopped.
   */
  stopRequested: boolean
  /** Guards the Stop → server cancel so it fires at most once per turn. */
  serverCancelRequested: boolean
  /** Resolves once `ownDeliveryIds` is known, or the turn settles / its drain
   *  loop exits. A steering send waits on it before POSTing. */
  identified: Promise<void>
  resolveIdentified: () => void
  /**
   * The steer facts (steer-opening.ts) this eve turn has shown so far: answer
   * text started (turn-scoped, like eve's outputStarted), the tools requested
   * and not yet returned, and a tool call's input streaming. Reset when a new
   * eve turn starts (turn.started, a HITL resume).
   */
  answerStarted: boolean
  toolsExecuting: Set<string>
  toolInputStreaming: boolean
  /** runTurn left the turn open on a park (an unanswered ask_user). */
  parkedIdle: boolean
  /** An approval-gated call (ask_user) was requested this eve turn: it is about to park. */
  approvalRequested: boolean
  /** Steers eve took into the eve turn this TurnState renders (0 for none). */
  steersInTurn: number
  /** Set when this turn adopted a posted steer's response (UI-2). */
  adoptedSteer: AdoptedSteer | null
  /** An adopted steer's outcome, read from its response's first turn-scoped event. */
  steerOutcome: SteerOutcome | null
  /** When that first event arrived (epoch ms; telemetry). */
  steerFirstEventAt: number | null
  /**
   * The steer was folded into the very turn Send now cancelled: its
   * `turn.cancelled` must not end this turn — the words are re-sent once as
   * the next turn instead, so Send now still gets them an answer.
   */
  resendOnCancel: boolean
  emit: (chunk: UIMessageChunk) => void
  close: () => void
  fail: (err: Error) => void
}

interface ActiveSession {
  /**
   * The eve client, plus the ID-addressed session handle. Post-0.31 a handle only
   * exists once `client.sessions.create()` has run (create IS the first turn's
   * POST), so this stays null until `runTurn` dispatches the first message —
   * unless a prewarm created it message-free first.
   */
  client: Client
  session: ClientSession | null
  /** eve's durable session id, once the first send mints it. null until then. */
  eveSessionId: string | null
  /** Whether eve_session_id was already registered (once per session). */
  registered: boolean
  /**
   * The session the conversation's row held when this handle was made (the
   * mint's), null for none: a fresh session registers only over it (A3), so
   * two windows never overwrite each other's.
   */
  knownSessionId?: string | null
  /**
   * Its register lost to another window's session (A3): this turn still runs
   * on it (Stop and ask_user answers work), and once the turn settles the
   * handle goes, so the chat's next send re-attaches to the session the row
   * holds, carrying this exchange (orphanCarry). The chat it belongs to.
   */
  orphanedFor?: string
  /** The orphaned turn has been settled (the handle dropped, the exchange kept). */
  orphanSettled?: boolean
  /**
   * The handle was RE-ATTACHED to the conversation's registered session (not
   * created here) and has not yet taken a turn. If its first send fails, that
   * session can no longer take turns: runTurn starts a fresh, primed one.
   */
  reattached?: boolean
  /** The mint's history primer, spent on the first message of a NEW session. */
  historyPrimer?: string | null
  /** The currently-open turn, or null between turns. */
  turn: TurnState | null
  /**
   * The freshest run token + per-turn ctx for THIS session. The client is created
   * once and cached; the token is short-lived (~60 min) and the ctx changes per
   * turn, so both are refreshed here on every send and passed as per-request
   * headers on `session.send()` — the constructor headers are only the seed.
   */
  token: string
  ctx: string
  /** The durable conversation id the mint resolved. Persist targets it via the
   *  token; onConversationEnsured surfaced it to the panel (once). */
  conversationId: string
  /** Whether onConversationEnsured already fired for this chat (once per chat). */
  conversationAnnounced: boolean
  /** The agent / skill the last send minted for — reused by a re-mint before a
   *  HITL respond whose token went stale (see refreshStaleRunToken). */
  agentId?: string
  skillId?: string
  /** The item the last send was about (a teammate chat's, bots v3 1d), for the same re-mint. */
  teammateAbout?: TeammateAboutRef | null
  /**
   * Who the conversation runs as, as one key: `focus:<area>`, or null for an
   * ordinary chat. A send for another key never reuses this session.
   */
  agentKey?: string | null
  /**
   * Set while the handle is a PREWARMED session (created and registered before
   * the chat's first send, see prewarm) that has not yet taken a turn: what its
   * run token was minted for and with — the persona / skill, when (epoch ms),
   * and the Supabase access token the mint sealed into it. A send reuses that
   * token only while all of them still hold (PREWARM_REUSE_MAX_AGE_MS).
   * Cleared once the first send lands; if that send is refused, runTurn starts
   * a fresh session instead.
   */
  prewarm?: { agentId?: string; skillId?: string; agentKey?: string | null; mintedAt: number; accessToken: string | null }
  /**
   * The last finished turn's write into chat_messages (persistFinishedTurn);
   * never rejects. Each write chains on the one before, so a steered reply's
   * part always lands before the steering message and its continuation.
   */
  lastPersist?: Promise<void>
  /** `lastPersist` has settled (a write after it starts at once). */
  lastPersistSettled?: boolean
  /** The held message steering the running turn, if any (UI-2; one at a time). */
  pendingSteer?: PendingSteer | null
}

/**
 * One chat's prewarm (see EveChatTransport.prewarm): a session made ready while
 * the user types their first message, held OUTSIDE `sessions` until that
 * chat's first send claims it, so nothing can drive it before then.
 */
interface PrewarmEntry {
  /** The ready handle, or null when the prewarm failed or was abandoned. Never rejects. */
  ready: Promise<ActiveSession | null>
  /**
   * Set when the prewarm must not be used: the transport was disposed, the
   * chat got bound to a conversation, or its send stopped waiting (a reset
   * keeps it, see resetSession). The prewarm then stops at its next step and
   * never registers a session.
   */
  abandoned: boolean
}

/**
 * A mint failure that carries the HTTP status + parsed body, so sendMessages can
 * distinguish a 401 SESSION_EXPIRED (refresh + retry once) from every other
 * failure (surface verbatim — 429/503 keep their documented no-fallback copy).
 * The `message` is already the user-facing string mint() composed, so a caller
 * that doesn't special-case the status can still surface it directly.
 */
class MintError extends Error {
  readonly status: number
  readonly code?: string
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'MintError'
    this.status = status
    this.code = code
  }
}

/**
 * True when a thrown mint error is a 401. Duck-typed on `status` so it matches
 * BOTH the default fetch path's MintError and an injected mintRunToken that
 * throws its own error shape carrying `{ status: 401 }`.
 */
function is401MintError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { status?: unknown }).status === 401
  )
}

/**
 * A conditional register lost (A3): the conversation's row holds another
 * session than the one this transport knew, registered by another window.
 * `current` is the session it holds now.
 */
export class EveSessionConflictError extends Error {
  constructor(readonly current: string | null) {
    super('another window registered a session on this conversation')
    this.name = 'EveSessionConflictError'
  }
}

/** The register route answered with a failure other than a conflict: its HTTP status. */
export class EveSessionRegisterError extends Error {
  constructor(readonly status: number) {
    super(`eve session register failed (${status})`)
    this.name = 'EveSessionRegisterError'
  }
}

/** How long the one register retry waits (a blip, not an outage). */
export const REGISTER_RETRY_DELAY_MS = 400

/**
 * A register failure worth one retry: the request never got an answer (fetch
 * threw a TypeError) or the server failed (5xx). Never a conflict, a 4xx, or
 * an injected helper's own error.
 */
export function isTransientRegisterError(err: unknown): boolean {
  if (err instanceof EveSessionRegisterError) return err.status >= 500
  return err instanceof TypeError
}

export class EveChatTransport implements ChatTransport<UIMessage> {
  private sessions = new Map<string, ActiveSession>()
  /**
   * Per chat, the exchange a lost register left in an orphaned session (A3):
   * the next message to the conversation's real session carries it once, as a
   * primer, so that session learns what was said.
   */
  private orphanCarry = new Map<string, string>()
  /**
   * eve sessions found dead after an accepted send that never started a turn
   * (sessionHealth): never re-attached again, even though the conversation's
   * row still names one, so the next send makes a fresh session (primed with
   * the conversation) and registers it over the dead one. Also a session
   * whose stream history expired (`history_expired`, reset and re-primed).
   */
  private deadSessions = new Map<string, StallReason | 'history_expired'>()
  /**
   * Sessions a Retry was already refused over (found compacting again): a
   * second Retry over the same one goes ahead with a fresh session, so a
   * compaction that never closes (a retired run) can't refuse it forever.
   */
  private retryRefused = new Set<string>()
  /** Per chat, a prewarm made before its first send (at most one per blank chat). */
  private prewarms = new Map<string, PrewarmEntry>()
  /** Per conversation, when its last presence ping went (see presence). */
  private lastPresence = new Map<string, number>()
  private opts: EveChatTransportOptions
  /** The refresh in flight, shared so concurrent requests refresh once. */
  private refreshInFlight: Promise<string | null> | null = null
  /**
   * The last refresh: the token it replaced → the one it produced. The host's
   * refreshAccessToken must update what getAccessToken reads; if it has not
   * (yet), a getAccessToken that still hands out `from` is answered with `to`.
   */
  private lastRefresh: { from: string; to: string } | null = null

  /** The cards on screen this send, or none: a failing reader never blocks a send. */
  private cardContext(): unknown[] | undefined {
    try {
      const cards = this.opts.getCardContext?.()
      return Array.isArray(cards) && cards.length ? cards : undefined
    } catch {
      return undefined
    }
  }

  constructor(opts: EveChatTransportOptions = {}) {
    this.opts = opts
    // New deploy → reload when idle (lib/deploy-reload.ts): never while a send
    // is on its way or a turn is open (streaming, or parked on a question).
    this.releaseReloadBlocker = registerReloadBlocker(() => this.busy())
  }

  /** Sends between their start and the turn they open. */
  private pendingSends = 0
  private releaseReloadBlocker: () => void

  /** A send is on its way, or a turn is open on any of this transport's chats. */
  private busy(): boolean {
    if (this.pendingSends > 0) return true
    for (const active of this.sessions.values()) {
      if (active.turn && !active.turn.settled) return true
    }
    return false
  }

  /**
   * The area this chat's conversation is focused on (opts.getFocusArea,
   * one-agent S3), read now, or null: none, or a teammate's own thread.
   */
  private focusArea(): string | null {
    if (this.opts.teammateId) return null
    const area = this.opts.getFocusArea?.()
    return typeof area === 'string' && area ? area : null
  }

  /** Who the conversation runs as, as one key (ActiveSession.agentKey): the focus, else null. */
  private agentKeyOf(): string | null {
    const area = this.focusArea()
    return area ? `focus:${area}` : null
  }

  /** The host's workspace (opts.workspaceId), read now, or null for none. */
  private workspaceId(): string | null {
    const w = typeof this.opts.workspaceId === 'function' ? this.opts.workspaceId() : this.opts.workspaceId
    return typeof w === 'string' && w ? w : null
  }

  /** `x-workspace-id` for the host's workspace, or nothing (see opts.workspaceId). */
  /** The usage check (see EveChatTransportOptions.checkUsage). Never throws. */
  private async usageCheck(): Promise<'ok' | 'blocked' | 'unknown'> {
    if (this.opts.checkUsage) return this.opts.checkUsage().catch(() => 'unknown' as const)
    try {
      const accessToken = await this.currentAccessToken()
      const res = await fetch('/api/account/chat/eve-session', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          ...this.workspaceHeaders(),
        },
        body: JSON.stringify({ action: 'usage' }),
      })
      if (res.ok) return 'ok'
      if (res.status === 429) return 'blocked'
      if (res.status === 503) {
        const body = (await res.json().catch(() => ({}))) as { code?: unknown }
        return body.code === 'BILLING_UNAVAILABLE' ? 'blocked' : 'unknown'
      }
      return 'unknown'
    } catch {
      return 'unknown'
    }
  }

  private workspaceHeaders(): Record<string, string> {
    const w = this.workspaceId()
    return w ? { [WORKSPACE_HEADER]: w } : {}
  }

  /**
   * Refresh the Supabase access token via the host hook, deduped: every caller
   * that asks while a refresh is in flight shares it. Null when there is no
   * hook or the refresh produced no token.
   */
  private refreshAccessTokenOnce(): Promise<string | null> {
    const refresh = this.opts.refreshAccessToken
    if (!refresh) return Promise.resolve(null)
    if (!this.refreshInFlight) {
      const from = this.opts.getAccessToken?.() ?? null
      this.refreshInFlight = refresh()
        .then((fresh) => {
          if (fresh && from && fresh !== from) this.lastRefresh = { from, to: fresh }
          return fresh
        })
        .finally(() => {
          this.refreshInFlight = null
        })
    }
    return this.refreshInFlight
  }

  /**
   * The access token to send NOW: the host's live token (never a value cached
   * at client-creation time), refreshed first when it is expired or expires
   * within ACCESS_TOKEN_REFRESH_MARGIN_MS. The chat panel caches the JWT, so a
   * tab idle past the hour would otherwise send a dead one — which the eve
   * channel used to misread as a workspace mismatch (production 2026-09-25).
   * A failed refresh falls back to the current token; the server's 401 path
   * (withSessionAuthRetry / mintWithRefresh) still recovers from there.
   */
  private async currentAccessToken(): Promise<string | null> {
    let token = this.opts.getAccessToken?.() ?? null
    if (token && this.lastRefresh && token === this.lastRefresh.from) token = this.lastRefresh.to
    if (!token || !this.opts.refreshAccessToken || !jwtExpiresSoon(token)) return token
    const fresh = await this.refreshAccessTokenOnce().catch(() => null)
    return fresh ?? token
  }

  /**
   * Run one eve request, recovering ONCE from a refusal on the caller's
   * credentials (isEveSessionAuthError — a 401, or a 403 session_expired /
   * chat_run_token_required / session_forbidden): refresh the access token,
   * re-mint the run token on it (the run token is bound to the user +
   * workspace the server resolves from that JWT), and retry the request. The
   * eve client reads its bearer per request (makeClient's getBearer), so the
   * retry already carries the fresh JWT without rebuilding the client, and
   * `request` must read turnHeaders(active) when CALLED so it carries the fresh
   * run token. A second refusal throws the reload copy — an expiry never
   * surfaces as the channel's "belongs to another user or workspace" wording.
   */
  private async withSessionAuthRetry<T>(
    active: ActiveSession,
    chatId: string,
    request: () => Promise<T>,
  ): Promise<T> {
    try {
      return await request()
    } catch (err) {
      if (!isEveSessionAuthError(err) || !this.opts.refreshAccessToken) throw err
      console.warn('[eve chat] eve refused the request on its credentials; refreshing and retrying once', describeEveError(err))
      const fresh = await this.refreshAccessTokenOnce().catch(() => null)
      if (!fresh) throw new Error(SESSION_EXPIRED_RELOAD_COPY)
      let minted: ChatRunMintResult
      try {
        minted = await this.mint({
          chatId,
          conversationId: active.conversationId,
          agentId: active.agentId,
          skillId: active.skillId,
          about: active.teammateAbout ?? null,
          accessToken: fresh,
        })
      } catch (mintErr) {
        if (is401MintError(mintErr)) throw new Error(SESSION_EXPIRED_RELOAD_COPY)
        throw mintErr
      }
      active.token = minted.token
      // The conversation's row now names another session (another window
      // replaced it, A3): this handle's session is no longer the
      // conversation's, so the retry goes to the one the row holds.
      const current = typeof minted.eveSessionId === 'string' && minted.eveSessionId ? minted.eveSessionId : null
      if (current && active.session && current !== active.eveSessionId) {
        console.warn('[eve chat] the conversation moved to another session; re-attaching to it')
        active.session = active.client.sessions.attach(current)
        active.eveSessionId = current
        active.knownSessionId = current
        active.registered = true
        active.reattached = true
        try {
          this.opts.onSessionMinted?.(chatId, current)
        } catch {
          /* best-effort */
        }
      }
      try {
        return await request()
      } catch (retryErr) {
        if (isEveSessionAuthError(retryErr)) {
          console.warn('[eve chat] eve refused the retried request too', describeEveError(retryErr))
          throw new Error(SESSION_EXPIRED_RELOAD_COPY)
        }
        throw retryErr
      }
    }
  }

  async sendMessages(
    options: Parameters<ChatTransport<UIMessage>['sendMessages']>[0],
  ): Promise<ReadableStream<UIMessageChunk>> {
    this.pendingSends += 1
    try {
      return await this.startSend(options)
    } catch (err) {
      // This bundle's eve client is older than the server's: reload instead of
      // showing an error (lib/deploy-reload.ts). The send itself may well have
      // been accepted; the reload shows the thread as stored.
      if (reloadForStaleStream(err)) return new ReadableStream<UIMessageChunk>({ start: (controller) => controller.close() })
      throw err
    } finally {
      this.pendingSends -= 1
    }
  }

  private async startSend(
    options: Parameters<ChatTransport<UIMessage>['sendMessages']>[0],
  ): Promise<ReadableStream<UIMessageChunk>> {
    // The turn's first TTFT mark: every client phase is measured from here.
    const submittedAt = clientNow()
    const { messages, chatId, abortSignal } = options

    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    const userText = lastUser ? extractText(lastUser) : ''
    // What eve receives: text only, with a line quoting the message the
    // person replied to, one naming the card they replied to, and one for
    // each attached photo, which the model looks at with read_chat_file
    // (never a file part: that makes eve provision a sandbox; see
    // eveUserContent).
    const userMessage = lastUser ? eveUserContent(userText, readChatFiles(options), readReplyNotes(options)) : userText

    // `let` because a mint 401 (SESSION_EXPIRED) refreshes the token below and
    // the fresh value must thread through the rest of this send (ensureSession).
    // currentAccessToken refreshes a token that is already (nearly) expired
    // BEFORE the mint, instead of waiting for the server to 401 it.
    let accessToken = await this.currentAccessToken()
    const agentId = readAgentId(options) ?? undefined
    const skillId = readSkillId(options) ?? undefined
    const teammateAbout = this.opts.teammateId ? readTeammateAbout(options) : null

    // Resolve the durable conversation id for THIS mint. Precedence:
    //   1. The id this chat's eve session already resolved on a PRIOR turn
    //      (existing.conversationId). This is the ONE authoritative owner once the
    //      session exists — the eve_session_id + every user message + the turn-1
    //      assistant projection are keyed to it. Reusing it makes every follow-up
    //      turn mint AGAINST it instead of minting a fresh row (the bug: the
    //      per-send body never carries conversationId — so turns 2+ minted null → a new empty row each, and their assistant
    //      persists landed on those orphans instead of the session's own row).
    //   2. Else the per-send body's conversationId (a loaded historical eve chat).
    //   3. Else the panel's tracked id via getConversationId (belt-and-suspenders
    //      for a first turn whose body omitted it) — null on a truly fresh chat, in
    //      which case the mint route creates the row and hands it back.
    // A chat's FIRST send may find a prewarmed session (see prewarm): claiming it
    // makes it this chat's handle, whose conversation is the row the prewarm's
    // mint created. A prewarm still in flight is waited for, briefly.
    // A focused conversation (one-agent S3): its focus is fixed, so a handle
    // made for another focus (or none) is dropped, never sent on.
    const agentKey = this.agentKeyOf()
    const held = this.sessions.get(chatId)
    if (held && (held.agentKey ?? null) !== agentKey) this.drop(chatId)
    // The flush of a held message the transport already POSTed as a steer
    // (UI-2, `body.steerId`): no mint and no POST — this turn adopts the
    // steer's own response, so useChat never runs two requests at once.
    const steerId = readSteerId(options)
    const adoptable = steerId ? this.adoptableSteer(chatId, steerId) : null
    if (adoptable) return this.adoptSteer(options, adoptable.active, adoptable.steer, submittedAt, userMessage, lastUser)
    // A first send while the panel is still creating this chat's conversation
    // (a page opened from `/` on a new chat) waits for that row and mints
    // against it, rather than claiming a prewarm made for another row.
    const creating = this.sessions.get(chatId) ? null : await this.pendingConversation()
    const existing = this.sessions.get(chatId) ?? (await this.claimPrewarm(chatId, options, agentKey, creating))
    const conversationId =
      existing?.conversationId ??
      readConversationId(options) ??
      creating ??
      this.opts.getConversationId?.() ??
      null

    // 1 — ensure conversation + mint the run token (durable facts only). If the
    //     mint 401s because the cached access token expired (a machine/tab that
    //     slept past the JWT's expiry — the FIRST send after wake), refresh the
    //     token and retry the mint ONCE. mintWithRefresh returns the token the
    //     successful mint used (fresh after a retry) so the rest of this send
    //     (ensureSession → the eve client, register, persist) runs on it too.
    // No live handle for this chat (first send after a reload, a Stop, loading a
    // chat, a restored tab): ask the mint for the conversation's registered eve
    // session (re-attach) and its history primer (a session that must be new).
    // A prewarmed handle's own token is minted for this chat's conversation: the
    // send runs on it, skipping the mint, only when it was minted for the same
    // persona and skill, at most PREWARM_REUSE_MAX_AGE_MS ago, and on the very
    // access token this send holds. Supabase rotates the JWT on every refresh,
    // so an equal token means the credential sealed into the run token is still
    // the live one. Otherwise the send mints as usual (a fresh usage check, the
    // current JWT) and still sends over the prewarmed session.
    const warm = existing?.prewarm
    const prewarmedToken =
      existing &&
      warm &&
      warm.agentId === agentId &&
      warm.skillId === skillId &&
      (warm.agentKey ?? null) === agentKey &&
      !teammateAbout &&
      Date.now() - warm.mintedAt <= PREWARM_REUSE_MAX_AGE_MS &&
      accessToken !== null &&
      accessToken === warm.accessToken
        ? existing.token
        : null
    let mint: ChatRunMintResult
    let mintedAt: number | undefined
    if (existing && prewarmedToken) {
      mint = { token: prewarmedToken, conversationId: existing.conversationId }
    } else {
      const minted = await this.mintWithRefresh(
        {
          chatId,
          conversationId,
          agentId,
          skillId,
          ...(teammateAbout ? { about: teammateAbout } : {}),
          ...(existing ? {} : { wantHistory: true }),
        },
        accessToken,
      )
      mintedAt = clientNow()
      mint = minted.mint
      accessToken = minted.accessToken
    }

    // 2 — base64url-encode the PER-TURN context (systemContext, and the
    //     message's routing signals: the server picks the tier from them,
    //     src/lib/ai/model-route.ts) — NOT in the token. A bad/absent ctx
    //     degrades to an empty turn context on the spec route, never a 500.
    // Every chat says what zone the person is in: the chat's clock reads in
    // it (and a calendar card's days). A chat that draws cards (the main
    // chat) also sends the person's local conditions (lib/sky/surroundings.ts).
    const mainChat = !!this.opts.getCardContext
    const ctx = encodeTurnContext(
      options,
      this.cardContext(),
      browserTimeZone(),
      mainChat ? currentSurroundings() : null,
      turnRouteSignals(userText, readChatFiles(options)),
    )

    // 3 — get-or-create the durable eve session (continues across turns). Refresh
    //     the cached session's token + ctx so THIS turn sends the fresh short-lived
    //     token (the seed baked into the client at create-time expires) and the
    //     current per-turn context — both ride as per-request headers on send().
    const active = this.ensureSession(chatId, mint.token, ctx, accessToken, mint.conversationId, mint)
    // A turn still streaming (not settled, not parked on a HITL request) when
    // this send arrives is being STEERED by it: mark it so it hands the rest of
    // the eve turn over at the steer point (see runTurn).
    const prior = active.turn
    const steered =
      prior && !prior.settled && prior.openInputRequests.size === 0 ? prior : null
    if (steered) steered.superseded = true
    // A held steer this send overtakes was never POSTed: it is not this send's.
    if (active.pendingSteer?.phase === 'held') this.withdrawPending(active, 'overtaken')
    active.token = mint.token
    active.ctx = ctx
    active.conversationId = mint.conversationId
    active.agentId = agentId
    active.skillId = skillId
    active.teammateAbout = teammateAbout
    active.agentKey = agentKey

    // Surface the mint's durable conversation id to the panel the FIRST time it's
    // known. On a fresh chat the mint CREATED the row, so this is the only place
    // the client learns the id — feeding it into the auto-save keeps the user
    // message + assistant projection on the SAME row (the conversation-split fix).
    if (!active.conversationAnnounced) {
      active.conversationAnnounced = true
      try {
        this.opts.onConversationEnsured?.(chatId, mint.conversationId)
      } catch {
        /* surfacing the id is best-effort; never fail the turn for it */
      }
    }

    // This send is the first on a prewarmed session: the prewarm created it for
    // this chat, so its first turn is a new session's too (session setup runs
    // now). A send steering that first turn is not.
    const prewarmed = active.prewarm !== undefined && prior === null

    // Build the per-turn state + its OWN stream closures. Assigning it to
    // active.turn makes it "current"; onEvent only acts on it while it IS current.
    const turn = newTurnState(chatId, lastUser, {
      // No `minted` mark when the send ran on its prewarm's token.
      client: { submit: submittedAt, minted: mintedAt },
      server: {},
      newSession: prewarmed,
      prewarmed,
    })
    active.turn = turn
    const stream = this.openTurnStream(active, chatId, turn, abortSignal)
    // The person's message is saved now, not when the reply ends: a page that
    // dies mid-turn still leaves it in the thread (the chat-agent's reply
    // backup writes the reply). A message steering a running reply waits for
    // that reply's part to be written first (persistFinishedTurn carries it).
    if (!steered) this.persistUserMessageNow(active, turn)

    // Kick off the turn (create or continue) and pump events into the stream.
    // Errors here settle the turn as a failure rather than rejecting the promise
    // (the stream is already returned).
    void this.runTurn(active, chatId, userMessage, mint, turn, abortSignal, steered).catch((err) => {
      turn.fail(err instanceof Error ? err : new Error(String(err)))
    })

    return stream
  }

  /**
   * The turn's ReadableStream and its OWN emit/close/fail closures, so a stale
   * event from a prior turn can never touch a later turn's stream.
   */
  private openTurnStream(
    active: ActiveSession,
    chatId: string,
    turn: TurnState,
    abortSignal: AbortSignal | undefined,
  ): ReadableStream<UIMessageChunk> {
    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        const detach = () => {
          if (active.turn === turn) active.turn = null
        }
        turn.emit = (chunk) => {
          if (turn.settled) return
          try {
            // The reply's time, as it is born (message-time.ts): its day line and hover time.
            controller.enqueue(chunk.type === 'start' ? { ...chunk, messageMetadata: stampCreatedAt(chunk.messageMetadata) } : chunk)
          } catch {
            /* stream already closed */
          }
        }
        turn.close = () => {
          if (turn.settled) return
          turn.settled = true
          try {
            controller.close()
          } catch {
            /* already closed */
          }
          // Release any answerPermission blocked on the drain gate so it observes
          // the settled turn and bails instead of hanging forever — and any
          // steering send waiting on this turn's identity.
          turn.resolveDrained()
          turn.resolveIdentified()
          detach()
        }
        turn.fail = (err) => {
          if (turn.settled) return
          // A stale bundle (eve client older than the server's stream): the page
          // reloads instead of showing the error (lib/deploy-reload.ts).
          if (reloadForStaleStream(err)) return
          turn.settled = true
          try {
            controller.error(err)
          } catch {
            /* already closed */
          }
          turn.resolveDrained()
          turn.resolveIdentified()
          detach()
        }

        // Abort (Stop) → cancel the durable eve turn on the server, then settle
        // this turn (never a later turn's) and drop the session so the next send
        // starts clean. The server cancel matters since eve 0.57: a later send's
        // `steer` no longer cancels a running turn, so without it the stopped
        // answer would keep generating unobserved — and its step.completed usage
        // would reach no persist body (unlogged spend).
        //
        // The cancel is ALWAYS scoped to a turn id, never "whatever is running":
        // with a steer in flight the running turn can be the PREVIOUS reply. If
        // this turn already knows its eve turn id it is cancelled now; otherwise
        // the send's response keeps draining until it names its turn (runTurn /
        // answerPermission → drainStopped). The abort signal is deliberately NOT
        // wired into the eve POSTs, so a send eve accepted always yields a
        // response to identify it by.
        //
        // Send now while a steer is on its way (UI-2: posting or posted): the
        // cancel stops only this turn, and the session is NOT dropped — its
        // handle carries the steer's unread response for the flush to adopt.
        // eve keeps an accepted message across a turn cancel: a cancel aborts
        // the ActiveTurn (execution/session/turn.js finishCancelledTurn) and
        // applySessionCancellation (execution/session/admission.js) only touches
        // tasks, so the delivery stays in the input queue and runs as the next
        // turn. (If eve had already folded it into this very turn, the adopted
        // turn re-sends it once: TurnState.resendOnCancel.)
        const onAbort = () => {
          if (turn.settled) return
          turn.stopRequested = true
          if (turn.eveTurnId) this.cancelServerTurn(active, turn)
          turn.emit({ type: 'abort' })
          turn.close()
          const steer = steerInFlightFor(active, turn)
          if (steer) steer.priorStopped = true
          else this.drop(chatId)
          this.persistStoppedUserMessage(active, turn)
        }
        // A Stop that landed before this stream existed (during the mint or the
        // wait for a prewarm) never fires a listener added now, and would leave
        // this turn open for the next send to wait on as a steer. Settle it at
        // once: runTurn POSTs nothing for an aborted send, so nothing is cancelled.
        if (abortSignal?.aborted) onAbort()
        else abortSignal?.addEventListener('abort', onAbort, { once: true })
      },
      cancel: () => {
        turn.close()
        if (!steerInFlightFor(active, turn)) this.drop(chatId)
      },
    })
  }

  /**
   * Mint, transparently recovering from an EXPIRED-token 401. The chat panel
   * caches the Supabase access token (the sync getAccessToken getter reads that
   * cache), so a machine/tab that slept past the JWT's expiry hands the mint a
   * STALE Bearer on its first wake send — the server now answers 401
   * SESSION_EXPIRED (see api-auth.ts) instead of a 500. When that happens AND a
   * refreshAccessToken hook is provided, refresh the token and retry the mint
   * ONCE with the fresh Bearer. Returns the mint result plus the token it
   * succeeded on, so the caller threads the fresh token through the rest of the
   * send (the eve client + register + persist).
   *
   * ONLY a 401 (SESSION_EXPIRED, or a bare 401) retries. 429/503 keep their
   * documented no-fallback semantics — they rethrow untouched. A second 401
   * after the refresh throws a plain session-expired instruction (reload). With
   * no refreshAccessToken hook, the original error propagates unchanged.
   */
  private async mintWithRefresh(
    args: {
      chatId: string
      conversationId: string | null
      agentId?: string
      skillId?: string
      wantHistory?: boolean
      about?: TeammateAboutRef | null
    },
    accessToken: string | null,
  ): Promise<{ mint: ChatRunMintResult; accessToken: string | null }> {
    try {
      const mint = await this.mint({ ...args, accessToken })
      return { mint, accessToken }
    } catch (err) {
      // Detect the 401 duck-typed on the thrown error's `status` (the default
      // fetch path throws a MintError carrying it; an injected mintRunToken may
      // throw any error shape) so the retry path works for both.
      if (!is401MintError(err) || !this.opts.refreshAccessToken) throw err

      // Refresh the cached access token (the hook also updates the ref the sync
      // getAccessToken reads, so later sends use the fresh token too), then retry.
      const fresh = await this.refreshAccessTokenOnce()
      if (!fresh) {
        throw new Error(SESSION_EXPIRED_RELOAD_COPY)
      }
      try {
        const mint = await this.mint({ ...args, accessToken: fresh })
        return { mint, accessToken: fresh }
      } catch (retryErr) {
        // A second 401 means the refreshed token is ALSO rejected — the session
        // is genuinely gone. Surface the reload copy (or the body error, if the
        // retry failed for a different reason like 429/503).
        if (is401MintError(retryErr)) {
          throw new Error(SESSION_EXPIRED_RELOAD_COPY)
        }
        throw retryErr
      }
    }
  }

  /**
   * Mint the run token (+ ensure conversation) via the injected helper or the
   * default route.
   *
   * ── Mint failure semantics (surface, never re-route) ──────────────────────
   * A failed mint THROWS out of sendMessages → useChat's onError → the error
   * toast. eve is the only cloud chat runtime, so there is nothing to fall back
   * to:
   *   - 429 (usage limit): MUST surface. The message
   *     composed below (error + reason + reset date) IS the toast the user sees;
   *     this mint gate is the PRIMARY usage block for the eve path (the
   *     chat-agent's usage-limit-gate hook only covers the mint→turn race: it
   *     cancels that turn, and this transport then asks the usage check for
   *     the dialog's copy).
   *   - 503 CHAT_RUNTIME_UNCONFIGURED (internal secret unset) vs 503
   *     BILLING_UNAVAILABLE (billing check down, fail-closed): distinguishable
   *     by body.code — both surface their body.error verbatim.
   */
  private async mint(args: {
    chatId: string
    conversationId: string | null
    agentId?: string
    skillId?: string
    accessToken: string | null
    wantHistory?: boolean
    about?: TeammateAboutRef | null
  }): Promise<ChatRunMintResult> {
    const rest = args
    // A focus only for the main agent's own conversation: never in a thread.
    const focusArea = this.focusArea()
    if (this.opts.mintRunToken) {
      return this.opts.mintRunToken({ ...rest, ...(focusArea ? { focusArea } : {}) })
    }
    const about = this.opts.teammateId ? (args.about ?? null) : null
    const res = await fetch('/api/account/chat/eve-session', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(args.accessToken ? { Authorization: `Bearer ${args.accessToken}` } : {}),
        ...this.workspaceHeaders(),
      },
      body: JSON.stringify({
        action: 'mint',
        conversationId: rest.conversationId,
        agentId: rest.agentId,
        skillId: rest.skillId,
        ...(this.opts.teammateId ? { teammateId: this.opts.teammateId } : {}),
        ...(focusArea ? { focusArea } : {}),
        ...(about ? { about } : {}),
        ...(args.wantHistory ? { wantHistory: true } : {}),
      }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
      // 429 = usage limit: compose the full user-facing copy from the structured
      // body instead of the bare body.error, so the toast tells the user WHY and
      // WHEN it resets.
      if (res.status === 429) {
        throw new MintError(usageLimitMintMessage(body), 429, 'RATE_LIMITED')
      }
      // Every failure carries its status + code so sendMessages can single out a
      // 401 SESSION_EXPIRED (refresh + retry once) from the 429/503 cases that
      // MUST surface verbatim with no fallback (documented above).
      throw new MintError(
        typeof body?.error === 'string' ? body.error : `chat-run mint failed (${res.status})`,
        res.status,
        typeof body?.code === 'string' ? body.code : undefined,
      )
    }
    return (await res.json()) as ChatRunMintResult
  }

  /**
   * Register eve_session_id via the injected helper or the default route.
   * Throws when the route refuses: an unregistered session fails the ownership
   * ACL on every later request, so the caller must know (runTurn re-allows a
   * registration on the next send; a prewarm gives up).
   */
  private async register(args: {
    conversationId: string
    sessionId: string
    accessToken: string | null
    previousSessionId: string | null
  }): Promise<void> {
    if (this.opts.registerEveSession) return this.opts.registerEveSession(args)
    const res = await fetch('/api/account/chat/eve-session', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(args.accessToken ? { Authorization: `Bearer ${args.accessToken}` } : {}),
        ...this.workspaceHeaders(),
      },
      body: JSON.stringify({
        action: 'register',
        conversationId: args.conversationId,
        sessionId: args.sessionId,
        previousSessionId: args.previousSessionId,
      }),
    })
    if (res.status === 409) {
      const body = (await res.json().catch(() => null)) as { code?: unknown; details?: { eveSessionId?: unknown } } | null
      if (body?.code === 'SESSION_CONFLICT') {
        const current = body.details?.eveSessionId
        throw new EveSessionConflictError(typeof current === 'string' && current ? current : null)
      }
    }
    if (!res.ok) throw new EveSessionRegisterError(res.status)
  }

  /** Get-or-create the durable eve session handle for a chat. */
  private ensureSession(
    chatId: string,
    token: string,
    ctx: string,
    accessToken: string | null,
    conversationId: string,
    mint?: ChatRunMintResult,
  ): ActiveSession {
    const existing = this.sessions.get(chatId)
    if (existing) return existing

    const active = this.buildActiveSession(token, ctx, accessToken, conversationId, mint)
    this.sessions.set(chatId, active)
    if (active.eveSessionId) {
      try {
        this.opts.onSessionMinted?.(chatId, active.eveSessionId)
      } catch {
        /* best-effort */
      }
    }
    return active
  }

  /**
   * A new session handle for a chat (not installed in `sessions`): its eve
   * client, re-attached to the mint's registered session when there is one.
   */
  private buildActiveSession(
    token: string,
    ctx: string,
    accessToken: string | null,
    conversationId: string,
    mint?: ChatRunMintResult,
  ): ActiveSession {
    const host = this.opts.host ?? `${CHAT_AGENT_MOUNT}`
    const client = this.makeClient({
      host,
      accessToken,
      getBearer: () => this.currentAccessToken(),
      token,
      ctx,
      workspaceId: this.workspaceId(),
    })
    // The conversation already has a registered eve session: RE-ATTACH to it (no
    // I/O), so this chat continues the durable session and its history instead
    // of starting an empty one. It is already registered (that is where the id
    // came from). Otherwise there is no handle yet: `client.sessions.create()`
    // performs the first turn's POST, so the first `runTurn` dispatch mints it.
    const rowSessionId = typeof mint?.eveSessionId === 'string' && mint.eveSessionId ? mint.eveSessionId : null
    // A session this transport found dead is never re-attached: the first send
    // makes a new one, which registers over it (knownSessionId).
    const registeredId = rowSessionId && !this.deadSessions.has(rowSessionId) ? rowSessionId : null
    const active: ActiveSession = {
      client,
      session: registeredId ? client.sessions.attach(registeredId) : null,
      eveSessionId: registeredId,
      registered: registeredId !== null,
      knownSessionId: rowSessionId,
      reattached: registeredId !== null,
      historyPrimer: mint?.historyPrimer ?? null,
      turn: null,
      token,
      ctx,
      conversationId,
      conversationAnnounced: false,
    }
    return active
  }

  /**
   * Prewarm a BLANK chat's eve session while the user types its first message,
   * so that at Enter only the send POST and the stream GET remain. Mints (which
   * creates the conversation row), creates the session WITHOUT a message, and
   * registers it on the row. eve parks a message-free session before session
   * hooks, dynamic definitions or sandbox setup run: the first send's own
   * request (its fresh run token + per-turn ctx, stamped by the chat-agent
   * channel) supplies the identity and context for session setup and turn_0.
   *
   * Invisible until a send claims it: nothing is installed in `sessions`, and
   * the conversation id is announced (onConversationEnsured) by the send, not
   * here, so the tab stays a blank chat (blank-tab reuse depends on it).
   *
   * Best-effort: a failure is logged and the first send takes the ordinary
   * path. At most one prewarm per blank chat, and none once the chat has a
   * session or a bound conversation. Resolves when the prewarm settles; never
   * rejects. An abandoned prewarm leaves an empty "New conversation" row
   * (hidden from the history list) and a parked eve session that expires.
   */
  async prewarm(chatId: string, opts: { agentId?: string; skillId?: string } = {}): Promise<void> {
    if (this.sessions.has(chatId) || this.prewarms.has(chatId)) return
    if (this.opts.getConversationId?.()) return
    const entry: PrewarmEntry = { ready: Promise.resolve(null), abandoned: false }
    this.prewarms.set(chatId, entry)
    entry.ready = this.runPrewarm(entry, chatId, opts).catch((err: unknown) => {
      console.warn('[eve chat] prewarm failed; the first send takes the ordinary path', {
        ...describeEveError(err),
        error: err instanceof Error ? err.message : String(err),
      })
      return null
    })
    await entry.ready
  }

  /**
   * The person is typing in an existing conversation: tell the server, so its
   * idle-compaction timer (src/lib/chat/idle-compaction-signal.ts) does not
   * summarize a conversation someone is in. A send's mint does the same, but
   * only at Enter. Throttled to one ping per conversation per
   * PRESENCE_PING_INTERVAL_MS, so keystrokes cost nothing in between.
   * Fire-and-forget: never awaited, never throws, and a failure is not retried.
   */
  presence(conversationId: string | null | undefined, now: number = Date.now()): void {
    if (!conversationId || this.opts.mintRunToken) return
    const last = this.lastPresence.get(conversationId)
    if (last !== undefined && now - last < PRESENCE_PING_INTERVAL_MS) return
    this.lastPresence.set(conversationId, now)
    const accessToken = this.opts.getAccessToken?.() ?? null
    try {
      void fetch('/api/account/chat/eve-session', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          ...this.workspaceHeaders(),
        },
        body: JSON.stringify({ action: 'presence', conversationId }),
      }).catch(() => {})
    } catch {
      /* best-effort */
    }
  }

  private async runPrewarm(
    entry: PrewarmEntry,
    chatId: string,
    opts: { agentId?: string; skillId?: string },
  ): Promise<ActiveSession | null> {
    const { agentId, skillId } = opts
    // The focus read once, before the mint: the session and its row are that focus's.
    const agentKey = this.agentKeyOf()
    const minted = await this.mintWithRefresh(
      { chatId, conversationId: null, agentId, skillId },
      await this.currentAccessToken(),
    )
    if (entry.abandoned) return null
    const { mint, accessToken } = minted
    const mintedAt = Date.now()
    const active = this.buildActiveSession(mint.token, '', accessToken, mint.conversationId)
    active.agentKey = agentKey
    // No `message` key: eve's client takes the message path for any object that
    // has one, even `{ message: undefined }`, and that path refuses to start.
    const { session } = await active.client.sessions.create({ headers: this.turnHeaders(active) })
    if (entry.abandoned) return null
    active.session = session
    active.eveSessionId = session.state.sessionId
    // Registered before any send can target it (the ownership ACL fails closed).
    await this.register({ conversationId: mint.conversationId, sessionId: active.eveSessionId, accessToken, previousSessionId: active.knownSessionId ?? null })
    active.registered = true
    active.prewarm = { agentId, skillId, agentKey, mintedAt, accessToken }
    return entry.abandoned ? null : active
  }

  /**
   * The first send's claim on its chat's prewarm: the prewarmed handle,
   * installed as the chat's session, or undefined when there is none to use
   * (never made, failed, abandoned, or not ready within PREWARM_WAIT_MS). The
   * prewarm serves only the blank chat it was made for: once the chat is bound
   * to a conversation (a loaded chat, the onboarding home), it is abandoned.
   */
  /** The conversation the panel is creating for this chat, waited for (bounded); null when there is none. */
  private async pendingConversation(): Promise<string | null> {
    let pending: Promise<string | null> | null = null
    try {
      pending = this.opts.getPendingConversation?.() ?? null
    } catch {
      return null
    }
    return pending ? settleWithin(pending, PENDING_CONVERSATION_WAIT_MS) : null
  }

  private async claimPrewarm(
    chatId: string,
    options: { body?: unknown },
    /** Who this send's conversation runs as (conversationAgentKey: a bot, a focus, or none), as the send read it. */
    agentKey: string | null,
    /** A conversation the panel just created for this chat: a prewarm made for another row never serves it. */
    knownConversationId: string | null = null,
  ): Promise<ActiveSession | undefined> {
    const entry = this.prewarms.get(chatId)
    if (!entry) return undefined
    if (knownConversationId ?? readConversationId(options) ?? this.opts.getConversationId?.()) {
      this.abandonPrewarm(chatId)
      return undefined
    }
    const ready = await settleWithin(entry.ready, PREWARM_WAIT_MS)
    if (this.prewarms.get(chatId) === entry) this.prewarms.delete(chatId)
    // A concurrent send already installed a session for this chat: use it.
    const live = this.sessions.get(chatId)
    if (live) {
      if (live !== ready) entry.abandoned = true
      return live
    }
    if (!ready || entry.abandoned) {
      entry.abandoned = true
      return undefined
    }
    // Made for another bot, or for none (the blank chat's agent changed while
    // its first message was typed): its conversation row is that bot's, so it
    // never serves this send (bots v4 Phase C). A focus likewise (one-agent S3).
    if ((ready.agentKey ?? null) !== agentKey) {
      entry.abandoned = true
      return undefined
    }
    this.sessions.set(chatId, ready)
    if (ready.eveSessionId) {
      try {
        this.opts.onSessionMinted?.(chatId, ready.eveSessionId)
      } catch {
        /* best-effort */
      }
    }
    return ready
  }

  /** Abandon a chat's prewarm, if any: it stops at its next step and is never used. */
  private abandonPrewarm(chatId: string): void {
    const entry = this.prewarms.get(chatId)
    if (!entry) return
    entry.abandoned = true
    this.prewarms.delete(chatId)
  }

  /**
   * Re-mint the session's run token when it expires within
   * RUN_TOKEN_REFRESH_MARGIN_MS. Every send already mints a fresh token; this
   * covers the one turn-starting request that does not go through sendMessages
   * — a HITL respond, whose picker may have been open longer than the token's
   * 60-minute TTL. The chat-agent channel refuses a turn-starting request whose
   * token is expired (403), so without this the answer would fail. Throws the
   * mint's error (e.g. a usage-limit 429) for answerPermission's catch.
   */
  private async refreshStaleRunToken(active: ActiveSession, chatId: string): Promise<void> {
    const exp = runTokenExpiresAt(active.token)
    if (exp !== null && exp - Date.now() > RUN_TOKEN_REFRESH_MARGIN_MS) return
    const minted = await this.mintWithRefresh(
      {
        chatId,
        conversationId: active.conversationId,
        agentId: active.agentId,
        skillId: active.skillId,
        about: active.teammateAbout ?? null,
      },
      await this.currentAccessToken(),
    )
    active.token = minted.mint.token
  }

  /**
   * Per-request headers for a `send()` on an existing session: the freshest token
   * + ctx. The client's constructor headers are only the seed (created once); these
   * override per turn so a long-open chat never sends an expired token and each turn
   * carries its own context. A request that starts or continues a reply (a send,
   * a steer, a HITL answer) also names it (`replyId`, CHAT_REPLY_ID_HEADER).
   */
  private turnHeaders(active: ActiveSession, replyId?: string): Record<string, string> {
    return {
      [CHAT_RUN_TOKEN_HEADER]: active.token,
      ...(active.ctx ? { [CHAT_RUN_CTX_HEADER]: active.ctx } : {}),
      ...(replyId ? { [CHAT_REPLY_ID_HEADER]: replyId } : {}),
      ...this.workspaceHeaders(),
    }
  }

  /**
   * Build the eve Client. The token + per-turn ctx ride as headers so the
   * chat-agent channel stamps them onto the principal; the user's Supabase bearer
   * authenticates the Supabase session (+ ownership ACL). redirect:'error' stops
   * the credentialed headers following a cross-origin redirect. Overridable for
   * tests via opts.createClient.
   *
   * The bearer is a RESOLVER, not a value: eve 0.66.3's client resolves
   * `auth.bearer` before every HTTP call (docs: ClientOptions.auth — "token-
   * refresh callbacks are called on every HTTP call"), including stream
   * re-attaches and cancels. The client is cached for the life of the chat, so
   * a value baked in here went stale after the JWT's hour and every later
   * request carried it. An empty resolution sends no Authorization header (the
   * cookie session then authenticates), same as the old no-token case.
   */
  private makeClient(args: {
    host: string
    accessToken: string | null
    getBearer: () => Promise<string | null>
    token: string
    ctx: string
    workspaceId?: string | null
  }): Client {
    if (this.opts.createClient) return this.opts.createClient(args)
    return new EveClient({
      host: args.host,
      auth: { bearer: async () => (await args.getBearer()) ?? '' },
      // The workspace header seeds every request this client makes — stream
      // re-attaches and cancels included, which the ownership ACL scopes by
      // the resolved workspace (opts.workspaceId).
      headers: {
        [CHAT_RUN_TOKEN_HEADER]: args.token,
        ...(args.ctx ? { [CHAT_RUN_CTX_HEADER]: args.ctx } : {}),
        ...(args.workspaceId ? { [WORKSPACE_HEADER]: args.workspaceId } : {}),
      },
      redirect: 'error',
    })
  }

  /**
   * Drive one turn: send (create or continue), register the session id the
   * instant it lands, and pump the NDJSON events into the turn's stream.
   */
  private async runTurn(
    active: ActiveSession,
    chatId: string,
    userMessage: string | UserContent,
    mint: ChatRunMintResult,
    turn: TurnState,
    abortSignal: AbortSignal | undefined,
    steered: TurnState | null = null,
    /**
     * The steer this turn adopts (UI-2): its response is read instead of a new
     * POST — eve already has the message, or is getting it (a POST still in
     * flight is waited for here, bounded). Read even after a Stop, so the turn
     * it started can be learned and cancelled (drainStopped).
     */
    adopted: PendingSteer | null = null,
  ): Promise<void> {
    if (!adopted && (turn.settled || abortSignal?.aborted)) {
      releaseSteer(steered)
      return
    }

    // `turnPolicy` is stated EXPLICITLY rather than inherited ('steer' is also
    // eve's default): a user who types while a turn is still streaming means "do
    // this instead".
    //
    // WHAT STEER MEANS SINCE eve 0.57 (docs: concepts/execution-model-and-
    // durability "Message delivery and steering"; concepts/sessions-runs-and-
    // streaming "Send a follow-up message"). It is NOT cancel-and-replace any
    // more — there is no turn.cancelled and no new turn id:
    //   - Before assistant output begins, eve stops pending model generation and
    //     continues the SAME turn (same turnId) with the correction.
    //   - An executing tool finishes and commits its result first.
    //   - After assistant output starts, the correction applies at the next
    //     committed workflow boundary; already-streamed text stays.
    //   - A message that reaches the boundary after the turn settled starts the
    //     NEXT turn instead.
    // Every event of a turn carries `meta.deliveryIds` = the accepted messages
    // that own it; a steer APPENDS its delivery id to the running turn's set.
    // eve's client scopes each send's response to its own delivery: it skips
    // events until the first one carrying that id, then reads to the boundary.
    //
    // So both the steered turn's response AND this steering send's response
    // would read the tail of the same eve turn. Left alone that renders the tail
    // twice (two bubbles), persists it twice, and double-counts its usage — the
    // pre-0.57 code relied on turn.cancelled to end the old stream, which never
    // comes now. The partition, exact and in eve's own terms:
    //   1. `sendMessages` marks the live prior turn `superseded`.
    //   2. Before POSTing, wait until the prior turn has learned its own
    //      deliveryIds (its first stamped event) — so eve cannot fold this
    //      message into the prior turn's START, where the two responses would
    //      be indistinguishable.
    //   3. The prior turn settles (finish + persist) at the first event carrying
    //      a delivery id it does not own — the exact event this send's response
    //      starts at. Everything before goes to the prior turn, everything from
    //      there to this one; each step.completed is counted once.
    //   4. If the prior turn instead settled before eve applied the steer, it
    //      ends normally and this response reads the NEXT turn (its events carry
    //      only this delivery id).
    // (HITL responses are unaffected — pure inputResponses deliveries never
    // steer. A turn PARKED on an open request is not superseded: eve runs the
    // new text as its own turn while the approval stays pending.)
    if (steered) await waitForTurnIdentity(steered, abortSignal)
    // Stopped before the POST: this message never reached eve, so nothing will
    // ever carry a steer id into the prior turn — hand it back its normal
    // ownership rules (a foreign id is then ADOPTED, not a steer point).
    if (!adopted && (turn.settled || abortSignal?.aborted)) {
      releaseSteer(steered)
      return
    }

    // No `signal`: Stop must not abort the POST or the response stream. An
    // aborted POST that eve had already accepted would leave a running turn with
    // no handle to cancel it by; Stop instead drains the response to learn the
    // turn id (drainStopped). Stop BEFORE this point never POSTs (checked above).
    // Built per dispatch (not once) so a credentials retry sends the re-minted
    // run token.
    const sendOptions = () => ({
      headers: this.turnHeaders(active, turn.messageId),
      turnPolicy: 'steer' as const,
    })

    // First turn of a chat: `sessions.create()` mints the fixed session id AND
    // performs this turn's POST in one call. Every later turn reuses that handle
    // via the positional `send(message, options)`.
    // A NEW session's first message carries the conversation so far (the mint's
    // primer), once: it then lives in the session's durable history.
    // The primer is spent only once the create SUCCEEDS, so a create refused on
    // its credentials (and retried) still carries it.
    // An exchange an orphaned session took (A3, settleOrphan) rides the first
    // message this chat sends to the conversation's real session, once. A new
    // session's own primer covers it (its rows are written by then).
    const carry = this.orphanCarry.get(chatId) ?? null
    const createSession = async (): Promise<MessageResponse> => {
      const primer = active.historyPrimer ?? carry
      const created = await active.client.sessions.create({
        message: primer ? withHistoryPrimer(primer, userMessage) : userMessage,
        ...sendOptions(),
      })
      active.historyPrimer = null
      if (carry) this.orphanCarry.delete(chatId)
      active.session = created.session
      turn.timings.newSession = true
      return created.response
    }
    const dispatch = async (): Promise<MessageResponse> => {
      if (!active.session) return createSession()
      try {
        const sent = await active.session.send(carry ? withHistoryPrimer(carry, userMessage) : userMessage, sendOptions())
        if (carry) this.orphanCarry.delete(chatId)
        active.reattached = false
        active.prewarm = undefined
        return sent
      } catch (err) {
        // Only a RE-ATTACHED or PREWARMED handle's first send falls back: the
        // session could not take the turn (failed, retired, expired while
        // parked), so start a fresh session primed with the history; runTurn
        // registers it below. A refusal on the caller's CREDENTIALS is not
        // that — the session is fine, the JWT is stale — so it goes to
        // withSessionAuthRetry instead of forking a new session.
        if ((!active.reattached && !active.prewarm) || isEveSessionAuthError(err)) throw err
        console.warn('[eve-chat] registered session refused the turn; starting a new one', err)
        active.reattached = false
        active.prewarm = undefined
        turn.timings.prewarmed = false
        active.session = null
        active.eveSessionId = null
        active.registered = false
        return createSession()
      }
    }
    let response: MessageResponse
    if (adopted) {
      const post = await this.awaitSteerPost(adopted)
      if (post === 'posted') {
        response = adopted.response!
      } else if (post === 'refused') {
        // eve refused the steer's POST, so it never had the words: they go
        // now as an ordinary turn — unless Stop came first.
        if (turn.stopRequested || abortSignal?.aborted) return
        turn.adoptedSteer = null
        response = await this.withSessionAuthRetry(active, chatId, dispatch)
      } else {
        // Unconfirmed (no answer in time, or a failure that may have reached
        // eve): never sent twice. The user message stays; the turn errors.
        if (turn.stopRequested || abortSignal?.aborted) return
        throw new Error(STEER_UNCONFIRMED_COPY)
      }
    } else {
      try {
        await this.refuseRetryOverLiveSession(active)
        response = await this.withSessionAuthRetry(active, chatId, dispatch)
      } catch (err) {
        // The POST failed, so eve accepted no steer: same release as a pre-POST Stop.
        releaseSteer(steered)
        throw err
      }
    }
    turn.timings.client.created = clientNow()

    // eve's session id is available synchronously once the POST resolves. On a
    // FRESH session, register it on the conversation BEFORE any continue/stream
    // could target it (the ownership ACL fails closed on an unregistered id).
    const registerSessionOf = async (sent: MessageResponse): Promise<void> => {
      const sessionId = sent.sessionId || active.eveSessionId
      if (sessionId && !active.eveSessionId) {
        active.eveSessionId = sessionId
        this.opts.onSessionMinted?.(chatId, sessionId)
      }
      if (sessionId && !active.registered) {
        active.registered = true
        const accessToken = await this.currentAccessToken()
        // Await BEFORE reading any event, so a follow-up turn's continue can't beat
        // the registration write. This is also what keeps a Stop's cancel from
        // 403ing: a cancel needs a turn id, a turn id is only learned from events,
        // and no event is read until registration has settled.
        const registration = { conversationId: mint.conversationId, sessionId, accessToken, previousSessionId: active.knownSessionId ?? null }
        // One retry for a transient failure (a dropped request, a 5xx): the
        // turn is already running in eve, and an unregistered session is one
        // nothing can reach again (its stream, the next send, the home turns:
        // home-turn-server.ts sends only into the row's session). A conflict
        // or a refusal is an answer, not a blip, and is never retried.
        await this.register(registration).catch(async (err) => {
          if (!isTransientRegisterError(err)) throw err
          console.warn('[eve chat] registering the session failed; retrying once', { error: err instanceof Error ? err.message : String(err) })
          await new Promise((resolve) => setTimeout(resolve, this.opts.timeouts?.registerRetryMs ?? REGISTER_RETRY_DELAY_MS))
          await this.register(registration)
        }).catch((err) => {
          if (err instanceof EveSessionConflictError) {
            // Another window registered its own session on this conversation
            // first (A3: two windows on the home thread). This turn's reply still
            // streams on this response, and the handle stays until it settles
            // (Stop's cancel and ask_user answers need it); then it goes, and the
            // chat's next send mints afresh and re-attaches to the session the
            // row holds, carrying this exchange, never overwriting it.
            active.orphanedFor = chatId
            return
          }
          // A failed registration means continues would 403; surface as a turn
          // failure rather than hanging. Re-allow a retry next send.
          active.registered = false
        })
        turn.timings.client.registered = clientNow()
      }
    }
    await registerSessionOf(response)

    // The words go once more at most (Send now: see resendOnCancel and the
    // first-event watchdog).
    let resent = false
    for (;;) {
      let resend = false
      // eve 0.79: a dormant session whose stream history passed the World's
      // retention answers its stream with 410 session_expired, while it may
      // still have taken the POST. Before any event, the turn goes to a fresh
      // session primed with the thread (A3's re-prime) instead of erroring.
      let reprime = false
      let sawEvent = false
      // Send now while posted: the steer's response must show the steer soon
      // after the cancel, or the words go once more as a plain turn.
      // Otherwise an ordinary send's first event is watched (stalledSendWatch):
      // a session that accepted the message but never starts a turn is found
      // out, never waited on forever. Not a steer's adopted response (its own
      // paths watch it) and not the Send-now resend.
      const watched = !turn.adoptedSteer && !resent && active.session ? active.session : null
      const source: AsyncIterable<HandleMessageStreamEvent> =
        turn.adoptedSteer?.priorStopped && !resent
          ? firstEventWithin(response, this.opts.timeouts?.sendNowFirstEventMs ?? SEND_NOW_FIRST_EVENT_MS)
          : watched
            ? stalledSendWatch(
                response,
                this.opts.timeouts?.turnStartStallMs ?? TURN_START_STALL_MS,
                () =>
                  // A Stop already asked: its own drain owns the turn, as before.
                  turn.stopRequested
                    ? Promise.resolve<SessionHealth>('alive')
                    : this.readHealth(active, watched.state.sessionId),
                {
                  maxMs: this.opts.timeouts?.compactionWaitMs ?? COMPACTION_WAIT_MS,
                  pollMs: this.opts.timeouts?.compactionPollMs ?? COMPACTION_POLL_MS,
                  onBusy: (state) => this.noteSessionBusy(chatId, state),
                },
              )
            : response
      try {
        for await (const event of source) {
          sawEvent = true
          if (turn.stopRequested) {
            if (this.drainStopped(active, turn, event)) break
            continue
          }
          if (turn.settled) break
          if (turn.adoptedSteer) noteAdoptedOutcome(turn, event)
          // Send now cancelled the turn this steer had just been folded into:
          // the words still deserve an answer, so they go once more (below) —
          // unless an answer to them already started here (one bubble never
          // holds two answers; that one is kept, cut off).
          if (turn.resendOnCancel && event.type === 'turn.cancelled' && !hasAnswerText(turn)) {
            resend = true
            break
          }
          if (claimEvent(event, turn) === 'steered') {
            this.settleSteeredTurn(turn)
            this.noteSteerLanded(active, turn, 'applied')
            break
          }
          // TTFT marks come from this send's own stream only, never from a HITL
          // resume (answerPermission's loop), so a user's pause on a picker can
          // never land inside a measured phase.
          markTurnEvent(turn.timings, event, clientNow())
          this.onEvent(event, turn)
          if (active.pendingSteer?.prior === turn) this.maybePostSteer(active, chatId)
        }
      } catch (err) {
        if (!sawEvent && !resent && !turn.stopRequested && active.session && isEveHistoryExpiredError(err)) {
          console.warn('[eve chat] the session’s stream history expired (410 session_expired); re-priming a fresh session', {
            sessionId: active.eveSessionId,
          })
          reprime = true
        } else if (err instanceof EveSessionStalledError) {
          // The session took the message and never started a turn (a retired
          // deployment's run, a terminated session): it is dropped, and never
          // re-attached, so the person's Retry (never an automatic resend:
          // nothing goes twice) starts a fresh session primed with the thread.
          // A session compacting (an idle compaction) reads as alive for up to
          // COMPACTION_WAIT_MS, so a live one is never dropped here, and the
          // Retry re-reads it before registering anything over it
          // (refuseRetryOverLiveSession).
          console.warn('[eve chat] the session accepted the message but never started a turn; dropping it', { sessionId: active.eveSessionId })
          if (active.eveSessionId) this.deadSessions.set(active.eveSessionId, err.reason)
          if (this.sessions.get(chatId) === active) this.sessions.delete(chatId)
          throw err
        } else {
          if (!(err instanceof FirstEventTimeout)) throw err
          console.warn('[eve chat] Send now: the steer did not show up after the cancel; sending it once more')
          resend = true
        }
      } finally {
        turn.resolveIdentified()
        // The MessageResponse iterator has now ended at the current turn boundary
        // (session.waiting / completed / failed), which means the eve session's
        // continuationToken has been advanced (the generator's finally ran). Release
        // the drain gate so a queued answerPermission can safely send its resume —
        // sending BEFORE this point runs against an un-advanced session (undefined
        // continuationToken) and eve throws before any POST (the dead-Submit bug).
        turn.resolveDrained()
      }
      if (reprime && !turn.settled && !turn.stopRequested) {
        resent = true
        const expired = active.session
        // Stop whatever turn the POST may have started there (its output is
        // unreadable), and never re-attach it: the row is re-registered below.
        if (active.eveSessionId) this.deadSessions.set(active.eveSessionId, 'history_expired')
        void expired?.reset({ reason: 'stream history expired; re-primed in a fresh session' }).catch(() => {})
        active.session = null
        active.eveSessionId = null
        active.registered = false
        active.reattached = false
        active.prewarm = undefined
        response = await this.withSessionAuthRetry(active, chatId, createSession)
        await registerSessionOf(response)
        continue
      }
      const session = active.session
      if (!resend || resent || turn.settled || turn.stopRequested || !session) break
      resent = true
      turn.resendOnCancel = false
      response = await this.withSessionAuthRetry(active, chatId, () => session.send(userMessage, sendOptions()))
    }

    // The MessageResponse iterator ends at the current turn boundary
    // (session.waiting / completed / failed). If the turn PARKED on an open
    // input request (an unanswered ask_user), leave the stream OPEN — the answer
    // (answerPermission) resumes the same turn and streams the reply into it
    // (the ignoreIncompleteToolCalls-equivalent). Otherwise the
    // turn already settled on turn.completed/failed, or ended cleanly with no
    // pending request → close so useChat leaves `streaming`.
    //
    // `!turn.answering` guards the click-vs-drain race: if the user answered the
    // parked ask_user before this drain reached the boundary, answerPermission has
    // already consumed the request (openInputRequests is now empty) and is awaiting
    // this very drain to fire its resume send. Closing here would settle the turn
    // out from under it. Let answerPermission own the close/persist in that case.
    if (!turn.settled && !turn.answering && turn.openInputRequests.size === 0) {
      turn.close()
    }
    this.afterTurnDrain(active, turn)
  }

  /** Tell the panel what a send waits behind (onSessionBusy); never throws. */
  private noteSessionBusy(chatId: string, state: SessionBusyState | null): void {
    try {
      this.opts.onSessionBusy?.(chatId, state)
    } catch {
      /* best-effort */
    }
  }

  /**
   * A session's health, read on a handle of its own (attach is no I/O), so
   * the tail read never touches the cursor of the handle a send is reading.
   */
  private readHealth(active: ActiveSession, sessionId: string): Promise<SessionHealth> {
    return sessionHealth(
      active.client.sessions.attach(sessionId),
      this.opts.timeouts?.sessionHealthReadMs ?? SESSION_HEALTH_READ_MS,
      this.opts.timeouts?.sessionHealthTailIdleMs,
    )
  }

  /**
   * Before a send makes a fresh session over the one its row holds because
   * this transport dropped that one as dead (a stall, then the person's
   * Retry): read it once more. Compacting again means an idle compaction
   * began after the stall: registering a new session over it would split the
   * thread while it still runs the message it accepted (its tools act, its
   * reply is never shown). So nothing is sent: it is re-attached for the next
   * send (which waits behind the compaction, bounded) and the send fails with
   * EveSessionBusyError. Refused at most once per session, and never when the
   * stall itself was the compaction wait running out (`wait_timed_out`): the
   * events carry no time, so a compaction a retired run left open would read
   * as compacting for good, nor over a session whose stream history expired
   * (it was reset). A turn running (`alive`) is not refused either:
   * a leftover `turn.started` whose run died reads alive for good, and a send
   * re-attached to it would wait on it forever. Ended or idle: the fresh
   * session goes ahead.
   */
  private async refuseRetryOverLiveSession(active: ActiveSession): Promise<void> {
    const known = active.knownSessionId
    if (active.session || !known) return
    const why = this.deadSessions.get(known)
    if (why === undefined || why === 'wait_timed_out' || why === 'history_expired' || this.retryRefused.has(known)) return
    const verdict = await this.readHealth(active, known)
    if (verdict !== 'compacting') return
    console.warn('[eve chat] the session dropped as dead is compacting; re-attaching it instead of starting a new one', { sessionId: known })
    this.retryRefused.add(known)
    this.deadSessions.delete(known)
    active.session = active.client.sessions.attach(known)
    active.eveSessionId = known
    active.registered = true
    active.reattached = true
    throw new EveSessionBusyError()
  }

  /**
   * Where a send's (or a HITL resume's) drain leaves the turn: finished →
   * persisted once; a steer that was on its way and found it ended first lands
   * as the next turn. Parked on a question → left open for the answer, unless
   * a steer is already posted: then eve runs the steer as its own turn while
   * the approval stays pending, so the picker is skipped and the turn settles
   * for the flush to adopt the steer (UI-2: the park race).
   */
  private afterTurnDrain(active: ActiveSession, turn: TurnState): void {
    if (turn.answering) return
    if (turn.openInputRequests.size === 0) {
      if (turn.settled) this.noteSteerLanded(active, turn, 'next_turn')
      this.persistFinishedTurn(active, turn)
      return
    }
    if (turn.settled) return
    turn.parkedIdle = true
    if (active.pendingSteer?.prior === turn && active.pendingSteer.phase === 'posted' && !holdsSessionLimit(turn)) {
      this.skipParkForSteer(active, turn)
    }
  }

  /**
   * POST the finalized assistant turn to the cookie-authed persist wrapper —
   * projection into chat_messages + knowledge hook (never billing: the chat-agent's
   * usage-meter hook bills the turn server-side). FIRE-AND-FORGET
   * and guarded:
   *  - `turn.persisted` makes it exactly-once (completed AND a resumed-close both
   *    call here);
   *  - a turn that produced nothing (never started → no message id rendered) is
   *    not persisted (no empty bubble);
   *  - a failure is swallowed to console.error so it can never break the visible
   *    turn (the user already saw the streamed reply).
   *
   * The body's messageId is EXACTLY the id the transport stamped on the `start`
   * chunk, so the writer's ui_message_id dedup converges the projection onto the
   * same identity the client rendered.
   */
  private persistFinishedTurn(active: ActiveSession, turn: TurnState): void {
    this.settleOrphan(active, turn)
    if (turn.persisted) return
    if (!turn.started) {
      // Nothing rendered → no reply to persist. But a turn a steer cut off
      // before its first output still had its user message: written alone
      // (chained), so a reload reads it ahead of the steering message.
      if (turn.superseded && turn.settled) this.persistUserMessageAlone(active, turn)
      return
    }
    turn.persisted = true

    // A steering message (UI-2) is written with how it landed, and the reply
    // a Stop (or Send now) ended says so: the "Stopped" caption on reload.
    const steer = turn.adoptedSteer ? steerTelemetryOf(turn) : null
    const body: EvePersistBody = {
      messageId: turn.messageId,
      role: 'assistant',
      parts: turn.parts,
      metadata: { [EVE_WRITTEN_METADATA_KEY]: true, ...(turn.stopRequested ? { stopped: true } : {}) },
      usage: {
        events: turn.events,
        wallMs: Math.max(0, Date.now() - turn.startedAt),
      },
      ...(turn.userMessage
        ? { userMessage: steer ? { ...turn.userMessage, metadata: { ...turn.userMessage.metadata, steer: steer.outcome } } : turn.userMessage }
        : {}),
      ...(this.opts.panelNamesChats?.() ? { panelTitles: true as const } : {}),
      // Derived here, under the persisted guard, so a turn reports its timings
      // exactly once, however it ended (completed, failed, stopped, steered).
      timings: deriveTurnTimings(turn.timings),
      ...(steer ? { steer } : {}),
    }
    const token = active.token

    this.chainPersist(active, token, body, 'eve chat: turn persist failed:')
  }

  /**
   * Write `body` after the chat's previous write: a steered reply's part is
   * written before the steering message and its continuation, so a reload
   * (ordered by created_at) reads them in the order they happened. The wait is
   * capped (PERSIST_CHAIN_CAP_MS): one slow write never holds back the rest.
   * Best-effort: a failure is logged and never breaks the visible turn.
   */
  private chainPersist(active: ActiveSession, token: string, body: EvePersistBody, failure: string): void {
    const write = async () => {
      const accessToken = await this.currentAccessToken()
      await this.persist({ token, accessToken, body })
    }
    const previous = active.lastPersist
    const cap = this.opts.timeouts?.persistChainCapMs ?? PERSIST_CHAIN_CAP_MS
    // A previous write already done is not waited on at all.
    const pending = previous && !active.lastPersistSettled ? previous : null
    active.lastPersistSettled = false
    const written: Promise<void> = (pending ? settleWithin(pending.then(() => true), cap).then(write) : write())
      .catch((err) => {
        console.error(failure, err)
      })
      .finally(() => {
        if (active.lastPersist === written) active.lastPersistSettled = true
      })
    active.lastPersist = written
  }

  /**
   * The turn's user message, written the moment it is sent (chained after the
   * chat's previous write, so it still lands after the last reply). The
   * reply's own persist carries it again, a dedup no-op then, which covers a
   * write that failed. Once per turn; never marks the turn persisted.
   */
  private persistUserMessageNow(active: ActiveSession, turn: TurnState): void {
    if (turn.userPersisted || !turn.userMessage) return
    turn.userPersisted = true
    const body: EvePersistBody = {
      messageId: turn.userMessage.messageId,
      role: 'user',
      parts: turn.userMessage.parts,
      metadata: turn.userMessage.metadata ?? {},
      usage: { events: [], wallMs: 0 },
      ...(this.opts.panelNamesChats?.() ? { panelTitles: true as const } : {}),
      onSend: true,
    }
    this.chainPersist(active, active.token, body, 'eve chat: user message persist failed:')
  }

  /** A turn's user message as its own row (no reply rendered), chained like any write. Once per turn. */
  private persistUserMessageAlone(active: ActiveSession, turn: TurnState): void {
    if (turn.persisted || !turn.userMessage) return
    turn.persisted = true
    // Already written when it was sent (persistUserMessageNow).
    if (turn.userPersisted) return
    const body: EvePersistBody = {
      messageId: turn.userMessage.messageId,
      role: 'user',
      parts: turn.userMessage.parts,
      metadata: turn.userMessage.metadata ?? {},
      usage: { events: [], wallMs: Math.max(0, Date.now() - turn.startedAt) },
      ...(this.opts.panelNamesChats?.() ? { panelTitles: true as const } : {}),
    }
    this.chainPersist(active, active.token, body, 'eve chat: user message persist failed:')
  }

  /**
   * Settles once the chat's last finished turn is written (or its write
   * failed), at most `ms` later: a message the client saves after it (a page
   * the person opened from `/` while the turn ran) then lands after the
   * turn's rows, which a reload orders by when they were written.
   */
  async turnPersisted(chatId: string, ms = 10_000): Promise<void> {
    const pending = this.sessions.get(chatId)?.lastPersist
    if (!pending) return
    await settleWithin(pending.then(() => true), ms)
  }

  /**
   * A bots v2 teammate thread's user message, when its turn was stopped before
   * anything rendered. persistFinishedTurn writes the user message beside the
   * reply, so a turn that never started would lose it, and a teammate thread
   * has no other writer: no panel autosave, and the chat-history PATCH is the
   * main chat's (whose autosave saves the message there, so it's left as it
   * was). Shares the turn's `persisted` guard, so it's written once, and never
   * beside a reply that did start (that persist carries it). Fire-and-forget,
   * like the reply's. The panel names the thread, so no title backfill runs.
   */
  private persistStoppedUserMessage(active: ActiveSession, turn: TurnState): void {
    if (!this.opts.teammateId || turn.started) return
    this.persistUserMessageAlone(active, turn)
  }

  /**
   * An orphaned handle's turn has settled (A3, see ActiveSession.orphanedFor):
   * keep its exchange for the chat's next message to the real session, and
   * drop the handle so that send re-attaches. Once per handle.
   */
  private settleOrphan(active: ActiveSession, turn: TurnState): void {
    const chatId = active.orphanedFor
    if (!chatId || active.orphanSettled) return
    active.orphanSettled = true
    const carry = orphanExchangePrimer(turn.userMessage?.parts ?? null, turn.parts)
    if (carry) this.orphanCarry.set(chatId, carry)
    if (this.sessions.get(chatId) === active) this.sessions.delete(chatId)
  }

  /** The eve session this chat's live handle is on, or null (A3: a window re-syncing the home thread compares it with the row's). */
  eveSessionIdOf(chatId: string): string | null {
    return this.sessions.get(chatId)?.eveSessionId ?? null
  }

  /** Persist a finished turn via the injected helper or the default wrapper route. */
  private async persist(args: {
    token: string
    accessToken: string | null
    body: EvePersistBody
  }): Promise<void> {
    if (this.opts.persistTurn) return this.opts.persistTurn(args)
    const res = await fetch(EVE_PERSIST_ROUTE, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [CHAT_RUN_TOKEN_HEADER]: args.token,
        ...(args.accessToken ? { Authorization: `Bearer ${args.accessToken}` } : {}),
        ...this.workspaceHeaders(),
      },
      body: JSON.stringify(args.body),
      signal: timeoutSignal(PERSIST_FETCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`eve-persist failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`)
    }
  }

  /**
   * Translate ONE eve stream event into UIMessageChunk(s) on the open turn,
   * through the shared reducer (src/lib/chat/eve-turn-parts.ts, which the
   * server's home-turn writer runs too, so both produce identical parts).
   * Enumerated mapping:
   *   message.appended        → text-start (first) / text-delta
   *   message.completed       → text-end (close the open text block)
   *   actions.requested       → tool-input-available (dynamic) per tool-call
   *   action.result           → tool-output-available (dynamic)
   *   action.partial          → tool-output-available (dynamic, preliminary)
   *   input.requested         → ask_user/confirmation → tool-input-available part
   *   turn.completed          → finish-step + finish (close)
   *   turn.cancelled          → finish-step + finish (close, graceful; not a failure)
   *   turn.failed/step.failed → unfinished tool errors, then an ordered error chunk
   * The transport adds only its own side: the usage events, the steer facts,
   * the HITL answer bookkeeping and closing the stream.
   */
  private onEvent(event: HandleMessageStreamEvent, turn: TurnState): void {
    if (turn.settled) return

    // Record ONLY the usage-relevant events for the persist body's `usage`
    // (display/analytics only — the turn is BILLED server-side by the
    // chat-agent's usage-meter hook, never from these). It consumes `step.completed`
    // (tokens/cost/steps/gateway generation ids) and `actions.requested`
    // (tool-call + discovery counts) — nothing else. Its meta.at duration
    // bracket is a fallback this transport never relies on: the persist body
    // always carries the turn's own wallMs, which mapEveTurnUsage prefers.
    // Pushing EVERY event here retained one object per text delta for the whole
    // turn (1–10MB transient per long turn — 2026-08-05 incident analysis).
    if (isUsageRelevantEvent(event)) turn.events.push(event)
    trackSteerFacts(turn, event)

    applyEveTurnEvent(turn, event, {
      emit: turn.emit,
      // An ask_user this turn already answered keeps the USER'S answers as the
      // part output — eve's result is the tool's internal "answers arrive next"
      // note, which would clobber the answered summary.
      answeredOutput: (callId) => turn.askUserAnswered.get(callId),
      onInputRequest: (request) => this.recordInputRequest(request, turn),
      onFailed: (message) => this.endReportedFailure(turn, message),
      // A settled reply or a cancellation: close so useChat leaves `streaming`.
      // (A HITL park never reaches here: the reducer keeps a parked turn open.)
      onFinished: (how) => {
        // Cancelled with no answer and no Stop: since eve 0.68 that is what the
        // usage-limit-gate hook does to a blocked turn. Ask the usage check so
        // the person sees why (its 429 opens the usage-limit dialog).
        if (how === 'cancelled' && !turn.stopRequested && !turn.superseded && !hasAnswerText(turn)) {
          void this.usageCheck().catch(() => 'unknown')
        }
        turn.close()
      },
    })
  }

  /**
   * A runtime-reported failure ends this displayed turn (the reducer already
   * settled its unresolved calls as output-error: they have no result, even
   * when actions.requested was emitted before dispatch).
   *
   * Use the SDK's ordered error chunk rather than controller.error(), which
   * discards queued tool updates before the UI can apply them. Generic stream
   * disconnects still use turn.fail: they do not establish that server work
   * ended. Neither path invents a tool result or retries a tool.
   */
  private endReportedFailure(turn: TurnState, message: string): void {
    turn.openInputRequests.clear()
    turn.inputRequestIdByCallId.clear()
    turn.inputRequestMeta.clear()
    turn.emit({ type: 'error', errorText: message })
    turn.close()
  }

  /**
   * Remember how to answer one HITL request, before the reducer surfaces it as
   * a tool part (keyed by requestId, so a re-emitted request never
   * double-announces).
   *
   * eve gates every `ask_user` call with `approval: always()`, so its pause is
   * an APPROVAL request: options [{id:'approve'},{id:'cancel'}], display
   * 'confirmation'. answerPermission must resume approval requests with an
   * `optionId` TAKEN FROM THE REQUEST'S OWN OPTIONS — eve's
   * resolveApprovalOutcome leaves an approval whose optionId it can't match
   * unresolved (deferred), which stalls the turn. Capture the actual
   * approve/cancel ids off the request so a schema tweak can never desync us
   * from a hardcoded literal. callId → requestId lets answerPermission answer
   * the eve pause and flip the part.
   */
  private recordInputRequest(request: InputRequest, turn: TurnState): void {
    const callId = inputRequestCallId(request)
    const { isApproval, isSessionLimit, approveOptionId, cancelOptionId } = describeApproval(request)
    // The question texts (#706): a typed reply answers the open question
    // instead of cancelling it, and the resume message names what it answers.
    const questions =
      request.action?.toolName === ASK_USER_TOOL_NAME
        ? questionTexts(request.action?.input ?? { questions: [] })
        : request.prompt
          ? [request.prompt]
          : []
    turn.inputRequestIdByCallId.set(callId, request.requestId)
    turn.inputRequestMeta.set(request.requestId, { callId, isApproval, isSessionLimit, approveOptionId, cancelOptionId, questions })
  }

  /**
   * Settle a turn at its steer point (see runTurn's turnPolicy comment): close
   * any open reasoning/text block and finish the stream GRACEFULLY, exactly like
   * a completed turn. The caller's post-loop then persists what this turn
   * rendered; the steering send's own TurnState renders the rest of the eve turn.
   */
  private settleSteeredTurn(turn: TurnState): void {
    if (turn.settled) return
    if (turn.reasoningId && !turn.reasoningClosed) {
      turn.emit({ type: 'reasoning-end', id: turn.reasoningId })
      turn.reasoningClosed = true
    }
    if (turn.textId && !turn.textClosed) {
      turn.emit({ type: 'text-end', id: turn.textId })
      turn.textClosed = true
    }
    if (turn.started) {
      turn.emit({ type: 'finish-step' })
      turn.emit({ type: 'finish' })
    }
    turn.close()
  }

  // ── Steering the running turn (UI-2, docs/plans/always-on-agent.md §2b) ──────
  //
  // A plain message typed while a reply runs is held above the composer. The
  // panel hands it here; the transport POSTs it to the eve session with
  // turnPolicy 'steer' at the first opening (steer-opening.ts) — beside useChat,
  // never as a second useChat request — and keeps eve's response unread. The
  // running turn's own stream settles at the steer point (settleSteeredTurn) or
  // at its normal end; either way useChat goes ready, the panel's flush sends
  // the message with `body.steerId`, and sendMessages adopts that response
  // instead of minting and POSTing again. One code path for applied and
  // fell-through, and never two concurrent useChat requests (#681).

  /**
   * Hold `req` as a steer for this chat's running turn. True when accepted —
   * it is then held (Edit works) until an opening, and `onState` reports each
   * phase. False when there is nothing to steer (no running eve turn, a turn
   * parked on a question, a Stop on its way) or one steer is already in
   * flight: the message then waits for the end, as before.
   */
  requestSteer(chatId: string, req: SteerRequest): boolean {
    const active = this.sessions.get(chatId)
    const prior = active?.turn
    if (!active || !active.session || !prior || prior.settled || prior.stopRequested) return false
    if (prior.openInputRequests.size > 0 || prior.answering) return false
    if (active.pendingSteer) return false
    const text = req.text.trim()
    if (!text) return false
    const options = { body: req.body }
    const mainChat = !!this.opts.getCardContext
    const steer: PendingSteer = {
      id: req.id,
      message: eveUserContent(text, [], readReplyNotes(options)),
      replyId: newReplyId(chatId),
      ctx: encodeTurnContext(
        options,
        this.cardContext(),
        mainChat ? browserTimeZone() : null,
        mainChat ? currentSurroundings() : null,
        turnRouteSignals(text),
      ),
      agentId: readAgentId(options) ?? undefined,
      skillId: readSkillId(options) ?? undefined,
      prior,
      phase: 'held',
      token: null,
      post: null,
      postAccepted: null,
      response: null,
      landed: null,
      priorStopped: false,
      priorTurnId: null,
      requestedAt: Date.now(),
      postedAt: null,
      opening: null,
      onState: (phase) => {
        try {
          req.onState?.(phase)
        } catch {
          /* the panel's bookkeeping never breaks the transport */
        }
      },
    }
    active.pendingSteer = steer
    void this.mintSteer(active, chatId, steer)
    return true
  }

  /**
   * Edit (or another send added to it): take a held steer back. True when it
   * was never sent (or is unknown here), false once its POST has started — eve
   * has no way to take a delivery back, so the row stays and says so.
   */
  withdrawSteer(chatId: string, id: string, reason: 'edited' | 'merged' | 'sent_now' | 'released' = 'edited'): boolean {
    const active = this.sessions.get(chatId)
    const steer = active?.pendingSteer
    if (!active || !steer || steer.id !== id) return true
    if (steer.phase !== 'held') return false
    this.withdrawPending(active, reason)
    return true
  }

  /**
   * The flush of a held message (the chat is free), decided at once — never
   * awaited, so the panel never blocks with its row gone:
   *  - `adopt`: its steer is posting or posted; send it with `body.steerId`
   *    and the turn adopts the steer's response (waiting, bounded, for a POST
   *    still in flight inside its own stream, where Stop works);
   *  - `send`: it was never POSTed (the running turn ended before an
   *    opening), so it goes as an ordinary turn;
   *  - `gone`: the row says it was sent (`sent`) but the transport no longer
   *    has it (its session was dropped): never sent again.
   */
  steerFlushPlan(chatId: string, id: string, sent: boolean): 'adopt' | 'send' | 'gone' {
    const active = this.sessions.get(chatId)
    const steer = active?.pendingSteer
    if (active && steer && steer.id === id) {
      if (steer.phase === 'held') {
        this.withdrawPending(active, 'next_turn')
        return 'send'
      }
      if (steer.phase === 'posting' || steer.phase === 'posted') return 'adopt'
    }
    return sent ? 'gone' : 'send'
  }

  /** Drop the held steer unsent, logging why (never message text). */
  private withdrawPending(active: ActiveSession, outcome: 'edited' | 'merged' | 'sent_now' | 'released' | 'next_turn' | 'overtaken'): void {
    const steer = active.pendingSteer
    if (!steer || steer.phase !== 'held') return
    steer.phase = 'withdrawn'
    active.pendingSteer = null
    logSteer({ outcome, posted: false, held_ms: Date.now() - steer.requestedAt })
  }

  /** The steer's own run token (the same usage check as a send), then its first chance to go. */
  private async mintSteer(active: ActiveSession, chatId: string, steer: PendingSteer): Promise<void> {
    try {
      const minted = await this.mintWithRefresh(
        {
          chatId,
          conversationId: active.conversationId,
          agentId: steer.agentId,
          skillId: steer.skillId,
          about: active.teammateAbout ?? null,
        },
        await this.currentAccessToken(),
      )
      steer.token = minted.mint.token
    } catch (err) {
      if (active.pendingSteer === steer && steer.phase === 'held') this.failSteer(active, steer, 'mint', err)
      return
    }
    this.maybePostSteer(active, chatId)
  }

  /** POST the held steer if its running turn is at an opening (steerOpening). */
  private maybePostSteer(active: ActiveSession, chatId: string): void {
    const steer = active.pendingSteer
    if (!steer || steer.phase !== 'held' || !steer.token) return
    if (this.sessions.get(chatId) !== active || !active.session) return
    const prior = steer.prior
    // The turn ended first: the flush sends it as the next turn (today's path).
    if (prior.settled || prior.stopRequested || active.turn !== prior) return
    const opening = steerOpening(steerFactsOf(prior))
    if (opening.action !== 'post') return
    this.postSteer(active, chatId, steer, opening.reason)
  }

  private postSteer(active: ActiveSession, chatId: string, steer: PendingSteer, reason: SteerOpeningReason): void {
    const session = active.session
    if (!session || !steer.token) return
    const prior = steer.prior
    steer.phase = 'posting'
    steer.opening = reason
    steer.postedAt = Date.now()
    steer.priorTurnId = prior.eveTurnId
    // Before the POST: eve can stream an event carrying the new delivery id
    // before the POST's own response returns, and the prior must already know
    // that is its steer point.
    prior.superseded = true
    active.token = steer.token
    steer.onState('posting')
    // eve's client reads the steer's response from the cursor the session held
    // when this POST went, which is where the PRIOR turn's own read began (a
    // response advances the cursor only once it is drained), and skips every
    // event not carrying the steer's delivery id. Starting it at the prior's
    // current position would save that replay, but ClientSession exposes no
    // way to set the cursor (its state is private, eve 0.66.3
    // client/session.js), so it is left to eve: the skipped events cost
    // bandwidth on the adopted turn's stream open, nothing else.
    steer.post = (async () => {
      let response: MessageResponse
      try {
        // Headers read per attempt (a credentials retry re-mints active.token);
        // the steer's own ctx in case eve runs it as the next turn.
        response = await this.withSessionAuthRetry(active, chatId, () =>
          session.send(steer.message, {
            headers: { ...this.turnHeaders(active, steer.replyId), ...(steer.ctx ? { [CHAT_RUN_CTX_HEADER]: steer.ctx } : {}) },
            turnPolicy: 'steer',
          }),
        )
      } catch (err) {
        releaseSteer(prior)
        if (steer.phase === 'posting') this.failSteer(active, steer, 'post', err)
        return
      }
      if (steer.phase !== 'posting') return
      steer.response = response
      steer.phase = 'posted'
      // A credentials retry re-minted the run token the POST went with.
      steer.token = active.token
      // Already adopted (the flush waits on this POST) or dropped: nothing to tell.
      if (active.pendingSteer !== steer) return
      steer.onState('posted')
      // The prior already settled at the steer point while the POST was out.
      if (steer.landed) steer.onState(steer.landed)
      // The park race: the model committed to ask_user before the steer
      // landed, and the turn is waiting on the picker. eve runs the steer as
      // its own turn while the approval stays pending.
      // Never past a session-limit prompt: eve holds the steer behind it until
      // Continue or Stop, so the card stays up to answer.
      if (prior.parkedIdle && !prior.settled && !prior.answering && !holdsSessionLimit(prior)) this.skipParkForSteer(active, prior)
    })()
  }

  /**
   * A refused mint or POST. eve answered the POST with an error (it carries a
   * status, or was refused on its credentials): it never took the message, so
   * the panel sends it as an ordinary turn at the end (`failed`). Anything
   * else (a network failure mid-POST) leaves it unknown whether eve has it:
   * `lost`, and it is never re-sent.
   */
  private failSteer(active: ActiveSession, steer: PendingSteer, stage: 'mint' | 'post', err: unknown): void {
    steer.phase = 'failed'
    steer.postAccepted = stage === 'mint' || isRefusedByEve(err) ? 'no' : 'unknown'
    releaseSteer(steer.prior)
    logSteer({ outcome: steer.postAccepted === 'no' ? 'failed' : 'lost', stage, posted: false, ...describeEveError(err) })
    // Adopted already: its turn reads the outcome (runTurn).
    if (active.pendingSteer !== steer) return
    active.pendingSteer = null
    steer.onState(steer.postAccepted === 'no' ? 'failed' : 'lost')
  }

  /**
   * The prior turn of a steer on its way ended (`next_turn`) or reached the
   * steer point (`applied`): remember it for the flush and tell the panel.
   */
  private noteSteerLanded(active: ActiveSession, turn: TurnState, outcome: SteerOutcome): void {
    const steer = active.pendingSteer
    if (!steer || steer.prior !== turn || steer.landed) return
    if (steer.phase !== 'posting' && steer.phase !== 'posted') return
    steer.landed = outcome
    if (steer.phase === 'posted') steer.onState(outcome)
  }

  /**
   * The park race (see afterTurnDrain): settle a turn parked on a question
   * because a posted steer will run as its own turn. Its pickers read
   * "Skipped: you sent a new message". Nothing answers the approval from
   * here: since eve 0.70 the person's own message steers the held turn and
   * cancels the approval itself (eve docs, sessions-runs-and-streaming
   * "Send a follow-up message"). A structured cancel sent now would be a
   * stale response that eve delivers to the model as a new user message.
   * The home turn's open-question check also ignores a request older than
   * the person's latest message (home-turn-server.ts hasOpenInputRequest).
   */
  private skipParkForSteer(active: ActiveSession, turn: TurnState): void {
    if (turn.settled) return
    const output = { response: STEER_SKIPPED_QUESTION_COPY }
    for (const meta of turn.inputRequestMeta.values()) {
      turn.askUserAnswered.set(meta.callId, output)
      turn.emit({ type: 'tool-output-available', toolCallId: meta.callId, output, dynamic: true })
      const idx = turn.toolPartIndex.get(meta.callId)
      if (idx !== undefined && turn.parts[idx]) {
        turn.parts[idx] = { ...turn.parts[idx], state: 'output-available', output }
      }
    }
    turn.openInputRequests.clear()
    turn.inputRequestIdByCallId.clear()
    turn.inputRequestMeta.clear()
    turn.parkedIdle = false
    this.noteSteerLanded(active, turn, 'next_turn')
    if (turn.started) {
      turn.emit({ type: 'finish-step' })
      turn.emit({ type: 'finish' })
    }
    turn.close()
    this.persistFinishedTurn(active, turn)
  }

  /**
   * The adopted steer's POST, waited for at most STEER_POST_WAIT_MS:
   * `posted` (read its response), `refused` (eve answered with an error and
   * never had the words) or `unconfirmed` (no answer in time, or a failure
   * that may have reached eve).
   */
  private async awaitSteerPost(steer: PendingSteer): Promise<'posted' | 'refused' | 'unconfirmed'> {
    if (steer.phase === 'posting' && steer.post) {
      await settleWithin(steer.post.then(() => true), this.opts.timeouts?.steerPostWaitMs ?? STEER_POST_WAIT_MS)
    }
    if (steer.phase === 'posted' && steer.response) return 'posted'
    if (steer.phase === 'failed' && steer.postAccepted === 'no') return 'refused'
    return 'unconfirmed'
  }

  /** This chat's posted steer named `steerId`, ready for its flush to adopt. */
  private adoptableSteer(chatId: string, steerId: string): { active: ActiveSession; steer: PendingSteer } | null {
    const active = this.sessions.get(chatId)
    const steer = active?.pendingSteer
    if (!active || !steer || steer.id !== steerId || !steer.token) return null
    if (steer.phase !== 'posting' && steer.phase !== 'posted') return null
    return { active, steer }
  }

  /**
   * The flush's send of a posted steer: a new turn that reads the steer's own
   * response from where eve took the message in (applied: the rest of the
   * running eve turn; next_turn: the turn it started). The user message
   * useChat appended renders exactly there.
   */
  private adoptSteer(
    options: Parameters<ChatTransport<UIMessage>['sendMessages']>[0],
    active: ActiveSession,
    steer: PendingSteer,
    submittedAt: number,
    userMessage: string | UserContent,
    lastUser: UIMessage | undefined,
  ): ReadableStream<UIMessageChunk> {
    const { chatId, abortSignal } = options
    active.pendingSteer = null
    // The flush runs once the prior turn's stream closed; settle a straggler
    // the same way the steer point would.
    const prior = active.turn
    if (prior && !prior.settled) this.settleSteeredTurn(prior)
    active.token = steer.token!
    active.ctx = steer.ctx
    active.agentId = steer.agentId
    active.skillId = steer.skillId

    const turn = newTurnState(
      chatId,
      lastUser,
      {
        client: { submit: submittedAt },
        server: {},
        newSession: false,
        prewarmed: false,
      },
      steer.replyId,
    )
    turn.adoptedSteer = {
      priorTurnId: steer.prior.eveTurnId ?? steer.priorTurnId,
      priorStopped: steer.priorStopped,
      priorAnswerStarted: steer.prior.answerStarted,
      priorSteersInTurn: steer.prior.steersInTurn,
      landed: steer.landed,
      requestedAt: steer.requestedAt,
      postedAt: steer.postedAt,
      opening: steer.opening,
    }
    active.turn = turn
    const stream = this.openTurnStream(active, chatId, turn, abortSignal)
    const mint: ChatRunMintResult = { token: steer.token!, conversationId: active.conversationId }
    void this.runTurn(active, chatId, userMessage, mint, turn, abortSignal, null, steer).catch((err) => {
      turn.fail(err instanceof Error ? err : new Error(String(err)))
    })
    return stream
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    // eve sessions ARE reconnectable by cursor, but useChat's reconnect path is
    // not wired to the eve stream here; a dropped turn re-sends, so no
    // reconnectable stream is surfaced.
    return null
  }

  /**
   * Whether this chat's open turn is parked on the request a tool part names,
   * so answerPermission can answer it. False for a request drawn from history
   * (a reload, a server-written home turn): no turn here holds it.
   */
  hasOpenInputRequest(chatId: string, toolCallId: string): boolean {
    const turn = this.sessions.get(chatId)?.turn
    if (!turn || turn.settled) return false
    const requestId = turn.inputRequestIdByCallId.get(toolCallId)
    return requestId !== undefined && turn.openInputRequests.has(requestId)
  }

  /**
   * Answer an open ask_user (or approval) request over the eve session. `answers`
   * maps each question text → chosen label(s); a defined `response` (with an empty
   * answers map) is the Skip / X dismissal, or, with `options.typed`, the words
   * the person typed into the composer instead of picking. The parked eve turn
   * resumes with the answer and streams its reply into the still-open turn stream.
   *
   * Every early return is LOGGED (silent no-ops are exactly how the dead-Submit
   * bug hid). An untyped `response` is a DISMISS: the request is cancelled so the
   * model is told nothing was chosen and the turn always closes cleanly. A typed
   * one is an ANSWER (the #681 rule): the request is approved and the words reach
   * the model as the person's answer, so it acts on them instead of re-asking.
   */
  async answerPermission(
    chatId: string,
    toolCallId: string,
    answers: Record<string, string>,
    response?: string,
    options?: AnswerPermissionOptions,
  ): Promise<void> {
    const active = this.sessions.get(chatId)
    if (!active) {
      console.error('[eve chat] answerPermission: no active session for chat', { chatId, toolCallId })
      return
    }
    const turn = active.turn
    if (!turn || turn.settled) {
      console.error('[eve chat] answerPermission: no open turn (already settled / torn down)', {
        chatId,
        toolCallId,
        hasTurn: !!turn,
        settled: turn?.settled,
      })
      return
    }

    // Resolve the eve requestId the pending pause is keyed by (the picker hands
    // back the tool part's callId, which differs from the requestId). No mapping
    // → the request isn't open here (already answered / torn down).
    const requestId =
      turn.inputRequestIdByCallId.get(toolCallId) ??
      // Fallback for the synthetic-callId shape we minted when eve gave no callId.
      (turn.openInputRequests.has(toolCallId.replace(/^(auq-|input-)/, ''))
        ? toolCallId.replace(/^(auq-|input-)/, '')
        : undefined)
    if (!requestId || !turn.openInputRequests.has(requestId)) {
      console.error('[eve chat] answerPermission: no open request for toolCallId', {
        chatId,
        toolCallId,
        resolvedRequestId: requestId,
        openRequests: [...turn.openInputRequests],
        knownCallIds: [...turn.inputRequestIdByCallId.keys()],
      })
      return
    }

    // Typed words answer the question; only Skip / X (an untyped `response`)
    // dismisses it. Before this, a typed reply went out as a cancel: the model
    // read "tool execution was denied" and asked again with a second picker.
    const typedReply = response !== undefined && options?.typed === true ? response : undefined
    const isDismiss = response !== undefined && typedReply === undefined
    const meta = turn.inputRequestMeta.get(requestId)

    // Mark the turn as answering BEFORE consuming the request, so runTurn's
    // post-loop (which may run concurrently if the click beat the park drain)
    // does not close/persist the turn out from under this resume send.
    turn.answering = true

    // Consume the mapping up front so a double-click can't send two responses for
    // the same requestId (eve rejects the second). If the SEND then fails we
    // RESTORE this below so a genuine retry still works — the bug was a network
    // hiccup permanently deadening the button.
    turn.openInputRequests.delete(requestId)
    turn.inputRequestIdByCallId.delete(toolCallId)
    turn.inputRequestMeta.delete(requestId)
    const restoreMapping = () => {
      turn.answering = false
      turn.openInputRequests.add(requestId)
      turn.inputRequestIdByCallId.set(toolCallId, requestId)
      if (meta) turn.inputRequestMeta.set(requestId, meta)
    }

    // Build the eve resume payload. Native Intelligence's ask_user pauses as an APPROVAL request
    // (approval: always() → options approve/cancel). Two facts from eve's dist
    // source (harness/input-request-resolution.js, harness/hitl/*) shape this:
    //
    //  1. resolveApprovalOutcome resolves an approval ONLY when the response's
    //     `optionId` matches one of the REQUEST'S OWN option ids ('approve', or the
    //     negative 'cancel' / legacy 'deny'); anything else yields
    //     `status: 'invalid'` → the turn is deferred (STALLED). So we pick the
    //     approve/cancel id captured off the request, never a blind literal —
    //     approveOptionId for an answer (picked or typed), cancelOptionId for a
    //     dismiss (Skip / X).
    //  2. buildToolResponsePartsForRequest DISCARDS any `text` on an approval
    //     response (it emits only `{approvalId, approved}`), so the user's choice
    //     cannot reach the model via `text` on an approval. Pre-0.31 it rode as a
    //     follow-up `message` in the SAME send(); 0.31 split that into
    //     `respond(inputResponses, options)`, which carries no `message` field at
    //     all (the channel route would reject the pair with HTTP 400, but the typed
    //     client never emits it). So the
    //     answer text travels as `clientContext` — one-turn model context attached
    //     to this very respond — exactly as resumeConversationSession does.
    //
    // A non-approval request (a plain confirmation / select / text question, if eve
    // ever surfaces one for us) takes the bare `text` shape eve resolves via
    // resolveTextToResponses; the same text still rides as clientContext so the
    // model reads it on this turn.
    // A session-limit answer is the person's Continue / Stop, not words for the model.
    const answerMessage = meta?.isSessionLimit
      ? undefined
      : isDismiss
        ? formatDismissMessage(response!)
        : typedReply !== undefined
          ? formatTypedReplyMessage(meta?.questions ?? [], typedReply)
          : formatAnswersMessage(answers)
    const inputResponse: { requestId: string; optionId?: string; text?: string } = { requestId }
    const respondOptions: {
      headers: Record<string, string>
      clientContext?: string
    } = { headers: this.turnHeaders(active, turn.messageId) }
    if (meta?.isApproval || meta?.isSessionLimit) {
      // Pick the option id FROM THE REQUEST (fallback to the eve literals only when
      // the request carried no options — defensive, should never happen for an
      // approval since eve (re-verified at 0.66.3) always emits [{id:'approve'},{id:'cancel'}]).
      inputResponse.optionId = isDismiss
        ? meta.cancelOptionId || 'cancel'
        : meta.approveOptionId || 'approve'
    } else {
      inputResponse.text = response !== undefined ? JSON.stringify({ response }) : JSON.stringify({ answers })
    }
    // Thread the user's choice to the model for this turn. A dismiss still carries a
    // short note so the model knows the user declined; a typed reply carries the
    // words as the answer to the question(s) asked.
    if (answerMessage) respondOptions.clientContext = answerMessage

    // Flip the accumulated ask_user part to output-available so the persisted
    // projection is truthful (a reload renders the answered summary, not a live
    // picker). Mirrors the live-capture branch's local flip in chat-panel.
    // Record the answer output per callId too: the resume stream's action.result
    // for this call carries the tool's EXECUTE output (an internal note), and
    // onEvent must keep THESE answers instead — they're what the existing
    // answered-picker rendering (extractQuestionAnswers) displays, same as the
    // cloud path.
    //
    // A session-limit prompt flips only once eve has the answer (below): until
    // then eve holds every other message behind it, so a card that read
    // "Stopped" while the respond failed would leave the chat silently stuck.
    const answerOutput = response !== undefined ? { response } : { answers }
    const flipAnswered = () => {
      if (!meta) return
      turn.askUserAnswered.set(meta.callId, answerOutput)
      const partIdx = turn.toolPartIndex.get(meta.callId)
      if (partIdx !== undefined && turn.parts[partIdx]) {
        turn.parts[partIdx] = {
          ...turn.parts[partIdx],
          state: 'output-available',
          output: answerOutput,
        }
      }
    }
    if (!meta?.isSessionLimit) flipAnswered()

    // CRITICAL: wait for the parked send's stream to have drained to the eve turn
    // boundary before resuming. eve would accept the respond either way (pure
    // inputResponses never steer, and they stay available to the pending request),
    // but the drain is what advances the durable stream cursor — responding early
    // makes the resume send re-attach from a stale `streamIndex`. The picker renders
    // on the `input.requested` event, which arrives BEFORE the `session.waiting`
    // boundary that advances the session, so a fast click races the drain.
    await turn.drained.catch(() => {})
    if (turn.settled) {
      // The turn was torn down while we waited (abort / drop). Nothing to resume.
      turn.answering = false
      console.error('[eve chat] answerPermission: turn settled while awaiting drain', {
        chatId,
        toolCallId,
        requestId,
      })
      return
    }

    // Re-arm the drain gate for THIS resume send so a nested question (the resumed
    // turn asks another ask_user) can itself be answered without racing.
    armDrainGate(turn)

    // A park can only exist after a turn has dispatched, so the handle is minted by
    // now; the guard keeps the nullable type honest rather than asserting.
    const session = active.session
    if (!session) {
      turn.resolveDrained()
      console.error('[eve chat] answerPermission: no eve session handle to resume', {
        chatId,
        toolCallId,
        requestId,
      })
      restoreMapping()
      return
    }

    // eve 0.70+ HOLDS the turn open on an ask_user (turn.waiting, not
    // turn.completed): the answer resumes the SAME eve turn id, with no new
    // turn.started. So the parked turn's id stays (a Stop targets it at once),
    // and nothing at turn start runs again for the resume, the chat-agent's
    // usage-limit-gate hook included: check usage here before resuming.
    // A Stop on a session-limit prompt runs no model call, so it skips the check.
    const stopsAtLimit = meta?.isSessionLimit === true && isDismiss
    if (!stopsAtLimit && (await this.usageCheck()) === 'blocked') {
      // Over the limit: the usage check's 429 opened the usage-limit dialog.
      // The held turn is not resumed; an answer stays answerable once the
      // person sorts the limit out, while a dismiss still settles the turn.
      turn.resolveDrained()
      if (isDismiss) {
        turn.answering = false
        if (!turn.settled) turn.close()
        this.persistFinishedTurn(active, turn)
      } else {
        restoreMapping()
      }
      return
    }
    // The resumed stretch's steer facts start afresh.
    turn.answerStarted = false
    turn.toolsExecuting.clear()
    turn.toolInputStreaming = false
    turn.parkedIdle = false
    turn.approvalRequested = false
    let resumed: MessageResponse
    try {
      // The respond resumes the held turn, and the channel requires a CURRENT
      // run token on it. A picker can stay open past the token's TTL: re-mint
      // first (the mint also re-runs the usage-limit check) and send the fresh one.
      await this.refreshStaleRunToken(active, chatId)
      // Headers read per attempt: a credentials retry re-mints the run token.
      resumed = await this.withSessionAuthRetry(active, chatId, () =>
        session.respond([inputResponse], { ...respondOptions, headers: this.turnHeaders(active, turn.messageId) }),
      )
    } catch (err) {
      // A stale bundle (eve client older than the server's stream): reload
      // instead of failing the answer (lib/deploy-reload.ts).
      if (reloadForStaleStream(err)) return
      // The resume POST failed (network / eve error). Restore the mapping so a
      // retry can work, and release the drain gate we just armed.
      turn.resolveDrained()
      console.error('[eve chat] answerPermission: resume send failed', {
        chatId,
        toolCallId,
        requestId,
        error: err instanceof Error ? err.message : String(err),
      })
      if (isDismiss && !meta?.isSessionLimit) {
        // A dismiss MUST resolve the parked turn no matter what — otherwise the
        // conversation stays wedged in `streaming` forever. Close it client-side.
        // Not a session-limit Stop: eve holds every later message behind that
        // prompt, so closing here would wedge the session instead. It stays
        // answerable (the card's buttons come back).
        turn.answering = false
        if (!turn.settled) turn.close()
        this.persistFinishedTurn(active, turn)
      } else {
        // A genuine answer (picked or typed): let the user retry (Submit again) —
        // restore mapping so the button isn't permanently dead. The turn stays
        // open (parked) for it.
        restoreMapping()
      }
      return
    }

    // eve sends no result for its own session-limit prompt: the answer is the
    // part's result on the live stream too, or the stream would put the card
    // back to waiting over chat-panel's local flip.
    if (meta?.isSessionLimit && !turn.settled) {
      flipAnswered()
      turn.emit({ type: 'tool-output-available', toolCallId: meta.callId, output: answerOutput, dynamic: true })
    }

    // The resume continues the SAME turn — pump its events into the still-open
    // turn stream so the reply lands where the picker is. A nested park during the
    // resume re-adds to openInputRequests (via the reducer), leaving the turn
    // open for the next answer.
    try {
      if (!turn.settled || turn.stopRequested) {
        for await (const event of resumed) {
          if (turn.stopRequested) {
            if (this.drainStopped(active, turn, event)) break
            continue
          }
          if (turn.settled) break
          if (claimEvent(event, turn) === 'steered') {
            this.settleSteeredTurn(turn)
            this.noteSteerLanded(active, turn, 'applied')
            break
          }
          this.onEvent(event, turn)
          if (active.pendingSteer?.prior === turn) this.maybePostSteer(active, chatId)
        }
      }
    } finally {
      turn.resolveDrained()
    }

    // The resume send + drain is done. If the resumed turn parked AGAIN on a nested
    // ask_user, openInputRequests is non-empty — leave `answering` false and the
    // turn open so the next answerPermission can resume it (unless a posted steer
    // skips it, see afterTurnDrain). Otherwise the turn is finished: clear
    // answering, close (leave `streaming`), and persist once.
    turn.answering = false
    if (!turn.settled && turn.openInputRequests.size === 0) turn.close()
    this.afterTurnDrain(active, turn)
  }

  /**
   * One event of a STOPPED send's response (output discarded). Learns the eve
   * turn this send started or steered and cancels exactly that turn. Returns
   * true once the cancel is requested, so the caller stops reading. If the
   * response reaches its boundary first, the turn ended on its own and nothing
   * is cancelled.
   *
   * Which event names the turn: eve's client starts each send's response at its
   * own delivery, so the first turn-scoped event belongs to the turn that
   * carries this message. That is a `turn.started` (a new turn: a first send, a
   * steer eve ran as the NEXT turn, a HITL resume) or the first event of the
   * running turn a steer was folded into. `input.resolved`/`approval.settled`
   * are skipped: a resume's stream opens with them and they carry the PARKED
   * turn's id. (eve's own MessageResponse.cancel() only learns a turn id from
   * `turn.started`, so it resolves `no_active_turn` for a folded steer — which
   * is why this does not use it.)
   */
  private drainStopped(active: ActiveSession, turn: TurnState, event: HandleMessageStreamEvent): boolean {
    if (turn.serverCancelRequested) return true
    if (event.type === 'input.resolved' || event.type === 'approval.settled') return false
    const turnId = (event as { data?: { turnId?: unknown } }).data?.turnId
    if (typeof turnId !== 'string' || turnId.length === 0) return false
    turn.eveTurnId = turnId
    this.cancelServerTurn(active, turn)
    return true
  }

  /**
   * Stop → request cooperative cancellation of the durable eve turn this
   * TurnState rendered, fire-and-forget (both `accepted` and `no_active_turn`
   * are success per eve's cancel contract; a parked session treats it as a
   * no-op). ONLY ever scoped by `turnId`: an unscoped cancel stops whatever is
   * running, which during a steer can be the previous reply. It needs no
   * registration wait of its own: a turn id is only learned from events, and
   * runTurn reads no event until the session id's registration has settled (the
   * ownership ACL 403s an unregistered id). The abort signal is deliberately
   * NOT passed — it is already aborted.
   */
  private cancelServerTurn(active: ActiveSession, turn: TurnState): void {
    const turnId = turn.eveTurnId
    if (turn.serverCancelRequested || !turnId || !active.session) return
    turn.serverCancelRequested = true
    void active.session
      .cancel({ turnId })
      .catch((err: unknown) => {
        console.warn('[eve chat] Stop: server-side turn cancel failed', {
          turnId,
          error: err instanceof Error ? err.message : String(err),
        })
      })
  }

  /** Drop a chat's session handle so the next send re-attaches. */
  private drop(chatId: string): void {
    const active = this.sessions.get(chatId)
    if (!active) return
    this.sessions.delete(chatId)
    // A held steer goes with the handle (its row goes as an ordinary turn). One
    // on its way (posting / posted) runs in eve, but no browser reads it (the
    // "only the browser writes turns" gap, §2): the panel is told, so the row
    // goes and its words are never sent twice.
    const steer = active.pendingSteer
    active.pendingSteer = null
    if (steer && (steer.phase === 'posting' || steer.phase === 'posted')) steer.onState('dropped')
    active.turn?.close()
  }

  /**
   * Start a fresh eve session for this chat on the next turn (new conversation /
   * loaded a different one). Drops the current handle; the next send re-creates.
   * A prewarm not yet claimed is KEPT: a reset can land while the blank chat's
   * draft is typed, and the panel never asks for a second prewarm. The prewarm still serves only a blank
   * chat: its send re-mints for a different persona or skill (sendMessages),
   * and claimPrewarm abandons it once the chat is bound to a conversation.
   */
  async resetSession(chatId: string): Promise<void> {
    this.drop(chatId)
  }

  async disposeAll(): Promise<void> {
    this.releaseReloadBlocker()
    for (const chatId of [...this.prewarms.keys()]) this.abandonPrewarm(chatId)
    for (const chatId of [...this.sessions.keys()]) this.drop(chatId)
  }
}

// ── Option readers ─────────────────────────────────────────────────────────────

/**
 * Compose the user-facing copy for a 429 usage-limit mint failure from the
 * route's structured body ({ error, reason, usageResetDate, … } — the shape
 * checkUsageLimits throws). This string lands VERBATIM in the chat error toast
 * (prefixed by chat-panel's "Message failed to send:"), so it must read as
 * clean prose, never raw JSON.
 *
 * Formatting rules mirror the chat-agent hook's buildUsageLimitMessage
 * (agents/chat-agent/hooks/usage-limit-gate.ts) so both gates produce
 * IDENTICAL copy — kept as a local twin because the client bundle cannot
 * import from agents/ (a separate eve-compiled root).
 *
 * Examples:
 *   { error:'Usage limit exceeded', reason:'trial_expired',
 *     usageResetDate:'2026-08-01' }
 *     → "Usage limit exceeded: trial_expired. Resets 2026-08-01."
 *   { error:'Usage limit exceeded' } → "Usage limit exceeded."
 */
function usageLimitMintMessage(body: Record<string, unknown>): string {
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v.trim() : null
  const headline = str(body.error) ?? 'Usage limit exceeded'
  const reason = str(body.reason)
  const resetDate = str(body.usageResetDate)
  // No free tier (migration 243): the one reason with a clear next step.
  if (reason === 'subscription_required') {
    return 'Your Native Intelligence trial or subscription isn\'t active. Start a free trial or update billing in Settings → Billing to keep going.'
  }
  let message = reason ? `${headline}: ${reason}` : headline
  if (!/[.!?]$/.test(message)) message += '.'
  if (resetDate) message += ` Resets ${resetDate}.`
  return message
}

/**
 * Read the durable conversation id from the per-turn send options. chat-panel
 * passes it as `body.conversationId` (the surgical addition). Null for a
 * brand-new chat with no saved conversation yet — the mint helper then ensures
 * one server-side.
 */
function readConversationId(options: { body?: unknown }): string | null {
  const body = options.body
  if (body && typeof body === 'object' && 'conversationId' in body) {
    const id = (body as { conversationId?: unknown }).conversationId
    if (typeof id === 'string' && id) return id
  }
  return null
}

/** Read the active agent (persona) id — the tool boundary. */
function readAgentId(options: { body?: unknown }): string | null {
  const body = options.body
  if (body && typeof body === 'object' && 'agentId' in body) {
    const id = (body as { agentId?: unknown }).agentId
    if (typeof id === 'string' && id) return id
  }
  return null
}

/** A teammate chat's item for this send (bots v3 1d: `body.teammateAbout`, ids only), or null. */
function readTeammateAbout(options: { body?: unknown }): TeammateAboutRef | null {
  const body = options.body
  return body && typeof body === 'object' ? parseTeammateAboutRef((body as { teammateAbout?: unknown }).teammateAbout) : null
}

/** Read the active skill (playbook) id — steers behavior, does NOT narrow tools. */
function readSkillId(options: { body?: unknown }): string | null {
  const body = options.body
  if (body && typeof body === 'object' && 'skillId' in body) {
    const id = (body as { skillId?: unknown }).skillId
    if (typeof id === 'string' && id) return id
  }
  return null
}

/** The part of the panel's SystemContext the transport reads off a turn's body. */
interface TurnSystemContext {
  /** Breadcrumb of the current view (e.g. "User is viewing capture: … (id: …)"). */
  conversationContext?: string
  /** True when the user navigated to a different entity since the last message. */
  contextSwitched?: boolean
  /** Text the user has selected in the entity they're viewing. */
  editorSelection?: {
    entityType: string
    entityId: string
    field: string
    selectedText: string
  }
  /** The For you card the person replied to (card-reply.ts), unchecked: read through parseCardReplyRef. */
  replyCard?: unknown
  /**
   * The message in the thread the person replied to, with the words quoted
   * (message-reply.ts), unchecked: read through parseMessageReplyRef. That
   * turn only; its line rides the message eve keeps (readReplyNotes).
   */
  replyTo?: unknown
  /**
   * The reactions the person made on the agent's messages since their last
   * message (message-reactions.ts ReactionNote[], at most REACTION_NOTES_MAX),
   * unchecked: the spec route reads them through parseReactionNotes into the
   * turn's `reactions` section. They ride the ctx with the rest of
   * systemContext; nothing here reads them.
   */
  reactions?: unknown
}

/** Read the viewing-context the panel sends as `body.systemContext`. */
function readSystemContext(options: { body?: unknown }): TurnSystemContext | undefined {
  const body = options.body
  if (!body || typeof body !== 'object' || !('systemContext' in body)) return undefined
  const sc = (body as { systemContext?: unknown }).systemContext
  if (!sc || typeof sc !== 'object') return undefined
  return sc as TurnSystemContext
}

/**
 * Base64url-encode the PER-TURN context (systemContext + the message's routing
 * signals) into the `ctx` string forwarded to the spec route. This is the
 * exact shape the spec route decodes ({ systemContext, route }); a bad/absent
 * value degrades to an empty turn context there (never a 500). Empty string
 * when there is nothing to send. The send body's old `model` and `thinking`
 * are never forwarded: nobody picks a model (src/lib/ai/model-route.ts).
 */
export function encodeTurnContext(
  options: { body?: unknown },
  cards?: unknown[],
  timeZone?: string | null,
  surroundings?: object | null,
  route?: TurnRouteSignals | null,
): string {
  if (surroundings) {
    // The person's local conditions (the main chat): the spec route checks
    // them and the model hears them only when they changed.
    const sent = readSystemContext(options)
    options = { ...options, body: { ...((options.body as Record<string, unknown> | undefined) ?? {}), systemContext: { ...(sent ?? {}), surroundings } } }
  }
  if (timeZone) {
    // The browser's IANA zone (every chat): the zone of the chat's clock and
    // of a calendar card's days, so show and read_card count the days it draws.
    const sent = readSystemContext(options)
    options = { ...options, body: { ...((options.body as Record<string, unknown> | undefined) ?? {}), systemContext: { ...(sent ?? {}), timeZone } } }
  }
  if (cards?.length) {
    // The cards ride inside systemContext, read fresh for this send (the
    // panel's own systemContext is a snapshot spread into the body). The ctx
    // rides in a request header, so past MAX_CTX_WITH_CARDS the turn goes
    // without them rather than not at all.
    const sent = readSystemContext(options)
    const withCards = encodePayload({ ...(sent ?? {}), cards }, route)
    if (withCards.length <= MAX_CTX_WITH_CARDS) return withCards
  }
  return encodePayload(readSystemContext(options), route)
}

/** The longest encoded ctx that may carry the cards (base64url characters). */
export const MAX_CTX_WITH_CARDS = 12_000

function encodePayload(systemContext: unknown, route?: TurnRouteSignals | null): string {
  if (systemContext === undefined && !route) return ''
  const payload: Record<string, unknown> = {}
  if (systemContext !== undefined) payload.systemContext = systemContext
  if (route) payload.route = route
  return base64UrlEncode(JSON.stringify(payload))
}

/** UTF-8 → base64url. Works in the browser (btoa) and Node (Buffer). */
function base64UrlEncode(s: string): string {
  let b64: string
  if (typeof Buffer !== 'undefined') {
    b64 = Buffer.from(s, 'utf8').toString('base64')
  } else {
    // Browser: encode UTF-8 safely before btoa.
    b64 = btoa(String.fromCharCode(...new TextEncoder().encode(s)))
  }
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Flatten a UIMessage's text parts into a single string. */
function extractText(msg: UIMessage): string {
  return msg.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

/** A URL eve can hand the model for an attachment: https, or an inline image data: URL. */
/** The longest storage path or file name a photo note carries. */
const PHOTO_NOTE_FIELD_MAX = 512

/** A chat upload's name or storage path, on one line, or null when it isn't one. */
function noteField(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const flat = value.replace(/[\r\n]+/g, ' ').trim()
  return flat && flat.length <= PHOTO_NOTE_FIELD_MAX ? flat : null
}

/**
 * The lines naming what the person replied to, for the message eve keeps: the
 * message in the thread, with the words they quoted (systemContext.replyTo,
 * checked: message-reply.ts messageReplyNote), then the For you card
 * (systemContext.replyCard, checked: card-reply.ts cardReplyNote), by its kind
 * and id only. Either, both or none. They ride the message itself, so what
 * the person meant is named even on a turn whose context failed to load, and
 * in the turns after ("make that shorter" two turns later still knows what
 * "that" is).
 */
function readReplyNotes(options: { body?: unknown }): string[] {
  const sc = readSystemContext(options)
  const message = parseMessageReplyRef(sc?.replyTo)
  const card = parseCardReplyRef(sc?.replyCard)
  return [...(message ? [messageReplyNote(message)] : []), ...(card ? [cardReplyNote(card)] : [])]
}

/** The turn's uploads (the composer's chatFiles meta in the send body's systemContext). */
function readChatFiles(options: { body?: unknown }): unknown[] {
  const body = options.body
  if (!body || typeof body !== 'object') return []
  const sc = (body as { systemContext?: unknown }).systemContext
  const files = sc && typeof sc === 'object' ? (sc as { chatFiles?: unknown }).chatFiles : undefined
  return Array.isArray(files) ? files : []
}

/**
 * The eve message for a user turn: always TEXT. A photo the person attached
 * is never sent as a file part: eve stages a message's file parts into a
 * sandbox it provisions first (harness/attachment-staging.js calls
 * SandboxKey.get() for any file part, an https URL included), and the
 * chat-agent is sandbox-free; and the upload's signed URL would sit in the
 * session's history and die after an hour. Instead each photo is named on its
 * own line with its storage_path, and the model looks at it with
 * read_chat_file, which hands the image back to a model that can view one
 * (agents/chat-agent/lib/chat-image-output.ts). Text files are listed in the
 * "Chat File Uploads" prompt block, as before.
 *
 * `replyNotes` (readReplyNotes) go first, under the person's words: the
 * message they replied to, then the card. A reaction's own turn needs nothing
 * here: its text part already is the line eve should read
 * (message-reactions.ts reactionTurnText), sent as it is.
 */
export function eveUserContent(text: string, chatFiles: readonly unknown[], replyNotes: readonly string[] = []): string {
  const notes: string[] = [...replyNotes]
  for (const file of chatFiles) {
    if (!file || typeof file !== 'object') continue
    const f = file as { storagePath?: unknown; fileName?: unknown; mimeType?: unknown }
    if (typeof f.mimeType !== 'string' || !f.mimeType.toLowerCase().startsWith('image/')) continue
    const storagePath = noteField(f.storagePath)
    if (!storagePath) continue
    const name = noteField(f.fileName) ?? 'photo'
    notes.push(
      `[Photo ${JSON.stringify(name)} attached, not in this message: call read_chat_file with storage_path ${JSON.stringify(storagePath)} to see it.]`,
    )
  }
  if (notes.length === 0) return text
  return [text, ...notes].filter(Boolean).join('\n\n')
}

/** Prepend the mint's "conversation so far" block to a new session's first message. */
export function withHistoryPrimer(primer: string, message: string | UserContent): string | UserContent {
  if (typeof message === 'string') return `${primer}\n\n${message}`
  return [{ type: 'text' as const, text: primer }, ...message]
}

/**
 * Whether a stream event feeds the persist body's (display-only, never billed —
 * see agents/chat-agent/hooks/usage-meter.ts) usage summary. These — and ONLY
 * these — are retained on TurnState.events and shipped in the persist body,
 * in the shape `mapEveTurnUsage` (src/lib/chat/eve-usage.ts) reads:
 * `step.completed` for tokens/cost/steps/gateway generation ids and
 * `actions.requested` for tool-call + discovery counts. Every other event type
 * (each `message.appended` text delta above all) is dropped after translation so
 * a long turn no longer accumulates one retained object per delta. The mapping's
 * meta.at duration bracket is a non-issue: the transport always passes wallMs,
 * which mapEveTurnUsage prefers.
 */
export function isUsageRelevantEvent(event: HandleMessageStreamEvent): boolean {
  return event.type === 'step.completed' || event.type === 'actions.requested'
}

// ── Time-to-first-token marks (docs/plans/chat-ttft.md, Phase 0) ─────────────

/**
 * The eve event types whose FIRST `meta.at` a turn keeps. The four output
 * types count only when they carry output: a non-empty delta, or the requested
 * call itself (a tool call whose input was never streamed still ends the wait).
 */
const SERVER_TIMING_EVENTS = [
  'session.started',
  'turn.started',
  'message.received',
  'step.started',
  'reasoning.appended',
  'message.appended',
  'action.input.appended',
  'actions.requested',
] as const
type ServerTimingEvent = (typeof SERVER_TIMING_EVENTS)[number]

/** The delta types among them: output only when the delta is non-empty. */
const DELTA_TIMING_EVENTS: ReadonlySet<string> = new Set([
  'reasoning.appended',
  'message.appended',
  'action.input.appended',
])

/**
 * One turn's TTFT marks, on two clocks that are never subtracted across:
 *  - `client`: `performance.now()` where the transport passes each point, from
 *    the entry of sendMessages to the first output the turn's stream carried.
 *  - `server`: the first eve `meta.at` (ISO-8601, server clock) seen per
 *    SERVER_TIMING_EVENTS type, as epoch ms.
 * Only the send's own stream is marked (runTurn's loop), never a HITL resume.
 */
export interface TurnTimingMarks {
  client: {
    /** sendMessages entered. */
    submit?: number
    /** The run token minted (absent when a send skips the mint). */
    minted?: number
    /** eve accepted the create / send POST. */
    created?: number
    /** eve_session_id registered (a session registered in this send only). */
    registered?: number
    /** The first event of the send's stream. */
    firstEvent?: number
    /** The first non-empty reasoning delta. */
    firstReasoning?: number
    /** The first non-empty answer-text delta. */
    firstText?: number
    /** The first tool input: a streamed input delta, or the requested call. */
    firstToolInput?: number
  }
  server: Partial<Record<ServerTimingEvent, number>>
  /**
   * The turn's dispatch created its eve session (sessions.create). A path that
   * creates the session before the send (a prewarm) must set it too.
   */
  newSession: boolean
  /** The send ran on a prewarmed session (see EveChatTransport.prewarm), which it then set up. */
  prewarmed: boolean
  /** The model eve resolved for the turn's first model call (`step.started`). */
  model?: string
}

/** The client clock for TTFT marks: monotonic, and never compared with `meta.at`. */
function clientNow(): number {
  return performance.now()
}

/** Which output an event is, if any (an empty delta is none, as in onEvent). */
function outputKindOf(event: HandleMessageStreamEvent): 'reasoning' | 'text' | 'tool' | null {
  // Read loosely: telemetry must never throw on an event the projection tolerates.
  const data = (event as { data?: Record<string, unknown> }).data
  switch (event.type) {
    case 'reasoning.appended':
      return typeof data?.reasoningDelta === 'string' && data.reasoningDelta ? 'reasoning' : null
    case 'message.appended':
      return typeof data?.messageDelta === 'string' && data.messageDelta ? 'text' : null
    case 'action.input.appended':
      return typeof data?.inputTextDelta === 'string' && data.inputTextDelta ? 'tool' : null
    case 'actions.requested':
      return 'tool'
    default:
      return null
  }
}

function isServerTimingEvent(type: string): type is ServerTimingEvent {
  return (SERVER_TIMING_EVENTS as readonly string[]).includes(type)
}

/** eve's `meta.at` as epoch ms, or null when it is absent or unparseable. */
function eventServerTime(event: HandleMessageStreamEvent): number | null {
  const at = (event as { meta?: { at?: unknown } }).meta?.at
  if (typeof at !== 'string') return null
  const ms = Date.parse(at)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Mark one event of the send's own stream. Every mark is first-seen: later
 * events of the same kind (the next step, the next delta) never move it.
 */
function markTurnEvent(marks: TurnTimingMarks, event: HandleMessageStreamEvent, now: number): void {
  const client = marks.client
  client.firstEvent ??= now
  const output = outputKindOf(event)
  if (output === 'reasoning') client.firstReasoning ??= now
  else if (output === 'text') client.firstText ??= now
  else if (output === 'tool') client.firstToolInput ??= now

  if (event.type === 'step.started' && marks.model === undefined) {
    const modelId = (event as { data?: { modelId?: unknown } }).data?.modelId
    if (typeof modelId === 'string' && modelId.length > 0) marks.model = modelId
  }

  const type = event.type
  if (!isServerTimingEvent(type) || marks.server[type] !== undefined) return
  if (DELTA_TIMING_EVENTS.has(type) && output === null) return
  const at = eventServerTime(event)
  if (at !== null) marks.server[type] = at
}

/** A non-negative whole-ms span between two marks of ONE clock, or undefined. */
function spanMs(from: number | undefined, to: number | undefined): number | undefined {
  if (typeof from !== 'number' || typeof to !== 'number') return undefined
  const ms = to - from
  if (!Number.isFinite(ms) || ms < 0) return undefined
  return Math.round(ms)
}

/** The earliest finite mark, or undefined when there is none. */
function earliest(...marks: Array<number | undefined>): number | undefined {
  let min: number | undefined
  for (const m of marks) {
    if (typeof m === 'number' && Number.isFinite(m) && (min === undefined || m < min)) min = m
  }
  return min
}

/**
 * The turn's TTFT phases from its marks (each key is described in
 * TURN_TIMING_MS_KEYS, src/lib/chat/turn-timings.ts): non-negative whole ms,
 * and a phase whose marks are missing (or run backwards, or are not finite) is
 * omitted rather than guessed.
 * `new_session` and `prewarmed` are always present.
 *
 * The client stages chain through the marks the send actually passed: a turn
 * on a live session registers nothing and a prewarmed one mints nothing, so
 * each stage starts at the latest earlier mark it has. A steering send's wait
 * for the prior turn's identity falls inside its create stage.
 *
 * `server_thinking_ms` ends at the first text OR tool input after the
 * reasoning, not at the first text: when the model thinks and then calls a
 * tool, the first text only arrives after the tool ran.
 */
export function deriveTurnTimings(marks: TurnTimingMarks): ChatTurnTimings {
  const { client: c, server: s } = marks
  const out: ChatTurnTimings = { new_session: marks.newSession === true, prewarmed: marks.prewarmed === true }
  const put = (key: TurnTimingMsKey, ms: number | undefined) => {
    if (ms !== undefined) out[key] = ms
  }

  put('client_first_output_ms', spanMs(c.submit, earliest(c.firstReasoning, c.firstText, c.firstToolInput)))
  put('client_first_text_ms', spanMs(c.submit, c.firstText))
  put('client_mint_ms', spanMs(c.submit, c.minted))
  put('client_create_ms', spanMs(c.minted ?? c.submit, c.created))
  put('client_register_ms', spanMs(c.created, c.registered))
  put('client_stream_open_ms', spanMs(c.registered ?? c.created, c.firstEvent))

  const firstAnswer = earliest(s['message.appended'], s['action.input.appended'], s['actions.requested'])
  put('server_session_setup_ms', spanMs(s['session.started'], s['turn.started']))
  put('server_turn_setup_ms', spanMs(s['turn.started'], s['message.received']))
  put('server_first_output_ms', spanMs(s['step.started'], earliest(s['reasoning.appended'], firstAnswer)))
  put('server_thinking_ms', spanMs(s['reasoning.appended'], firstAnswer))

  if (marks.model) out.model = marks.model
  return out
}

/**
 * (Re-)arm the turn's drain gate: a fresh promise that `runTurn` (and each resume
 * loop in answerPermission) resolves once its send's stream has drained to the eve
 * turn boundary. answerPermission awaits it before issuing the resume send so it
 * never runs against a session whose `continuationToken` hasn't been advanced yet
 * (which makes eve's send throw before any POST — the dead-Submit bug).
 */
function armDrainGate(turn: TurnState): void {
  let resolve: () => void = () => {}
  turn.drained = new Promise<void>((r) => {
    resolve = r
  })
  turn.resolveDrained = resolve
}

/** (Re-)arm the turn's identity gate — see TurnState.identified. */
function armIdentifiedGate(turn: TurnState): void {
  let resolve: () => void = () => {}
  turn.identified = new Promise<void>((r) => {
    resolve = r
  })
  turn.resolveIdentified = resolve
}

/**
 * Upper bound on how long a steering send waits for the steered turn's identity.
 * Normally that is its first stamped event (milliseconds into a live stream).
 * The bound is liveness insurance only: past it the send proceeds, at worst
 * risking the fold-at-turn-start overlap the wait exists to prevent.
 */
const STEER_IDENTITY_WAIT_MS = 15_000

/**
 * Undo `sendMessages`' `superseded` mark on the prior turn when the steering
 * send never reached eve (Stop before its POST, or the POST failed). Otherwise
 * the prior turn would keep treating ANY later foreign delivery id — e.g. the
 * same chat steered from another tab — as a steer point and cut its own tail
 * off, with no local steering response to render it.
 */
function releaseSteer(steered: TurnState | null): void {
  if (steered && !steered.settled) steered.superseded = false
}

/**
 * Wait until `turn` knows its own deliveryIds (or settled / drained), the send
 * is aborted, or STEER_IDENTITY_WAIT_MS elapses — whichever comes first.
 */
async function waitForTurnIdentity(turn: TurnState, abortSignal?: AbortSignal): Promise<void> {
  if (turn.ownDeliveryIds !== null || turn.settled) return
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    await Promise.race([
      turn.identified,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, STEER_IDENTITY_WAIT_MS)
      }),
      new Promise<void>((resolve) => {
        if (!abortSignal) return
        if (abortSignal.aborted) return resolve()
        onAbort = () => resolve()
        abortSignal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort) abortSignal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Attribute one stream event to `turn` by eve's `meta.deliveryIds` (see
 * runTurn's turnPolicy comment). Returns 'steered' when `turn` was superseded by
 * a later send and this event carries a delivery id it does not own — the steer
 * point, where the steering send's response takes over. Otherwise 'own' (and
 * the first stamped event teaches the turn its ids). Events without
 * deliveryIds are always 'own'. A foreign id on a turn that was NOT superseded
 * here (e.g. the same chat steered from another tab) is adopted, so the turn
 * keeps rendering the stream it is the only local consumer of.
 */
function claimEvent(event: HandleMessageStreamEvent, turn: TurnState): 'own' | 'steered' {
  const verdict = attributeEvent(event, turn)
  if (verdict === 'own') noteEveTurnId(event, turn)
  return verdict
}

function attributeEvent(event: HandleMessageStreamEvent, turn: TurnState): 'own' | 'steered' {
  const ids = event.meta?.deliveryIds
  if (!ids || ids.length === 0) return 'own'
  if (turn.ownDeliveryIds === null) {
    turn.ownDeliveryIds = new Set(ids)
    turn.resolveIdentified()
    return 'own'
  }
  const own = turn.ownDeliveryIds
  if (ids.every((id) => own.has(id))) return 'own'
  if (turn.superseded) return 'steered'
  for (const id of ids) own.add(id)
  return 'own'
}

// ── Steering helpers (UI-2) ──────────────────────────────────────────────────

/**
 * Tools eve gates on the person's approval (their call parks the turn on an
 * input request): ask_user in the chat-agent, plus any other tool an approval
 * request has named so far (learned in trackSteerFacts).
 */
const APPROVAL_TOOL_NAMES = new Set<string>([ASK_USER_TOOL_NAME])

/** Thrown by firstEventWithin when the source yields nothing in time. */
class FirstEventTimeout extends Error {
  constructor() {
    super('no event in time')
    this.name = 'FirstEventTimeout'
  }
}

/**
 * `source`, failing with FirstEventTimeout when its first event takes longer
 * than `ms`. The abandoned read is left to end on its own (eve's response has
 * no abort wired, see runTurn).
 */
function firstEventWithin<T>(source: AsyncIterable<T>, ms: number): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      const it = source[Symbol.asyncIterator]()
      let timer: ReturnType<typeof setTimeout> | undefined
      const first = await Promise.race([
        it.next(),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), ms)
        }),
      ]).finally(() => clearTimeout(timer))
      if (first === 'timeout') throw new FirstEventTimeout()
      if (first.done) return
      yield first.value
      for (;;) {
        const next = await it.next()
        if (next.done) return
        yield next.value
      }
    },
  }
}

/**
 * A send whose session accepted it and then never started a turn (see
 * TURN_START_STALL_MS). `code` lets the panel offer its Retry; the handle is
 * already dropped, so that Retry runs on a fresh session.
 */
export class EveSessionStalledError extends Error {
  readonly code = 'EVE_SESSION_STALLED'
  /** Why: no turn running (`idle`), or the bounded wait behind a compaction ran out (`wait_timed_out`). */
  constructor(readonly reason: StallReason = 'idle') {
    super(SESSION_STALLED_COPY)
    this.name = 'EveSessionStalledError'
  }
}

/** Why a send's session was dropped as dead (EveSessionStalledError.reason). */
export type StallReason = 'idle' | 'wait_timed_out'

/** EveSessionBusyError's code: what the panel's onError matches a busy refusal on. */
export const EVE_SESSION_BUSY = 'EVE_SESSION_BUSY'

/**
 * A Retry (or any send) that found the session its chat had dropped as dead
 * busy again: compacting or running a turn. Nothing was sent and no fresh
 * session registered over it (it is re-attached for the next send).
 */
export class EveSessionBusyError extends Error {
  readonly code = EVE_SESSION_BUSY
  constructor() {
    super(SESSION_BUSY_COPY)
    this.name = 'EveSessionBusyError'
  }
}

/**
 * What a stalled send's health read found: a turn running (slow, keep
 * waiting), a compaction running (keep waiting, bounded), or a dead session.
 */
export type SessionHealth = 'alive' | 'compacting' | 'dead'

/** A health read looks at this many of the session's newest events, never its whole history. */
export const SESSION_HEALTH_TAIL_EVENTS = 200
/** After its first event, a pause this long in the tail read means the durable tail was reached. */
const SESSION_HEALTH_TAIL_IDLE_MS = 750

/**
 * The session's health from its newest SESSION_HEALTH_TAIL_EVENTS events (a
 * tail read, as idle compaction and the home turn read it: the biggest
 * sessions are the ones that stall, and a read from event 0 could outlast the
 * cap and read as dead). Bounded by `ms`; the read stops at the tail's first
 * pause. A turn streaming the whole time is read until `ms` and judged on
 * what came. No event at all (a failed or slow open): dead. Never throws.
 * See healthOfEvents for the verdicts.
 */
export async function sessionHealth(
  session: Pick<ClientSession, 'stream'>,
  ms: number,
  tailIdleMs: number = SESSION_HEALTH_TAIL_IDLE_MS,
): Promise<SessionHealth> {
  const controller = new AbortController()
  const deadline = Date.now() + ms
  const events: Array<{ type?: unknown }> = []
  let it: AsyncIterator<unknown> | null = null
  try {
    it = session
      .stream({ startIndex: -SESSION_HEALTH_TAIL_EVENTS, streamReconnectPolicy: { reconnect: false }, signal: controller.signal })
      [Symbol.asyncIterator]()
    for (;;) {
      const left = deadline - Date.now()
      if (left <= 0) break
      const next = it.next()
      // An abandoned read rejects on the abort below: never unhandled.
      next.catch(() => {})
      const r = await raceTimeout(next, events.length === 0 ? left : Math.min(tailIdleMs, left))
      if (r === 'timeout' || r.done) break
      events.push(r.value as { type?: unknown })
    }
  } catch {
    // A torn read: judged on what came, if anything.
  } finally {
    controller.abort()
    try {
      void it?.return?.()?.catch(() => {})
    } catch {
      /* already closed */
    }
  }
  return events.length === 0 ? 'dead' : healthOfEvents(events)
}

/** Ends of a turn. */
const TURN_END_EVENTS: ReadonlySet<unknown> = new Set(['turn.completed', 'turn.failed', 'turn.cancelled'])
/** Events that are not a turn's own activity: the park, session lifecycle, compaction, a clear. */
const BETWEEN_TURN_EVENTS: ReadonlySet<unknown> = new Set([
  'session.waiting',
  'session.started',
  'compaction.requested',
  'compaction.completed',
  'context.cleared',
])

/**
 * sessionHealth's reading of a window of the session's newest events (pure):
 *   - ended (`session.failed` / `session.completed`): dead;
 *   - a turn running (any turn activity, `turn.started` included, after the
 *     last turn's end; the window may begin mid-turn, past its
 *     `turn.started`): alive, only slow, so the send keeps waiting for it;
 *   - a compaction running (a `compaction.requested` with no
 *     `compaction.completed` / `session.waiting` / turn end after it): eve's
 *     compact-only pass (idle compaction) emits no `turn.started` (eve 0.79.1
 *     harness/compaction/step.js compactHistory), and the message just
 *     accepted waits behind it, silent until its turn starts: compacting;
 *   - idle (no turn running, so the message just accepted never started one:
 *     a retired deployment's run, never resumed): dead.
 */
export function healthOfEvents(events: ReadonlyArray<{ type?: unknown }>): SessionHealth {
  let lastActivity = -1
  let lastEnd = -1
  let lastCompaction = -1
  let lastCompactionEnd = -1
  for (let i = 0; i < events.length; i++) {
    const type = events[i]?.type
    if (type === 'session.failed' || type === 'session.completed') return 'dead'
    if (TURN_END_EVENTS.has(type)) {
      lastEnd = i
      // A turn's end closes a compaction too: an automatic one runs inside
      // its turn, and a turn that ends has no compaction left open.
      lastCompactionEnd = i
    } else if (type === 'compaction.requested') lastCompaction = i
    // A failed compact-only pass emits no compaction.completed, only the park.
    else if (type === 'compaction.completed' || type === 'session.waiting') lastCompactionEnd = i
    else if (!BETWEEN_TURN_EVENTS.has(type)) lastActivity = i
  }
  if (lastActivity > lastEnd) return 'alive'
  return lastCompaction > lastCompactionEnd ? 'compacting' : 'dead'
}

/** How a stalled send waits behind a compaction (stalledSendWatch). */
interface CompactionWait {
  /** The longest wait while it reads compacting (COMPACTION_WAIT_MS). */
  maxMs: number
  /** How often the health is read again meanwhile (COMPACTION_POLL_MS). */
  pollMs: number
  /** Entering (`'compacting'`) and leaving (`null`) the wait. */
  onBusy: (state: SessionBusyState | null) => void
}

/** `pending`, or 'timeout' after `ms`. */
async function raceTimeout<T>(pending: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    pending,
    new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * `source`, watched until its first event: when none comes within `ms`, the
 * session's health is read (`health`).
 *   - Alive (a turn running, only slow): the same read goes on, with no limit.
 *   - Compacting (the message waits behind an idle compaction): the read goes
 *     on and the health is read again every `compaction.pollMs`, at most
 *     `compaction.maxMs` in all (then it reads as dead). The panel hears
 *     `onBusy('compacting')` meanwhile. Once the compaction ends, the turn has
 *     one more `ms` to show itself (the park and the queued turn's start are
 *     two events, and a read between them sees an idle session).
 *   - Dead: EveSessionStalledError.
 * Once the first event is in, everything passes straight through.
 */
function stalledSendWatch<T>(source: AsyncIterable<T>, ms: number, health: () => Promise<SessionHealth>, compaction: CompactionWait): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      const it = source[Symbol.asyncIterator]()
      let watching = true
      const first = async (): Promise<IteratorResult<T>> => {
        const pending = it.next()
        let window = ms
        let compactingSince: number | null = null
        let graced = false
        try {
          for (;;) {
            const raced = await raceTimeout(pending, window)
            if (raced !== 'timeout') return raced
            const verdict = await health()
            if (verdict === 'alive') return pending
            if (verdict === 'dead') {
              if (compactingSince === null || graced) throw new EveSessionStalledError('idle')
              graced = true
              window = ms
              continue
            }
            const now = Date.now()
            if (compactingSince === null) {
              compactingSince = now
              compaction.onBusy('compacting')
            }
            const left = compaction.maxMs - (now - compactingSince)
            if (left <= 0) throw new EveSessionStalledError('wait_timed_out')
            graced = false
            window = Math.min(compaction.pollMs, left)
          }
        } finally {
          if (compactingSince !== null) compaction.onBusy(null)
        }
      }
      // Past the first event every read goes straight to the source (no
      // added hop), so the stream's timing is the source's own.
      return {
        next: () => {
          if (!watching) return it.next()
          watching = false
          return first()
        },
        return: (value?: unknown) => (it.return ? it.return(value as never) : Promise.resolve({ done: true as const, value: undefined as never })),
      }
    },
  }
}

/** This turn rendered answer text (a cancelled fold's answer already started). */
function hasAnswerText(turn: TurnState): boolean {
  return turn.parts.some((p) => p.type === 'text' && typeof p.text === 'string' && p.text.trim().length > 0)
}

/**
 * eve answered the request with a refusal (an HTTP status, or the session
 * credentials could not be restored), so it never accepted it. A failure with
 * neither (the network dropped mid-request) may have reached eve.
 */
function isRefusedByEve(err: unknown): boolean {
  if (typeof err === 'object' && err !== null && typeof (err as { status?: unknown }).status === 'number') return true
  return err instanceof Error && err.message === SESSION_EXPIRED_RELOAD_COPY
}

/** A new id for an assistant reply (TurnState.messageId). */
function newReplyId(chatId: string): string {
  return `${EVE_REPLY_ID_PREFIX}${chatId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * The part of the turn-opening user message's metadata its stored row keeps
 * (persist-eve-turn.ts userMessageOf parses each again): `replyCard`,
 * `replyTo`, and a reaction turn's `kind` with its `reaction`. Copied as the
 * client wrote them; nothing else of the metadata goes (the skill's name, the
 * time it was made: the autosave keeps those). An empty object when there is
 * none of it.
 */
function persistedUserMetadata(metadata: unknown): { metadata?: Record<string, unknown> } {
  if (!metadata || typeof metadata !== 'object') return {}
  const m = metadata as Record<string, unknown>
  const kept: Record<string, unknown> = {
    ...('replyCard' in m ? { replyCard: m.replyCard } : {}),
    ...('replyTo' in m ? { replyTo: m.replyTo } : {}),
    ...(m.kind === REACTION_TURN_KIND && 'reaction' in m ? { kind: m.kind, reaction: m.reaction } : {}),
  }
  return Object.keys(kept).length > 0 ? { metadata: kept } : {}
}

/** A fresh TurnState for one send (its stream closures are wired by openTurnStream). */
function newTurnState(
  chatId: string,
  lastUser: UIMessage | undefined,
  timings: TurnTimingMarks,
  messageId: string = newReplyId(chatId),
): TurnState {
  const turn: TurnState = {
    messageId,
    textId: null,
    textClosed: false,
    reasoningId: null,
    reasoningClosed: false,
    started: false,
    settled: false,
    announcedTools: new Set(),
    openInputRequests: new Set(),
    inputRequestIdByCallId: new Map(),
    inputRequestMeta: new Map(),
    askUserAnswered: new Map(),
    userMessage: lastUser
      ? {
          messageId: lastUser.id,
          parts: (lastUser.parts ?? []) as EveMessagePart[],
          // What it replied to stays on its row: the card (card-reply.ts) and
          // the message it quoted (message-reply.ts); and a reaction's own
          // turn keeps what its line draws (message-reactions.ts). The persist
          // route checks each again.
          ...persistedUserMetadata(lastUser.metadata),
        }
      : null,
    parts: [],
    toolPartIndex: new Map(),
    events: [],
    startedAt: Date.now(),
    timings,
    persisted: false,
    userPersisted: false,
    drained: Promise.resolve(),
    resolveDrained: () => {},
    answering: false,
    ownDeliveryIds: null,
    superseded: false,
    eveTurnId: null,
    stopRequested: false,
    serverCancelRequested: false,
    identified: Promise.resolve(),
    resolveIdentified: () => {},
    answerStarted: false,
    toolsExecuting: new Set(),
    toolInputStreaming: false,
    parkedIdle: false,
    approvalRequested: false,
    steersInTurn: 0,
    adoptedSteer: null,
    steerOutcome: null,
    steerFirstEventAt: null,
    resendOnCancel: false,
    emit: () => {},
    close: () => {},
    fail: () => {},
  }
  armIdentifiedGate(turn)
  // Arm the FIRST drain gate before the initial send iterates (runTurn resolves
  // it when the stream reaches the turn boundary → the eve session is advanced).
  armDrainGate(turn)
  return turn
}

/** The send body's `steerId` (UI-2): the posted steer this send adopts. */
function readSteerId(options: { body?: unknown }): string | null {
  const body = options.body
  if (body && typeof body === 'object' && 'steerId' in body) {
    const id = (body as { steerId?: unknown }).steerId
    if (typeof id === 'string' && id) return id
  }
  return null
}

/** The chat's steer on its way (posting/posted) against `turn`, if any. */
function steerInFlightFor(active: ActiveSession, turn: TurnState): PendingSteer | null {
  const steer = active.pendingSteer
  if (!steer || steer.prior !== turn) return null
  return steer.phase === 'posting' || steer.phase === 'posted' ? steer : null
}

/** The running turn's facts, as steerOpening reads them. */
function steerFactsOf(turn: TurnState): SteerOpeningFacts {
  return {
    identified: turn.ownDeliveryIds !== null,
    // A requested approval-gated call (ask_user) parks the turn the moment
    // eve publishes its input request: treat it as parked already, so a steer
    // never POSTs into a turn about to wait on the person (it would only skip
    // the question, and eve keeps the approval pending).
    parked: turn.openInputRequests.size > 0 || turn.approvalRequested,
    answerStarted: turn.answerStarted,
    toolExecuting: turn.toolsExecuting.size > 0,
    toolCallStarting: turn.toolInputStreaming,
  }
}

/**
 * Keep a turn's steer facts current from one event (eve's own definitions,
 * harness/generation-steering.js): answer output is a non-empty answer delta
 * or a non-empty message.completed (reasoning is not); a tool executes from
 * its request to its result; a tool call starts when its input streams.
 */
function trackSteerFacts(turn: TurnState, event: HandleMessageStreamEvent): void {
  const data = (event as { data?: Record<string, unknown> }).data
  switch (event.type) {
    case 'turn.started':
      turn.answerStarted = false
      turn.toolsExecuting.clear()
      turn.toolInputStreaming = false
      turn.approvalRequested = false
      return
    case 'input.requested': {
      // Learn every tool eve gates on the person's approval, beyond ask_user.
      const requests = Array.isArray(data?.requests) ? (data.requests as Array<Parameters<typeof describeApproval>[0] & { action?: { toolName?: unknown } }>) : []
      for (const request of requests) {
        const name = request.action?.toolName
        if (typeof name === 'string' && name && describeApproval(request).isApproval) APPROVAL_TOOL_NAMES.add(name)
      }
      return
    }
    case 'message.appended':
      if (typeof data?.messageDelta === 'string' && data.messageDelta) turn.answerStarted = true
      return
    case 'message.completed':
      if (typeof data?.message === 'string' && data.message) turn.answerStarted = true
      return
    case 'action.input.appended':
      if (typeof data?.inputTextDelta !== 'string' || !data.inputTextDelta) return
      if (typeof data.toolName === 'string' && APPROVAL_TOOL_NAMES.has(data.toolName)) turn.approvalRequested = true
      else turn.toolInputStreaming = true
      return
    case 'actions.requested': {
      turn.toolInputStreaming = false
      const actions = Array.isArray(data?.actions)
        ? (data.actions as Array<{ kind?: string; callId?: string; toolName?: string }>)
        : []
      for (const action of actions) {
        if (action.kind === 'tool-call' && typeof action.toolName === 'string' && APPROVAL_TOOL_NAMES.has(action.toolName)) {
          // Not a tool that executes on its own: the turn is about to park.
          turn.approvalRequested = true
          continue
        }
        if (typeof action.callId === 'string' && resultProducingActionName(action) !== null) {
          turn.toolsExecuting.add(action.callId)
        }
      }
      return
    }
    case 'action.result': {
      const callId = (data?.result as { callId?: unknown } | undefined)?.callId
      if (typeof callId === 'string') turn.toolsExecuting.delete(callId)
      return
    }
    case 'step.completed':
      turn.toolInputStreaming = false
      return
    default:
      return
  }
}

/**
 * An adopted steer's outcome, from its response's first turn-scoped event:
 * the running turn's id (no turn.started) means eve took it into that turn;
 * a new turn means it fell through. Applied carries the turn's facts over
 * (eve's outputStarted is turn-scoped), and a fold into a turn Send now
 * cancelled arms the one re-send.
 */
function noteAdoptedOutcome(turn: TurnState, event: HandleMessageStreamEvent): void {
  const adopted = turn.adoptedSteer
  if (!adopted || turn.steerOutcome) return
  const turnId = (event as { data?: { turnId?: unknown } }).data?.turnId
  if (typeof turnId !== 'string' || !turnId) return
  turn.steerFirstEventAt = Date.now()
  const applied = event.type !== 'turn.started' && adopted.priorTurnId !== null && turnId === adopted.priorTurnId
  turn.steerOutcome = applied ? 'applied' : 'next_turn'
  if (applied) {
    turn.answerStarted = adopted.priorAnswerStarted
    turn.steersInTurn = adopted.priorSteersInTurn + 1
    if (adopted.priorStopped) turn.resendOnCancel = true
  }
}

/** The steer facts an adopted turn's persist carries (numbers and enums only). */
function steerTelemetryOf(turn: TurnState): SteerTelemetry {
  const a = turn.adoptedSteer!
  const outcome = turn.steerOutcome ?? a.landed ?? 'next_turn'
  const out: SteerTelemetry = { outcome }
  if (a.postedAt !== null) {
    out.held_ms = Math.max(0, a.postedAt - a.requestedAt)
    if (turn.steerFirstEventAt !== null) out.apply_ms = Math.max(0, turn.steerFirstEventAt - a.postedAt)
  }
  if (a.opening) out.opening = a.opening
  if (outcome === 'applied' && turn.steersInTurn > 0) out.steers_in_turn = turn.steersInTurn
  if (a.priorStopped) out.sent_now = true
  return out
}

/** A client-side `[chat-steer]` line for a steer that never persists (edited, failed, unposted). */
function logSteer(fields: Record<string, unknown>): void {
  try {
    console.info('[chat-steer]', JSON.stringify(fields))
  } catch {
    /* telemetry never throws */
  }
}

/** Remember the eve turn id an event this turn claimed is scoped to (Stop cancels it). */
function noteEveTurnId(event: HandleMessageStreamEvent, turn: TurnState): void {
  const turnId = (event as { data?: { turnId?: unknown } }).data?.turnId
  if (typeof turnId === 'string' && turnId.length > 0) turn.eveTurnId = turnId
}

/** Whether the turn is parked on eve's session-limit prompt (a steer can't skip it). */
function holdsSessionLimit(turn: TurnState): boolean {
  for (const meta of turn.inputRequestMeta.values()) if (meta.isSessionLimit) return true
  return false
}

/**
 * Classify an eve input request and pull its approve/cancel option ids off the
 * request itself.
 *
 * An APPROVAL gate has exactly two options [{id:'approve'},{id:'cancel'}] with
 * `display: 'confirmation'` — eve builds these for any tool gated with an
 * `approval` (Native Intelligence's ask_user uses `approval: always()`). Ground truth in the
 * installed eve (re-verified at 0.66.3): `harness/input-extraction.js` `extractApprovalRequests`
 * emits literally `options:[{id:'approve',label:'Approve'},{id:'cancel',
 * label:'Cancel'}]`. eve 0.32.0 renamed this negative verb from 'deny' to
 * 'cancel' ('approve' is unchanged).
 *
 * eve's `resolveApprovalOutcome` (harness/input-request-resolution.js) treats
 * `optionId === 'approve'` as approved, `'cancel'` OR the legacy `'deny'` as
 * denied, and ANY OTHER value as `status: 'invalid'` — which leaves the approval
 * unresolved and the turn deferred forever (the stall). So we return the ids
 * verbatim for answerPermission to echo back, never a hardcoded literal that a
 * schema tweak could desync.
 *
 * `isApproval` accepts BOTH negative verbs so a 0.32.0-era rename can't
 * misclassify an approval as a plain question (which would take the `text`
 * resume branch and stall the turn). The positional index-1 fallback below
 * covers a future rename on its own.
 *
 * eve's session-limit prompt (kind 'session-limit', eve 0.79.1
 * harness/hitl/budget-request.js) is answered the same way, by option id:
 * `continue` grants a fresh budget and resumes the held turn, `stop` cancels
 * it. It has no `allowFreeform`, so a `text` response would leave it open.
 */
function describeApproval(request: {
  kind?: string | undefined
  options?: Array<{ id?: string }> | undefined
  display?: string | undefined
}): { isApproval: boolean; isSessionLimit: boolean; approveOptionId: string; cancelOptionId: string } {
  const opts = request.options
  if (request.kind === 'session-limit') {
    return {
      isApproval: false,
      isSessionLimit: true,
      approveOptionId: opts?.find((o) => o?.id === 'continue')?.id ?? opts?.[0]?.id ?? 'continue',
      cancelOptionId: opts?.find((o) => o?.id === 'stop')?.id ?? opts?.[1]?.id ?? 'stop',
    }
  }
  const isApproval =
    Array.isArray(opts) &&
    opts.length === 2 &&
    opts[0]?.id === 'approve' &&
    (opts[1]?.id === 'cancel' || opts[1]?.id === 'deny')
  const approveOptionId =
    opts?.find((o) => o?.id === 'approve')?.id ?? opts?.[0]?.id ?? 'approve'
  const cancelOptionId =
    opts?.find((o) => o?.id === 'cancel' || o?.id === 'deny')?.id ?? opts?.[1]?.id ?? 'cancel'
  return { isApproval, isSessionLimit: false, approveOptionId, cancelOptionId }
}

/**
 * Render the user's picker answers as the follow-up `message` that eve replays to
 * the model after the approval resolves (the sanctioned answer-to-model path —
 * eve discards `text` on an approval response, so the choice must ride here).
 * `answers` maps each question text → the chosen label(s). Kept plain and readable
 * so the model reads it as the user's own reply, e.g.:
 *   "I answered the questions:\n- Which env?: Staging\n- Region?: US"
 */
function formatAnswersMessage(answers: Record<string, string>): string {
  const lines = Object.entries(answers)
    .filter(([, v]) => v != null && String(v).length > 0)
    .map(([q, v]) => `- ${q}: ${v}`)
  if (lines.length === 0) {
    // No concrete choice (empty answers) — tell the model the user acknowledged
    // without picking, so it can proceed rather than re-ask into the void.
    return 'I acknowledged the question without selecting a specific option.'
  }
  return `I answered the questions:\n${lines.join('\n')}`
}

/**
 * Render words typed into the composer while a question was open as the
 * person's ANSWER (the #681 rule), never a dismissal. One question reads like a
 * picked answer, so the model treats it exactly as the picker's "Other" text:
 *   "I answered the questions:\n- Which day?: Thursday\n(I typed …)"
 * Several questions get one reply that covers them, listed under the questions.
 */
function formatTypedReplyMessage(questions: string[], reply: string): string {
  const text = reply.trim()
  const typedNote = '(I typed this answer instead of picking one of your options.)'
  if (questions.length === 1) return `${formatAnswersMessage({ [questions[0]]: text })}\n${typedNote}`
  const asked = questions.length > 0 ? `\n${questions.map((q) => `- ${q}`).join('\n')}` : ''
  return `I answered the questions in my own words instead of picking options:${asked}\nMy answer: ${text}`
}

/** The question texts of an ask_user input (`{ questions: [{ question }] }`). */
function questionTexts(input: unknown): string[] {
  const questions = (input as { questions?: unknown } | null | undefined)?.questions
  if (!Array.isArray(questions)) return []
  return questions
    .map((q) => (q as { question?: unknown } | null)?.question)
    .filter((q): q is string => typeof q === 'string' && q.length > 0)
}

/**
 * Render a dismiss / skip as the follow-up message. The user closed the picker
 * without answering; tell the model plainly so it moves on. `response` is the
 * sentinel chat-panel passes ("(dismissed)" / "(skipped)"); words typed in the
 * composer are an answer instead (formatTypedReplyMessage).
 */
function formatDismissMessage(response: string): string {
  const trimmed = response.trim()
  return trimmed.length > 0
    ? `I dismissed the question without answering (${trimmed}).`
    : 'I dismissed the question without answering.'
}

/** Each side of an orphaned exchange is capped to this many characters. */
const ORPHAN_SIDE_MAX_CHARS = 4_000

/** A message's text parts, joined and capped (tool parts and files drop out). */
function partsText(parts: readonly EveMessagePart[] | null | undefined): string {
  const text = (parts ?? [])
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => (p.text as string).trim())
    .filter(Boolean)
    .join('\n')
  return text.length > ORPHAN_SIDE_MAX_CHARS ? `${text.slice(0, ORPHAN_SIDE_MAX_CHARS - 1)}…` : text
}

/**
 * The primer for an exchange an orphaned session took (A3: this window's
 * register lost to another window's session): what the person said and what
 * was answered, for the conversation's real session, which never saw it. Null
 * when neither side has text.
 */
export function orphanExchangePrimer(userParts: readonly EveMessagePart[] | null, replyParts: readonly EveMessagePart[]): string | null {
  const user = partsText(userParts)
  const reply = partsText(replyParts)
  if (!user && !reply) return null
  return [
    '<conversation-so-far>',
    'The last exchange of this chat ran in another session of it, so you have not seen it. It is context for the message after this block: do not answer it again, and do not mention this block.',
    '',
    ...(user ? [`User: ${user}`] : []),
    ...(reply ? [`Assistant: ${reply}`] : []),
    '</conversation-so-far>',
  ].join('\n')
}
