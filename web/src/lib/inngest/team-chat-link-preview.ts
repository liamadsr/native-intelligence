import { getServiceClient } from '@/lib/admin'
import { inngest } from './client'
import { TEAM_CHAT_LINK_PREVIEW_EVENT, writeLinkPreview } from '@/lib/team-chat/link-preview'
import { isUuid } from '@/lib/team-chat/types'

/**
 * team-chat/link-preview.requested → a team chat message's link preview
 * (migration 555): fetch its first link with the SSRF-safe fetcher and store
 * what the page says on the message, which reaches the channel live
 * (src/lib/team-chat/link-preview.ts). Out of the request path, so a send
 * never waits on someone else's server.
 *
 * One step; its output is the outcome only (never a URL or a word). A few at
 * a time per workspace's worth of traffic: the fetches are small and capped.
 * One `[team-chat-preview]` line per run.
 */
export const teamChatLinkPreview = inngest.createFunction(
  {
    id: 'team-chat-link-preview',
    retries: 1,
    concurrency: [{ limit: 5 }],
    triggers: [{ event: TEAM_CHAT_LINK_PREVIEW_EVENT }],
  },
  async ({ event, step }) => {
    const messageId = (event.data as { messageId?: unknown } | undefined)?.messageId
    if (!isUuid(messageId)) {
      console.info('[team-chat-preview] message=- outcome=bad_event')
      return { status: 'skipped', reason: 'bad_event' }
    }
    const outcome = await step.run('preview', () => writeLinkPreview(getServiceClient(), messageId))
    console.info(`[team-chat-preview] message=${messageId} outcome=${outcome}`)
    return { status: 'done', outcome }
  },
)
