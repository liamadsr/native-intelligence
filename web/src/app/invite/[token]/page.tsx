import { getServiceClient } from '@/lib/admin'
import { createClient } from '@/lib/supabase/server'
import { InviteAcceptView } from './invite-accept-view'

export const metadata = {
  title: 'Accept Invite',
  // Per-recipient invite links — keep them out of the search index.
  robots: { index: false, follow: false },
}

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const service = getServiceClient()

  const { data: invite } = await service
    .from('invite')
    .select(
      '*, workspace:workspace_id(id, name, slug, logo_url), inviter:invited_by(display_name)',
    )
    .eq('token', token)
    .single()

  if (!invite) {
    return <InviteError message="This invite link is invalid." />
  }

  if (invite.accepted_at) {
    return <InviteError message="This invite has already been accepted." />
  }

  if (new Date(invite.expires_at) < new Date()) {
    return (
      <InviteError message="This invite has expired. Please ask for a new one." />
    )
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  return (
    <InviteAcceptView
      invite={{
        token: invite.token,
        email: invite.email,
        role: invite.role,
        workspaceName: (invite.workspace as { name: string })?.name ?? 'Unknown',
        workspaceLogo: (invite.workspace as { logo_url: string | null })?.logo_url ?? null,
        inviterName: (invite.inviter as { display_name: string })?.display_name ?? 'Someone',
      }}
      isLoggedIn={!!user}
      userEmail={user?.email ?? null}
    />
  )
}

function InviteError({ message }: { message: string }) {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-md rounded-lg border p-8 text-center">
        <p className="text-sm text-muted-foreground">{message}</p>
        <a
          href="/login"
          className="mt-4 inline-block text-sm font-medium underline"
        >
          Go to sign in
        </a>
      </div>
    </div>
  )
}
