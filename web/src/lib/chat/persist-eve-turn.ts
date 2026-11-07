/**
 * Server-side writer for a finalized eve main-chat turn, driven by
 * `/api/account/chat/eve-persist` — the BROWSER path (Supabase cookie auth +
 * chat-run token). (The internal-secret twin `/api/internal/chat/persist` had
 * no caller and was deleted with the legacy cloud chat route.) The chat-agent
 * also writes its own copy of each reply (the reply backup,
 * ./reply-backup.ts → /api/internal/chat/reply) as a PROVISIONAL row, so a
 * reply survives a page that died mid-turn; this browser write replaces that
 * row (persistEveMessage), so when the page is alive its copy is the one kept.
 *
 * The route verifies a chat-run token and hands the verified
 * `ChatRunTokenClaims` (tenancy READ FROM the token, never the body) plus the
 * parsed body to this function, which performs the side effects the
 * POST/PATCH chat-history routes own for a client-saved chat:
 *
 *   1. PROJECTION: write the finalized assistant message into `chat_messages`
 *      (kept for search / RLS / Realtime) via persistEveMessage — which
 *      re-asserts the token's (userId, workspaceId) against the conversation's
 *      actual owner row, so a token scoped to conversation A can only write A.
 *   2. KNOWLEDGE HOOK RE-HOME: fire `conversation/activity` (the debounced weaver
 *      trigger) so extraction keeps running for eve-routed chats. Fires ONCE per
 *      persisted turn (only when a NEW row actually landed) — a replay never
 *      re-triggers extraction. Never for a bot's own thread (bots v2); a
 *      main-chat conversation with a bot as its agent (bots v4 Phase C) is
 *      ingested like any main-chat conversation.
 *   3. NO USAGE BILLING. The turn is billed server-side by the chat-agent's
 *      usage-meter hook (agents/chat-agent/hooks/usage-meter.ts →
 *      /api/internal/chat/usage, feature 'ai_chat'). The client-reported
 *      `usage` in this body is display/analytics only and never reaches
 *      logUsage.
 *   4. TITLE BACKFILL: give a still-untitled conversation the panel's own
 *      first-message fallback name (model-free; see backfillConversationTitle).
 *
 * The projection and the title are independent best-effort steps: a problem in
 * one must not lose the other.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { inngest } from '@/lib/inngest/client'
import { isBotConversation, type ChatRunTokenClaims } from '@/lib/chat/chat-run-token'
import { persistEveMessage, type EveMessagePart, type EveMessageResult } from '@/lib/chat/eve-message-writer'
import { DEFAULT_CONVERSATION_TITLE, fallbackChatTitle } from '@/lib/chat/chat-title'
import { parseTurnTimings, type ChatTurnTimings } from '@/lib/chat/turn-timings'
import { STEER_OUTCOMES, parseSteerTelemetry, type SteerTelemetry } from '@/lib/chat/steer-telemetry'
import { parseCardReplyRef } from '@/lib/chat/card-reply'
import { parseMessageReplyRef } from '@/lib/chat/message-reply'
import { REACTION_TURN_KIND, reactionTurnOfMetadata } from '@/lib/chat/message-reactions'
import type { HandleMessageStreamEvent } from 'eve/client'

/** The parsed persist body (already JSON-decoded + validated). */
export interface PersistEveTurnBody {
  messageId: string
  role?: 'assistant' | 'user'
  parts: EveMessagePart[]
  metadata?: Record<string, unknown>
  /**
   * CLIENT-reported turn usage — display/analytics only, NEVER billed (the
   * chat-agent's usage meter bills the turn server-side).
   */
  usage?: {
    events?: HandleMessageStreamEvent[]
    wallMs?: number
    model?: string
  }
  /**
   * The user message that STARTED this turn (the client's own id + parts).
   * Written BEFORE the assistant projection so the pair lands in reading order —
   * without it, the client autosave (which only fires at turn end) races this
   * persist and the assistant row's created_at precedes the user row's, so a
   * reload renders the reply ABOVE the question. Deduped on ui_message_id, so
   * the autosave's own later upsert of the same message is a no-op. Also makes
   * headless/API-driven turns (no panel autosave) persist complete pairs.
   */
  userMessage?: {
    messageId: string
    parts: EveMessagePart[]
    /**
     * Merged into the user row's ui_message.metadata — only `steer`
     * ('applied' | 'next_turn'): the message steered a running reply (UI-2);
     * `replyCard`: the For you card it replied to (card-reply.ts), and
     * `replyTo`: the message in the thread it replied to, with the words
     * quoted (message-reply.ts), each shown above it in the thread; and
     * `kind: 'reaction'` with `reaction`: the message is a reaction's own
     * turn (message-reactions.ts), drawn as a line, not a bubble.
     */
    metadata?: Record<string, unknown>
  }
  /**
   * The chat's name is settled elsewhere (the main chat has none; a capture's
   * conversation is named for the meeting). The title backfill then does
   * nothing — it only covers chats nobody else names.
   */
  panelTitles?: boolean
  /**
   * The body is the user message alone, written the moment it was sent (the
   * transport's persistUserMessageNow): the knowledge hook is left to the
   * reply's write (the browser's or the reply backup's), so a turn feeds
   * extraction once.
   */
  onSend?: boolean
  /**
   * CLIENT-measured time-to-first-token phases (see turn-timings.ts) —
   * analytics only. The route forwards them as `ttft_*` event properties and
   * one `[chat-ttft]` log line; nothing here writes them.
   */
  timings?: ChatTurnTimings
  /**
   * The turn adopted a steer (UI-2): how it landed and how long it waited.
   * Analytics only — the route forwards it as `steer_*` and one `[chat-steer]`
   * log line; nothing here writes it.
   */
  steer?: SteerTelemetry
}

