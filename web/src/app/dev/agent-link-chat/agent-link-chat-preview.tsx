'use client'

/**
 * The main chat with another person's agent in it (see page.tsx), every
 * piece the real one: the chat's message list, an exchange's log line drawn
 * through the chat's own data-part registry (tool-renderers.tsx), a held call
 * from the other agent as ChatAskCard draws it live (its line over the chat's
 * approval card), and the two agents' conversation card
 * (pages/agent-link-card.tsx) in a card's glass frame with its header slots.
 * The exchanges route answers from fixtures here.
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import { ChatMessageList } from '@/app/account/(dashboard)/chat/chat-message-list'
import { MessageInteractionsContext, type MessageInteractions } from '@/app/account/(dashboard)/chat/message-interactions'
import { dataPartRendererFor } from '@/app/account/(dashboard)/chat/tool-renderers'
import { OnSkyContext } from '@/components/sky/on-sky'
import { MarketingSky } from '@/components/sky/marketing-sky'
import { AttentionCard } from '@/components/attention/attention-card'
import { AgentLinkLine } from '@/components/agent-links/agent-link-chat-cards'
import { CardHeaderSlotsProvider } from '@/components/chat-cards/card-header-slot'
import { ChatCardStore } from '@/components/chat-cards/card-store'
import AgentLinkCard from '@/components/chat-cards/pages/agent-link-card'
import { cn } from '@/lib/utils'
import type { AttentionItem } from '@/hooks/use-attention-items'
import type { PageCardSpec } from '@/lib/chat-cards/pages'
import { AGENT_LINK_ACTIVITY_PART_TYPE } from '@/lib/agent-links/chat-parts'
import type { ExchangeView } from '@/lib/agent-links/views'

const LINK = '00000000-0000-4000-8000-0000000000d1'
const HALF = '00000000-0000-4000-8000-0000000000d2'
const E1 = '00000000-0000-4000-8000-0000000000e1'
const E2 = '00000000-0000-4000-8000-0000000000e2'
const NOW = new Date().toISOString()
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

const text = (id: string, role: 'assistant' | 'user', words: string): UIMessage => ({ id, role, parts: [{ type: 'text', text: words }] }) as UIMessage

const MAIN: UIMessage[] = [
  text('m-u1', 'user', 'Find 30 minutes with Dana this week about the Northwind renewal'),
  text('m-a1', 'assistant', 'Dana’s agent offered Thu 2:00 or Fri 10:00, and held Thu 2:00 on her side. Want me to send the invite for Thu 2:00–2:30?'),
]

const EXCHANGES: ExchangeView[] = [
  {
    id: E2,
    topic: 'Hold a time for the renewal',
    state: 'open',
    startedBy: 'them',
    messages: [{ id: 'x3', from: 'them', kind: 'ask', body: 'Dana would like to hold Thu 2:00–2:30 on Liam’s calendar for the renewal while she checks with her team.', at: minutesAgo(4) }],
    createdAt: minutesAgo(4),
    closedAt: null,
  },
  {
    id: E1,
    topic: '30 min this week about the Northwind renewal',
    state: 'done',
    startedBy: 'me',
    messages: [
      { id: 'x1', from: 'me', kind: 'ask', body: 'Liam would like 30 minutes with Dana this week about the Northwind renewal. He’s free Thu 2:00–4:00 and Fri 10:00–11:30.', at: minutesAgo(14) },
      { id: 'x2', from: 'them', kind: 'answer', body: 'Dana can do Thu 2:00 or Fri 10:00. I’ve held Thu 2:00 on her calendar for now.', at: minutesAgo(13) },
    ],
    createdAt: minutesAgo(14),
    closedAt: minutesAgo(13),
  },
]

const DANA_ASK: AttentionItem = {
  id: 'dev-link-ask',
  workspace_id: 'dev',
  member_id: 'dev',
  kind: 'approval',
  title: 'Hold Thu 2:00–2:30 for the Northwind renewal',
  why: '“Dana would like to hold Thu 2:00–2:30 on Liam’s calendar.” Joseph would place a hold, not send an invite.',
  payload: { input: { hold: 'Thu Oct 29 · 2:00–2:30 PM', title: 'Hold: Northwind renewal (Dana Kim)' } } as AttentionItem['payload'],
  proposal_id: null,
  source_flow_run_id: null,
  status: 'pending',
  expires_at: null,
  created_at: NOW,
}

/** The route the card reads, answered from fixtures (a dev page has no session). */
function useFixtureRoutes() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const real = window.fetch
    window.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input)
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
      if (url.endsWith(`/api/account/agent-links/${LINK}/exchanges`)) {
        return json({ link: { id: LINK, state: 'active', peerName: 'Dana Kim', workspaceName: 'Northwind', myHalfGuestId: HALF }, exchanges: EXCHANGES, hasMore: false })
      }
      return real(input, init)
    }
    setReady(true)
    return () => {
      window.fetch = real
    }
  }, [])
  return ready
}

