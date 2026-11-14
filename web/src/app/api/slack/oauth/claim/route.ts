/**
 * POST /api/slack/oauth/claim   { sealed, state, claimSecret }
 *
 * The second half of a Slack install started in the DESKTOP app
 * (src/lib/slack/install.ts). The person finished Slack's page in their
 * system browser, where the callback (/api/slack/oauth/callback) never
 * exchanges the code: it seals it and deep-links it back to the app
 * (dial8desktop://slack/complete). The window that started the install posts
 * it here with the claim secret the install route gave it. The install is
 * finished only when ALL of these hold:
 *   - Slack is set up here;
 *   - the caller is signed in through the webview's session (never a device
 *     token) as exactly the state's user;
 *   - the state's signature verifies and its `exp` is within the claim grace,
 *     and it is a Slack install's desktop state with a claim hash, a nonce
 *     and a workspace;
 *   - `claimSecret` hashes to the claim hash signed into the state;
 *   - the sealed code opens with the state's nonce.
 * Why both the session and the secret: the session alone would let a
 * person's app claim an install someone else started (it can't: the state
 * names the starter), and the secret alone is held by whoever started it, but
 * the code from a victim's consent lands on the victim's machine. Together,
 * only the starting window on the starter's machine finishes it
 * (src/lib/oauth/state.ts, security review "P0-2"). completeSlackInstall then
 * runs exactly as from the web callback, its checks included (the starter
 * must still be an admin of the workspace).
 *
 * Answers JSON `{ result }` (src/lib/slack/install-result.ts): 200 once the
 * install was attempted, whatever its result; otherwise 400 (bad body or
 * state), 401 (not signed in), 403 (another person, or the wrong secret) or
 * 503 (Slack or the state key not set up), with a result the page can show.
 */
import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { authenticateUser } from '@/lib/ai/auth'
import { CLAIM_GRACE_MS, claimSecretMatches, openDesktopCode, verifyOAuthState } from '@/lib/oauth/state'
import { slackConfigured } from '@/lib/slack/config'
import { slackInstallDeps } from '@/lib/slack/deps'
import { SLACK_INSTALL_CAPABILITY, completeSlackInstall } from '@/lib/slack/install'
import type { SlackInstallResult } from '@/lib/slack/install-result'

function answer(result: SlackInstallResult, status = 200): NextResponse {
  return NextResponse.json({ result }, { status, headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(request: Request) {
  if (!slackConfigured()) return answer('unavailable', 503)

  let userId: string
  try {
    const auth = await authenticateUser(request)
    // The webview's own session only: a device token is not the person at this window.
    if (auth.via === 'device') return answer('session', 401)
    userId = auth.user.id
  } catch (error) {
    if (error instanceof Response) return answer('session', 401)
    throw error
  }

  const body = (await request.json().catch(() => null)) as { sealed?: unknown; state?: unknown; claimSecret?: unknown } | null
  if (typeof body?.sealed !== 'string' || !body.sealed || typeof body.state !== 'string' || !body.state) {
    return answer('failed', 400)
  }

  // A claim follows a callback that passed within the state's `exp`; let it finish.
  const verified = verifyOAuthState(body.state, { graceMs: CLAIM_GRACE_MS })
  if (!verified.ok) {
    if (verified.error === 'server_misconfigured') return answer('failed', 503)
    return answer(verified.error === 'state_expired' ? 'expired' : 'failed', 400)
  }
  const state = verified.data
  if (state.capability !== SLACK_INSTALL_CAPABILITY || !state.workspaceId) return answer('failed', 400)
  // A web install is bound to its browser's cookie and is never claimable here.
  if (state.source !== 'desktop' || !state.claim || !state.nonce) return answer('session', 400)
  if (!state.userId || state.userId !== userId) return answer('session', 403)
  if (!claimSecretMatches(body.claimSecret, state.claim)) return answer('session', 403)
  const code = openDesktopCode(body.sealed, state.nonce)
  if (!code || code.length > 500) return answer('session', 400)

  const svc = getServiceClient()
  const result = await completeSlackInstall(svc, { code, userId: state.userId, workspaceId: state.workspaceId }, slackInstallDeps(svc))
  console.log('[slack/install]', { result })
  return answer(result)
}
