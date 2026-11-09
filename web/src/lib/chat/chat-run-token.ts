/**
 * Chat-run signed token + internal-route trust boundary for the eve MAIN-CHAT
 * runtime (Phase 4 — main chat → eve durable sessions).
 *
 * ── Why STATELESS (no in-process store) ─────────────────────────────────────
 * Same reasoning as the skill-run and agent-run tokens
 * (src/lib/flows/skill-run-token.ts, src/lib/agent-run/agent-run-token.ts): the
 * eve chat agent runs in a SEPARATE Nitro service, and on Vercel the transport,
 * the eve service, and the /api/internal/chat/* invocations are DIFFERENT
 * function instances with NO sticky routing. An in-process Map would routinely
 * NOT be visible across instances, so every turn would break in prod while
 * "working" in single-process dev. So there is no cross-instance state here.
 *
 * Instead the transport mints a compact HMAC-SHA256-signed token carrying only
 * the durable routing facts needed to REBUILD the chat spec deterministically
 * from live DB state: { conversationId, workspaceId, userId, agentId?, skillId?,
 * surface?, teammateId?, teammateIn?, relay?, focusArea?, exp }. No prompt text, no per-turn systemContext — the base + persona/skill
 * layering is re-derived on the internal spec route from these ids via
 * buildChatSystemPrompt. Per-TURN context (editor
 * selection, chat files, live-capture id, attached projects, email thread) is
 * volatile and is NOT in the token; it rides as a per-turn payload on the spec
 * request (see the ChatSpec contract in /api/internal/chat/spec/route.ts).
 *
 * ── The durable-vs-per-turn split (documented) ──────────────────────────────
 * DURABLE (in the token — the conversation's identity): conversationId, tenancy
 *   (workspaceId/userId), and the persona/mode chosen for the conversation
 *   (agentId/skillId). These re-resolve at most once per turn (plan §"Message
 *   conversion + concurrency": dynamic instructions re-resolve per turn).
 * PER-TURN (NOT in the token — sent with each spec request): the systemContext
 *   fields (editorSelection, chatFiles, liveCaptureId, contextSwitched,
 *   attachedProjectIds/NoteIds/CaptureIds, conversationContext, emailThreadId)
 *   and the requested model. These change turn-to-turn and must
 *   never be frozen into the durable token.
 *
 * ── Trust model ─────────────────────────────────────────────────────────────
 * Two gates on every internal route (identical to skill-run/agent-run):
 *   1. a shared bearer secret (CHAT_INTERNAL_SECRET, constant-time) proves the
 *      caller is our own eve runtime — belt to the OIDC/localDev suspenders;
 *   2. the signed token proves the routing facts were minted by us (HMAC over the
 *      same secret) and scopes the caller to ONE conversation — a tampered or
 *      expired token is rejected. Tenancy (workspaceId/userId) is READ FROM the
 *      verified token, never from the model, never from an untrusted header.
 *
 * ── Split secrets (hardening) ───────────────────────────────────────────────
 * The signing key is CHAT_INTERNAL_SECRET — its OWN env var, deliberately NOT
 * reusing RUN_SKILL_INTERNAL_SECRET, so a leak of one runtime's secret can't
 * forge tokens for the other. It FALLS BACK to RUN_SKILL_INTERNAL_SECRET when
 * unset so a single secret can bootstrap dev.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { resolveInternalSecret } from '@/lib/eve/internal-secret'
import { isAreaKey } from '@/lib/packs/registry'
import type { HomeTurnReason } from './home-turn'

/**
 * Token lifetime — a chat conversation is long-lived, but the token only needs
 * to cover a single turn's spec fetch + tool-dispatch calls (all of which
 * re-verify). The transport re-mints per turn (the durable facts are cheap to
 * re-derive), so a generous-but-bounded window is safe. 60 min comfortably
 * outlasts one turn plus any HITL pause.
 */
const TOKEN_TTL_MS = 60 * 60 * 1000 // 60 min

/**
 * The one exception to TOKEN_TTL_MS: a home turn's server token
 * (`server: 'home_turn'`, src/lib/chat/home-turn-server.ts
 * HOME_TURN_TOKEN_TTL_MS). It is the turn's token for the turn's whole life
 * (an hour's cap) and then the token a later idle compaction's profile recall
 * posts, so it may run to 90 minutes. It still only sends a queued message
 * into a home thread and reads.
 */
