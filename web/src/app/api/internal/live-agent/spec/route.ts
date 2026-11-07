/**
 * GET /api/internal/live-agent/spec   (token via header; `?schemas=1` for the
 * real input JSON Schemas)
 *
 * INTERNAL-ONLY. The eve `live-agent` mount's dynamic resolvers (instructions,
 * model, tools) call this at session.started — and the tools resolver again at
 * every step.started — to get the turn's system prompt, model, and tool
 * ceiling (LIVE-AGENT-DESIGN §5.2). The spec is REBUILT from live DB state keyed
 * ONLY by the verified run token (./live-agent-spec.ts), with the same
 * composition the cloud route runs — byte-identical, pinned by
 * live-agent-spec-parity.test.ts.
 *
 * Two gates (same discipline as every /api/internal/* eve route): the shared
 * internal secret (constant-time) proves the caller is our own eve runtime; the
 * HMAC-signed run token proves the routing facts were minted by the cloud route
 * and scopes the caller to one turn of one capture. No `?ctx=` payload: a
 * live-agent task session's whole per-turn content (transcript, corrections)
 * is its one message, assembled by the cloud route — the spec needs only the
 * durable claims.
 */
import { NextResponse } from 'next/server'
import {
  extractInternalSecret,
  extractLiveAgentRunToken,
  verifyInternalSecret,
  verifyLiveAgentRunToken,
} from '@/lib/live-agent/live-agent-run-token'
import { rebuildLiveAgentSpec } from '@/lib/live-agent/live-agent-spec'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  // Gate 1: our-infrastructure caller.
  if (!verifyInternalSecret(extractInternalSecret(request))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  // Gate 2: a valid, unexpired, untampered run token — the only tenancy source.
  const claims = verifyLiveAgentRunToken(extractLiveAgentRunToken(request))
  if (!claims) {
    return NextResponse.json({ error: 'invalid or expired run token' }, { status: 401 })
  }

  let schemas = false
  try {
    schemas = new URL(request.url).searchParams.get('schemas') === '1'
  } catch {
    // A malformed URL just means no schemas — the proxies fall back to permissive.
  }

  const spec = await rebuildLiveAgentSpec(claims, { schemas })
  if (!spec) {
    // Capture gone, not in the claimed workspace, private to another member,
    // membership revoked, or a batch token for a capture the caller doesn't own
    // — the turn can't proceed.
    return NextResponse.json(
      { error: 'live-agent turn not found for this token', code: 'TURN_NOT_FOUND' },
      { status: 404 },
    )
  }
  // Prompt text + tool names/schemas + model only — tenancy stays in the token.
  return NextResponse.json(spec)
}
