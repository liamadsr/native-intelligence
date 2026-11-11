/**
 * GET /api/internal/agent-run/spec  (token via its header only)
 *
 * INTERNAL-ONLY. The eve `coding-agent`'s dynamic resolvers (instructions, model,
 * sandbox) call this at session start to get the run's persona system prompt,
 * task text (the action's `<issue>` block, or a flow-origin run's own
 * task_prompt), target repo/branch, cloud-environment shaping, and the run's
 * git gate token. The spec is REBUILT DETERMINISTICALLY
 * from live DB state keyed by the verified token's claims — there is no
 * cross-instance store, so this works across separate Vercel function instances
 * (see src/lib/agent-run/agent-run-token.ts and
 * docs/plans/eve-phase3-coding-runs.md).
 *
 * Auth (two gates, same discipline as /api/internal/skill-run/*): the shared
 * internal secret (constant-time) proves the caller is our own eve runtime; the
 * HMAC-signed run token proves the routing facts were minted by us and scopes the
 * caller to one run. Tenancy comes ONLY from the verified token — never a header,
 * never the model.
 *
 * The response does NOT carry the triggering user's GitHub OAuth token: the
 * coding agent never holds it (rebuildAgentRunSpec drops it). It carries the
 * run's git gate token (src/lib/agent-run/git-push-token.ts) instead, for the
 * app's git gate (git-read-proxy.ts, git-push-proxy.ts), the only way the
 * run's clones, fetches and pushes reach GitHub; the gate adds the GitHub
 * token server-side. The gate token transits ONLY this internal authed
 * channel, and is not in the run token.
 */
import { NextResponse } from 'next/server'
import {
  extractInternalSecret,
  verifyInternalSecret,
  extractAgentRunToken,
  verifyAgentRunToken,
} from '@/lib/agent-run/agent-run-token'
import { rebuildAgentRunSpec } from '@/lib/agent-run/spec-rebuild'

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

  const spec = await rebuildAgentRunSpec(claims)
  if (!spec) {
    // Run/action/repo/token/persona/task missing — the run can't proceed. The
    // watcher settles it failed (agentRunExecute's precondition guard, built on
    // the same spec build, normally fails it before a session ever starts).
    return NextResponse.json({ error: 'agent run not found or not runnable' }, { status: 404 })
  }

  return NextResponse.json(spec)
}
