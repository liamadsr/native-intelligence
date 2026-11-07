'use client'

/**
 * A guest's conversation as a card (the `guest` page kind, guest access): the
 * whole thread between one person and the agent the owner made for them, as
 * the guest saw it, drawn with the chat's own message list. Opened by the
 * person from a guest's request or activity card in their chat, on the
 * message it is about when it names one (`at`, a `guest_message`); only the
 * person opens one (show doesn't offer it).
 *
 * Read-only: no composer, and the thread has no session to talk in (the
 * eve-session mint refuses it). Nothing in it acts on the owner's chat
 * either: no reply or reaction on its bubbles, no thumbs (those are the main
 * chat's, for its own messages). The header says who and how, and opens them
 * in People.
 */
import * as React from 'react'
import type { UIMessage } from '@ai-sdk/react'
import { ChevronRight } from 'lucide-react'
import { ChatMessageList } from '@/app/account/(dashboard)/chat/chat-message-list'
import { MessageInteractionsContext } from '@/app/account/(dashboard)/chat/message-interactions'
import { MessageFeedbackContext } from '@/app/account/(dashboard)/chat/message-feedback-buttons'
import { openAgentEditor } from '@/components/bots/agent-editor'
import { guestInitials, presetLabel } from '@/lib/guests/chat-parts'
import type { GuestPresetValue } from '@/lib/guests/presets'
import { CardHeaderSlot } from '../card-header-slot'
import { PageCardNotice, usePagePlace, type PageCardProps } from './page-card'

interface GuestConversation {
  guest: { id: string; displayName: string; preset: GuestPresetValue; state: string; channel: 'sms' | 'slack' }
  messages: UIMessage[]
  hasMore: boolean
}

type Read = { state: 'loading' } | { state: 'failed'; gone: boolean } | ({ state: 'ok' } & GuestConversation)

function useGuestConversation(guestId: string | null): Read {
  const [read, setRead] = React.useState<Read>({ state: 'loading' })
  React.useEffect(() => {
    if (!guestId) return
    let on = true
    setRead({ state: 'loading' })
    void (async () => {
      try {
        const res = await fetch(`/api/account/agent-guests/${guestId}/conversation`, { credentials: 'include' })
        if (!res.ok) {
          if (on) setRead({ state: 'failed', gone: res.status === 404 })
          return
        }
        const body = (await res.json()) as GuestConversation
        if (on) setRead({ state: 'ok', guest: body.guest, messages: Array.isArray(body.messages) ? body.messages : [], hasMore: !!body.hasMore })
      } catch {
        if (on) setRead({ state: 'failed', gone: false })
      }
    })()
    return () => {
      on = false
    }
  }, [guestId])
  return read
}

export default function GuestCard(props: PageCardProps) {
  const { spec } = props
  const guestId = spec.target?.type === 'guest' ? spec.target.id : null
  const read = useGuestConversation(guestId)
  const scrollRef = React.useRef<HTMLDivElement>(null)
  // The message the card opened on, kept with the card; opening the same guest again moves it.
  const { at } = usePagePlace(props)
  const messageId = at?.type === 'guest_message' ? at.id : null

  const messages = read.state === 'ok' ? read.messages : null
  React.useLayoutEffect(() => {
    const host = scrollRef.current
    if (!host || !messages) return
    const row = messageId ? [...host.querySelectorAll<HTMLElement>('[data-message-row]')].find((el) => el.dataset.messageRow === messageId) : null
    if (row) row.scrollIntoView({ block: 'center' })
    else host.scrollTop = host.scrollHeight
  }, [messages, messageId])

  if (!guestId) return <PageCardNotice text="This conversation can’t open." />
  if (read.state === 'loading') return <PageCardNotice text="Loading…" />
  if (read.state === 'failed') return <PageCardNotice text={read.gone ? 'This person is no longer one of your guests.' : 'This conversation couldn’t load. Try again in a moment.'} />

  const { guest } = read
  const how = [presetLabel(guest.preset), guest.channel === 'slack' ? 'in Slack' : 'by text', guest.state === 'removed' ? 'no longer has access' : null]
    .filter(Boolean)
    .join(' · ')
  const lastUser = [...read.messages].reverse().find((m) => m.role === 'user')?.id ?? null
  return (
    <div className="flex h-full min-h-0 flex-col" data-guest-conversation={guest.id}>
      <CardHeaderSlot side="right">
        <span className="hidden truncate text-xs text-muted-foreground sm:inline">{how}</span>
        <button
          type="button"
          data-guest-manage=""
          onClick={(e) => openAgentEditor(e.currentTarget, 'people', { guestId: guest.id })}
          className="inline-flex shrink-0 items-center gap-0.5 rounded-md px-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Manage in People
          <ChevronRight className="h-3 w-3" />
        </button>
      </CardHeaderSlot>
      <div ref={scrollRef} role="log" aria-label={`${guest.displayName}’s conversation`} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {read.messages.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{guest.displayName} hasn’t texted yet.</p>
        ) : (
          <MessageInteractionsContext.Provider value={null}>
            <MessageFeedbackContext.Provider value={null}>
              <div className="flex flex-col gap-4">
                {read.hasMore && <p className="text-center text-[11px] text-muted-foreground">Earlier messages aren’t shown.</p>}
                <ChatMessageList
                  messages={read.messages}
                  latestUserMessageId={lastUser}
                  userAvatarUrl={null}
                  userInitials={guestInitials(guest.displayName)}
                />
              </div>
            </MessageFeedbackContext.Provider>
          </MessageInteractionsContext.Provider>
        )}
      </div>
    </div>
  )
}