export const HOME_TURN_TOKEN_MAX_TTL_MS = 90 * 60 * 1000

/**
 * The server principals whose send token may run past TOKEN_TTL_MS (up to
 * HOME_TURN_TOKEN_MAX_TTL_MS): the turn writers of a home thread.
 */
const LONG_LIVED_SERVER_PRINCIPALS: ReadonlySet<string> = new Set(['home_turn', 'channel_turn'])

/**
 * How long past its expiry a token may still speak for its turn's end: the
 * reply backup (/api/internal/chat/reply) and who pays for the turn
 * (resolveChatUsagePayer, for the usage route and its outbox sweep), both
 * reported by chat-agent hooks as the turn ends. The work past expiry is
 * bounded: the spec and tool routes refuse an expired token, so at most the
 * model step in flight at expiry runs on (one eve flow function, Vercel's
 * `max` of 800 s) and a closing step after it, then the hooks' retries.
 * 30 minutes covers that with room for queue delay. Past it the reply route
 * answers 401, and usage is billed to the session's owner as if no token came.
 */
export const TURN_REPORT_TOKEN_GRACE_MS = 30 * 60 * 1000

/**
 * The DURABLE routing facts a signed chat-run token carries. Small by design —
 * no prompt, no per-turn systemContext (all re-derived / carried per-turn on the
 * spec request). `conversationId` scopes every internal call to one conversation.
 */
