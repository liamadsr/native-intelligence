/**
 * GET /api/internal/work-run/spec  (token via its header only)
 *
 * INTERNAL-ONLY. The eve `work-agent`'s dynamic resolvers (instructions, tools,
 * model) call this at session.started to get the run's system prompt, model, and
 * ceiling-filtered workspace tools. The spec is REBUILT DETERMINISTICALLY from
 * live DB state keyed by the verified token's claims — there is no cross-instance
 * store, so this works across separate Vercel function instances
 * (docs/loop-engine/WORK-PROPOSALS-DESIGN.md).
 *
 * Auth (two gates, same discipline as /api/internal/agent-run/* and skill-run):
 * the shared internal secret (constant-time) proves the caller is our own eve
 * runtime; the HMAC-signed run token proves the routing facts were minted by us
 * and scopes the caller to one run. Tenancy comes ONLY from the verified token —
 * never a header, never the model. The work-run token is the SAME agent-run token
 * (agent-run-token.ts) — a work run IS an agent_run row (kind='workspace').
 */
import { NextResponse } from 'next/server'
import {
  extractInternalSecret,
  verifyInternalSecret,
  extractAgentRunToken,
  verifyAgentRunToken,
} from '@/lib/agent-run/agent-run-token'
import { rebuildWorkRunSpec } from '@/lib/agent-run/run-work-spec-rebuild'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  // Gate 1: our-infrastructure caller (shared secret).
  if (!verifyInternalSecret(extractInternalSecret(request))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // Gate 2: a valid, unexpired, untampered run token — carries the routing facts.
  const claims = verifyAgentRunToken(extractAgentRunToken(request))
  if (!claims) {
    return NextResponse.json({ error: 'invalid or expired run token' }, { status: 401 })
  }

  const spec = await rebuildWorkRunSpec(claims)
  if (!spec) {
    // Run vanished, or is not a workspace-kind run — the run can't proceed here.
    return NextResponse.json({ error: 'work run not found for this token' }, { status: 404 })
  }

  // Return the eve-facing view. Deliberately NO secrets — prompt text + tool
  // names + model only; tenancy stays inside the token and never becomes a
  // model-visible lever.
  return NextResponse.json(spec)
}
