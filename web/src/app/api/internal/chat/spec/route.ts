/**
 * GET /api/internal/chat/spec  (token via its header only, per-turn ctx via ?ctx=)
 *
 * INTERNAL-ONLY. The eve main-chat agent's dynamic resolvers (instructions,
 * tools, model) call this each turn to get the conversation's layered system
 * prompt, plan-clamped model, and callable-tool ceiling. The spec is REBUILT
 * DETERMINISTICALLY from live DB state keyed by the verified token's DURABLE
 * claims + the PER-TURN context this request carries — there is no
 * cross-instance store, so it works across separate Vercel function instances
 * (see src/lib/chat/chat-run-token.ts and docs/plans/eve-phase4-chat.md).
 *
 * Auth (two gates, same discipline as /api/internal/skill-run|agent-run/*): the
 * shared internal secret (constant-time) proves the caller is our own eve
 * runtime; the HMAC-signed run token proves the durable routing facts were
 * minted by us and scopes the caller to one conversation. Tenancy
 * (workspaceId/userId) comes ONLY from the verified token — never a header,
 * never the model.
 *
 * ── Durable vs per-turn split ───────────────────────────────────────────────
 * The token carries the DURABLE identity (conversationId, tenancy, agentId,
 * skillId). The VOLATILE per-turn context (editor selection, chat files,
 * live-capture id, attached projects, email thread, the message's routing
 * signals) rides as a base64url-encoded JSON `ctx` query param — it changes
 * turn-to-turn and must not be frozen into the durable token. A malformed or
 * absent `ctx` degrades to an empty turn context (base prompt + persona only),
 * never a 500.
 */
import { NextResponse } from 'next/server'
import {
  extractInternalSecret,
  verifyInternalSecret,
  extractChatRunToken,
  verifyChatRunToken,
} from '@/lib/chat/chat-run-token'
import { rebuildChatSpec } from '@/lib/chat/chat-run-rebuild'
import { GuestTurnRefused, rebuildGuestChatSpec } from '@/lib/guests/guest-spec'
import { decodeChatTurnContext } from '@/lib/chat/chat-spec-turn'
import { chatRunBindingRefusal } from '@/lib/chat/surface-run-guard'
import { helperSpecFields } from '@/lib/chat/helpers-gate'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  // Gate 1: our-infrastructure caller (shared secret).
  if (!verifyInternalSecret(extractInternalSecret(request))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // Gate 2: a valid, unexpired, untampered run token — carries the durable
  // routing facts. A wrong/absent secret or bad token is 401.
  const claims = verifyChatRunToken(extractChatRunToken(request))
  if (!claims) {
    return NextResponse.json({ error: 'invalid or expired run token' }, { status: 401 })
  }

  // Gate 3 (surface tokens only): the run must still own its ephemeral row —
  // /api/device/ask deletes it when the ask ends, which revokes the token.
  const refused = await chatRunBindingRefusal(claims)
  if (refused) return refused

  // Liveness-only probe (?live=1): the chat-agent's usage gate asks this before
  // EVERY model step of a surface run, so a run whose row was deleted (the ask
  // ended; its cancel may have failed) dies at its next step instead of running
  // on. Answered right after the gates above — no rebuild, no usage check.
  if (new URL(request.url).searchParams.get('live') === '1') {
    return NextResponse.json({ live: true })
  }

  const turn = decodeChatTurnContext(new URL(request.url).searchParams.get('ctx'))

  // Skills (?skills=1: the "Available skills" section + spec.skills), the
  // tools' input schemas (?schemas=1) and the split prompt (?turnContext=1:
  // the stable systemPrompt + spec.turnContext) ride only when requested. The
  // chat-agent asks for all three on its one memoized fetch per turn, which
  // serves every resolver (agents/chat-agent/lib/spec-client.ts). A caller
  // that does not ask for the split gets the full layered prompt, as before.
  const params = new URL(request.url).searchParams
  const includeSkills = params.get('skills') === '1'
  const includeSchemas = params.get('schemas') === '1'
  const splitTurnContext = params.get('turnContext') === '1'

  let spec
  try {
    // A guest's own agent (guest access) gets its own spec: none of the
    // owner's layers, only what the owner gave that person.
    spec = claims.guestId
      ? await rebuildGuestChatSpec(claims, { includeSchemas, splitTurnContext })
      : await rebuildChatSpec(claims, turn, { includeSkills, includeSchemas, splitTurnContext })
  } catch (err) {
    if (err instanceof GuestTurnRefused) {
      return NextResponse.json({ error: err.message, code: 'GUEST_UNAVAILABLE' }, { status: 403 })
    }
    // checkUsageLimits throws a Response on 429/503 (usage/billing). Surface it
    // as-is so the eve runtime sees the real status; anything else is a 500.
    if (err instanceof Response) return err
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message, code: 'CHAT_SPEC_REBUILD_FAILED' }, { status: 500 })
  }

  // Return the eve-facing view. Deliberately NO secrets — prompt text + tool
  // names + model only; tenancy stays inside the token.
  //
  // Quick helpers (A4 slice 3): whether this conversation may start them,
  // decided here from the VERIFIED claims (never anything the model or the
  // browser sends), with the reason when not, and the tools a helper may
  // call (src/lib/chat/helpers-gate.ts). The chat-agent's `helpers` tool reads
  // the flag in its first step; the helper's tool resolver reads the names.
  return NextResponse.json({ ...spec, ...helperSpecFields(claims, spec.ceilingTools) })
}
