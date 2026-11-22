import { notFound } from 'next/navigation'
import MailThreadPreview from './mail-thread-preview'

/**
 * Mail's thread view and composer, drawn standalone — DEV ONLY
 * (docs/plans/mail-macro.md): the real thread pane (email-thread-detail.tsx)
 * and composer (email-composer.tsx) on a made-up thread, every mail request
 * answered in the browser from a fixture, so nothing is read from or sent to
 * any mailbox. For a screenshot without signing in.
 *
 * `?compose=reply|replyAll|forward` opens the composer; `?theme=dark` draws
 * it dark. Outside /account, as /dev/inbox-tidy: the proxy matcher only
 * covers /account and /admin. `notFound()` keeps it out of production.
 */
export const metadata = {
  robots: { index: false },
}

export default function MailThreadPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound()
  return <MailThreadPreview />
}