export interface PersistEveTurnResult {
  written: boolean
  /** The reply backup had written this reply first (a provisional row), and this write replaced it. */
  replaced?: boolean
  conversationId: string
  activityFired: boolean
  reason?: EveMessageResult['reason']
}

/**
 * Persist a finalized eve turn's assistant message + fire its side effects.
 * Tenancy comes ONLY from the verified `claims` (never the body). Total by
 * construction — the projection is best-effort (returns a discriminated result,
 * never throws for a persistence miss) and the two side effects are wrapped so
 * neither can wedge the other.
 */
export async function persistEveTurn(
  supabase: SupabaseClient,
  claims: ChatRunTokenClaims,
  body: PersistEveTurnBody,
): Promise<PersistEveTurnResult> {
  // ── 0. Project the turn's USER message first (ordering authority) ───────────
  // Sequenced BEFORE the assistant write so created_at ordering matches reading
  // order on reload. Dedup on ui_message_id makes this idempotent vs the client
  // autosave. Best-effort: a user-message miss must never lose the assistant turn.
  if (body.userMessage) {
    try {
      await persistEveMessage(supabase, {
        conversationId: claims.conversationId,
        userId: claims.userId,
        workspaceId: claims.workspaceId,
        role: 'user',
        parts: body.userMessage.parts,
        messageId: body.userMessage.messageId,
        ...(body.userMessage.metadata ? { metadata: body.userMessage.metadata } : {}),
      })
    } catch {
      // Never fail the assistant projection for the user-message write.
    }
  }

  // ── 1. Project the message into chat_messages (tenancy from the token) ──────
  const result = await persistEveMessage(supabase, {
    conversationId: claims.conversationId,
    userId: claims.userId,
    workspaceId: claims.workspaceId,
    role: body.role ?? 'assistant',
    parts: body.parts,
    messageId: body.messageId,
    metadata: body.metadata,
  })

  // ── 2. Knowledge hook re-home — fire once per newly-persisted turn ──────────
  // Only when a NEW row actually landed (conversationActivityFired), so a replay
  // never re-triggers extraction. Best-effort: extraction must never fail the
  // projection. Turns the client saves fire it from the POST/PATCH
  // chat-history routes instead.
  //
  // A bot's own thread (bots v2, the token's teammateId) is a working
  // conversation with a bot, not a source of facts (docs/plans/bots-v2.md
  // decision 1): it never signals ingest, so it never feeds claims. A
  // main-chat conversation with the bot as its agent (bots v4 Phase C,
  // `teammateIn: 'chat'`) is a main-chat conversation like any other, and is
  // ingested like one.
  // A guest's thread (guest access, the token's guestId) never signals either.
  const signalIngest = result.conversationActivityFired && !body.onSend && (!claims.teammateId || isBotConversation(claims)) && !claims.guestId
  if (signalIngest) {
    try {
      await inngest.send({
        name: 'conversation/activity',
        data: {
          workspaceId: claims.workspaceId,
          userId: claims.userId,
          conversationId: claims.conversationId,
        },
      })
    } catch {
      // Knowledge extraction is best-effort; never fail the persist for it.
    }
  }

  // ── 3. NO billing here. eve chat usage is metered SERVER-SIDE by the
  // chat-agent's usage-meter hook → POST /api/internal/chat/usage (one
  // logUsage per turn, idempotent on the eve session + turn). The body's
  // `usage` (events / wallMs / model) is what the BROWSER says — it is never a
  // billing input: a client could under-report its own bill. It stays on the
  // wire for display/analytics only (the route's launch event reads its model).

  // ── 4. First-turn title backfill — LAST. Model-free, best-effort by contract
  // (never throws). From the turn's opening message, or from a user message
  // written on its own (the transport saves it the moment it is sent, so a
  // page that dies mid-turn still leaves its chat named).
  const openingParts = body.userMessage?.parts ?? (body.role === 'user' ? body.parts : null)
  if (openingParts && !body.panelTitles) {
    await backfillConversationTitle(supabase, claims, openingParts)
  }

  return {
    written: result.written,
    ...(result.replaced ? { replaced: true } : {}),
    conversationId: result.conversationId ?? claims.conversationId,
    activityFired: signalIngest,
    reason: result.reason,
  }
}

