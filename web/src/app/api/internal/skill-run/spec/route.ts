/**
 * GET /api/internal/skill-run/spec  (token via its header only)
 *
 * INTERNAL-ONLY. The eve `skill-runner` agent's dynamic resolvers (instructions,
 * tools, model) call this at session.started to get the run's system prompt,
 * model, and ceiling tools. The spec is REBUILT DETERMINISTICALLY from live DB
 * state keyed by the verified token's claims — there is no cross-instance store,
 * so this works across separate Vercel function instances (see
 * src/lib/flows/skill-run-token.ts and docs/plans/eve-migration-plan.md Phase 2).
 *
 * Auth (two gates): the shared internal secret (constant-time) proves the caller
 * is our own eve runtime; the HMAC-signed run token proves the routing facts were
 * minted by us and scopes the caller to one run. Tenancy comes ONLY from the
 * verified token — never a header, never the model. No session-ownership ACL
 * because there is no user-facing session access here.
 */
import { NextResponse } from 'next/server'
import {
  extractInternalSecret,
  verifyInternalSecret,
  extractRunToken,
  verifyRunToken,
} from '@/lib/flows/skill-run-token'
import { skillRunBindingRefusal } from '@/lib/flows/skill-run-binding'
import { rebuildEveSpec } from '@/lib/flows/skill-run-rebuild'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  // Gate 1: our-infrastructure caller (shared secret).
  if (!verifyInternalSecret(extractInternalSecret(request))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // Gate 2: a valid, unexpired, untampered run token — carries the routing facts.
  const claims = verifyRunToken(extractRunToken(request))
  if (!claims) {
    return NextResponse.json({ error: 'invalid or expired run token' }, { status: 401 })
  }

  // Gate 3: the claims must bind to live rows of their workspace (skill-run-binding.ts).
  const bindingRefusal = await skillRunBindingRefusal(claims)
  if (bindingRefusal) return bindingRefusal

  const spec = await rebuildEveSpec(claims)
  if (!spec) {
    // Skill vanished/edited-away in the claimed workspace — the run can't proceed.
    return NextResponse.json({ error: 'skill not found for this run' }, { status: 404 })
  }

  // Return the eve-facing view. Deliberately NO secrets — prompt text + tool
  // names + model only; tenancy stays inside the token and never becomes a
  // model-visible lever.
  return NextResponse.json(spec)
}
