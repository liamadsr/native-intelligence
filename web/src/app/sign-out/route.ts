import { createClient } from '@/lib/supabase/server'
import { AUTH_EVENT_COOKIE } from '@/lib/posthog'
import { NextResponse, type NextRequest } from 'next/server'

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  // Scope to this session only. The default ('global') revokes every session
  // the user has — including the desktop app and other browsers.
  await supabase.auth.signOut({ scope: 'local' })

  const redirectUrl = request.nextUrl.clone()
  redirectUrl.pathname = '/login'
  redirectUrl.search = ''
  const res = NextResponse.redirect(redirectUrl)
  // Clear the auth-session dedup cookie so the NEXT sign-in (even a re-login
  // within the hour) is counted as a fresh login rather than silently
  // deduped away.
  res.cookies.delete(AUTH_EVENT_COOKIE)
  return res
}
