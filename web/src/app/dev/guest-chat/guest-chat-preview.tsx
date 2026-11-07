'use client'

/**
 * The main chat with guests in it (see page.tsx), every piece the real one:
 * the chat's message list, the home thread's guest parts drawn through the
 * chat's own data-part registry (tool-renderers.tsx: the activity card and
 * the access request), a guest's held call as ChatAskCard draws it live (their
 * line over the chat's approval card), and the guest's conversation card
 * (pages/guest-card.tsx) in a card's glass frame with its header slots. The
 * People routes and the conversation route answer from fixtures here.
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import { ChatMessageList } from '@/app/account/(dashboard)/chat/chat-message-list'
import { MessageInteractionsContext, type MessageInteractions } from '@/app/account/(dashboard)/chat/message-interactions'
import { dataPartRendererFor } from '@/app/account/(dashboard)/chat/tool-renderers'
import { OnSkyContext } from '@/components/sky/on-sky'
import { MarketingSky } from '@/components/sky/marketing-sky'
import { AttentionCard } from '@/components/attention/attention-card'
import { GuestLine } from '@/components/guests/guest-chat-cards'
import { CardHeaderSlotsProvider } from '@/components/chat-cards/card-header-slot'
import { ChatCardStore } from '@/components/chat-cards/card-store'
import GuestCard from '@/components/chat-cards/pages/guest-card'
import { cn } from '@/lib/utils'
import type { AttentionItem } from '@/hooks/use-attention-items'
import type { PageCardSpec } from '@/lib/chat-cards/pages'
import { GUEST_ACTIVITY_PART_TYPE, GUEST_REQUEST_PART_TYPE } from '@/lib/guests/chat-parts'

const SAM = '00000000-0000-4000-8000-00000000005a'
const JASON = '00000000-0000-4000-8000-0000000000a1'
const PRIYA = '00000000-0000-4000-8000-0000000000b1'
const NOW = new Date().toISOString()
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

const text = (id: string, role: 'assistant' | 'user', words: string, metadata?: Record<string, unknown>): UIMessage =>
  ({ id, role, parts: [{ type: 'text', text: words }], ...(metadata ? { metadata } : {}) }) as UIMessage

const MAIN: UIMessage[] = [
  text('m-u1', 'user', "What's on my plate this afternoon?"),
  text('m-a1', 'assistant', 'Two things: the Acme renewal call at 2:00, and your 1:1 with Dana at 4:30. Nothing needs prep.'),
]

const byText = { kind: 'channel_message', channel: 'sms' }
const SAM_THREAD: UIMessage[] = [
  text('sms-in:SM1', 'user', 'Book Nopa Saturday 7:30 for us, and add eggs and coffee to the grocery list', { ...byText, createdAt: minutesAgo(40) }),
  text('home-turn:1', 'assistant', "Done. Nopa is booked Saturday 7:30 for 2 under Liam's name, and eggs and coffee are on the list.", { createdAt: minutesAgo(39) }),
  text('sms-in:SM2', 'user', 'When does Liam land tomorrow?', { ...byText, createdAt: minutesAgo(12) }),
  text('home-turn:2', 'assistant', 'His flight gets into SFO at 6:05 PM.', { createdAt: minutesAgo(11) }),
]

const JASON_ASK: AttentionItem = {
  id: 'dev-guest-ask',
  workspace_id: 'dev',
  member_id: 'dev',
  kind: 'approval',
  title: 'Jason wants your notes from last Thursday’s Northwind call',
  why: '“Can you send me the notes from last Thursday’s Northwind call?” Joseph would text him the summary, not the transcript, this once.',
  payload: { input: { to: 'Jason Lee (Colleague)', share: 'Northwind sync · Thu Oct 22 · summary' } } as AttentionItem['payload'],
  proposal_id: null,
  source_flow_run_id: null,
  status: 'pending',
  expires_at: null,
  created_at: NOW,
}

/** The routes the cards read, answered from fixtures (a dev page has no session). */
function useFixtureRoutes() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const real = window.fetch
    window.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input)
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
      if (url.endsWith(`/api/account/agent-guests/${SAM}/conversation`)) {
        return json({ guest: { id: SAM, displayName: 'Sam', preset: 'household', state: 'active', channel: 'sms' }, conversationId: 'dev', messages: SAM_THREAD, hasMore: false })
      }
      if (url.endsWith(`/api/account/agent-guests/${PRIYA}`)) return json({ guest: { id: PRIYA, state: 'requested' } })
      if (url.includes('/api/account/agent-guests/')) return json({ ok: true })
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
const CONVERSATION: PageCardSpec = { kind: 'guest', title: 'Sam', target: { type: 'guest', id: SAM, label: 'Sam' } }

