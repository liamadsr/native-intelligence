'use client'

/**
 * A meeting guest's chat in the call (migration 670), and the side panel it
 * shares with the call's notes (src/components/meeting-links/guest-meeting.tsx
 * draws them beside the call).
 *
 *   - {@link useGuestChat}: the meeting's chat as the guest reads it (GET
 *     /m/<token>/chat, src/lib/meeting-links/guest-chat.ts says what a guest is
 *     given), asked every GUEST_CHAT_POLL_MS while they are connected and the
 *     tab is on screen, never while it is hidden (it asks again the moment it
 *     is back), so the Chat control can show a dot for what is new while the
 *     panel is closed. Their own message is sent with POST; a send that fails
 *     says so and keeps the words. A guest has no database session: no
 *     Realtime, a timer at most (no animation loop).
 *   - {@link GuestChatView}: the list and the composer, pure. Enter sends,
 *     Shift+Enter is a new line, 2000 characters at most.
 *   - {@link GuestSidePanel}: one panel, clear glass on the sky like the
 *     notes pad: two tabs ("Notes", "Chat") when the call's notes are shown
 *     to guests, the chat alone otherwise; the whole width on a phone.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { MessagesSquare, NotebookPen, SendHorizontal, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { linkRuns, messageTime } from '@/lib/team-chat/compose'
import { GUEST_CHAT_MAX, GUEST_CHAT_POLL_MS, guestChatListOf, unreadSince, withMessage, type GuestChatMessage } from '@/lib/meeting-links/guest-chat'

export type GuestChatState = 'loading' | 'ready' | 'failed' | 'refused'

export interface GuestChat {
  messages: GuestChatMessage[]
  state: GuestChatState
  draft: string
  setDraft: (text: string) => void
  sending: boolean
  /** Why the last send failed, in plain words; null when it didn't. */
  sendError: string | null
  send: () => Promise<boolean>
}

/** A refused send, said plainly. */
function sendErrorOf(status: number | null): string {
  if (status === null) return 'Couldn’t send: you seem to be offline. Your message is still here.'
  if (status === 429) return 'Too many messages at once. Wait a moment, then send again.'
  if (status === 403 || status === 401) return 'You can’t send messages in this call any more.'
  if (status === 400) return `Couldn’t send: a message is 1 to ${GUEST_CHAT_MAX} characters.`
  return 'Couldn’t send. Your message is still here: try again.'
}

/**
 * The meeting's chat for a guest in its call. `active`: they are connected
 * (nothing is asked otherwise). Asked at once, then every GUEST_CHAT_POLL_MS
 * while the tab is on screen; hidden, not at all.
 */
