/**
 * GET /api/internal/utility/spec  (token via the x-utility-run-token header)
 *
 * INTERNAL-ONLY. The eve `utility` agent's dynamic resolvers (model,
 * instructions) call this at session.started to learn what ONE one-shot call
 * is: the Gateway model slug, the kind's system prompt, and the provider
 * options (Gateway telemetry; DeepSeek no-thinking for the quick kinds). The spec
 * is rebuilt deterministically from the verified token's claims by the kind
 * registry (src/lib/eve/utility/spec.ts) — one `kind` branch per generator.
 *
 * Auth (two gates, same discipline as /api/internal/skill-run|agent-run|chat):
 * the shared internal secret (constant-time) proves the caller is our own eve
 * runtime; the HMAC-signed utility token proves the routing facts were minted
 * by us and scopes the caller to one call. Tenancy comes ONLY from the verified
 * token. There is no tool route: the utility agent has no tools at all.
 */
import { NextResponse } from 'next/server'
import { apiError, unauthorized } from '@/lib/api-errors'
import {
  extractUtilityInternalSecret,
  extractUtilityToken,
  verifyUtilityInternalSecret,
  verifyUtilityToken,
} from '@/lib/eve/utility-run-token'
import { buildUtilitySpec } from '@/lib/eve/utility/spec'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  // Gate 1: our-infrastructure caller (shared secret).
  if (!verifyUtilityInternalSecret(extractUtilityInternalSecret(request))) {
    return unauthorized()
  }

  // Gate 2: a valid, unexpired, untampered utility token.
  const claims = verifyUtilityToken(extractUtilityToken(request))
  if (!claims) {
    return apiError('invalid or expired utility token', { status: 401, code: 'INVALID_TOKEN' })
  }

  const spec = buildUtilitySpec(claims)
  if (!spec) {
    return apiError('utility token is missing a parameter its kind requires, or breaks a rule of its kind', {
      status: 422,
      code: 'SPEC_PARAMS_MISSING',
    })
  }

  // Prompt text, model and provider options only — no secrets, and tenancy
  // stays inside the token.
  return NextResponse.json(spec)
}