export interface ChatRunTokenClaims {
  conversationId: string
  workspaceId: string
  userId: string
  /** Active agent (persona) id — the tool boundary. Absent → default assistant. */
  agentId?: string
  /** Active skill (playbook) id — steers behavior, does NOT narrow tools. */
  skillId?: string
  /**
   * Which entry point minted the token. Absent → the in-app chat (the browser
   * transport via /api/account/chat/eve-session). 'device_ask' → the ESP32
   * /api/device/ask one-shot, minted SERVER-SIDE for a single one-shot session
   * (src/lib/chat/device-ask-eve.ts): the spec rebuild picks the device's model
   * default, Gateway feature tag and device note from it, and the
   * browser-facing persist route refuses it. It never WIDENS the tool ceiling;
   * it only removes the surface's structural exclusions (chat-ceiling.ts
   * SURFACE_EXCLUDED_TOOLS), and the internal spec + tool routes admit it only
   * while its ownership row exists (surface-run-guard.ts).
   * 'slack' | 'sms' | 'call' | 'team_chat' → a message the person sent from an outside channel (a
   * Slack DM or channel thread, docs/plans/slack-connect.md; a text to the
   * Dial8 number, or what they said on a call to it, docs/plans/text-and-calling.md): ONLY together with `server:
   * 'channel_turn'`, and that principal always carries an outside channel's
   * surface (see `server`). The spec adds the turn-context line naming the
   * channel, and the surface's exclusions take everything that needs a
   * screen (cards, pickers, the desktop browser, helpers). Unlike device_ask
   * it is billed as `ai_chat` by the usage meter and has no ephemeral
   * ownership row: its conversation is the person's durable home thread.
   */
  surface?: ChatRunSurface
  /**
   * The AI teammate (`ai_team_member` id) this conversation is with — a bots v2
   * teammate chat (docs/plans/bots-v2.md, Phase 1). Minted only by the browser
   * mint's teammate path (/api/account/chat/eve-session with a teammateId),
   * after the teammate was found visible to the caller under RLS, in a
   * workspace the caller is a member of, and only for the conversation row
   * stamped with it (chat_conversations.ai_team_member_id, migration 300).
   * The spec rebuild then speaks as that teammate (its name, persona and
   * memory) and BOTH ceiling halves narrow to its bounds
   * (composeTeammateChatCeiling, chat-ceiling.ts); the persist hook keeps the
   * thread out of knowledge ingest. Deliberately NOT a `surface`: a teammate
   * chat is an ordinary attended in-app chat for billing, persistence and
   * liveness, which `surface` would all flip.
   */
  teammateId?: string
  /**
   * Where a token naming a teammate talks to it. Absent: the bot's own thread
   * (the bubble, its page's chat, Open in Dial8), as every teammate token was
   * before. 'chat': a main-chat conversation with the bot as its agent (bots
   * v4 Phase C, a conversation stamped with the bot in
   * chat_conversations.agent_teammate_id, migration 307). One chat (Slice 2)
   * retired those: the browser mint refuses such a conversation (409
   * BOT_CONVERSATION) and nothing mints 'chat' any more; the verifier and the
   * spec rebuild still read it. Such a turn is built exactly as the thread's
   * (the bot's persona, memory and ceiling), but its conversation note says it
   * is in the main chat, and the persist hook ingests it like any main-chat
   * conversation (the thread still isn't). Only with `teammateId`, and never
   * with an item (`about*`): those are the thread's.
   */
  teammateIn?: TeammateChatPlace
  /**
   * A teammate chat's turn about one of the caller's own items (bots v3 1d,
   * docs/plans/bots-v3.md): the run's ledger row (`tracked_job`), else one
   * card (`attention_item`). Only with `teammateId`, and minted only after the
   * mint found the item the caller's own under RLS, in the teammate's
   * workspace (acceptTeammateAbout, teammate-about.ts). Ids only, never
   * text: the spec rebuild builds the "About this item" section from them,
   * re-scoped to the caller's own member row (buildTeammateAboutBlock).
   */
  aboutWorkItemId?: string
  aboutCardId?: string
  /**
   * A RELAYED turn in a bot's own thread (bots v4 Phase A4,
   * docs/plans/bots-v4.md "The main agent talks to the bots"): the main
   * chat's assistant passes the person's message on, on their behalf, and
   * reads the bot's reply back. The value is the relay's row id (`bot_relay`,
   * migration 309). Minted only server-side by the relay
   * (src/lib/bots/bot-relay.ts), for the person's own thread with a bot they
   * may reach, sealing their own credential like the browser mint does. Only
   * with `teammateId` and on the bot's thread: never with `teammateIn` or a
   * `surface`. The spec adds the turn-context line saying who is talking
   * (teammate-chat.ts relayTurnNote); the usage meter notes it on the row;
   * the turn is otherwise an ordinary metered teammate-thread turn, and the
   * tool route refuses the relay tools on it as on every teammate token.
   */
  relay?: string
  /**
   * A main-chat conversation focused on an area (one-agent plan S3,
   * `chat_conversations.focus_area`, migration 318): an area face's page
   * chat. The MAIN agent, full tools, attended, exactly as
   * the default chat; the spec rebuild only puts the area's pack in the stable
   * prompt from the first turn (src/lib/packs/focus.ts). Minted by the
   * ordinary browser mint from the conversation's own row (a new
   * conversation is stamped with it, an existing one keeps its own), never
   * with a teammate or a surface.
   */
  focusArea?: string
  /**
   * A token the server minted for itself, not for a person's turn (A4,
   * docs/plans/always-on-agent.md §2). 'idle_compaction': idle-time
   * compaction (src/lib/chat/idle-compaction.ts) presents it with the chat
   * secret to compact the session or read its stream. 'home_turn': a
   * server-written turn in a home thread (src/lib/chat/home-turn-server.ts),
   * the ONE server principal that may send a message, and only
   * `{ message, turnPolicy: 'queue' }` into an `is_home` session
   * (agents/chat-agent/lib/auth.ts serverCompactionAuth). It never widens
   * anything: a server token carries no `cred` (no sealed user JWT), the
   * internal tool route holds it to reads (isServerTurnTool, chat-ceiling.ts),
   * `ask_user` answers instead of parking, and a gate that needs the person in
   * the chat refuses it (quick helpers, src/lib/chat/helpers-gate.ts). Billing is unchanged: the turn is metered as
   * `ai_chat` to the token's user (it is not a `surface`).
   *
   * 'channel_turn' (docs/plans/slack-connect.md, decision 14): a message the
   * person sent from an outside channel (a Slack DM from their linked Slack
   * account, a text from their verified phone), verified at intake by that
   * channel's route and written into their home thread by the same machinery
   * (src/lib/slack/turn.ts, src/lib/chat/text-turn-server.ts). Unlike a
   * home turn it IS the person speaking (caller.ts callerClassOf: the
   * channel's class for its owner), so it may send (queued, into its own
   * `is_home` session only) and acts with the person's own tools, under the
   * workspace's autonomy and usage limits, minus what needs a screen. It
   * always carries its channel's surface (CHANNEL_SURFACES), and such a
   * surface always means it: THE RULE is that a server token carries no
   * surface, except that 'channel_turn' ⇔ a channel surface (each requires
   * the other). Read-only stays the default for every other principal
   * (serverTurnMayCall, chat-ceiling.ts).
   */
  server?: ChatRunServerPrincipal
  /**
   * Why a `home_turn` token was minted (src/lib/chat/home-turn-server.ts
   * homeTurnToken): only with `server: 'home_turn'`. The tool route lets only
   * the background updates that act on their own write (chat-ceiling.ts
   * serverTurnMayCall, HOME_TURN_ACTING_REASONS); a home token without it is
   * read-only.
   */
  homeTurnReason?: HomeTurnTokenReason
  /**
   * A guest's channel turn (guest access, migrations 427, 428 and 434): the
   * `agent_guest` id of the person the owner added, messaging the agent made
   * for them, in that guest's own thread (chat_conversations.agent_guest_id).
   * Only with `server: 'channel_turn'` and a channel surface: minted only by
   * the text turn for a thread the SMS webhook matched to the guest's
   * activated number, by the Slack turn for a DM from the guest's bound
   * Slack user (src/lib/guests/slack.ts), or (surface 'dial8', which always
   * carries one) by the agent-link turn for a message from the linked user's
   * agent (src/lib/agent-links/exchange.ts). The caller class is `guest`
   * (caller.ts), the spec rebuild speaks as that person's agent
   * (src/lib/guests/guest-spec.ts), the tool route holds it to the guest's
   * own tools (src/lib/guests/guest-tools.ts), and the memory route refuses
   * it: the owner's memory is never read or written from it.
   */
  guestId?: string
  /**
   * The caller's Supabase JWT, sealed (AES-256-GCM, bound to this token's
   * conversation + tenancy — chat-run-credential.ts). The internal tool route
   * opens it for the tools that call back into the app as the user (the
   * email-draft tools), exactly as the in-process routes passed their bearer.
   * Sealed by the browser chat mint (from the mint's own Bearer) and by the
   * device ask; never set for a device (`d8d_`) token or a cookie-only caller.
   */
  cred?: string
  /**
   * The person's AI runs on their own ChatGPT plan (the free tier,
   * docs/plans/chatgpt-free-tier.md): the browser mint's usage check said so.
   * Each turn's spec still decides from the live usage row; this claim is the
   * chat-agent's fallback when the spec can't be read, so a spec outage falls
   * back to the plan, never to a Gateway model Dial8 pays for
   * (agents/chat-agent/lib/chatgpt-plan-model.ts).
   */
  chatgptPlan?: true
  /** Epoch ms expiry. Verified on every internal route. */
  exp: number
}