export function useGuestChat(base: string, active: boolean): GuestChat {
  const [messages, setMessages] = useState<GuestChatMessage[]>([])
  const [state, setState] = useState<GuestChatState>('loading')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  // The poll's own "ask now" (after a send): set by the effect below.
  const askNow = useRef<(() => void) | null>(null)
  // Their sends, by id, when this page had them back (its own clock: the server's may differ).
  const sentAt = useRef(new Map<string, number>())

  useEffect(() => {
    if (!active) return
    let stopped = false
    let asking = false
    let timer: ReturnType<typeof setTimeout> | null = null
    setState((s) => (s === 'refused' ? 'loading' : s))
    const ask = async () => {
      timer = null
      if (stopped || asking || document.visibilityState !== 'visible') return
      asking = true
      try {
        const res = await fetch(`${base}/chat`, { cache: 'no-store' })
        if (stopped) return
        if (res.status === 401 || res.status === 403) {
          // No longer in the call (left, removed, it ended): nothing more is asked.
          setState('refused')
          return
        }
        const json = res.ok ? ((await res.json().catch(() => null)) as { messages?: unknown } | null) : null
        if (stopped) return
        if (json) {
          const fresh = guestChatListOf(json.messages)
          // A message they just sent stays until a read has it (one already on its way when it was sent may not).
          const recent = (m: GuestChatMessage) => Date.now() - (sentAt.current.get(m.id) ?? 0) < 30_000
          setMessages((prev) => prev.filter((m) => m.mine && recent(m) && !fresh.some((f) => f.id === m.id)).reduce(withMessage, fresh))
          setState('ready')
        } else setState((s) => (s === 'ready' ? s : 'failed'))
      } catch {
        if (!stopped) setState((s) => (s === 'ready' ? s : 'failed'))
      } finally {
        asking = false
      }
      if (!stopped && document.visibilityState === 'visible') timer = setTimeout(() => void ask(), GUEST_CHAT_POLL_MS)
    }
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || asking) return
      if (timer) clearTimeout(timer)
      void ask()
    }
    document.addEventListener('visibilitychange', onVisible)
    askNow.current = onVisible
    void ask()
    return () => {
      stopped = true
      askNow.current = null
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [base, active])

  const send = useCallback(async (): Promise<boolean> => {
    const text = draft.trim()
    if (!text || sending) return false
    setSending(true)
    setSendError(null)
    let res: Response | null = null
    try {
      res = await fetch(`${base}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
    } catch {
      res = null
    }
    const json = res?.ok ? ((await res.json().catch(() => null)) as { message?: unknown } | null) : null
    const [message] = guestChatListOf(json?.message ? [json.message] : [])
    setSending(false)
    if (!message) {
      setSendError(sendErrorOf(res ? (res.ok ? 500 : res.status) : null))
      if (res?.status === 403 || res?.status === 401) setState('refused')
      return false
    }
    sentAt.current.set(message.id, Date.now())
    setMessages((prev) => withMessage(prev, message))
    setDraft('')
    askNow.current?.()
    return true
  }, [base, draft, sending])

  return { messages, state, draft, setDraft, sending, sendError, send }
}

/** Words with their links as links (http and https only, opened apart, never followed by search engines). */
function Words({ text }: { text: string }) {
  const runs = linkRuns(text)
  return (
    <>
      {runs.map((run, i) =>
        run.href ? (
          <a key={i} href={run.href} target="_blank" rel="noopener noreferrer nofollow ugc" className="underline underline-offset-2 [overflow-wrap:anywhere] hover:no-underline">
            {run.text}
          </a>
        ) : (
          <span key={i}>{run.text}</span>
        ),
      )}
    </>
  )
}

/** The chat as drawn: pure (tests, screenshots). */
export function GuestChatView({ chat, className }: { chat: Pick<GuestChat, 'messages' | 'state' | 'draft' | 'setDraft' | 'sending' | 'sendError' | 'send'>; className?: string }) {
  const { messages, state, draft, setDraft, sending, sendError, send } = chat
  const list = useRef<HTMLDivElement>(null)
  // Was the reader at the newest message before this draw? Only then is the next one followed.
  const atEnd = useRef(true)
  const last = messages.at(-1)?.id ?? ''
  useEffect(() => {
    const box = list.current
    if (box && atEnd.current) box.scrollTop = box.scrollHeight
  }, [last])
  const refused = state === 'refused'
  const length = [...draft].length
  const over = length > GUEST_CHAT_MAX
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
    e.preventDefault()
    if (!over) void send()
  }
  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)} data-guest-chat={state}>
      <div
        ref={list}
        role="log"
        aria-label="Chat messages"
        aria-live="polite"
        onScroll={(e) => {
          const box = e.currentTarget
          atEnd.current = box.scrollHeight - box.scrollTop - box.clientHeight < 32
        }}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1 text-sm leading-relaxed"
        data-guest-chat-list=""
      >
        {state === 'loading' && messages.length === 0 && <p className="text-xs text-muted-foreground">Loading…</p>}
        {state === 'failed' && messages.length === 0 && <p className="text-xs text-amber-700 dark:text-amber-300">Couldn’t load the chat. Trying again…</p>}
        {state === 'ready' && messages.length === 0 && <p className="text-xs text-muted-foreground">No messages yet. Say hello to the people in the meeting.</p>}
        {messages.map((m) => (
          <div key={m.id} data-guest-chat-message={m.author} data-mine={m.mine || undefined} className="min-w-0">
            <p className="flex items-baseline gap-1.5">
              <span className="min-w-0 truncate text-xs font-semibold text-foreground">{m.mine ? 'You' : m.name}</span>
              {m.author === 'guest' && !m.mine && <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Guest</span>}
              {m.author === 'agent' && <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Agent</span>}
              <time dateTime={m.at} className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                {messageTime(m.at)}
              </time>
            </p>
            {m.text && (
              <p className="whitespace-pre-wrap break-words text-foreground/90">
                <Words text={m.text} />
              </p>
            )}
            {m.note && <p className="text-xs italic text-muted-foreground">{m.note}</p>}
          </div>
        ))}
      </div>
      <form
        className="mt-3 shrink-0 border-t border-foreground/10 pt-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (!over) void send()
        }}
      >
        <label htmlFor="guest-chat-text" className="sr-only">
          Message everyone in the meeting
        </label>
        <div className="flex items-end gap-2">
          <textarea
            id="guest-chat-text"
            rows={2}
            value={draft}
            maxLength={GUEST_CHAT_MAX}
            disabled={refused}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={refused ? 'You’re no longer in the call' : 'Message everyone in the meeting'}
            aria-describedby="guest-chat-help"
            aria-invalid={!!sendError || undefined}
            className="max-h-32 min-h-[44px] flex-1 resize-none rounded-2xl border border-foreground/15 bg-background/60 px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 dark:bg-white/[0.06]"
            data-guest-chat-input=""
          />
          <button
            type="submit"
            disabled={refused || sending || !draft.trim() || over}
            aria-label={sending ? 'Sending…' : 'Send'}
            title="Send"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-foreground text-background hover:bg-foreground/90 disabled:opacity-40"
            data-guest-chat-send=""
          >
            <SendHorizontal className="h-4 w-4" aria-hidden />
          </button>
        </div>
        {sendError && (
          <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400" data-guest-chat-error="">
            {sendError}
          </p>
        )}
        <p id="guest-chat-help" className="mt-2 flex gap-2 text-[11px] text-muted-foreground">
          <span className="min-w-0 flex-1">Everyone in the meeting reads this chat, and it stays with the meeting. Enter sends, Shift+Enter starts a new line.</span>
          {length > GUEST_CHAT_MAX - 200 && <span className={cn('shrink-0 tabular-nums', over && 'text-red-600 dark:text-red-400')}>{`${length}/${GUEST_CHAT_MAX}`}</span>}
        </p>
      </form>
    </div>
  )
}

export type GuestPanelTab = 'notes' | 'chat'

const TAB_LABEL: Record<GuestPanelTab, string> = { notes: 'Notes', chat: 'Chat' }
const TAB_ICON = { notes: NotebookPen, chat: MessagesSquare } as const

/**
 * The guest's side panel: the Notes and Chat tabs (Chat alone when the notes
 * aren't shown to guests), a close button, and the tab's body. Arrow keys move
 * between the tabs. The whole width on a phone, a column beside the call on a
 * wide screen.
 */
export function GuestSidePanel({
  tab,
  tabs,
  onTab,
  onClose,
  unread = 0,
  children,
  className,
}: {
  tab: GuestPanelTab
  tabs: readonly GuestPanelTab[]
  onTab: (tab: GuestPanelTab) => void
  onClose: () => void
  /** New chat messages while the Notes tab is shown: a dot on the Chat tab. */
  unread?: number
  children: ReactNode
  className?: string
}) {
  const refs = useRef<Partial<Record<GuestPanelTab, HTMLButtonElement | null>>>({})
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const at = tabs.indexOf(tab)
    const next = tabs[(at + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]
    onTab(next)
    refs.current[next]?.focus()
  }
  const single = tabs.length === 1
  return (
    <aside aria-label="Meeting notes and chat" data-guest-panel={tab} className={cn('flex min-h-0 w-full flex-col rounded-3xl p-4', className)}>
      <div className="flex shrink-0 items-center gap-2">
        {single ? (
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <MessagesSquare className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            {TAB_LABEL[tab]}
          </h2>
        ) : (
          <div role="tablist" aria-label="Notes and chat" onKeyDown={onKey} className="flex gap-1 rounded-full bg-foreground/[0.06] p-1">
            {tabs.map((t) => {
              const Icon = TAB_ICON[t]
              const selected = t === tab
              return (
                <button
                  key={t}
                  ref={(el) => {
                    refs.current[t] = el
                  }}
                  type="button"
                  role="tab"
                  id={`guest-panel-tab-${t}`}
                  aria-selected={selected}
                  aria-controls="guest-panel-body"
                  tabIndex={selected ? 0 : -1}
                  onClick={() => onTab(t)}
                  data-guest-panel-tab={t}
                  className={cn(
                    'relative flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold transition-colors',
                    selected ? 'bg-background/80 text-foreground shadow-sm dark:bg-white/[0.14]' : 'text-foreground/70 hover:text-foreground',
                  )}
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden />
                  {TAB_LABEL[t]}
                  {t === 'chat' && !selected && unread > 0 && (
                    <>
                      <span className="h-1.5 w-1.5 rounded-full bg-sky-500" aria-hidden data-guest-chat-tab-dot="" />
                      <span className="sr-only">{unread === 1 ? '1 new message' : `${unread} new messages`}</span>
                    </>
                  )}
                </button>
              )
            })}
          </div>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the panel"
          title="Close"
          className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-foreground/70 hover:bg-foreground/[0.08] hover:text-foreground"
          data-guest-panel-close=""
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <div id="guest-panel-body" role={single ? undefined : 'tabpanel'} aria-labelledby={single ? undefined : `guest-panel-tab-${tab}`} className="mt-3 flex min-h-0 flex-1 flex-col">
        {children}
      </div>
    </aside>
  )
}

/** How many of the chat's messages from others are newer than what the guest last had on screen. */
export function useChatUnread(messages: readonly GuestChatMessage[], onScreen: boolean): number {
  const [seenAt, setSeenAt] = useState<number | null>(null)
  const newest = useMemo(() => messages.reduce((t, m) => Math.max(t, Date.parse(m.at) || 0), 0), [messages])
  useEffect(() => {
    if (onScreen && newest) setSeenAt((s) => (s !== null && s >= newest ? s : newest))
  }, [onScreen, newest])
  return onScreen ? 0 : unreadSince(messages, seenAt)
}
