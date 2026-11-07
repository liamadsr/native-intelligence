/**
 * POST /api/account/chat/eve-session — the browser-facing companion the
 * EveChatTransport calls to (a) mint a chat-run token for a conversation and
 * (b) register the eve session id onto that conversation (Phase 4 — main chat →
 * eve durable sessions).
 *
 * WHY THIS EXISTS (and is Supabase-authed, not internal-secret): the transport
 * runs in the BROWSER. The chat-run token is HMAC-signed with a SERVER-ONLY
 * secret (CHAT_INTERNAL_SECRET), so the client can never mint it directly — it
 * asks this Supabase-authed route to. And the ownership ACL on the chat-agent's
 * eve channel authorizes continue/stream against `chat_conversations.eve_session_id`
 * (migration 190), which must be written the instant eve mints the session — this
 * route does that write, owner-scoped, so the ACL fails CLOSED on anything not
 * provably ours.
 *
 * TENANCY: userId + workspaceId come from the caller's verified Supabase session
 * (requireWorkspace), NEVER from the body. The body only names WHICH conversation
 * (+ the active persona/skill) — and any conversation id it names is re-scoped to
 * the caller's own row before it's trusted (a cross-user/cross-workspace id is
 * treated as absent → a fresh conversation is created for the caller instead).
 *
 * GATING: eve is the only cloud chat runtime, so there is no flag — but mint is
 * refused with 503 CHAT_RUNTIME_UNCONFIGURED when the internal secret
 * (CHAT_INTERNAL_SECRET, falling back to RUN_SKILL_INTERNAL_SECRET) is unset: the
 * token could not be signed, and every internal route would refuse it anyway.
 * Mint is ALSO the PRIMARY usage-limit gate for the chat: checkUsageLimits runs
 * before the token is minted, and its thrown 429/503 Responses pass through
 * verbatim (429 usage-limit; 503 code BILLING_UNAVAILABLE — distinguishable from
 * this route's own 503 by body.code).
 *
 * Two actions on one route (both cheap, both per-turn / once-per-session):
 *   { action: 'mint', conversationId?, agentId?, skillId?, wantHistory? }
 *     → ensures a conversation owned by the caller exists (creates one when the id
 *       is absent/foreign), mints a token for it. Returns { token, conversationId,
 *       eveSessionId } (the session already registered on the conversation, which
 *       a chat with no live handle re-attaches to), plus, with wantHistory,
 *       historyPrimer: a bounded "conversation so far" block for the first
 *       message of a NEW session (conversation-history.ts), null when empty.
 *   { action: 'register', conversationId, sessionId }
 *     → writes eve_session_id onto the caller's own conversation. Returns { ok }.
 *   { action: 'presence', conversationId }
 *     → the person is typing in an existing conversation: pushes its
 *       idle-compaction timer back (idle-compaction-signal.ts, `typing`). Only
 *       for the caller's own conversation in this workspace (404 otherwise);
 *       one with no eve session yet has nothing to compact and answers
 *       { ok, session: false } without a signal. No usage gate, no token. The
 *       composer asks at most once a minute per conversation. Returns { ok }.
 *
 * TEAMMATE CHATS (bots v2, docs/plans/bots-v2.md Phase 1): with a `teammateId`,
 * the conversation is the caller's ONE thread with that AI teammate:
 *   { action: 'mint', teammateId, wantHistory? }
 *     → the teammate must be visible to the caller under RLS, the caller a
 *       member of its workspace, and the private-team rule must hold, checked
 *       explicitly (teammate-access.ts: ai_team_member's admin ALL policy
 *       would otherwise let an owner or admin outside a private team in); the thread is got-or-created (upsert on (user_id,
 *       ai_team_member_id), migration 300) in the TEAMMATE's workspace, and
 *       the token is minted for that workspace with a `teammateId` claim. The
 *       persona is the teammate's, resolved server-side at spec time — never
 *       routed through the RLS `agentId` check (a system teammate's loop
 *       recipe is invisible under RLS) — so the body's conversationId and
 *       agentId are ignored. A `skillId` (bots v4: the full composer's picked
 *       skill) is checked like the main chat's, under the caller's RLS, and
 *       must be the teammate's workspace's own or a system skill (400
 *       otherwise); it steers the turn, never widens the teammate's ceiling.
 *       Returns { token, conversationId, eveSessionId, workspaceId,
 *       historyPrimer? }.
 *     With `about: { workItemId } | { cardId }` (bots v3 1d, docs/plans/
 *     bots-v3.md "The conversation, per run kind"): the turn is about one of
 *     the caller's own items (a loop's run, opened from its bot's peek). The
 *     item is checked on the caller's RLS client (acceptTeammateAbout:
 *     tracked_job and attention_item SELECT are owner-only), in the
 *     teammate's workspace, not another teammate's work; only then are its
 *     ids signed into the token (aboutWorkItemId / aboutCardId), and the
 *     spec rebuild builds the "About this item" section from them. One that
 *     fails the check mints without it (the turn still goes to the thread)
 *     and answers `about: false`; one that passes, `about: true`.
 *   { action: 'focus', focusArea }
 *     → an area face's page chat (one-agent S3): the caller's latest
 *       conversation focused on that area here, else a new one; no usage
 *       gate, no token (focusedConversation).
 *   { action: 'thread', teammateId }
 *     → the same checks and get-or-create, with no usage gate and no token:
 *       what a teammate chat calls on open to load its history before the
 *       first send. Returns { conversationId, workspaceId, eveSessionId,
 *       teammate: { id, name } }.
 * The client then sends `x-workspace-id: <workspaceId>` on register, the eve
 * channel and the history read (EveChatTransport's `workspaceId` option), so
 * a teammate in a workspace other than the current one works.
 * SYSTEM TEAMMATES (one face, docs/plans/always-on-agent.md §2c): the
 * Assistant and the area faces are the agent's own face, and talking to it is
 * the person's home thread, so no new thread is made with one: 'thread' only
 * finds an existing one (404 SYSTEM_TEAMMATE_NO_THREAD when there is none),
 * and a teammate 'mint' (a send) is refused (409 SYSTEM_TEAMMATE_READ_ONLY:
 * the old threads stay, read-only).
 *
 * FOCUSED CONVERSATIONS (one-agent plan S3, migration 318): the ordinary mint
 * with `focusArea` (one of the 16 area keys) makes a NEW conversation focused
 * on that area (`chat_conversations.focus_area`): the main agent, full tools,
 * attended, as any main chat, with the area's pack in its prompt from the
 * first turn. The focus is fixed when the conversation starts: an existing
 * conversation keeps its own (the row's, signed as `focusArea`), whatever the
 * body says, so a resend can never re-focus or un-focus it. A value that
 * isn't an area key is a 400 naming the keys. Answers `focusArea` when set.
 *
 * THE HOME THREAD (always-on agent A3, docs/plans/always-on-agent.md §2c,
 * migration 330): the person's ONE conversation in this workspace, which every
 * surface opens and which never starts over.
 *   { action: 'mint', home: true, agentId?, skillId?, wantHistory? }
 *     → the caller's home thread here, got or created (ensureHomeThread: a
 *       read, then an ignore-duplicates upsert on (user_id, workspace_id,
 *       is_home)); the body's conversationId and focusArea are ignored (a
 *       home thread is never focused). Otherwise the ordinary mint: the same
 *       usage gate, persona/skill checks and token. Answers `home: true`.
 *   The ordinary mint naming a conversation that is the caller's home thread
 *   answers `home: true` too. For either, a history primer (wantHistory, a
 *   session that must be new) is the home primer when the thread has a
 *   checkpoint (renderHomePrimer: eve's last checkpoint, fenced as untrusted,
 *   plus the messages since), else the ordinary 40-message one.
 *
 * ONE AGENT (docs/plans/one-chat.md, Slice 2): the main chat is always the main
 * agent. The ordinary mint takes a persona `agentId` only for a live call's
 * conversation (one with a capture link whose capture is the caller's own, in
 * this workspace: the live agent picked for that call) and for the onboarding
 * guide's persona on the caller's home thread; any other is a 400
 * AGENT_NOT_ALLOWED, checked before any conversation is made. A custom agent is reached as a named helper or
 * on its bot's page.
 *
 * The mint refuses a conversation that names a bot (409 BOT_CONVERSATION):
 * bots v4 Phase C let a main-chat conversation have a bot as its agent
 * (chat_conversations.agent_teammate_id, migration 307); one chat (Slice 2)
 * retired them, nothing makes one any more, and the old rows stay, unlisted
 * and read-only, since only their bot could carry them on.
 * A bot deleted since leaves the column NULL (ON DELETE SET NULL), and the
 * conversation carries on as an ordinary one.
 */
import { requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest, rateLimited, serverError } from '@/lib/api-errors'
import { NextResponse, type NextRequest } from 'next/server'
import { checkUsageLimits } from '@/lib/ai/auth'
import { isChatGptPlanUsage } from '@/lib/chatgpt/plan-models'
import { internalSecret, mintChatRunToken } from '@/lib/chat/chat-run-token'
import { sealRunCredential } from '@/lib/chat/chat-run-credential'
import { isDeviceToken } from '@/lib/device-tokens'
import { decodeJwtSub } from '@/lib/supabase/server'
import { DEFAULT_CONVERSATION_TITLE } from '@/lib/chat/chat-title'
import { renderConversationPrimer, renderHomePrimer } from '@/lib/chat/conversation-history'
import { HomeThreadUnavailableError, UNDEFINED_COLUMN, ensureHomeThread } from '@/lib/chat/home-thread'
import { ensureTeammateThread, findTeammateThread, resolveVisibleTeammate, type TeammateThread, type VisibleTeammate } from '@/lib/chat/teammate-chat'
import { acceptTeammateAbout } from '@/lib/chat/teammate-about'
import { parseTeammateAboutRef, type TeammateAboutRef } from '@/lib/chat/teammate-about-ref'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AREA_KEYS, PACKS, isAreaKey, type AreaKey } from '@/lib/packs/registry'
import { enabledAreaGate } from '@/lib/packs/chat-packs'
import { resolveWorkspaceEdition } from '@/lib/editions'
import { allowPresencePing, signalChatSessionActivity } from '@/lib/chat/idle-compaction-signal'