/** The non-default entry points a chat-run token can be minted for. */
export type ChatRunSurface = 'device_ask' | ChannelSurface

/**
 * The outside channels a `channel_turn` speaks through (decision 14). 'dial8'
 * is another Dial8 user's agent over an agent link (migration 435): a guest
 * turn only (it always carries `guestId`), never the owner speaking.
 */
export type ChannelSurface = 'slack' | 'sms' | 'dial8' | 'call' | 'team_chat'

/** Every {@link ChannelSurface}. */
export const CHANNEL_SURFACES: ReadonlySet<string> = new Set<ChannelSurface>(['slack', 'sms', 'dial8', 'call', 'team_chat'])

/** The channel surfaces only a guest's turn speaks through: never the owner's own. */
export const GUEST_ONLY_SURFACES: ReadonlySet<string> = new Set<ChannelSurface>(['dial8'])

/** Every {@link ChatRunSurface}, for the verifiers' shape guard. */
export const CHAT_RUN_SURFACES: ReadonlySet<string> = new Set<ChatRunSurface>(['device_ask', ...(CHANNEL_SURFACES as ReadonlySet<ChannelSurface>)])

/** The server-side callers that mint a chat-run token for themselves. */
export type ChatRunServerPrincipal = 'idle_compaction' | 'home_turn' | 'channel_turn'

/** Every {@link ChatRunServerPrincipal}, for the verifiers' shape guard. */
export const CHAT_RUN_SERVER_PRINCIPALS: ReadonlySet<string> = new Set<ChatRunServerPrincipal>(['idle_compaction', 'home_turn', 'channel_turn'])

