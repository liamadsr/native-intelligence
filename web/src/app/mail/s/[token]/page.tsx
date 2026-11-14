import { EmailShareLinkView } from '@/components/email/email-share-link-view'
import { isEmailShareLinkToken } from '@/lib/email-share/links'

export const metadata = {
  title: 'Shared email',
  // Someone's mail thread: out of the search index, and out of the Referer of anything it links to.
  robots: { index: false, follow: false },
  referrer: 'no-referrer' as const,
}

/**
 * An email thread's share link (/mail/s/<token>, migration 646). It grants
 * nothing on its own: the owner sees their thread; a teammate sees it when a
 * share made from this link sits in a chat they can read; anyone else sees
 * only that it is shared in chat. What to show is decided by the link's API,
 * as the person opening it (src/lib/email-share/service.ts resolveShareLink).
 * Kept out of PostHog and Sentry like a join link
 * (src/lib/privacy/join-token-redaction.ts).
 */
export default async function EmailShareLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return <EmailShareLinkView token={isEmailShareLinkToken(token) ? token : null} />
}
