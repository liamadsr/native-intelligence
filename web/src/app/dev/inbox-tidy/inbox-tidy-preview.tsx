'use client'

/**
 * The home thread on a morning with a tidy (see page.tsx), every piece the
 * real one: the chat's message list drawing the digest and the tidy's
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
import { EMAIL_AUTO_ARCHIVE_PART_TYPE, autoArchiveMessageId, type EmailAutoArchivePartData } from '@/lib/email/auto-archive-part'

const BATCH = '00000000-0000-4000-8000-0000000000a1'
const UNDONE = '00000000-0000-4000-8000-0000000000a2'

const text = (id: string, role: 'assistant' | 'user', words: string): UIMessage => ({ id, role, parts: [{ type: 'text', text: words }] }) as UIMessage
const tidy = (data: EmailAutoArchivePartData): UIMessage =>
  ({
    id: autoArchiveMessageId(data.batch_id),
    role: 'assistant',
    parts: [{ type: EMAIL_AUTO_ARCHIVE_PART_TYPE, id: autoArchiveMessageId(data.batch_id), data }],
    metadata: { kind: 'email_auto_archive', batch_id: data.batch_id },
  }) as UIMessage

const MESSAGES: UIMessage[] = [
  text(
    'digest',
    'assistant',
    'Good morning. Two things want you today: Dana replied about the Northwind renewal (a draft is ready), and the Q4 deck review is waiting on you. Standup is at 9:30.',
  ),
  tidy({ batch_id: BATCH, count: 14, domains: ['amazon.com', 'gusto.com', 'uber.com'], more_domains: 3 }),
  text('u1', 'user', 'Where did my Uber receipt go?'),
  text('a1', 'assistant', 'I archived it this morning with 13 other receipts and notifications. It’s in your archive, and Undo on that message puts them all back.'),
  tidy({ batch_id: UNDONE, count: 3, domains: ['github.com'], more_domains: 0, undone: true }),
]

/** The undo route, answered from a fixture (a dev page has no session). */
function useFixtureRoutes() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const real = window.fetch
    window.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.endsWith(`/api/account/email/auto-archive/${BATCH}/undo`)) {
        await new Promise((r) => setTimeout(r, 600))
        return new Response(JSON.stringify({ restored: 14, failed: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
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

export default function InboxTidyPreview() {
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
