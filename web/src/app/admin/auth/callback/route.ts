import { createClient } from '@/lib/supabase/server'
import { isAuthorizedAdmin } from '@/lib/admin'
import { NextResponse, type NextRequest } from 'next/server'

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const code = searchParams.get('code')

  const redirectUrl = request.nextUrl.clone()

  if (!code) {
    redirectUrl.pathname = '/admin/login'
    redirectUrl.searchParams.set('error', 'missing_code')
    return NextResponse.redirect(redirectUrl)
  }

  const supabase = await createClient()
  const { data, error } = await supabase.auth.exchangeCodeForSession(code)

  if (error || !data.user) {
    redirectUrl.pathname = '/admin/login'
    redirectUrl.searchParams.set('error', 'auth_failed')
    return NextResponse.redirect(redirectUrl)
  }

  // Server-side admin allowlist check (ADMIN_EMAILS) — this is the security gate
  if (!isAuthorizedAdmin(data.user.email)) {
    // Local scope: drop only the session this sign-in just made. The default
    // (global) would also sign the person out of the app and desktop.
    await supabase.auth.signOut({ scope: 'local' })
    redirectUrl.pathname = '/admin/login'
    redirectUrl.searchParams.set('error', 'unauthorized_domain')
    return NextResponse.redirect(redirectUrl)
  }

  redirectUrl.pathname = '/admin'
  redirectUrl.search = ''
  return NextResponse.redirect(redirectUrl)
}
