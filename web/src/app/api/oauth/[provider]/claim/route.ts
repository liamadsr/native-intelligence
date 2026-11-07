import { NextResponse } from 'next/server'
import { authenticateUser } from '@/lib/ai/auth'
import { isValidProvider, isValidCapability } from '@/lib/oauth/config'
import { CLAIM_GRACE_MS, claimSecretMatches, openDesktopCode, verifyOAuthState } from '@/lib/oauth/state'
import { completeOAuthConnect } from '@/lib/oauth/complete-connect'

/**
 * POST /api/oauth/[provider]/claim  { sealed, state, claimSecret }
 *
 * The second half of a DESKTOP integration connect (security review
 * 2026-10-31, P0-2). The callback never exchanges a desktop code: it deep-links
 * it back to the app SEALED (lib/oauth/state.ts sealDesktopCode — only this
 * server can open it), and the window that started the connect posts it here
 * with the claim secret the authorize route gave it. The code is opened,
 * exchanged and stored only when ALL of these hold:
 *   - the state's signature and `exp` verify, and it is a desktop state;
 *   - the caller is signed in (the webview's session, never a device token)
 *     as exactly the state's user;
 *   - `claimSecret` hashes to the claim hash signed into the state.
 *
 * Why both checks: the session check alone would let a victim's own app claim
 * an attacker-started code (it can't: the state names the attacker), and the
 * secret check alone would be met by the attacker, who started the flow and
 * holds their own secret — but the code from the victim's consent lands on the
 * victim's machine, never the attacker's. Together, only the initiating window
 * on the initiator's machine can finish the link.
 *
 * Answers JSON: 200 `{ success: true, provider, capability, email }`, else
 * `{ success: false, error }` with 400 (bad body / state), 401 (not signed
 * in), 403 (wrong user or secret) or 502 (the exchange failed).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params
  if (!isValidProvider(provider)) {
    return NextResponse.json({ success: false, error: 'invalid_provider' }, { status: 400 })
  }

  let user: { id: string }
  try {
    const auth = await authenticateUser(req)
    if (auth.via === 'device') {
      return NextResponse.json({ success: false, error: 'not_signed_in' }, { status: 401 })
    }
    user = auth.user
  } catch (err) {
    if (err instanceof Response) {
      return NextResponse.json({ success: false, error: 'not_signed_in' }, { status: 401 })
    }
    throw err
  }

  let body: { sealed?: unknown; state?: unknown; claimSecret?: unknown }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ success: false, error: 'invalid_body' }, { status: 400 })
  }
  if (typeof body.sealed !== 'string' || !body.sealed || typeof body.state !== 'string' || !body.state) {
    return NextResponse.json({ success: false, error: 'invalid_body' }, { status: 400 })
  }

  // A claim follows a callback that passed the state's `exp`; let it finish.
  const verified = verifyOAuthState(body.state, { graceMs: CLAIM_GRACE_MS })
  if (!verified.ok) {
    const status = verified.error === 'server_misconfigured' ? 503 : 400
    return NextResponse.json({ success: false, error: verified.error }, { status })
  }
  const state = verified.data
  if (state.source !== 'desktop' || !state.claim || !state.nonce) {
    return NextResponse.json({ success: false, error: 'csrf_validation_failed' }, { status: 400 })
  }
  if (!state.userId || state.userId !== user.id) {
    return NextResponse.json({ success: false, error: 'csrf_validation_failed' }, { status: 403 })
  }
  if (!claimSecretMatches(body.claimSecret, state.claim)) {
    return NextResponse.json({ success: false, error: 'csrf_validation_failed' }, { status: 403 })
  }
  if (!state.capability || !isValidCapability(state.capability)) {
    return NextResponse.json({ success: false, error: 'invalid_state' }, { status: 400 })
  }
  const code = openDesktopCode(body.sealed, state.nonce)
  if (!code) {
    return NextResponse.json({ success: false, error: 'csrf_validation_failed' }, { status: 400 })
  }

  const result = await completeOAuthConnect({
    provider,
    code,
    userId: user.id,
    capability: state.capability,
    stateWorkspaceId: state.workspaceId,
    stateNonce: state.nonce,
  })
  if (!result.ok) {
    const status = result.error === 'not_member' || result.error === 'no_workspace' ? 403 : 502
    return NextResponse.json({ success: false, error: result.error }, { status })
  }
  return NextResponse.json({ success: true, provider: result.provider, capability: result.capability, email: result.email })
}