/**
 * First-turn title backfill. The eve mint creates the conversation row titled
 * 'New conversation'. A chat whose name is settled elsewhere (the main chat,
 * which has none; a capture's conversation, named for the meeting) arrives with
 * `panelTitles` and never reaches here. Every OTHER conversation (headless)
 * gets fallbackChatTitle, cut at a word boundary — so no eve chat stays
 * 'New conversation'.
 *
 * Deliberately model-free: this path makes no title model call.
 *
 * Reads the row first and does nothing unless it still carries EXACTLY the
 * mint's default title — the same predicate the guarded write matches. The
 * write stays guarded to the default title (a rename that landed meanwhile is
 * never overwritten) and scoped to the token's owner. Best-effort: never throws.
 */
async function backfillConversationTitle(
  supabase: SupabaseClient,
  claims: ChatRunTokenClaims,
  parts: EveMessagePart[],
): Promise<void> {
  try {
    const textPart = parts.find((p) => p.type === 'text') as { text?: unknown } | undefined
    const text = typeof textPart?.text === 'string' ? textPart.text : ''
    const title = fallbackChatTitle(text)
    if (!title) return

    const { data: row } = await supabase
      .from('chat_conversations')
      .select('title')
      .eq('id', claims.conversationId)
      .eq('user_id', claims.userId)
      .eq('workspace_id', claims.workspaceId)
      .maybeSingle<{ title: string | null }>()
    if (!row || row.title !== DEFAULT_CONVERSATION_TITLE) return

    await supabase
      .from('chat_conversations')
      .update({ title })
      .eq('id', claims.conversationId)
      .eq('user_id', claims.userId)
      .eq('workspace_id', claims.workspaceId)
      .eq('title', DEFAULT_CONVERSATION_TITLE)
  } catch {
    // Title is cosmetic; never fail the persist for it.
  }
}

/**
 * Parse + shape-validate a persist request body. Returns a discriminated result:
 * `{ ok: true, body }` or `{ ok: false, error }` (a 400-worthy message), so a
 * malformed body is rejected before any DB work. `timings` is the exception to
 * rejection: parseTurnTimings keeps its valid keys and drops the rest, so bad
 * telemetry never fails the persist.
 */
export function parsePersistEveTurnBody(
  raw: unknown,
): { ok: true; body: PersistEveTurnBody } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'invalid body' }
  const b = raw as Record<string, unknown>
  if (typeof b.messageId !== 'string' || !b.messageId) {
    return { ok: false, error: 'missing messageId' }
  }
  if (!Array.isArray(b.parts)) {
    return { ok: false, error: 'missing parts' }
  }
  const role = b.role === 'user' ? 'user' : 'assistant'
  const timings = parseTurnTimings(b.timings)
  const steer = parseSteerTelemetry(b.steer)
  return {
    ok: true,
    body: {
      messageId: b.messageId,
      role,
      parts: b.parts as EveMessagePart[],
      ...(b.metadata && typeof b.metadata === 'object'
        ? { metadata: b.metadata as Record<string, unknown> }
        : {}),
      ...(b.usage && typeof b.usage === 'object'
        ? { usage: b.usage as PersistEveTurnBody['usage'] }
        : {}),
      ...(isUserMessage(b.userMessage) ? { userMessage: userMessageOf(b.userMessage) } : {}),
      ...(b.panelTitles === true ? { panelTitles: true } : {}),
      ...(b.onSend === true ? { onSend: true } : {}),
      ...(timings ? { timings } : {}),
      ...(steer ? { steer } : {}),
    },
  }
}

/**
 * The user message as written. The client may set only `metadata.steer`
 * ('applied' | 'next_turn', UI-2), `metadata.replyCard` (the card it replied
 * to, parsed again: parseCardReplyRef), `metadata.replyTo` (the message it
 * replied to and the words quoted, parsed again: parseMessageReplyRef), and
 * the pair `kind: 'reaction'` + `reaction` (a reaction's own turn, parsed
 * again: reactionTurnOfMetadata; one without the other is dropped). Anything
 * else it sends there is ignored (never the message itself).
 */
function userMessageOf(m: NonNullable<PersistEveTurnBody['userMessage']>): NonNullable<PersistEveTurnBody['userMessage']> {
  const meta = m.metadata as { steer?: unknown; replyCard?: unknown; replyTo?: unknown } | undefined
  const steer = meta?.steer
  const okSteer = typeof steer === 'string' && (STEER_OUTCOMES as readonly string[]).includes(steer)
  const replyCard = parseCardReplyRef(meta?.replyCard)
  const replyTo = parseMessageReplyRef(meta?.replyTo)
  const reaction = reactionTurnOfMetadata(meta)
  const metadata = {
    ...(okSteer ? { steer } : {}),
    ...(replyCard ? { replyCard } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(reaction ? { kind: REACTION_TURN_KIND, reaction } : {}),
  }
  return { messageId: m.messageId, parts: m.parts, ...(Object.keys(metadata).length > 0 ? { metadata } : {}) }
}

/** Shape guard for the optional turn-opening user message. */
function isUserMessage(v: unknown): v is NonNullable<PersistEveTurnBody['userMessage']> {
  if (!v || typeof v !== 'object') return false
  const m = v as Record<string, unknown>
  return typeof m.messageId === 'string' && m.messageId.length > 0 && Array.isArray(m.parts)
}
