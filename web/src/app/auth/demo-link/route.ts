import { NextResponse, type NextRequest } from 'next/server'
import { createClient as createBareClient } from '@supabase/supabase-js'
import { browserOrigin } from '@/lib/auth/post-auth-redirect'
import { demoSupabaseTarget, isDemoUserEmail, isLocalHostname } from '@/lib/demo/demo-workspace-guard'
import { createClient } from '@/lib/supabase/server'

/**
 * Signs a local `next dev` into the demo workspace's person, from the link
 * `scripts/demo-workspace.ts --link` prints:
 *   http://localhost:3000/auth/demo-link?token_hash=…
 *
 * The token is a one-time magic-link token the script made with the service
 * role (auth.admin.generateLink). It isn't PKCE, so /auth/confirm (which takes
 * PKCE links only, on purpose) won't redeem it; this route does, and only
 * where it can't sign anyone real in:
 *   - only under `next dev` (NODE_ENV=development); everywhere else it is a 404;
 *   - only on a loopback host (localhost, 127.0.0.1, [::1]);
 *   - only against DEV's or a local Supabase (the seed script's own guard);
 *   - only for the demo person (demo@native-intelligence.test): the token is
 *     redeemed on a client that stores nothing, and only the demo person's
 *     session is then set on the browser. Anyone else's is never stored.
 * Then it lands on /account.
 */
export async function GET(request: NextRequest) {
  const origin = browserOrigin(request)
  if (!demoLinkAllowed(origin)) return new NextResponse(null, { status: 404 })

  const tokenHash = request.nextUrl.searchParams.get('token_hash')
  if (!tokenHash || !/^[0-9a-f]{40,64}$/.test(tokenHash)) {
    return NextResponse.redirect(new URL('/login?error=auth_failed', origin))
  }

  // Redeem the token on a client that keeps nothing, so no cookie is written
  // until we know whose session it is. Only the demo person's is then set on
  // the browser; anyone else's is dropped, never stored.
  const bare = createBareClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  const { data, error } = await bare.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' })
  if (error || !data.session || !isDemoUserEmail(data.user?.email)) {
    console.error('[demo-link] refused:', error ? error.message : 'not the demo person')
    return NextResponse.redirect(new URL('/login?error=auth_failed', origin))
  }
  const supabase = await createClient()
  const { error: setError } = await supabase.auth.setSession({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  })
  if (setError) {
    console.error('[demo-link] could not set the session:', setError.message)
    return NextResponse.redirect(new URL('/login?error=auth_failed', origin))
  }
  return NextResponse.redirect(new URL('/account', origin))
}

function demoLinkAllowed(origin: string): boolean {
  if (process.env.NODE_ENV !== 'development') return false
  if (!demoSupabaseTarget(process.env.NEXT_PUBLIC_SUPABASE_URL)) return false
  try {
    return isLocalHostname(new URL(origin).hostname)
  } catch {
    return false
  }
}

/** Link previews send HEAD; Next would run GET for it and spend the token. */
export function HEAD() {
  return new Response(null, { status: 204 })
}