/** A home turn's reasons that mint a `home_turn` token: every reason but a channel turn's (text, slack, agent_ask, call, team_chat). */
export type HomeTurnTokenReason = Exclude<HomeTurnReason, 'text' | 'slack' | 'agent_ask' | 'call' | 'team_chat'>

/** Every {@link HomeTurnTokenReason}, for the verifiers' shape guard. */
export const HOME_TURN_TOKEN_REASONS: ReadonlySet<string> = new Set<HomeTurnTokenReason>(['helper_report', 'event', 'digest', 'guest_ask', 'agent_answer', 'check_in', 'approval'])

/** True when a home turn's reason mints a `home_turn` token (not a channel turn's). */
export function isHomeTurnTokenReason(reason: string): reason is HomeTurnTokenReason {
  return HOME_TURN_TOKEN_REASONS.has(reason)
}

/**
 * True for the main agent's check-in (docs/plans/now-file.md "The check-in"):
 * a home turn's token minted for reason 'check_in'. Its conversation is the
 * person's home thread (where its reply lands), but it runs in a fresh eve
 * session of its own, registered on its home_turn row, never the thread's
 * (agents/chat-agent/lib/auth.ts). The spec, the tool route and the Now file
 * read it from the verified claims only.
 */
export function isCheckInClaims(claims: Pick<ChatRunTokenClaims, 'server' | 'homeTurnReason'>): boolean {
  return claims.server === 'home_turn' && claims.homeTurnReason === 'check_in'
}

/**
 * The one server principal that carries a surface, and its surfaces: a
 * channel turn always carries a channel surface, and a channel surface always
 * means a channel turn. Every other server principal carries none, and
 * 'device_ask' never carries a server principal.
 */
export function serverSurfacePairValid(server: unknown, surface: unknown): boolean {
  const channelSurface = typeof surface === 'string' && CHANNEL_SURFACES.has(surface)
  if (server === 'channel_turn' || channelSurface) return server === 'channel_turn' && channelSurface
  return server === undefined || surface === undefined
}

/** Where a teammate token talks to its bot, besides its own thread: the main chat (bots v4 Phase C). */
export type TeammateChatPlace = 'chat'

/**
 * True for a token naming a bot as a main-chat conversation's agent (bots v4
 * Phase C): `teammateIn: 'chat'`. A teammate token without it is the bot's
 * own thread.
 */
export function isBotConversation(claims: Pick<ChatRunTokenClaims, 'teammateId' | 'teammateIn'>): boolean {
  return !!claims.teammateId && claims.teammateIn === 'chat'
}

// ── HMAC-signed token: base64url(payload).base64url(hmac) ─────────────────────

function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}

function signPayload(payloadB64: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadB64).digest('base64url')
}

/** Header the eve runtime presents to the internal routes (shared secret). */
export const CHAT_RUN_SECRET_HEADER = 'x-chat-run-secret'
/** Header carrying the signed run token (routing facts + HMAC). */
export const CHAT_RUN_TOKEN_HEADER = 'x-chat-run-token'
/**
 * Header carrying the pre-encoded per-turn context (base64url JSON) to the
 * chat-agent channel, which forwards it as the spec route's ?ctx=. Kept in sync
 * with CHAT_RUN_CTX_HEADER in agents/chat-agent/lib/auth.ts.
 */
export const CHAT_RUN_CTX_HEADER = 'x-chat-run-ctx'
/**
 * Header naming the reply a send starts or continues (the id the transport
 * renders it under). The chat-agent's reply backup writes its own copy of the
 * reply under it (src/lib/chat/reply-backup.ts). Kept in sync with
 * CHAT_REPLY_ID_HEADER in agents/chat-agent/lib/auth.ts.
 */
export const CHAT_REPLY_ID_HEADER = 'x-chat-reply-id'
/** Header carrying the workspace id (observability echo; token is authoritative). */
const CHAT_RUN_WORKSPACE_HEADER = 'x-chat-run-workspace'
/** Header carrying the run-as user id (observability echo; token is authoritative). */
const CHAT_RUN_USER_HEADER = 'x-chat-run-user'

