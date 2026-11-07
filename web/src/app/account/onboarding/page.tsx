import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceIdSafe } from '@/lib/workspace'
import { getBillingAccess } from '@/lib/billing/access.server'
import { redirect } from 'next/navigation'
import { OnboardingWizard } from './onboarding-wizard'
import { AuthSessionPinger } from '@/components/analytics/auth-session-pinger'

export const metadata = {
  title: 'Get Started – Dial8',
}

export default async function OnboardingPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  // Trial wall first (same gate as the dashboard layout): a new signup adds a
  // card before they see the wizard.
  const access = await getBillingAccess(supabase, user)
  if (!access.allowed) {
    redirect('/account/start-trial')
  }

  // Server-side mirror of the (dashboard)/layout.tsx check, with the OPPOSITE
  // condition on the SAME row: a member whose onboarding is already complete
  // never mounts the wizard — they go straight to the dashboard. Both sides
  // read member.onboarding_completed_at through the same resolution
  // (header → cookie → oldest membership), so as long as the two requests
  // resolve the same workspace — which that shared, deterministic resolution
  // guarantees for identical request context — the redirects cannot disagree.
  // (Degrades open: if the workspace or member can't be resolved, render the
  // wizard and let its own GET sort things out.)
  const workspaceId = await getCurrentWorkspaceIdSafe()
  if (workspaceId) {
    const { data: member } = await supabase
      .from('member')
      .select('onboarding_completed_at')
      .eq('user_id', user.id)
      .eq('workspace_id', workspaceId)
      .single()

    if (member?.onboarding_completed_at) {
      redirect('/account')
    }
  }

  // New sign-ups land here BEFORE the dashboard, so fire the auth-session
  // tracker here too. The pinger POSTs the same Route Handler, which dedups
  // server-side — so this counts a signup at first contact even if the user
  // abandons onboarding and never reaches the dashboard.
  return (
    <>
      <AuthSessionPinger />
      <OnboardingWizard />
    </>
  )
}
