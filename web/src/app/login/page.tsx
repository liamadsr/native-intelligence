import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/admin'
import { resolveSignupInvite } from '@/lib/admin/signup-invites'
import { isGoogleSignInEnabled } from '@/lib/auth/google-sign-in'
import { isChatGptSignInEnabled } from '@/lib/chatgpt/config'
import { redirect } from 'next/navigation'
import { LoginForm } from './login-form'

export const metadata = {
  title: 'Sign In',
  robots: { index: false, follow: false },
}

export default async function AccountLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string; invite?: string }>
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { redirect: redirectParam, invite: inviteToken } = await searchParams

  if (user) {
    // If the user came here to sign in so they could comment on a shared
    // view, honour that redirect instead of dumping them into /account.
    if (
      redirectParam &&
      redirectParam.startsWith('/s/') &&
      !redirectParam.includes('//')
    ) {
      redirect(redirectParam)
    }
    redirect('/account')
  }

  // An admin signup invite (/login?invite=<token>). Resolved here, server-side
  // with the service role, so the invitee's address is prefilled without ever
  // appearing in the URL. Unknown, used or expired tokens simply render the
  // ordinary form.
  const invited = inviteToken
    ? await resolveSignupInvite(getServiceClient(), inviteToken)
    : null

  return (
    <LoginForm
      invitedEmail={invited?.email ?? null}
      chatGptSignIn={isChatGptSignInEnabled()}
      googleOnDial8={isGoogleSignInEnabled()}
    />
  )
}
