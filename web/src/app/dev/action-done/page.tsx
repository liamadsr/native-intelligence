import { notFound } from 'next/navigation'
import ActionDonePreview from './action-done-preview'

/**
 * A to-do arriving mail marked done, in the home thread, drawn standalone —
 * DEV ONLY (src/lib/email/action-done-from-mail.ts): the close's own message
 * with Undo, and one already reopened, from the real chat components with
 * fixture data (action-done-preview.tsx), on the sky, for a screenshot
 * without signing in.
 *
 * Outside /account, as /dev/inbox-tidy: the proxy matcher only covers
 * /account and /admin, so there is no auth round trip. `notFound()` keeps it
 * out of production.
 */
export const metadata = {
  robots: { index: false },
}

export default function ActionDonePreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound()
  return <ActionDonePreview />
}
