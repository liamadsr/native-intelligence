import { getServiceClient } from '@/lib/admin'
import { createClient } from '@/lib/supabase/server'
import { findOpenJoinLink } from '@/lib/workspace-join/settings'
import { JOIN_LINK_CLOSED_MESSAGE, isJoinTokenShape } from '@/lib/workspace-join/token'
import { JoinLinkView } from './join-link-view'

export const metadata = {
  title: 'Join a workspace',
  // A workspace's own link: keep it out of the search index, and out of the
  // Referer header of anything the page links to.
  robots: { index: false, follow: false },
  referrer: 'no-referrer' as const,
}

/**
 * A workspace's shareable invite link (/join/<token>, migration 645). Signed
 * out, the page sends the person through sign-in and back here (the
 * invite_redirect cookie, src/lib/auth/post-auth-redirect.ts); signed in, one
 * click joins (POST /api/account/workspace/join/accept). A link that is off,
 * reset or unknown says so and nothing else: not even the workspace's name.
 */
export default async function JoinLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (!isJoinTokenShape(token)) return <LinkClosed />

  const service = getServiceClient()
  const link = await findOpenJoinLink(service, token)
  if (!link) return <LinkClosed />

  const { data: workspace } = await service
    .from('workspace')
    .select('name, logo_url')
    .eq('id', link.workspaceId)
    .maybeSingle()
  if (!workspace) return <LinkClosed />

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  let alreadyMember = false
  if (user) {
    const { data: member } = await service
      .from('member')
      .select('id')
      .eq('workspace_id', link.workspaceId)
      .eq('user_id', user.id)
      .maybeSingle()
    alreadyMember = !!member
  }

  return (
    <JoinLinkView
      token={token}
      workspaceName={(workspace.name as string) ?? 'a workspace'}
      isLoggedIn={!!user}
      userEmail={user?.email ?? null}
      alreadyMember={alreadyMember}
    />
  )
}

function LinkClosed() {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-md rounded-lg border p-8 text-center">
        <p className="text-sm font-medium">{JOIN_LINK_CLOSED_MESSAGE}</p>
        <p className="mt-2 text-sm text-muted-foreground">
          It was switched off or replaced. Ask someone in the workspace for a new one.
        </p>
        <a href="/login" className="mt-4 inline-block text-sm font-medium underline">
          Go to sign in
        </a>
      </div>
    </div>
  )
}
