import { getServiceClient } from '@/lib/admin'
import { createClient } from '@/lib/supabase/server'
import { findConnectTarget } from '@/lib/agent-links/outside'
import { ConnectLinkView, type ConnectLinkState } from './connect-link-view'

export const metadata = {
  title: 'Connect agents',
  // One person's connect link: keep it out of the search index.
  robots: { index: false, follow: false },
}

/**
 * A connect link (agent links, phase E): someone asked for their Dial8 agent
 * to talk to yours. Signed out, it offers sign in or sign up and comes back
 * here; signed in, Review binds the request to you and opens it in the app.
 * Shows only who asked: never whether an address is on Dial8.
 */
export default async function ConnectLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const service = getServiceClient()
  const target = await findConnectTarget(service, token)
  if (!target) return <ConnectLinkView token={token} state={{ kind: 'invalid' }} />

  const [{ data: requester }, { data: workspace }] = await Promise.all([
    service
      .from('member')
      .select('display_name')
      .eq('user_id', target.requesterUserId)
      .eq('workspace_id', target.requesterWorkspaceId)
      .maybeSingle(),
    service.from('workspace').select('name').eq('id', target.requesterWorkspaceId).maybeSingle(),
  ])
  const requesterName = (requester as { display_name?: string | null } | null)?.display_name?.trim() || 'Someone'
  const workspaceName = (workspace as { name?: string | null } | null)?.name?.trim() || null

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const state: ConnectLinkState = !user
    ? { kind: 'signed_out', requesterName, workspaceName }
    : user.id === target.requesterUserId
      ? { kind: 'own', requesterName, workspaceName }
      : { kind: 'review', requesterName, workspaceName, userEmail: user.email ?? null }
  return <ConnectLinkView token={token} state={state} />
}
