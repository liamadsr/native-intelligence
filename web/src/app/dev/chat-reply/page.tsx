import { notFound } from 'next/navigation'
import ChatReplyPreview from './chat-reply-preview'

/**
 * A reply in the chat thread, drawn standalone — DEV ONLY (GEN-353): a reply
 * to a whole message and one to words selected in it, each with its frosted
 * capsule and ┐ (chat-reply-preview.tsx), on the sky, for a screenshot
 * without signing in.
 *
 * Outside /account, as /dev/knowledge-map: the proxy matcher only covers
 * /account and /admin, so there is no auth round trip. `notFound()` keeps it
 * out of production.
 */
export const metadata = {
  robots: { index: false },
}

export default function ChatReplyPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound()
  return <ChatReplyPreview />
}
