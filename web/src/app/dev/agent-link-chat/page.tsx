import { notFound } from 'next/navigation'
import AgentLinkChatPreview from './agent-link-chat-preview'

/**
 * Another person's agent in the owner's chat, drawn standalone — DEV ONLY
 * (agent links phase D): a held call under the other agent's line, an
 * exchange's log line, and the two agents' conversation opened as a card, all
 * from the real components with fixture data (agent-link-chat-preview.tsx),
 * on the sky, for a screenshot without signing in.
 *
 * Outside /account, as /dev/guest-chat: the proxy matcher only covers
 * /account and /admin, so there is no auth round trip. `notFound()` keeps it
 * out of production.
 */
export const metadata = {
  robots: { index: false },
}

export default function AgentLinkChatPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound()
  return <AgentLinkChatPreview />
}
