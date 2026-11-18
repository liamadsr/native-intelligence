import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getBillingAccess } from '@/lib/billing/access.server'
import { setActiveWorkspace } from '@/lib/workspace-join/add-member'

/**
 * GET /account/enter-demo: put a demo workspace's visitor back in it.
 *
 * A visitor has no seat of their own (migration 667, lib/billing/access.ts):
 * the dashboard and onboarding gates send them here whenever the active
 * workspace is any other one (a lost cookie falls back to the oldest
 * membership, which is the workspace their signup made). Sets the
 * active-workspace cookie and returns to the dashboard. Anyone else is simply
 * sent on: the cookie only ever names the caller's own demo workspace.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/login', request.url))

  const access = await getBillingAccess(supabase, user)
  if (access.state === 'demo' && access.demoWorkspaceId) {
    await setActiveWorkspace(access.demoWorkspaceId)
    return NextResponse.redirect(new URL('/account', request.url))
  }
  return NextResponse.redirect(new URL(access.allowed ? '/account' : '/account/start-trial', request.url))
}