export const dynamic = 'force-dynamic'

interface EveSessionBody {
  action?: 'mint' | 'register' | 'thread' | 'focus' | 'presence' | 'usage'
  /** mint: also return the history primer (a send with no live session handle). */
  wantHistory?: boolean
  conversationId?: string | null
  agentId?: string
  skillId?: string
  sessionId?: string
  /** A teammate chat (bots v2): the AI teammate the thread is with. */
  teammateId?: string
  /** A teammate chat's turn about one of the caller's items (bots v3 1d): ids only. */
  about?: unknown
  /** The ordinary mint: a new conversation focused on this area (one-agent S3). */
  focusArea?: unknown
  /** The mint: the caller's home thread in this workspace (A3), got or created. */
  home?: boolean
  /** register: the session the transport knew the row held (null: none); present = a conditional write. */
  previousSessionId?: string | null
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  let body: EveSessionBody
  try {
    body = (await request.json()) as EveSessionBody
  } catch {
    return badRequest('invalid JSON body')
  }

  const teammateId = typeof body.teammateId === 'string' && body.teammateId ? body.teammateId : null

  if (body.action === 'thread') {
    if (!teammateId) return badRequest('teammateId required')
    const resolved = await resolveTeammateThread(request, supabase, user.id, teammateId, 'read')
    if (resolved instanceof Response) return resolved
    return NextResponse.json({
      conversationId: resolved.thread.id,
      workspaceId: resolved.teammate.workspaceId,
      eveSessionId: resolved.thread.eveSessionId,
      teammate: { id: resolved.teammate.id, name: resolved.teammate.name },
    })
  }

  if (body.action === 'focus') {
    if (!isAreaKey(body.focusArea)) {
      return badRequest(`focusArea must be one of ${AREA_KEYS.join(', ')}.`)
    }
    const off = await areaSwitchedOff(supabase, workspaceId, body.focusArea)
    if (off) return off
    return focusedConversation(supabase, { userId: user.id, workspaceId, area: body.focusArea })
  }

  // The usage check alone (no row, no token): the transport asks it when a turn
  // it sent was cancelled with no answer and no Stop, which since eve 0.68 is
  // what the chat-agent's usage-limit-gate hook does to a blocked turn (it can
  // no longer throw). A 429 / 503 BILLING_UNAVAILABLE answer comes back exactly
  // as the mint's would, so the client's /api 429 watch opens the usage-limit
  // dialog (lib/workspace-fetch.ts).
  if (body.action === 'usage') {
    try {
      // The same opt-in as the mint: a free ChatGPT user's chat runs on their plan.
      await checkUsageLimits(user.id, undefined, { chatgptPlan: true })
    } catch (err) {
      if (err instanceof Response) return err
      return serverError(err instanceof Error ? err.message : 'usage check failed')
    }
    return NextResponse.json({ ok: true })
  }

