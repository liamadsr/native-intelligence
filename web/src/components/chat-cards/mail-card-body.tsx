'use client'

/**
 * A mail card's page (docs/plans/one-agent-and-chat-pages.md, P2): the Mail
 * page on the card's own folder, search, mailboxes or thread (EmailLayout's
 * `card`), never the page's state or its module-wide open signal.
 *
 *   - Inline it is one pane: the thread list, or the thread when one is open
 *     (a thread card opens on it). Full screen, the page's two panes.
 *   - Where the person takes it stays with the card, kept per device: a thread
 *     card stays a thread card while that thread is open; a thread the person
 *     opens from a list is "open inside" it, by its sender (never its subject,
 *     which the sender wrote).
 *   - Its count is the folder's total; the agent's note carries the first
 *     five as sender and subject.
 *   - A folder or a thread is a step in the card's history: the card header's
 *     Back and Forward walk them (a search or a mailbox filter is not one).
 */
import * as React from 'react'
import { EmailLayout, type MailCardState } from '@/components/email/email-layout'
import type { EmailThread } from '@/components/email/email-thread-item'
import { MAIL_FOLDERS, type MailCardSpec, type MailFolder, type MailQuery } from '@/lib/chat-cards/kinds'
import type { CardBodyProps } from './card-body'
import { useCardNav } from './card-history'

/** What Back and Forward walk in a mail card. */
interface MailPlace {
  folder: string
  threadId: string | null
}

/** The rows the agent's note carries: "Sarah Lee: Pricing question". */
export function threadRow(thread: Pick<EmailThread, 'from_name' | 'from_email' | 'subject'>): string {
  const from = thread.from_name || thread.from_email || 'Unknown'
  // The subject arrives live (no stored mail); until it does, the sender alone.
  return thread.subject ? `${from}: ${thread.subject}` : from
}

/**
 * What a card shows now, from where the person left it: the agent's thread
 * stays the card's while it is open; any other thread is open inside it.
 */
export function cardStateToQuery(spec: MailCardSpec, state: MailCardState): { mail: MailQuery; open: { type: 'thread'; id: string; label?: string } | null } {
  const folder = ((MAIL_FOLDERS as readonly string[]).includes(state.folder) ? state.folder : 'inbox') as MailFolder
  const base: MailQuery = {
    folder,
    ...(state.search.trim() ? { search: state.search.trim() } : {}),
    ...(state.unread ? { unread: true } : {}),
    ...(state.accounts?.length ? { accounts: state.accounts } : {}),
  }
  if (state.threadId && state.threadId === spec.mail.thread_id) return { mail: { ...base, thread_id: state.threadId }, open: null }
  return {
    mail: base,
    open: state.threadId ? { type: 'thread', id: state.threadId, ...(state.threadFrom ? { label: `from ${state.threadFrom}` } : {}) } : null,
  }
}

export default function MailCardBody({ toolCallId, spec, store, fullScreen, onCount }: CardBodyProps & { spec: MailCardSpec }) {
  // Where the card was left, or the agent's folder, search or thread. Read at
  // mount; the layout owns it after, full screen and back alike (the card keeps
  // its page mounted across the move: show-tool-card.tsx).
  const initial = React.useMemo<MailCardState>(() => {
    const kept = store.state(toolCallId)
    const q = kept.mail ?? spec.mail
    const open = kept.open?.type === 'thread' ? kept.open : null
    return {
      folder: q.folder,
      search: q.search ?? '',
      unread: !!q.unread,
      accounts: q.accounts?.length ? q.accounts : null,
      threadId: q.thread_id ?? open?.id ?? null,
      // The agent's (or a draft card's) draft to open on, for its own thread only.
      draftId: q.thread_id && q.draft_id ? q.draft_id : null,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, toolCallId])
  const onCountRef = React.useRef(onCount)
  onCountRef.current = onCount
  // The layout reports every move and keeps the card store current itself.
  const nav = useCardNav<MailPlace>('mail', () => ({ folder: initial.folder, threadId: initial.threadId }))
  const { set: navigate } = nav
  const place = nav.value

  const card = React.useMemo(
    () => ({
      initial,
      fullScreen,
      place,
      onStateChange: (state: MailCardState) => {
        const { mail, open } = cardStateToQuery(spec, state)
        store.update(toolCallId, { mail, open }, { touch: true })
        navigate({ folder: state.folder, threadId: state.threadId }, { persist: false })
      },
      onThreads: (threads: EmailThread[], total: number | null) => {
        store.update(toolCallId, { count: total, rows: threads.slice(0, 5).map((t) => ({ title: threadRow(t) })) })
        onCountRef.current?.(total)
      },
    }),
    [initial, fullScreen, place, navigate, spec, store, toolCallId],
  )

  // One layout for both modes: it draws the list beside the thread full screen
  // and one of them inline, and keeps its folder, search and thread across.
  return <EmailLayout card={card} />
}
