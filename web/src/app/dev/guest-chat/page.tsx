import { notFound } from 'next/navigation'
import GuestChatPreview from './guest-chat-preview'

/**
 * Guests in the owner's chat, drawn standalone — DEV ONLY (guest access PR4):
 * a guest's activity card, a guest's held call under their line, an access
 * request, and a guest's conversation opened as a card, all from the real
 * components with fixture data (guest-chat-preview.tsx), on the sky, for a
 * screenshot without signing in.
 *
 * Outside /account, as /dev/chat-reply: the proxy matcher only covers
 * /account and /admin, so there is no auth round trip. `notFound()` keeps it
 * out of production.
 */
export const metadata = {
  robots: { index: false },
}

export default function GuestChatPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound()
  return <GuestChatPreview />
}