  if (body.action === 'mint') {
    // The internal secret must be configured — without it the token can't be
    // signed or verified. A deployment misconfiguration, surfaced verbatim.
    if (!internalSecret()) return runtimeUnconfigured()

    // ── Usage gate: the PRIMARY billing block for the eve chat path ─────────
    // A usage-limited user must never receive a run token: with no token, no
    // turn can start, so the block happens BEFORE any eve session work — the
    // exact analogue of gating before any model call. (The chat-agent's
    // usage-limit-gate hook still guards the residual race where limits flip
    // between this mint and turn.started: it cancels the turn, and the
    // transport then asks the 'usage' action above, whose 429 opens the
    // usage-limit dialog. This mint gate is still where the user gets the
    // toast copy before any eve session work.)
    //
    // checkUsageLimits THROWS a Response on 429 (usage limit, body carries
    // error/reason/plan/isPaidPlan/usageResetDate/creditBalanceUsd) and on 503
    // fail-closed (body { error, code: 'BILLING_UNAVAILABLE' }) — return those
    // as-is so the transport reads the real status + structured body. NOTE the
    // two 503s on this route stay distinguishable by body.code:
    // CHAT_RUNTIME_UNCONFIGURED (secret unset) vs BILLING_UNAVAILABLE (billing
    // check down, fail-closed). Anything else thrown is a genuine 500.
    //
    // It opts in to the ChatGPT free tier: the chat runs a free user on their
    // own plan (the spec routes it, chat-run-rebuild.ts), and the token says so
    // for the agent's spec-outage fallback (ChatRunTokenClaims.chatgptPlan).
    let chatgptPlan = false
    try {
      chatgptPlan = isChatGptPlanUsage(await checkUsageLimits(user.id, undefined, { chatgptPlan: true }))
    } catch (err) {
      if (err instanceof Response) return err
      return serverError(err instanceof Error ? err.message : 'usage check failed')
    }

    // A teammate chat: the caller's one thread with that teammate, in ITS
    // workspace, with a token carrying the teammate (see the header).
    if (teammateId) {
      const resolved = await resolveTeammateThread(request, supabase, user.id, teammateId, 'send')
      if (resolved instanceof Response) return resolved
      const asked = parseTeammateAboutRef(body.about)
      const about = await acceptTeammateAbout(supabase, asked, {
        workspaceId: resolved.teammate.workspaceId,
        teammateId: resolved.teammate.id,
      })
      const skillId = await teammateSkillId(supabase, body.skillId, resolved.teammate.workspaceId)
      if (skillId instanceof Response) return skillId
      return mintResponse(request, supabase, {
        conversationId: resolved.thread.id,
        workspaceId: resolved.teammate.workspaceId,
        userId: user.id,
        eveSessionId: resolved.thread.eveSessionId,
        teammateId: resolved.teammate.id,
        ...(skillId ? { skillId } : {}),
        ...(asked ? { about, askedAbout: true } : {}),
        // Only an existing thread has history to prime a new eve session with.
        existing: !resolved.thread.created,
        wantHistory: body.wantHistory === true,
        chatgptPlan,
      })
    }

    // The home thread (A3): the caller's one conversation here, got or created.
    // Ensure a conversation owned by THIS caller. A named id is trusted only after
    // it resolves to the caller's own row; otherwise (absent / foreign) create one.
    const home = body.home === true ? await homeThreadOr500(supabase, user.id, workspaceId) : null
    if (home instanceof Response) return home
    const owned = home
      ? { id: home.id, eveSessionId: home.eveSessionId, agentTeammateId: null, focusArea: null, isHome: true, captureId: null }
      : await ownedConversationOr500(supabase, body.conversationId ?? null, user.id, workspaceId)
    if (owned instanceof Response) return owned
    // A conversation with a bot as its agent (bots v4 Phase C, retired by one
    // chat): never run as an ordinary chat, which would drop the bot's persona
    // and limits. It stays read-only.
    if (owned?.agentTeammateId) {
      return apiError('This conversation is with an agent: start a new chat.', {
        status: 409,
        code: 'BOT_CONVERSATION',
        details: { teammateId: owned.agentTeammateId },
      })
    }
    // A guest's thread (guest access): only their own agent answers in it, by
    // text. The owner reads it; a turn of theirs there would run their own
    // agent in the guest's session.
    if (owned && 'guestId' in owned && owned.guestId) {
      return apiError('This conversation is someone texting your agent: it is read-only here.', {
        status: 409,
        code: 'GUEST_CONVERSATION',
      })
    }
    let conversationId = owned?.id ?? null
    const eveSessionId = owned?.eveSessionId ?? null
    // A focus is fixed when the conversation starts: an existing one keeps its own.
    let focusArea: AreaKey | null = owned ? owned.focusArea : null
    if (!owned && !home && body.focusArea !== undefined && body.focusArea !== null && body.focusArea !== '') {
      if (!isAreaKey(body.focusArea)) {
        return badRequest(`focusArea must be one of ${AREA_KEYS.join(', ')}, or left out for an ordinary chat.`)
      }
      const off = await areaSwitchedOff(supabase, workspaceId, body.focusArea)
      if (off) return off
      focusArea = body.focusArea
    }

    // One agent: a persona drives only a live call's conversation (the live
    // agent picked for it: a capture conversation whose capture is the
    // caller's own, in this workspace); never the main chat, and never a
    // conversation this call would create. Onboarding is the main agent too
    // (docs/plans/getting-started-skill.md). Checked BEFORE anything is made,
    // so a refused mint leaves no empty conversation behind.
    if (typeof body.agentId === 'string' && body.agentId) {
      const liveCall = !!owned?.captureId && (await ownsCapture(supabase, owned.captureId, user.id, workspaceId))
      if (!liveCall) {
        return apiError('The main chat is always the main agent: a custom agent works as a named helper or on its own page.', {
          status: 400,
          code: 'AGENT_NOT_ALLOWED',
        })
      }
    }

    if (!conversationId) {
      const { data: conv, error } = await supabase
        .from('chat_conversations')
        .insert({
          user_id: user.id,
          workspace_id: workspaceId,
          // The constant the first-turn title backfill (persist-eve-turn.ts) matches
          // on — a different string here would leave eve chats untitled forever.
          title: DEFAULT_CONVERSATION_TITLE,
          ...(focusArea ? { focus_area: focusArea } : {}),
        })
        .select('id')
        .single<{ id: string }>()
      if (error || !conv) {
        return serverError(error?.message || 'failed to create conversation')
      }
      conversationId = conv.id
    }

    // Verify the requested persona/skill is one the caller may actually use
    // BEFORE embedding its id in the signed token. The id is client-supplied and
    // the downstream rebuild reads the recipe with a service-role client (no
    // workspace filter), so without this check an attacker could pass another
    // workspace's private recipe UUID and have its system_prompt injected. The
    // lookup runs under the caller's RLS (request-scoped `supabase`), so
    // recipe_select_visibility only returns rows the caller is entitled to
    // (system / public / own-workspace).
    if (typeof body.agentId === 'string' && body.agentId) {
      const { data: agent } = await supabase
        .from('recipe')
        .select('id')
        .eq('id', body.agentId)
        .eq('category', 'agent')
        .maybeSingle<{ id: string }>()
      if (!agent) return badRequest('agent not found')
    }
    if (typeof body.skillId === 'string' && body.skillId) {
      const { data: skill } = await supabase
        .from('recipe')
        .select('id')
        .eq('id', body.skillId)
        .eq('category', 'skill')
        .maybeSingle<{ id: string }>()
      if (!skill) return badRequest('skill not found')
    }

    return mintResponse(request, supabase, {
      conversationId,
      workspaceId,
      userId: user.id,
      eveSessionId,
      ...(typeof body.agentId === 'string' ? { agentId: body.agentId } : {}),
      ...(typeof body.skillId === 'string' ? { skillId: body.skillId } : {}),
      ...(focusArea ? { focusArea } : {}),
      ...(owned?.isHome ? { home: true } : {}),
      // A home thread this call created is empty: no history to prime with.
      existing: home ? !home.created : owned !== null,
      wantHistory: body.wantHistory === true,
      chatgptPlan,
    })
  }

