/**
 * POST /api/internal/analytics/skill-loaded  (token via header)
 *
 * INTERNAL-ONLY. The eve main-chat runtime's native `load_skill` tool posts here
 * (fire-and-forget) after it matches a skill and injects its playbook into the
 * CURRENT chat context, so `skill_auto_loaded` becomes a countable product event
 * — the ONLY window into how often description-as-routing actually pulls a skill
 * in mid-conversation. A tracking failure never affects the tool result (the
 * caller swallows any error), and this route never writes the DB (a SURFACE
 * token costs one liveness read — surface-run-guard.ts).
 *
 * Auth (two gates, same discipline as /api/internal/chat/spec): the shared
 * internal secret (constant-time) proves the caller is our own eve runtime; the
 * HMAC-signed chat-run token proves the tenancy facts were minted by us. Tenancy
 * (userId/workspaceId) comes ONLY from the verified token — never a header, never
 * the model. Body carries just `{ skillName }`, the untrusted display string.
 */
import { NextResponse } from 'next/server'
import {
  extractInternalSecret,
  verifyInternalSecret,
  extractChatRunToken,
  verifyChatRunToken,
} from '@/lib/chat/chat-run-token'
import { trackServerEvent } from '@/lib/posthog'
import { chatRunBindingRefusal } from '@/lib/chat/surface-run-guard'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  // Gate 1: our-infrastructure caller (shared secret).
  if (!verifyInternalSecret(extractInternalSecret(request))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // Gate 2: a valid, unexpired, untampered run token — carries the tenancy.
  const claims = verifyChatRunToken(extractChatRunToken(request))
  if (!claims) {
    return NextResponse.json({ error: 'invalid or expired run token' }, { status: 401 })
  }

  // Gate 3 (surface tokens only): the same liveness fence as the spec + tool
  // routes — a device ask whose ownership row is gone has ended, and its token
  // is revoked everywhere, analytics included.
  const refused = await chatRunBindingRefusal(claims)
  if (refused) return refused

  // Body is best-effort: a malformed/empty body degrades to no skill name, never
  // a 500 — this is analytics, not a product write.
  let skillName: string | undefined
  try {
    const body = (await request.json()) as { skillName?: unknown }
    if (typeof body?.skillName === 'string') skillName = body.skillName
  } catch {
    // ignore — skillName stays undefined
  }

  // Tenancy from the TOKEN only. trackServerEvent is itself fail-soft (no-op when
  // PostHog is unconfigured, never throws).
  trackServerEvent(
    'skill_auto_loaded',
    { userId: claims.userId, workspaceId: claims.workspaceId },
    {
      skill_name: skillName,
      conversation_id: claims.conversationId,
      workspace_id: claims.workspaceId,
    },
  )

  return NextResponse.json({ ok: true })
}
