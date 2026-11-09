import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceIdSafe } from '@/lib/workspace'
import { getBillingAccess } from '@/lib/billing/access.server'
import { redirect } from 'next/navigation'
import { DashboardShell } from './dashboard-shell'
import { DashboardErrorBoundary } from './dashboard-error-boundary'

export const metadata = {
  title: 'My Account',
}

export default async function AccountLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  // Signup/login tracking is fired client-side by <AuthSessionPinger> (mounted
  // in DashboardShell), which POSTs /api/analytics/auth-session. That Route
  // Handler is the one place Next 16 lets us write the dedup cookie — Server
  // Components like this layout can read cookies but not set them.

  // The trial wall: no trialing/active seat (or comp) → no dashboard. Runs
  // before onboarding so a brand-new signup adds a card first, then onboards.
  // The same rule is enforced for every API path by check_ai_usage_limit.
  const access = await getBillingAccess(supabase, user)
  if (!access.allowed) {
    redirect('/account/start-trial')
  }

  // Redirect new users to onboarding if they haven't completed it
  const workspaceId = await getCurrentWorkspaceIdSafe()
  if (workspaceId) {
    const { data: member } = await supabase
      .from('member')
      .select('onboarding_completed_at')
      .eq('user_id', user.id)
      .eq('workspace_id', workspaceId)
      .single()

    if (member && !member.onboarding_completed_at) {
      redirect('/account/onboarding')
    }
  }

  const name =
    user.user_metadata?.full_name || user.user_metadata?.name || null
  const avatarUrl = user.user_metadata?.avatar_url || null

  // DashboardErrorBoundary must stay the container's ONLY child. A client
  // component rendered here beside siblings is a "forked" child to React's
  // useId, and when its JS chunk lands a moment after hydration reaches it,
  // React suspends and then replays it — and the replay drops the fork
  // (resetWorkInProgress clears the Forked flag). Every useId below it, i.e.
  // the whole shell, then hydrates with ids the server never rendered: an
  // intermittent mismatch that surfaced on the tab strip's gooey filter ids.
  // As an only child there is no fork to lose; the page slot sits beside the
  // container instead.
  // Pinned by src/app/__tests__/client-fork-hydration.test.tsx.
  return (
    <>
      <div data-dial8-app-root="" className="fixed inset-0 overflow-hidden overscroll-none bg-background text-foreground">
        <DashboardErrorBoundary>
          <DashboardShell
            userId={user.id}
            email={user.email ?? ''}
            name={name}
            avatarUrl={avatarUrl}
          />
        </DashboardErrorBoundary>
      </div>
      {/* children kept for Next.js layout contract; DashboardShell handles all views */}
      <div className="hidden">{children}</div>
    </>
  )
}