  if (body.action === 'presence') {
    const conversationId = body.conversationId
    if (typeof conversationId !== 'string' || !conversationId) {
      return badRequest('conversationId required')
    }
    // Per person too (the signal throttles per conversation), before any read.
    if (!allowPresencePing(user.id)) return rateLimited('too many presence pings')
    // The caller's own conversation, here: one indexed read.
    const { data: conv, error } = await supabase
      .from('chat_conversations')
      .select('id, eve_session_id')
      .eq('id', conversationId)
      .eq('user_id', user.id)
      .eq('workspace_id', workspaceId)
      .maybeSingle<{ id: string; eve_session_id: string | null }>()
    if (error) return serverError(error.message)
    if (!conv) {
      return NextResponse.json(
        { error: 'conversation not found for caller', code: 'CONVERSATION_NOT_FOUND' },
        { status: 404 },
      )
    }
    // Typing in a conversation with no eve session (a home thread or a live
    // call's chat before its first registered turn) is ordinary: there is
    // nothing to compact, so nothing to signal. This was a 404, which put
    // every such keystroke in prod's error logs as a "not found".
    if (!conv.eve_session_id) return NextResponse.json({ ok: true, session: false })
    signalChatSessionActivity({ conversationId, workspaceId, userId: user.id, source: 'typing' })
    return NextResponse.json({ ok: true })
  }

  if (body.action === 'register') {
    const conversationId = body.conversationId
    const sessionId = body.sessionId
    if (typeof conversationId !== 'string' || !conversationId) {
      return badRequest('conversationId required')
    }
    if (typeof sessionId !== 'string' || !sessionId) {
      return badRequest('sessionId required')
    }

    // Write eve_session_id onto the caller's OWN conversation only. Scoped by
    // user_id + workspace_id so a caller can never claim ownership of another's
    // conversation; count === 0 means the row wasn't the caller's (or is gone).
    //
    // With `previousSessionId` (the session the transport knew the row held,
    // null for none): the write lands only while the row still holds that one
    // (or nothing, or this very session). Two windows on one conversation (the
    // home thread, A3) whose sessions both forked can't overwrite each other:
    // the loser gets a 409 SESSION_CONFLICT naming the current session and
    // re-attaches to it on its next send. Without the field (an older client)
    // the write is unconditional, as before.
    const conditional = 'previousSessionId' in body
    const previous = typeof body.previousSessionId === 'string' && body.previousSessionId ? body.previousSessionId : null
    let update = supabase
      .from('chat_conversations')
      .update({ eve_session_id: sessionId }, { count: 'exact' })
      .eq('id', conversationId)
      .eq('user_id', user.id)
      .eq('workspace_id', workspaceId)
    if (conditional) {
      update = update.or(
        [
          'eve_session_id.is.null',
          `eve_session_id.eq.${postgrestValue(sessionId)}`,
          ...(previous ? [`eve_session_id.eq.${postgrestValue(previous)}`] : []),
        ].join(','),
      )
    }
    const { error, count } = await update

    if (error) return serverError(error.message)
    if (!count && conditional) {
      const { data: current, error: readError } = await supabase
        .from('chat_conversations')
        .select('eve_session_id')
        .eq('id', conversationId)
        .eq('user_id', user.id)
        .eq('workspace_id', workspaceId)
        .maybeSingle<{ eve_session_id: string | null }>()
      if (readError) return serverError(readError.message)
      if (current) {
        return apiError('Another window started a new session on this conversation.', {
          status: 409,
          code: 'SESSION_CONFLICT',
          details: { eveSessionId: current.eve_session_id ?? null },
        })
      }
    }
    if (!count) {
      return NextResponse.json(
        { error: 'conversation not found for caller', code: 'CONVERSATION_NOT_FOUND' },
        { status: 404 },
      )
    }
    return NextResponse.json({ ok: true })
  }

  return badRequest('unknown action')
}

