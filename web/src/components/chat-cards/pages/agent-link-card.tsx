'use client'

/**
 * The two agents' conversation as a card (the `agent_link` page kind, agent
 * links phase D): every exchange between the person's agent and one linked
 * person's agent, drawn the way a guest's conversation is (guest-card.tsx),
 * with the chat's own message list. The other agent's words are the incoming
 * side, as a guest's texts are; the person's agent's are its replies. Each
 * exchange opens with its topic in one quiet line. Opened by the person from
 * the line over a held card or an exchange's log line in their chat, on the
 * exchange it is about when it names one (`at`, an `agent_link_exchange`);
 * only the person opens one (show doesn't offer it).
 *
 * Read-only: no composer, no reply or reaction on its bubbles, no thumbs. The
 * header says whose agent and from where, and opens them in People.
 */
import * as React from 'react'
import type { UIMessage } from '@ai-sdk/react'
import { ChevronRight } from 'lucide-react'
import { ChatMessageList } from '@/app/account/(dashboard)/chat/chat-message-list'
import { MessageInteractionsContext } from '@/app/account/(dashboard)/chat/message-interactions'
import { MessageFeedbackContext } from '@/app/account/(dashboard)/chat/message-feedback-buttons'
import { openAgentEditor } from '@/components/bots/agent-editor'
import { peerAgentName } from '@/lib/agent-links/chat-parts'
import { guestInitials } from '@/lib/guests/chat-parts'
import type { ExchangeView } from '@/lib/agent-links/views'
import type { ExchangesLinkView } from '@/app/api/account/agent-links/[id]/exchanges/route'
import { CardHeaderSlot } from '../card-header-slot'
import { PageCardNotice, usePagePlace, type PageCardProps } from './page-card'

interface LinkConversation {
  link: ExchangesLinkView
  exchanges: ExchangeView[]
  hasMore: boolean
}

type Read = { state: 'loading' } | { state: 'failed'; gone: boolean } | ({ state: 'ok' } & LinkConversation)

function useLinkConversation(linkId: string | null): Read {
  const [read, setRead] = React.useState<Read>({ state: 'loading' })
  React.useEffect(() => {
    if (!linkId) return
    let on = true
    setRead({ state: 'loading' })
    void (async () => {
      try {
        const res = await fetch(`/api/account/agent-links/${linkId}/exchanges`, { credentials: 'include' })
        if (!res.ok) {
          if (on) setRead({ state: 'failed', gone: res.status === 404 })
          return
        }
        const body = (await res.json()) as LinkConversation
        if (on) setRead({ state: 'ok', link: body.link, exchanges: Array.isArray(body.exchanges) ? body.exchanges : [], hasMore: !!body.hasMore })
      } catch {
        if (on) setRead({ state: 'failed', gone: false })
      }
    })()
    return () => {
      on = false
    }
  }, [linkId])
  return read
}

/** One exchange's messages as the chat's own: theirs incoming, mine the replies. */
function exchangeMessages(exchange: ExchangeView): UIMessage[] {
  return exchange.messages.map(
    (m) =>
      ({
        id: `agent-link-message:${m.id}`,
        role: m.from === 'them' ? 'user' : 'assistant',
        parts: [{ type: 'text', text: m.body }],
        metadata: { createdAt: m.at },
      }) as UIMessage,
  )
}

/** The quiet line over an exchange: its topic, who started it, and how it ended. */
function exchangeLine(exchange: ExchangeView, peerName: string): string {
  const who = exchange.startedBy === 'me' ? 'Your agent asked' : `${peerAgentName(peerName)} asked`
  const end = exchange.state === 'capped' ? 'stopped at 8 messages' : exchange.state === 'open' ? 'still going' : null
  return [exchange.topic, who, end].filter(Boolean).join(' · ')
}

const LINK_STATE_WORD: Partial<Record<ExchangesLinkView['state'], string>> = {
  requested: 'waiting to connect',
  declined: 'not connected',
  expired: 'not connected',
  ended: 'disconnected',
}

export default function AgentLinkCard(props: PageCardProps) {
  const { spec } = props
  const linkId = spec.target?.type === 'agent_link' ? spec.target.id : null
  const read = useLinkConversation(linkId)
  const scrollRef = React.useRef<HTMLDivElement>(null)
  // The exchange the card opened on, kept with the card; opening the same link again moves it.
  const { at } = usePagePlace(props)
  const exchangeId = at?.type === 'agent_link_exchange' ? at.id : null

  const exchanges = read.state === 'ok' ? read.exchanges : null
  React.useLayoutEffect(() => {
    const host = scrollRef.current
    if (!host || !exchanges) return
    const row = exchangeId ? [...host.querySelectorAll<HTMLElement>('[data-agent-link-exchange]')].find((el) => el.dataset.agentLinkExchange === exchangeId) : null
    if (row) row.scrollIntoView({ block: 'start' })
    else host.scrollTop = host.scrollHeight
  }, [exchanges, exchangeId])

  if (!linkId) return <PageCardNotice text="This conversation can’t open." />
  if (read.state === 'loading') return <PageCardNotice text="Loading…" />
  if (read.state === 'failed') return <PageCardNotice text={read.gone ? 'This link is no longer yours to read.' : 'This conversation couldn’t load. Try again in a moment.'} />

  const { link } = read
  // The card's title already names whose agent: the header says from where, and how the link stands.
  const how = [link.workspaceName, LINK_STATE_WORD[link.state]].filter(Boolean).join(' · ')
  // Oldest first, as a chat reads; the route answers newest first.
  const ordered = [...read.exchanges].reverse()
  return (
    <div className="flex h-full min-h-0 flex-col" data-agent-link-conversation={link.id}>
      <CardHeaderSlot side="right">
        <span className="hidden truncate text-xs text-muted-foreground sm:inline">{how}</span>
        {link.myHalfGuestId && (
          <button
            type="button"
            data-agent-link-manage=""
            onClick={(e) => openAgentEditor(e.currentTarget, 'people', { guestId: link.myHalfGuestId! })}
            className="inline-flex shrink-0 items-center gap-0.5 rounded-md px-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Manage in People
            <ChevronRight className="h-3 w-3" />
          </button>
        )}
      </CardHeaderSlot>
      <div ref={scrollRef} role="log" aria-label={`Your agent and ${peerAgentName(link.peerName)}`} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {ordered.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Your agent and {peerAgentName(link.peerName)} haven’t talked yet.</p>
        ) : (
          <MessageInteractionsContext.Provider value={null}>
            <MessageFeedbackContext.Provider value={null}>
              <div className="flex flex-col gap-6">
                {read.hasMore && <p className="text-center text-[11px] text-muted-foreground">Earlier conversations aren’t shown.</p>}
                {ordered.map((exchange) => {
                  const messages = exchangeMessages(exchange)
                  const lastTheirs = [...messages].reverse().find((m) => m.role === 'user')?.id ?? null
                  return (
                    <section key={exchange.id} data-agent-link-exchange={exchange.id} className="flex flex-col gap-4">
                      <p data-agent-link-exchange-line="" className="text-center text-[11px] text-muted-foreground">
                        {exchangeLine(exchange, link.peerName)}
                      </p>
                      <ChatMessageList messages={messages} latestUserMessageId={lastTheirs} userAvatarUrl={null} userInitials={guestInitials(link.peerName)} />
                    </section>
                  )
                })}
              </div>
            </MessageFeedbackContext.Provider>
          </MessageInteractionsContext.Provider>
        )}
      </div>
    </div>
  )
}