/**
 * The configured internal shared secret, or null when unset (chat cannot run:
 * the mint route refuses 503 and every internal route refuses 401).
 * Prefers CHAT_INTERNAL_SECRET, falls back to RUN_SKILL_INTERNAL_SECRET so a
 * single secret bootstraps dev (see the module doc's split-secrets note).
 */
export function internalSecret(): string | null {
  return resolveInternalSecret('chat', 'CHAT_INTERNAL_SECRET')
}

/**
 * Mint a signed chat-run token from the durable routing claims. Sets `exp` to
 * now + TTL. Throws when the secret is unset — callers check internalSecret() first
 * and refuse (503) rather than let the throw become a 500.
 *
 * `opts.ttlMs` SHORTENS the lifetime for a caller with a hard wall budget (the
 * device ask: once its route has answered, a session that outlived a failed
 * cancel must stop being able to fetch its spec or dispatch tools, on the
 * verified `exp` alone). It can only shorten: a value above the default TTL is
 * clamped to it, and a non-positive / non-finite one throws. The one
 * exception: a home or channel turn's server token may ask for up to
 * HOME_TURN_TOKEN_MAX_TTL_MS (still clamped there).
 */
export function mintChatRunToken(
  claims: Omit<ChatRunTokenClaims, 'exp'>,
  opts?: { ttlMs?: number },
): string {
  const secret = internalSecret()
  if (!secret) throw new Error('[chat-run] CHAT_INTERNAL_SECRET is not set — cannot mint token')
  let ttlMs = TOKEN_TTL_MS
  if (opts?.ttlMs !== undefined) {
    if (!Number.isFinite(opts.ttlMs) || opts.ttlMs <= 0) {
      throw new Error('[chat-run] ttlMs must be a positive, finite number of milliseconds')
    }
    ttlMs = Math.min(opts.ttlMs, claims.server && LONG_LIVED_SERVER_PRINCIPALS.has(claims.server) ? HOME_TURN_TOKEN_MAX_TTL_MS : TOKEN_TTL_MS)
  }
  const full: ChatRunTokenClaims = { ...claims, exp: Date.now() + ttlMs }
  const payloadB64 = b64url(Buffer.from(JSON.stringify(full), 'utf8'))
  const sig = signPayload(payloadB64, secret)
  return `${payloadB64}.${sig}`
}

/**
 * Verify a chat-run token's HMAC (constant-time) and expiry, returning its
 * claims or null. Rejects a tampered payload (signature mismatch), an expired
 * token, and any malformed input. The secret must be set (else null — fail
 * closed).
 *
 * `opts.allowExpired` skips ONLY the expiry check (signature + shape still
 * required). It exists for ATTRIBUTION of work that already ran — who pays for
 * a finished turn, whether a finished run was a device-ask surface run — where
 * expiry (which gates NEW work) says nothing about who minted the token. Never
 * use it to admit work.
 */