/**
 * Mint the token for a resolved conversation and answer the mint. Shared by
 * the ordinary chat and the teammate chat: tenancy is always the VERIFIED one
 * the caller resolved (the teammate's workspace for a teammate chat).
 *
 * Throws only if the secret is unset, which the caller ruled out — but guard
 * anyway so a misconfig is a 503, not a 500.
 *
 * The caller's Supabase JWT (the Bearer this mint authenticated with) rides
 * the token SEALED (chat-run-credential.ts), so the internal tool route can
 * hand it to the tools that call back into the app as the user
 * (generate_email_drafts, draft_followup_email), exactly as the in-process
 * chat route passed its bearer to createTools. Only a JWT for THIS user; a
 * device token or a cookie-only caller seals nothing.
 *
 * The history primer, only for an EXISTING conversation (a created one is
 * empty) and only when asked. Read under the caller's RLS (request-scoped
 * client) and owner-scoped again inside; best-effort: a failed read degrades
 * to no primer, never a failed mint.
 */
async function mintResponse(
  request: NextRequest,
  supabase: SupabaseClient,
  args: {
    conversationId: string
    workspaceId: string
    userId: string
    eveSessionId: string | null
    agentId?: string
    skillId?: string
    teammateId?: string
    /** A teammate chat's item, checked (null: asked for and refused). */
    about?: TeammateAboutRef | null
    /** The mint was asked for an item: it answers whether it took it. */
    askedAbout?: boolean
    /** A focused conversation's area (one-agent S3): signed, and answered. Never with a teammate. */
    focusArea?: AreaKey
    /** The caller's home thread (A3): answered, and its primer is the home primer when it has a checkpoint. */
    home?: boolean
    existing: boolean
    wantHistory: boolean
    /** The caller's AI runs on their ChatGPT plan: signed into the token. */
    chatgptPlan?: boolean
  },
): Promise<Response> {
  const { conversationId, workspaceId, userId } = args
  const jwt = callerJwt(request, userId)
  let token: string
  try {
    const binding = { conversationId, workspaceId, userId }
    token = mintChatRunToken({
      ...binding,
      ...(args.agentId !== undefined ? { agentId: args.agentId } : {}),
      ...(args.skillId !== undefined ? { skillId: args.skillId } : {}),
      ...(args.teammateId ? { teammateId: args.teammateId } : {}),
      // An item is the thread's alone: never on a bot conversation's token.
      ...(args.teammateId && args.about?.workItemId ? { aboutWorkItemId: args.about.workItemId } : {}),
      ...(args.teammateId && args.about?.cardId ? { aboutCardId: args.about.cardId } : {}),
      ...(args.focusArea && !args.teammateId ? { focusArea: args.focusArea } : {}),
      ...(jwt ? { cred: sealRunCredential(jwt, binding) } : {}),
      ...(args.chatgptPlan ? { chatgptPlan: true as const } : {}),
    })
  } catch {
    return runtimeUnconfigured()
  }

  // A send is starting: push this conversation's idle-compaction timer back
  // (idle-compaction-signal.ts; after the response, at most once a minute).
  signalChatSessionActivity({ conversationId, workspaceId, userId, source: 'mint' })

  let historyPrimer: string | null = null
  if (args.wantHistory && args.existing) {
    const ids = { conversationId, userId, workspaceId }
    // A home thread re-primes from its last checkpoint when it has one; a
    // failed or empty read falls back to the ordinary primer.
    const homePrimer = args.home ? await renderHomePrimer(supabase, ids).catch(() => null) : null
    historyPrimer = homePrimer ?? (await renderConversationPrimer(supabase, ids).catch(() => null))
  }

  return NextResponse.json({
    token,
    conversationId,
    eveSessionId: args.eveSessionId,
    // A teammate thread's workspace, which the client sends as x-workspace-id.
    ...(args.teammateId ? { workspaceId } : {}),
    ...(args.askedAbout ? { about: !!args.about } : {}),
    ...(args.focusArea && !args.teammateId ? { focusArea: args.focusArea } : {}),
    ...(args.home && !args.teammateId ? { home: true } : {}),
    ...(args.wantHistory ? { historyPrimer } : {}),
  })
}

/** The caller's Supabase JWT from the Bearer, only when it is THIS user's (never a device token). */
function callerJwt(request: NextRequest, userId: string): string | null {
  const authHeader = request.headers.get('authorization') || ''
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  return bearer && !isDeviceToken(bearer) && decodeJwtSub(bearer) === userId ? bearer : null
}

/**
 * A teammate chat's thread for the caller: the teammate visible to them under
 * RLS in a workspace they belong to, on a team they may reach
 * (resolveVisibleTeammate, on the caller's request-scoped client), then their one thread with it, got or created
 * (ensureTeammateThread). A device token is refused outright: a teammate chat
 * is an in-app conversation, and a device credential is pinned to one
 * workspace with no RLS session behind it. 404 TEAMMATE_NOT_FOUND for a
 * teammate the caller can't see (never saying which check failed); 409 when
 * their existing thread sits in another workspace than the teammate now does;
 * 500 on a query error. A SYSTEM teammate's thread (one face, see the header)
 * is never made: `read` finds an existing one (404 SYSTEM_TEAMMATE_NO_THREAD
 * when there is none), and `send` is refused (409 SYSTEM_TEAMMATE_READ_ONLY).
 */