/** Sam's conversation, as it opens in the chat: the card's frame and header, the real page inside. */
function ConversationCard() {
  const [store] = useState(() => {
    const s = new ChatCardStore()
    s.setCards([{ id: 'dev-guest', spec: CONVERSATION }])
    s.update('dev-guest', { at: { type: 'guest_message', id: 'sms-in:SM2' } })
    return s
  })
  const [right, setRight] = useState<HTMLDivElement | null>(null)
  return (
    <div className={cn('relative w-full overflow-hidden', GLASS_FRAME)} style={{ height: 420 }}>
      <div className="pointer-events-none absolute inset-0 z-0 rounded-3xl bg-background/70 backdrop-blur-md" />
      <div className="relative z-10 flex h-full min-h-0 flex-col">
        <div className="relative z-10 flex h-9 shrink-0 items-center gap-2 border-b px-3">
          <span className="truncate text-[13px] font-medium">Sam</span>
          <div ref={setRight} className="ml-auto flex min-w-0 items-center gap-2" />
        </div>
        <div className="min-h-0 flex-1">
          <CardHeaderSlotsProvider value={{ left: null, right }}>
            <GuestCard toolCallId="dev-guest" spec={CONVERSATION} store={store} fullScreen={false} />
          </CardHeaderSlotsProvider>
        </div>
      </div>
    </div>
  )
}

const INTERACTIONS: MessageInteractions = { reply: () => {}, react: () => {}, reactions: null }
const noop = async () => ({ ok: true }) as never

export default function GuestChatPreview() {
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
              {part(GUEST_ACTIVITY_PART_TYPE, { guest: { id: SAM, name: 'Sam', preset: 'household', channel: 'sms' }, summary: 'Added “Max · dentist” to the Family calendar', count: 1, last_at: minutesAgo(95) }, 'a1')}
              {/* ChatAskCard's live card: the guest's line over the chat's approval card. */}
              <div className="flex w-full max-w-[28rem] flex-col gap-1 self-start">
                <GuestLine guest={{ id: JASON, name: 'Jason Lee', preset: 'colleague', channel: 'sms' }} />
                <AttentionCard item={JASON_ASK} editable={false} members={[]} aiMembers={[]} projects={[]} onEdit={() => {}} onAccept={noop} onStart={noop} onDismiss={async () => {}} surface="chat" />
              </div>
              {part(GUEST_REQUEST_PART_TYPE, { guest_id: PRIYA, guest_name: 'Priya Shah', phone_last4: '4821', status: 'pending', requested_at: minutesAgo(3) }, 'r1')}
              {part(GUEST_ACTIVITY_PART_TYPE, { guest: { id: SAM, name: 'Sam', preset: 'household', channel: 'sms', message_id: 'sms-in:SM1' }, summary: 'Booked Nopa, added 2 to Groceries, asked when you land', count: 3, last_at: minutesAgo(11) }, 'a2')}
              <ConversationCard />
            </div>
          </OnSkyContext.Provider>
        </MessageInteractionsContext.Provider>
      </main>
    </>
  )
}
