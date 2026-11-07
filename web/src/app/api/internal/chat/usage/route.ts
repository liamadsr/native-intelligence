/**
 * POST /api/internal/chat/usage
 *
 * INTERNAL-ONLY. The eve main-chat agent's usage-meter hook
 * (agents/chat-agent/hooks/usage-meter.ts) posts each finished turn's summed
 * step usage here, and this route bills it — exactly once per turn — under
 * feature 'ai_chat' (src/lib/chat/chat-usage-meter.ts). This replaced billing
 * from the browser's eve-persist body, which a client could under-report.
 *
 * Auth: the shared internal secret (constant-time) proves the caller is our own
 * eve runtime — it is the ONLY gate on who may report usage. Who PAYS is never
 * read from the body: it is the user of a chat-run token whose HMAC verifies
 * (an expired one included: expiry gates new work, not attribution), else the
 * owner of the eve session (chat_conversations.eve_session_id —
 * owner-derivation). So a turn whose token is missing or expired by the time it
 * ends is still billed to the right user. A token expired
 * TURN_REPORT_TOKEN_GRACE_MS ago or more counts as no token: the session's
 * owner pays (resolveChatUsagePayer). A report the hook could not deliver
 * here is billed by the outbox sweep (src/lib/inngest/chat-usage-outbox.ts)
 * through the same logic and key.
 *
 * Status codes (the hook's retry classification — spec-client reportTurnUsage):
 *   200 — billed, duplicate, empty, or a SURFACE run (the device ask bills its
 *         own 'device_ask' row, so metering it here too would double-bill it);
 *   400 — malformed report (final: never billed on a guess);
 *   401 {code: INTERNAL_SECRET_REJECTED} — the runtime's secret does not match
 *         this deployment (misconfiguration / rotation): alerted, and the hook
 *         keeps the report to re-send;
 *   409 {code: SESSION_UNREGISTERED} — no verifiable token and no conversation
 *         registers the session yet: the hook keeps it to re-send;
 *   500 — owner lookup failed or the bill was lost: the hook re-sends.
 */
import { NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { getServiceClient } from '@/lib/admin'
import { extractInternalSecret, verifyInternalSecret, extractChatRunToken } from '@/lib/chat/chat-run-token'
import {
  INTERNAL_SECRET_REJECTED,
  SESSION_UNREGISTERED,
  meterChatTurn,
  parseChatTurnUsageReport,
  resolveChatUsagePayer,
} from '@/lib/chat/chat-usage-meter'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  // The only gate: our-infrastructure caller (shared secret).
  if (!verifyInternalSecret(extractInternalSecret(request))) {
    // A caller holding a wrong secret is either a stranger or OUR runtime after
    // a secret mismatch — in which case every turn's bill is being refused.
    // Alert (Sentry groups repeats) so the latter is never silent.
    console.error('[chat usage] internal secret rejected')
    Sentry.captureMessage('chat usage report: internal secret rejected', {
      level: 'warning',
      tags: { area: 'billing', op: 'chat_usage_secret' },
    })
    return NextResponse.json({ error: 'unauthorized', code: INTERNAL_SECRET_REJECTED }, { status: 401 })
  }

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const parsed = parseChatTurnUsageReport(raw)
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 })
  }

  try {
    const supabase = getServiceClient()
    const resolved = await resolveChatUsagePayer(supabase, extractChatRunToken(request), parsed.report)
    if (resolved.kind === 'surface') {
      return NextResponse.json({ billed: false, reason: 'surface' })
    }
    if (resolved.kind === 'unregistered') {
      return NextResponse.json(
        { error: 'no conversation owns this session', code: SESSION_UNREGISTERED },
        { status: 409 },
      )
    }
    if (resolved.payer.via === 'session-owner') {
      // Expected only when the runtime had no readable token; worth seeing if it isn't.
      console.warn('[chat usage] billing a turn to its session owner (no verifiable run token)')
    }
    const result = await meterChatTurn(resolved.payer, parsed.report)
    return NextResponse.json(result)
  } catch (err) {
    console.error('[chat usage] metering failed:', err)
    return NextResponse.json({ error: 'usage metering failed' }, { status: 500 })
  }
}