async function resolveTeammateThread(
  request: NextRequest,
  supabase: SupabaseClient,
  userId: string,
  teammateId: string,
  use: 'read' | 'send',
): Promise<{ teammate: VisibleTeammate; thread: TeammateThread } | Response> {
  const authHeader = request.headers.get('authorization') || ''
  if (authHeader.startsWith('Bearer ') && isDeviceToken(authHeader.slice(7).trim())) {
    return NextResponse.json(
      { error: 'teammate chats need a signed-in session', code: 'TEAMMATE_CHAT_DEVICE_TOKEN' },
      { status: 403 },
    )
  }
  try {
    const teammate = await resolveVisibleTeammate(supabase, userId, teammateId)
    if (!teammate) {
      return NextResponse.json({ error: 'teammate not found', code: 'TEAMMATE_NOT_FOUND' }, { status: 404 })
    }
    if (teammate.isSystem) {
      // One face: talking to the agent is the person's home thread.
      if (use === 'send') {
        return NextResponse.json(
          { error: 'Talk to your assistant in your conversation with it: this older thread is read-only.', code: 'SYSTEM_TEAMMATE_READ_ONLY' },
          { status: 409 },
        )
      }
      const old = await findTeammateThread(supabase, { userId, teammate })
      if (!old) {
        return NextResponse.json(
          { error: 'Talk to your assistant in your conversation with it.', code: 'SYSTEM_TEAMMATE_NO_THREAD' },
          { status: 404 },
        )
      }
      return { teammate, thread: old }
    }
    const thread = await ensureTeammateThread(supabase, { userId, teammate })
    if (!thread) {
      return NextResponse.json(
        { error: 'this teammate thread belongs to another workspace', code: 'TEAMMATE_THREAD_CONFLICT' },
        { status: 409 },
      )
    }
    return { teammate, thread }
  } catch (err) {
    console.error('[eve-session] teammate thread failed:', err instanceof Error ? err.message : String(err))
    return serverError('could not open the teammate thread')
  }
}

/**
 * Whether `captureId` is the caller's own capture in this workspace (the live
 * conversation is the recorder's, as POST /api/account/chat-history/live
 * makes it). A failed read is no: the persona is simply not unlocked.
 */
async function ownsCapture(supabase: SupabaseClient, captureId: string, userId: string, workspaceId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('captures')
    .select('id')
    .eq('id', captureId)
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .maybeSingle<{ id: string }>()
  return !error && !!data
}

async function areaSwitchedOff(supabase: SupabaseClient, workspaceId: string, area: AreaKey): Promise<Response | null> {
  const enabled = enabledAreaGate(await resolveWorkspaceEdition(supabase, workspaceId))
  if (enabled(area)) return null
  const name = PACKS[area].name
  return apiError(
    `${name} is switched off in this workspace, so a conversation can't be focused on it. Turn ${name} on in Settings → Features, or focus an area that's on.`,
    { status: 400, code: 'AREA_OFF', details: { area, feature: PACKS[area].feature } },
  )
}

/**
 * An area face's page chat (one-agent plan S3): the caller's latest main-chat
 * conversation focused on `area` in this workspace, else a new one: the same
 * kind of conversation the ordinary mint makes for a new one with `focusArea`
 * (the main agent, full tools, the area's pack from the first turn), so each
 * visit to the page continues the last one. No usage gate and no token (the
 * 'thread' action's shape):
 * the send mints through the ordinary path, which reads the focus from the
 * row. Answers { conversationId, workspaceId, eveSessionId, focusArea }.
 */
async function focusedConversation(
  supabase: SupabaseClient,
  args: { userId: string; workspaceId: string; area: AreaKey },
): Promise<Response> {
  const { userId, workspaceId, area } = args
  const { data: latest, error } = await supabase
    .from('chat_conversations')
    .select('id, eve_session_id')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .eq('focus_area', area)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; eve_session_id: string | null }>()
  if (error) {
    console.error('[eve-session] focused conversation read failed:', error.message)
    return serverError('could not read the conversation')
  }
  if (latest) {
    return NextResponse.json({ conversationId: latest.id, workspaceId, eveSessionId: latest.eve_session_id ?? null, focusArea: area })
  }
  const { data: conv, error: insertError } = await supabase
    .from('chat_conversations')
    .insert({ user_id: userId, workspace_id: workspaceId, title: DEFAULT_CONVERSATION_TITLE, focus_area: area })
    .select('id')
    .single<{ id: string }>()
  if (insertError || !conv) return serverError(insertError?.message || 'failed to create conversation')
  return NextResponse.json({ conversationId: conv.id, workspaceId, eveSessionId: null, focusArea: area })
}

/**
 * A skill picked in a teammate's conversation (its thread's full composer,
 * bots v4, or a bot conversation in the main chat, Phase C): checked as the
 * main chat's is (the caller's RLS read of a skill), and only `workspaceId`'s
 * own or a system one, the "/" picker's set there. Its playbook steers the
 * bot's turn (the spec's skill layer); the ceiling stays the bot's (a skill
 * never widens it). Undefined for none; a 400 for any other.
 */
