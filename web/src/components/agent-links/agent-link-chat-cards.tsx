'use client'

/**
 * Another person's agent in the owner's chat (agent links phase D), drawn
 * with the guest cards' parts and no new look (src/lib/agent-links/chat-parts.ts
 * has the data):
 *
 *   AgentLinkLine           whose agent a held card is from: their initials,
 *                           "Dana Kim’s agent" and the workspace it answers
 *                           from, in the pill GuestLine puts over a guest's
 *                           cards. It opens the two agents' conversation.
 *   AgentLinkActivityChip   one exchange between the two agents, in the guest
 *                           activity card (guest-chat-cards.tsx), their
 *                           initials in its tile. It opens the conversation on
 *                           that exchange.
 *
 * A held call from another agent is the ordinary ask card with an
 * AgentLinkLine over it (chat-ask-card.tsx ChatAskCard).
 */
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { openTarget } from '@/lib/chat-cards/open-card'
import { guestInitials } from '@/lib/guests/chat-parts'
import {
  activityLinkRef,
  agentLinkActivityMeta,
  agentLinkLine,
  peerAgentName,
  type AgentLinkActivityPartData,
  type AgentLinkRef,
} from '@/lib/agent-links/chat-parts'

/** Open the two agents' conversation as a card in the chat, on `exchangeId` when given (the same card again when it's there). */
export function openAgentLinkConversation(link: Pick<AgentLinkRef, 'link_id' | 'peer_name'>, exchangeId?: string | null): void {
  openTarget({ type: 'agent_link', linkId: link.link_id, name: peerAgentName(link.peer_name), exchangeId: exchangeId ?? null }, { from: 'agent_link', reuse: true })
}

/** "1:15 PM", or the day before that when it isn't today. */
function shortTime(iso: string, now: Date = new Date()): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return at.toDateString() === now.toDateString() ? time : `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`
}

/** Whose agent a card is from, over it: GuestLine's pill. */
export function AgentLinkLine({ link }: { link: AgentLinkRef }) {
  return (
    <button
      type="button"
      data-agent-link-line={link.link_id}
      onClick={() => openAgentLinkConversation(link, link.exchange_id)}
      title={`Open your agent’s conversation with ${peerAgentName(link.peer_name)}`}
      className="inline-flex h-5 max-w-full items-center gap-1 self-start rounded-full bg-card/70 pl-0.5 pr-2 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-neutral-900/70"
    >
      <Avatar className="h-[18px] w-[18px]">
        <AvatarFallback className="bg-muted text-[9px] font-medium">{guestInitials(link.peer_name)}</AvatarFallback>
      </Avatar>
      <span className="truncate">{agentLinkLine(link)}</span>
    </button>
  )
}

/**
 * One exchange between the two agents in the owner's chat: the guest
 * activity card (the teammate report's card), the other person's initials in
 * its tile. No notification of its own: held calls are what ask for attention.
 */
export function AgentLinkActivityChip({ data }: { data: AgentLinkActivityPartData }) {
  return (
    <button
      type="button"
      data-agent-link-activity={data.exchange_id}
      data-chat-panel="deliverable"
      onClick={() => openAgentLinkConversation(activityLinkRef(data), data.exchange_id)}
      className="group relative w-1/2 min-w-[15rem] max-w-[calc(100%-2.25rem)] self-start rounded-[24px] border border-border/60 bg-black/[0.04] p-1.5 text-left shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none dark:border-white/10 dark:bg-white/[0.06]"
    >
      <span className="flex min-w-0 items-center gap-3 rounded-[18px] bg-background px-3 py-2.5">
        <Avatar aria-hidden className="h-10 w-10 rounded-[12px]">
          <AvatarFallback className="rounded-[12px] bg-foreground/[0.05] text-sm font-medium text-foreground/75">{guestInitials(data.peer.name)}</AvatarFallback>
        </Avatar>
        <span className="flex min-w-0 flex-col">
          <span data-agent-link-activity-summary="" className="line-clamp-2 text-[15px] font-medium leading-5 text-foreground">
            {data.summary}
          </span>
          <span data-agent-link-activity-meta="" className="mt-0.5 text-[12px] leading-4 text-muted-foreground">
            {agentLinkActivityMeta(data, shortTime(data.last_at))}
          </span>
        </span>
      </span>
    </button>
  )
}
