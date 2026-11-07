import { notFound } from 'next/navigation'
import InboxTidyPreview from './inbox-tidy-preview'

/**
 * The morning tidy in the home thread, drawn standalone — DEV ONLY
 * (src/lib/email/auto-archive.ts): the morning digest, then the tidy's own
 * message with Undo, from the real chat components with fixture data
 * (inbox-tidy-preview.tsx), on the sky, for a screenshot without signing in.
 *
 * Outside /account, as /dev/agent-link-chat: the proxy matcher only covers
 * /account and /admin, so there is no auth round trip. `notFound()` keeps it
 * out of production.
 */
export const metadata = {
  robots: { index: false },
}

export default function InboxTidyPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound()
  return <InboxTidyPreview />
}