async function teammateSkillId(
  supabase: SupabaseClient,
  requested: unknown,
  workspaceId: string,
): Promise<string | undefined | Response> {
  if (typeof requested !== 'string' || !requested) return undefined
  const { data: skill } = await supabase
    .from('recipe')
    .select('id, workspace_id, is_system')
    .eq('id', requested)
    .eq('category', 'skill')
    .maybeSingle<{ id: string; workspace_id: string | null; is_system: boolean | null }>()
  if (!skill || (skill.is_system !== true && skill.workspace_id !== workspaceId)) return badRequest('skill not found')
  return skill.id
}

/** A value for a PostgREST filter: as is when plain (an eve session id is `wrun_…`), else quoted. */
function postgrestValue(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : `"${value.replace(/["\\]/g, '')}"`
}

/** 503 for a deployment with no internal secret — the token cannot be signed. */
function runtimeUnconfigured(): Response {
  return NextResponse.json(
    { error: 'chat runtime is not configured', code: 'CHAT_RUNTIME_UNCONFIGURED' },
    { status: 503 },
  )
}

/**
 * Return the given conversation id ONLY when it resolves to a row owned by
 * (userId, workspaceId); otherwise null. This makes a client-supplied id
 * untrusted-until-verified: a foreign or unknown id is treated as absent so the
 * caller gets a fresh conversation of their own rather than binding to another's.
 * `agentTeammateId` is the bot it runs as (bots v4 Phase C, migration 307),
 * null for an ordinary chat; `focusArea` the area it is focused on (one-agent
 * S3, migration 318), null for none.
 *
 * A failed read throws (the mint answers 500), never a false "not yours": read
 * as absent, it would fork the conversation onto a fresh row at every send
 * (and a bot conversation would slip its bot), which is what a database
 * without migration 307's column would do on every follow-up turn.
 */
async function resolveOwnedConversation(
  supabase: SupabaseClient,
  candidate: string | null,
  userId: string,
  workspaceId: string,
): Promise<{ id: string; eveSessionId: string | null; agentTeammateId: string | null; focusArea: AreaKey | null; isHome: boolean; captureId: string | null; guestId?: string | null } | null> {
  if (!candidate) return null
  type Row = { id: string; eve_session_id: string | null; agent_teammate_id: string | null; focus_area?: string | null; is_home?: boolean | null; capture_id?: string | null; agent_guest_id?: string | null }
  const read = (columns: string) =>
    supabase
      .from('chat_conversations')
      .select(columns)
      .eq('id', candidate)
      .eq('user_id', userId)
      .eq('workspace_id', workspaceId)
      .maybeSingle<Row>()
  let { data, error } = await read('id, eve_session_id, agent_teammate_id, focus_area, is_home, capture_id, agent_guest_id')
  // A database without migration 427 has no guest threads.
  if (error?.code === UNDEFINED_COLUMN) ({ data, error } = await read('id, eve_session_id, agent_teammate_id, focus_area, is_home, capture_id'))
  // A database without migration 330 has no is_home: the conversation is no
  // home thread, and the send goes on as before (never a 500).
  if (error?.code === UNDEFINED_COLUMN) ({ data, error } = await read('id, eve_session_id, agent_teammate_id, focus_area, capture_id'))
  if (error) throw new Error(`conversation lookup failed: ${error.message}`)
  return data
    ? {
        id: data.id,
        eveSessionId: data.eve_session_id ?? null,
        agentTeammateId: data.agent_teammate_id ?? null,
        focusArea: isAreaKey(data.focus_area) ? data.focus_area : null,
        isHome: data.is_home === true,
        captureId: data.capture_id ?? null,
        ...(data.agent_guest_id ? { guestId: data.agent_guest_id } : {}),
      }
    : null
}

/**
 * The caller's home thread here (A3), got or created on their RLS client
 * (ensureHomeThread), with a failed read or write answered as a 500 (logged,
 * never the DB's words).
 */
async function homeThreadOr500(
  supabase: SupabaseClient,
  userId: string,
  workspaceId: string,
): Promise<Awaited<ReturnType<typeof ensureHomeThread>> | Response> {
  try {
    return await ensureHomeThread(supabase, { userId, workspaceId })
  } catch (err) {
    if (err instanceof HomeThreadUnavailableError) {
      return apiError('Home threads are not available yet.', { status: 404, code: 'HOME_THREAD_UNAVAILABLE' })
    }
    console.error('[eve-session]', err instanceof Error ? err.message : String(err))
    return serverError('could not open the home thread')
  }
}

/** resolveOwnedConversation, with a failed read answered as a 500 (logged, never the DB's words). */
async function ownedConversationOr500(
  supabase: SupabaseClient,
  candidate: string | null,
  userId: string,
  workspaceId: string,
): Promise<Awaited<ReturnType<typeof resolveOwnedConversation>> | Response> {
  try {
    return await resolveOwnedConversation(supabase, candidate, userId, workspaceId)
  } catch (err) {
    console.error('[eve-session]', err instanceof Error ? err.message : String(err))
    return serverError('could not read the conversation')
  }
}
