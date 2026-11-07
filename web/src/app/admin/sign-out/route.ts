import { createClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  // Scope to this session only. The default ('global') revokes every session
  // the user has — including the desktop app and other browsers.
  await supabase.auth.signOut({ scope: 'local' })

  const url = request.nextUrl.clone()
  url.pathname = '/admin/login'
  return NextResponse.redirect(url)
}