export function verifyChatRunToken(
  token: string | null | undefined,
  opts?: { allowExpired?: boolean },
): ChatRunTokenClaims | null {
  const secret = internalSecret()
  if (!secret) return null
  if (typeof token !== 'string' || token.length === 0) return null

  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  const payloadB64 = token.slice(0, dot)
  const presentedSig = token.slice(dot + 1)

  const expectedSig = signPayload(payloadB64, secret)
  if (!constantTimeEqual(presentedSig, expectedSig)) return null

  let claims: ChatRunTokenClaims
  try {
    claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as ChatRunTokenClaims
  } catch {
    return null
  }
  if (typeof claims.exp !== 'number' || (!opts?.allowExpired && claims.exp <= Date.now())) return null
  // Minimal shape guard — a valid HMAC already proves WE minted it, but be
  // defensive. agentId/skillId are optional so only their presence-as-string is
  // checked when set.
  if (
    typeof claims.conversationId !== 'string' ||
    typeof claims.workspaceId !== 'string' ||
    typeof claims.userId !== 'string' ||
    (claims.agentId !== undefined && typeof claims.agentId !== 'string') ||
    (claims.skillId !== undefined && typeof claims.skillId !== 'string') ||
    (claims.surface !== undefined && (typeof claims.surface !== 'string' || !CHAT_RUN_SURFACES.has(claims.surface))) ||
    (claims.teammateId !== undefined && (typeof claims.teammateId !== 'string' || !claims.teammateId)) ||
    // A bot conversation (bots v4 Phase C): only 'chat', only with a teammate, never about an item.
    (claims.teammateIn !== undefined &&
      (claims.teammateIn !== 'chat' || !claims.teammateId || claims.aboutWorkItemId !== undefined || claims.aboutCardId !== undefined)) ||
    (claims.aboutWorkItemId !== undefined && (typeof claims.aboutWorkItemId !== 'string' || !claims.teammateId)) ||
    (claims.aboutCardId !== undefined && (typeof claims.aboutCardId !== 'string' || !claims.teammateId)) ||
    // A relayed turn (bots v4 Phase A4): only in a bot's own thread.
    (claims.relay !== undefined &&
      (typeof claims.relay !== 'string' || !claims.relay || !claims.teammateId || claims.teammateIn !== undefined || claims.surface !== undefined)) ||
    // A focused conversation (one-agent S3): the main agent's alone, never a teammate's or a surface's.
    (claims.focusArea !== undefined &&
      (!isAreaKey(claims.focusArea) || claims.teammateId !== undefined || claims.surface !== undefined)) ||
    // A server-minted token (A4): a known principal, never with a relay or a
    // sealed user credential (the server has no JWT to seal). A channel turn
    // speaks in the person's home thread: never a teammate's. The surface
    // rule: no surface on a server token, except channel_turn ⇔ a channel
    // surface (each requires the other), checked below for every token.
    (claims.server !== undefined &&
      (typeof claims.server !== 'string' ||
        !CHAT_RUN_SERVER_PRINCIPALS.has(claims.server) ||
        claims.relay !== undefined ||
        claims.cred !== undefined ||
        (claims.server === 'channel_turn' && (claims.teammateId !== undefined || claims.focusArea !== undefined)))) ||
    !serverSurfacePairValid(claims.server, claims.surface) ||
    // A home turn's reason: only on a home turn's token, and only a known one.
    (claims.homeTurnReason !== undefined &&
      (claims.server !== 'home_turn' || typeof claims.homeTurnReason !== 'string' || !isHomeTurnTokenReason(claims.homeTurnReason))) ||
    // A guest's turn: only a channel turn (by text, Slack or a linked agent), never a teammate's or a focused chat.
    (claims.guestId !== undefined &&
      (typeof claims.guestId !== 'string' || !claims.guestId || claims.server !== 'channel_turn' || typeof claims.surface !== 'string' || !CHANNEL_SURFACES.has(claims.surface) ||
        claims.teammateId !== undefined || claims.focusArea !== undefined)) ||
    // A linked agent's turn is always a guest's (the owner's half for that user), never the owner's own.
    (typeof claims.surface === 'string' && GUEST_ONLY_SURFACES.has(claims.surface) && claims.guestId === undefined) ||
    (claims.cred !== undefined && typeof claims.cred !== 'string') ||
    (claims.chatgptPlan !== undefined && claims.chatgptPlan !== true)
  ) {
    return null
  }
  return claims
}

// ── Internal shared-secret auth (outer gate) ──────────────────────────────────

/**
 * Constant-time comparison of a presented secret against the configured one.
 * False when the env secret is unset or on any length/format mismatch.
 */
export function verifyInternalSecret(presented: string | null | undefined): boolean {
  const expected = internalSecret()
  if (!expected) return false
  if (typeof presented !== 'string' || presented.length === 0) return false
  return constantTimeEqual(presented, expected)
}

/**
 * Constant-time string comparison. Length-checks first (a length difference is
 * not itself secret) then compares bytes in constant time. Wraps the Buffers in
 * Uint8Array views so timingSafeEqual's ArrayBufferView typing is satisfied.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = new Uint8Array(Buffer.from(a, 'utf8'))
  const bb = new Uint8Array(Buffer.from(b, 'utf8'))
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/** Extract the presented internal secret from a request's header. */
export function extractInternalSecret(request: Request): string | null {
  return request.headers.get(CHAT_RUN_SECRET_HEADER)
}

/**
 * The run token, from its header ONLY. Deliberately no `?token=` fallback: a
 * token in a URL lands in access logs, and every caller (the chat agent's
 * spec-client, the browser transport, the server's turn writers) sends the
 * header.
 */
export function extractChatRunToken(request: Request): string | null {
  return request.headers.get(CHAT_RUN_TOKEN_HEADER)
}
