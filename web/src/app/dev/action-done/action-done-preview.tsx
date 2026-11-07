'use client'

/**
 * The home thread the day a confirmation closed a to-do (see page.tsx),
 * every piece the real one: the chat's message list drawing the close's
 * message, whose data part goes through the chat's own registry
 * (tool-renderers.tsx). The undo route answers from a fixture here, so Undo
 * can be tried.
 */
import { useEffect, useState } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import { ChatMessageList } from '@/app/account/(dashboard)/chat/chat-message-list'
import { MessageInteractionsContext, type MessageInteractions } from '@/app/account/(dashboard)/chat/message-interactions'
import { OnSkyContext } from '@/components/sky/on-sky'
import { MarketingSky } from '@/components/sky/marketing-sky'
import { ACTION_DONE_PART_TYPE, actionDoneMessageId, type ActionDonePartData } from '@/lib/email/action-done-part'

const CLOSED = '00000000-0000-4000-8000-0000000000b1'
const REOPENED = '00000000-0000-4000-8000-0000000000b2'

const text = (id: string, role: 'assistant' | 'user', words: string): UIMessage => ({ id, role, parts: [{ type: 'text', text: words }] }) as UIMessage
const done = (data: ActionDonePartData): UIMessage =>
  ({
    id: actionDoneMessageId(data.record_id),
    role: 'assistant',
    parts: [{ type: ACTION_DONE_PART_TYPE, id: actionDoneMessageId(data.record_id), data }],
    metadata: { kind: 'action_done_from_mail', record_id: data.record_id, action_id: data.action_id },
  }) as UIMessage

const MESSAGES: UIMessage[] = [
  text('digest', 'assistant', 'Good morning. Standup is at 9:30, and the Q4 deck review is waiting on you.'),
  done({ record_id: CLOSED, action_id: 'a1', identifier: 'GEN-863', title: 'Look into renting a car for next week upstate', sender_domain: 'enterprise.com' }),
  text('u1', 'user', 'Did the Con Edison payment go through?'),
  text('a1', 'assistant', 'It did: their receipt came in this morning, so I marked the bill done.'),
  done({ record_id: REOPENED, action_id: 'a2', identifier: 'GEN-871', title: 'Pay the Con Edison bill', sender_domain: 'coned.com', undone: true }),
]

/** The undo route, answered from a fixture (a dev page has no session). */
function useFixtureRoutes() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const real = window.fetch
    window.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.endsWith(`/api/account/email/action-done/${CLOSED}/undo`)) {
        await new Promise((r) => setTimeout(r, 600))
        return new Response(JSON.stringify({ status: 'reopened' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
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

const INTERACTIONS: MessageInteractions = { reply: () => {}, react: () => {}, reactions: null }

export default function ActionDonePreview() {
  const ready = useFixtureRoutes()
  if (!ready) return null
  return (
    <>
      <MarketingSky />
      <main className="flex min-h-dvh flex-col justify-end py-10">
        <MessageInteractionsContext.Provider value={INTERACTIONS}>
          <OnSkyContext.Provider value>
            <div className="chat-reading-col flex w-full flex-col gap-4 px-5">
              <ChatMessageList messages={MESSAGES} latestUserMessageId="u1" userAvatarUrl={null} userInitials="LA" />
            </div>
          </OnSkyContext.Provider>
        </MessageInteractionsContext.Provider>
      </main>
    </>
  )
}