const part = (type: string, data: unknown, key: string): ReactNode => dataPartRendererFor(type)?.render({ type, data }, key) ?? null

const GLASS_FRAME = 'rounded-3xl border border-border/60 shadow-lg shadow-black/5 ring-1 ring-black/5 dark:shadow-black/30 dark:ring-white/5'
const CONVERSATION: PageCardSpec = { kind: 'agent_link', title: 'Dana Kim’s agent', target: { type: 'agent_link', id: LINK, label: 'Dana Kim’s agent' } }

/** The two agents' conversation, as it opens in the chat: the card's frame and header, the real page inside. */
function ConversationCard() {
  const [store] = useState(() => {
    const s = new ChatCardStore()
    s.setCards([{ id: 'dev-link', spec: CONVERSATION }])
    return s
  })
  const [right, setRight] = useState<HTMLDivElement | null>(null)
  return (
    <div className={cn('relative w-full overflow-hidden', GLASS_FRAME)} style={{ height: 460 }}>
      <div className="pointer-events-none absolute inset-0 z-0 rounded-3xl bg-background/70 backdrop-blur-md" />
      <div className="relative z-10 flex h-full min-h-0 flex-col">
        <div className="relative z-10 flex h-9 shrink-0 items-center gap-2 border-b px-3">
          <span className="truncate text-[13px] font-medium">{CONVERSATION.title}</span>
          <div ref={setRight} className="ml-auto flex min-w-0 items-center gap-2" />
        </div>
        <div className="min-h-0 flex-1">
          <CardHeaderSlotsProvider value={{ left: null, right }}>
            <AgentLinkCard toolCallId="dev-link" spec={CONVERSATION} store={store} fullScreen={false} />
          </CardHeaderSlotsProvider>
        </div>
      </div>
    </div>
  )
}

const INTERACTIONS: MessageInteractions = { reply: () => {}, react: () => {}, reactions: null }
const noop = async () => ({ ok: true }) as never

export default function AgentLinkChatPreview() {
  const ready = useFixtureRoutes()
  if (!ready) return null
  return (
    <>
      <MarketingSky />
      <main className="flex min-h-dvh flex-col justify-end py-10">
        <MessageInteractionsContext.Provider value={INTERACTIONS}>
          <OnSkyContext.Provider value>
            <div className="chat-reading-col flex w-full flex-col gap-4 px-5">
              <ChatMessageList messages={MAIN} latestUserMessageId="m-u1" userAvatarUrl={null} userInitials="LA" />
              {part(AGENT_LINK_ACTIVITY_PART_TYPE, { link_id: LINK, peer: { name: 'Dana Kim', workspace_name: 'Northwind' }, exchange_id: E1, summary: 'Told Dana’s agent you’re free Thu 2:00 and Fri 10:00', count: 2, last_at: minutesAgo(13) }, 'a1')}
              {/* ChatAskCard's live card: the other agent's line over the chat's approval card. */}
              <div className="flex w-full max-w-[28rem] flex-col gap-1 self-start">
                <AgentLinkLine link={{ link_id: LINK, peer_name: 'Dana Kim', workspace_name: 'Northwind', exchange_id: E2 }} />
                <AttentionCard item={DANA_ASK} editable={false} members={[]} aiMembers={[]} projects={[]} onEdit={() => {}} onAccept={noop} onStart={noop} onDismiss={async () => {}} surface="chat" />
              </div>
              <ConversationCard />
            </div>
          </OnSkyContext.Provider>
        </MessageInteractionsContext.Provider>
      </main>
    </>
  )
}
