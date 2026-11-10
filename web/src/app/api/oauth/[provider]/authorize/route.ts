import { NextResponse } from 'next/server'
import { isValidProvider, isValidCapability } from '@/lib/oauth/config'
import { OAUTH_NONCE_COOKIE, OAUTH_STATE_TTL_MS, bindingCookieOptions } from '@/lib/oauth/state'
import { buildOAuthStart } from '@/lib/oauth/authorize-url'
import { authenticateUser } from '@/lib/ai/auth'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { notMember, serverError } from '@/lib/api-errors'
import { requestOrigin } from '@/lib/security/same-origin'

/**
 * GET /api/oauth/[provider]/authorize?capability=…: the signed-in person's
 * connect. The state and the provider URL are built by buildOAuthStart
 * (src/lib/oauth/authorize-url.ts), which a texted single-use link shares.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  try {
    const { user, supabase } = await authenticateUser(req)
    const { provider } = await params

    if (!isValidProvider(provider)) {
      return NextResponse.json(
        { error: `Invalid provider: ${provider}` },
        { status: 400 },
      )
    }

    // Get capability from query param (required)
    const url = new URL(req.url)
    const capability = url.searchParams.get('capability')

    if (!capability || !isValidCapability(capability)) {
      return NextResponse.json(
        { error: 'capability query param required (calendar or email)' },
        { status: 400 },
      )
    }

    // `source` selects how the callback binds the completer to the initiator
    // (security review P0-2). 'web' (the default, and what anything other than
    // exactly 'desktop' becomes): the callback requires the single-use nonce
    // cookie. 'desktop': the callback never exchanges the code; it deep-links
    // it back, and only the initiating window, holding the claim secret and
    // signed in as this user, can claim it (/api/oauth/[provider]/claim).
    // Before this, a non-web source was bound by the nonce's presence alone,
    // so an attacker could send a victim their own signed consent link and
    // have the victim's tokens stored under the attacker's account.
    const source = url.searchParams.get('source') === 'desktop' ? 'desktop' : 'web'
    const requestedWorkspaceId = url.searchParams.get('workspace_id')
    if (requestedWorkspaceId) {
      // The callback links the account (and imports its mail/CRM data) into
      // this workspace, so the caller must actually belong to it.
      const { data: member, error: memberError } = await supabase
        .from('member')
        .select('id')
        .eq('user_id', user.id)
        .eq('workspace_id', requestedWorkspaceId)
        .maybeSingle()
      if (memberError) return serverError('Failed to verify workspace membership')
      if (!member) return notMember()
    }
    const workspaceId = requestedWorkspaceId || await getCurrentWorkspaceId()

    const { authUrl, state, nonce, claimSecret } = buildOAuthStart({
      provider,
      capability,
      userId: user.id,
      workspaceId,
      source,
      returnTo: url.searchParams.get('redirect') || null,
      loginHint: url.searchParams.get('login_hint'),
      // The cookie below is set on this origin, so the connect finishes here: when the
      // provider calls back another of the app's domains, the callback hands its answer over.
      pageOrigin: source === 'web' ? requestOrigin(req) : null,
    })

    // The claim secret goes ONLY to the caller (the initiating desktop window,
    // which keeps it in memory to claim the code the deep link brings back).
    const response = NextResponse.json({ url: authUrl, state, ...(claimSecret && { claimSecret }) })
    // The web flow's binding: this browser's nonce, in a `__Host-` cookie in
    // production (lib/oauth/state.ts bindingCookieName), which the callback
    // requires. (A desktop flow is bound by its claim secret instead.)
    if (source === 'web') {
      response.cookies.set(OAUTH_NONCE_COOKIE(), nonce, bindingCookieOptions(Math.floor(OAUTH_STATE_TTL_MS / 1000)))
    }
    return response
  } catch (error) {
    if (error instanceof Response) return error
    return NextResponse.json({ error: 'Failed to generate OAuth URL' }, { status: 500 })
  }
}
