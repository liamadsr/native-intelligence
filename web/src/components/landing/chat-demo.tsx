'use client'

/**
 * Landing demo of the main chat: the product's own composer (ChatInput) and
 * message list (ChatMessageList), on a contained version of the app's sky.
 * A question is typed into the composer, sent, and answered; then the next.
 * Only the turns are scripted: nothing here is sent anywhere, and the demo
 * takes no input (pointer-events off, hidden from the tab order).
 *
 * `exchanges` lets a landing variant aim it at its audience (the sales page
 * asks deal questions instead of eng ones). Content is FICTIONAL.
 */
import { useEffect, useMemo, useState } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import { ChatInput } from '@/app/account/(dashboard)/chat/chat-input'
import { ChatMessageList } from '@/app/account/(dashboard)/chat/chat-message-list'
import { MessageInteractionsContext, type MessageInteractions } from '@/app/account/(dashboard)/chat/message-interactions'
import { OnSkyContext } from '@/components/sky/on-sky'
import { Loader } from '@/components/ui/loader'
import { DemoSky } from './demo-card'

export interface ChatDemoExchange {
  /** What's typed into the composer. */
  ask: string
  /** The assistant's answer (markdown, as the chat renders it). */
  answer: string
}

const DEFAULT_EXCHANGES: ChatDemoExchange[] = [
  {
    ask: 'What did we decide on the Postgres migration in the last integrations sync?',
    answer:
      'In Tuesday’s sync the team agreed to:\n\n- **Migrate behind a flag**, read replicas first\n- Keep **v1 writes on MySQL** until dual-write passes\n- **Marcus** owns the cutover plan, due Friday',
  },
  {
    ask: 'What’s blocking the v2 API launch?',
    answer:
      'Two things, from the last three standups:\n\n- **Rate limits**: not in yet (Priya, due Thu)\n- **Auth refresh bug**: ENG-142, still open with Bikrant\n\nEverything else on the checklist is done.',
  },
]

const INTERACTIONS: MessageInteractions = { reply: () => {}, react: () => {}, reactions: null }
const noop = () => {}

const TYPE_MS = 28
const START_MS = 900
const SEND_PAUSE_MS = 500
const THINK_MS = 1300
const HOLD_MS = 5200

type Phase = 'typing' | 'thinking' | 'answered'

const text = (id: string, role: 'assistant' | 'user', words: string): UIMessage =>
  ({ id, role, parts: [{ type: 'text', text: words }] }) as UIMessage

function useScriptedTurns(exchanges: ChatDemoExchange[]) {
  const [turn, setTurn] = useState(0)
  const [typed, setTyped] = useState(0)
  const [phase, setPhase] = useState<Phase>('typing')
  useEffect(() => {
    let live = true
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          timers.delete(t)
          resolve()
        }, ms)
        timers.add(t)
      })
    async function run() {
      await wait(START_MS)
      for (let i = 0; live; i = (i + 1) % exchanges.length) {
        setTurn(i)
        setPhase('typing')
        setTyped(0)
        const ask = exchanges[i].ask
        for (let n = 1; n <= ask.length && live; n++) {
          setTyped(n)
          await wait(TYPE_MS)
        }
        await wait(SEND_PAUSE_MS)
        if (!live) return
        setPhase('thinking')
        await wait(THINK_MS)
        if (!live) return
        setPhase('answered')
        await wait(HOLD_MS)
      }
    }
    void run()
    return () => {
      live = false
      for (const t of timers) clearTimeout(t)
    }
  }, [exchanges])
  const current = exchanges[turn]
  const draft = phase === 'typing' ? current.ask.slice(0, typed) : ''
  const messages = useMemo<UIMessage[]>(() => {
    if (phase === 'typing') return []
    const asked = text(`u${turn}`, 'user', current.ask)
    return phase === 'answered' ? [asked, text(`a${turn}`, 'assistant', current.answer)] : [asked]
  }, [phase, turn, current])
  return { draft, messages, thinking: phase === 'thinking', turn }
}

export function ChatDemo({ exchanges = DEFAULT_EXCHANGES }: { exchanges?: ChatDemoExchange[] }) {
  const { draft, messages, thinking, turn } = useScriptedTurns(exchanges)
  return (
    <DemoSky className="flex h-[460px] flex-col justify-end p-3 sm:p-4">
      {/* The app at a window's scale: its chat reads at full size in a wide column, not in a card. */}
      <div className="flex min-h-0 flex-1 flex-col justify-end [zoom:0.86]">
      <MessageInteractionsContext.Provider value={INTERACTIONS}>
        <OnSkyContext.Provider value>
          <div
            key={turn}
            className="flex min-h-0 flex-1 flex-col justify-end gap-3 overflow-hidden pb-3 [mask-image:linear-gradient(to_bottom,transparent_0,#000_40px)]"
          >
            {messages.length > 0 && (
              <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                <ChatMessageList messages={messages} latestUserMessageId={`u${turn}`} userAvatarUrl={null} userInitials="AR" />
              </div>
            )}
            {thinking && (
              <div className="px-1">
                <Loader variant="orb" orbState="working" size="sm" />
              </div>
            )}
          </div>
          <ChatInput
            value={draft}
            onChange={noop}
            onSubmit={noop}
            onStop={noop}
            isLoading={thinking}
            attachedNotes={[]}
            onAttachNote={noop}
            onRemoveNote={noop}
            attachedFiles={[]}
            onAttachFiles={noop}
            onRemoveFile={noop}
            mainComposer={false}
          />
        </OnSkyContext.Provider>
      </MessageInteractionsContext.Provider>
      </div>
    </DemoSky>
  )
}
