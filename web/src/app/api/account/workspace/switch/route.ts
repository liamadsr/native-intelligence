import { createClient } from '@/lib/supabase/server'
import { DEMO_ONLY_MESSAGE, demoVisitorWorkspace } from '@/lib/demo/demo-mode'
import { NextResponse, type NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import { WORKSPACE_COOKIE } from '@/lib/workspace'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { workspace_id } = await request.json()
  if (!workspace_id) {
    return NextResponse.json(
      { error: 'workspace_id is required' },
      { status: 400 },
    )
  }

  // Verify membership
  const { data: member } = await supabase
    .from('member')
    .select('id')
    .eq('user_id', user.id)
    .eq('workspace_id', workspace_id)
    .single()

  if (!member) {
    return NextResponse.json({ error: 'Not a member' }, { status: 403 })
  }

  // A demo workspace's visitor (migration 669) stays in it: no other
  // workspace of theirs can be used until they hold a seat.
  const demoHome = await demoVisitorWorkspace(user.id)
  if (demoHome && demoHome !== workspace_id) {
    return NextResponse.json({ error: DEMO_ONLY_MESSAGE, code: 'DEMO_WORKSPACE_ONLY' }, { status: 403 })
  }

  const cookieStore = await cookies()
  cookieStore.set(WORKSPACE_COOKIE, workspace_id, {
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365,
  })

  return NextResponse.json({ ok: true })
}
