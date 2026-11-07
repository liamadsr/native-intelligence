import { getServiceClient } from '@/lib/admin'
import { connectOAuthClientId } from '@/lib/payments/config'
import { peekSetupLink } from '@/lib/payments/setup-link'
import { getConnectedAccount } from '@/lib/payments/accounts'
import { SetupLinkView, type SetupLinkState } from './setup-link-view'

export const metadata = {
  title: 'Connect Stripe',
  // One owner's single-use link: keep it out of the search index.
  robots: { index: false, follow: false },
}

// Read on every visit: a link is good once.
export const dynamic = 'force-dynamic'

/**
 * The texted Stripe setup link (roadmap C1, src/lib/payments/setup-link.ts).
 * GET only PEEKS (a link preview fetching the URL can't use it up); each
 * button is a same-origin form POST to /api/payments/setup/<token>, which
 * uses the link once and sends the owner on to Stripe. No sign-in: the link
 * itself, texted to the owner's verified number, is the proof.
 */
export default async function StripeSetupPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const service = getServiceClient()
  const found = await peekSetupLink(service, token)
  let state: SetupLinkState
  if (!found.ok) {
    state = { kind: found.reason === 'expired' ? 'expired' : found.reason === 'used' ? 'used' : 'invalid' }
  } else {
    const [{ data: workspace }, account] = await Promise.all([
      service.from('workspace').select('name').eq('id', found.link.workspaceId).maybeSingle<{ name: string | null }>(),
      getConnectedAccount(service, found.link.workspaceId),
    ])
    const business = workspace?.name?.trim() || 'your business'
    state = account?.status === 'ready'
      ? { kind: 'connected', business }
      : { kind: 'ready', business, canLinkExisting: connectOAuthClientId() !== null, resuming: account?.status === 'onboarding' && account.linkedVia === 'created' }
  }
  return <SetupLinkView token={token} state={state} />
}
