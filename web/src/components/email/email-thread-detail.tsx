'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { toast } from 'sonner'
import {
  ChevronLeft,
  ChevronRight,
  Archive,
  Trash2,
  Star,
  ReplyAll,
  CircleCheck,
  Boxes,
  ChevronDown,
  Tag,
  X,
  Send,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { useScopedLabels } from '@/lib/labels/use-scoped-labels'
import { LabelPickerContent } from '@/components/labels/label-picker-content'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { ListenTarget } from '@/components/read-aloud/listen-target'
import { emailThreadToSentences, type ThreadSpeechMessage } from '@/lib/read-aloud/email-thread-speech'
import type { DraftEdits } from '@/lib/email/draft-edits'
import type { EmailReplyRequest } from '@/lib/email/reply-in-chat'
import { emailTaskLabel, makeTaskFromEntity } from '@/lib/entities/actions'
import { scheduleSend } from '@/lib/email/send-later'
import { EmailMessage, type EmailMessageData } from './email-message'
import { EmailShareDialog } from './email-share-dialog'
import { EmailShareChips } from './email-share-chips'

interface EmailLabel {
  id: string
  name: string
  color: string
}

interface FullEmailThread {
  threadId: string
  /** The thread's index row, which its agent activity is keyed on (null when not indexed). */
  indexId?: string | null
  subject: string
  messages: EmailMessageData[]
  contact: { id: string; full_name: string; company?: { name: string } } | null
  metadata: {
    needs_reply: boolean
    auto_classified: string | null
    linked_capture_id: string | null
  }
}

/**
 * Generic thread update event. All detail-view actions emit this
 * so the parent can optimistically update the thread list.
 *
 * - patch:  merge partial fields into the thread (star, labels, etc.)
 * - remove: remove the thread from the list (archive, trash)
 */
export type ThreadUpdate =
  | { type: 'patch'; threadId: string; data: Partial<EmailThread> }
  | { type: 'remove'; threadId: string }

interface EmailThread {
  is_starred?: boolean
  labels?: EmailLabel[]
  [key: string]: unknown
}

interface EmailThreadDetailProps {
  threadId: string
  /** The mailbox the thread is in: a search result the index doesn't have opens by it. */
  accountId?: string | null
  /** Bump to force a background reload of this thread's messages + drafts
   *  (e.g. a new reply landed, or an email_draft for this thread changed).
   *  Unlike a threadId change, this reloads in place: the skeleton is not
   *  shown and scroll position is preserved. */
  reloadKey?: number
  isStarred?: boolean
  onThreadUpdate?: (update: ThreadUpdate) => void
  onClose?: () => void
  onPrev?: () => void
  onNext?: () => void
  /** Hands the thread (or one message on it) to the chat assistant to draft a reply. */
  onReplyRequest?: (request: EmailReplyRequest) => void
  /** A draft in this thread was sent. The pane reloads itself; the parent
   *  updates what lists the thread (Drafts drops it). */
  onDraftSent?: (threadId: string) => void
  /** A draft in this thread was discarded. The pane reloads itself while the
   *  thread remains; the parent updates what lists it (Drafts drops it, and
   *  every folder drops a thread that was nothing but the draft). */
  onDraftDiscarded?: (threadId: string, threadRemains: boolean) => void
  /** The user's own addresses (their connected mailboxes): in listen mode,
   *  what they sent reads as "you". Lowercase. Unknown: read by name. */
  ownAddresses?: readonly string[]
  /**
   * A draft to open on (its mailbox message id: a For you draft card, a work
   * item's "Review draft"): once the thread loads, it is scrolled into view
   * and ringed for a moment, so the person lands on it, not the thread's top.
   */
  focusDraftId?: string | null
}

/**
 * The thread's messages as listen mode reads them (@/lib/read-aloud/email-thread-speech):
 * the user's own (sent from one of `own`) as "you", and files counted. Outlook
 * lists a message's inline images (a signature's logo) among its attachments
 * but says it has none: then it has none here either.
 */
function threadSpeechMessages(messages: EmailMessageData[], own: ReadonlySet<string>): ThreadSpeechMessage[] {
  return messages.map((message) => {
    const address = message.from.email?.trim().toLowerCase() ?? ''
    return {
      from: message.from,
      mine: address !== '' && own.has(address),
      date: message.date,
      subject: message.subject,
      bodyHtml: message.bodyHtml,
      bodyText: message.bodyText,
      attachmentCount: message.hasAttachments ? Math.max(1, message.attachments?.length ?? 0) : 0,
      isDraft: message.isDraft,
    }
  })
}

export function EmailThreadDetail({
  threadId,
  accountId,
  reloadKey,
  isStarred: isStarredProp,
  onThreadUpdate,
  onClose,
  onPrev,
  onNext,
  onReplyRequest,
  onDraftSent,
  onDraftDiscarded,
  ownAddresses,
  focusDraftId = null,
}: EmailThreadDetailProps) {
  const [thread, setThread] = useState<FullEmailThread | null>(null)
  const [loading, setLoading] = useState(true)
  const [starred, setStarred] = useState(isStarredProp ?? false)
  const starredPropRef = useRef(isStarredProp)
  starredPropRef.current = isStarredProp
  const [threadLabels, setThreadLabels] = useState<EmailLabel[]>([])
  // The draft to land on (focusDraftId): once its message has loaded, scroll
  // to it and ring it for a few seconds. Once per thread and draft.
  const [focusRing, setFocusRing] = useState<string | null>(null)
  const focusedRef = useRef<string | null>(null)
  const messagesRootRef = useRef<HTMLDivElement>(null)
  const focusTarget = focusDraftId && thread?.messages.some((m) => m.id === focusDraftId && m.isDraft) ? focusDraftId : null
  useEffect(() => {
    if (!focusTarget || focusedRef.current === `${threadId}:${focusTarget}`) return
    focusedRef.current = `${threadId}:${focusTarget}`
    // By attribute value, not a selector: a provider id is any string.
    const el = [...(messagesRootRef.current?.querySelectorAll<HTMLElement>('[data-email-message-id]') ?? [])].find((n) => n.getAttribute('data-email-message-id') === focusTarget)
    el?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    setFocusRing(focusTarget)
    const t = setTimeout(() => setFocusRing(null), 4000)
    return () => clearTimeout(t)
  }, [focusTarget, threadId])
  const { labels: scopedLabelsRaw, grouped: scopedLabelsGrouped } = useScopedLabels('email_thread')
  const allLabels = useMemo(() => scopedLabelsRaw as unknown as EmailLabel[], [scopedLabelsRaw])
  const ownAddressSet = useMemo(
    () => new Set((ownAddresses ?? []).map((address) => address.trim().toLowerCase())),
    [ownAddresses],
  )

  // Sync starred from parent when thread changes
  useEffect(() => {
    setStarred(isStarredProp ?? false)
  }, [isStarredProp, threadId])

  // Fetch thread labels when thread changes
  useEffect(() => {
    if (!threadId) return
    let cancelled = false
    setThreadLabels([])
    fetch(`/api/account/email/threads/${threadId}/labels`)
      .then((r) => r.ok ? r.json() : { labels: [] })
      .then((d) => { if (!cancelled) setThreadLabels(d.labels || []) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [threadId])

  const toggleLabel = useCallback(async (labelId: string, isAttached: boolean) => {
    let newLabels: EmailLabel[]
    if (isAttached) {
      newLabels = threadLabels.filter((l) => l.id !== labelId)
      setThreadLabels(newLabels)
      onThreadUpdate?.({ type: 'patch', threadId, data: { labels: newLabels } })
      try {
        const res = await fetch(`/api/account/email/threads/${threadId}/labels/${labelId}`, { method: 'DELETE' })
        if (!res.ok) throw new Error(`label remove failed: ${res.status}`)
      } catch {
        const label = allLabels.find((l) => l.id === labelId)
        if (label) {
          const reverted = [...newLabels, label]
          setThreadLabels(reverted)
          onThreadUpdate?.({ type: 'patch', threadId, data: { labels: reverted } })
        }
      }
    } else {
      const label = allLabels.find((l) => l.id === labelId)
      if (label) {
        newLabels = [...threadLabels, label]
        setThreadLabels(newLabels)
        onThreadUpdate?.({ type: 'patch', threadId, data: { labels: newLabels } })
        try {
          const res = await fetch(`/api/account/email/threads/${threadId}/labels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label_id: labelId }),
          })
          if (!res.ok) throw new Error(`label add failed: ${res.status}`)
        } catch {
          const reverted = newLabels.filter((l) => l.id !== labelId)
          setThreadLabels(reverted)
          onThreadUpdate?.({ type: 'patch', threadId, data: { labels: reverted } })
        }
      }
    }
  }, [threadId, threadLabels, allLabels, onThreadUpdate])

  // Request-generation guard: a background reload (live refresh) can be in
  // flight when the thread switches or another load starts. Each call bumps the
  // generation and captures it; a response is only applied if it's still the
  // latest, so a slow stale response can't clobber a fresher thread's data.
  const loadGenRef = useRef(0)

  // `background` reloads the messages + drafts in place without flipping the
  // full-panel skeleton, so a live refresh (new reply / draft change) keeps
  // the rendered messages and scroll position instead of blanking the panel.
  const loadThread = useCallback(async ({ background = false } = {}) => {
    const gen = ++loadGenRef.current
    if (!background) {
      setLoading(true)
      setThread(null)
    }
    try {
      const res = await fetch(`/api/account/email/threads/${threadId}${accountId ? `?account=${encodeURIComponent(accountId)}` : ''}`)
      if (res.ok) {
        const data = await res.json()
        if (loadGenRef.current === gen) {
          setThread(data)
          if (starredPropRef.current === undefined) {
            setStarred(data.messages.some((message: EmailMessageData) => message.isStarred))
          }
        }
      }
    } catch {
      // Network error
    } finally {
      // Only the latest load owns the loading flag — a superseded load
      // resolving late must not clear the spinner for the current one.
      if (!background && loadGenRef.current === gen) setLoading(false)
    }
  }, [threadId, accountId])

  useEffect(() => {
    loadThread()
    const generation = loadGenRef
    return () => { generation.current++ }
  }, [loadThread])

  // Live refresh when the parent bumps reloadKey (open thread got a new reply,
  // or an email_draft for it changed). Reload in place — skip the initial
  // mount (reloadKey 0 / undefined), which loadThread above already covers.
  const lastReloadKeyRef = useRef(reloadKey)
  useEffect(() => {
    if (lastReloadKeyRef.current === reloadKey) return
    lastReloadKeyRef.current = reloadKey
    loadThread({ background: true })
  }, [reloadKey, loadThread])

  const handleArchive = useCallback(async () => {
    onThreadUpdate?.({ type: 'remove', threadId })
    onClose?.()
    const ok = await fetch(`/api/account/email/threads/${threadId}/archive`, {
      method: 'POST',
    }).then((res) => res.ok, () => false)
    if (!ok) toast.error('Could not archive the email')
  }, [threadId, onClose, onThreadUpdate])

  const handleTrash = useCallback(async () => {
    onThreadUpdate?.({ type: 'remove', threadId })
    onClose?.()
    const ok = await fetch(`/api/account/email/threads/${threadId}/trash`, {
      method: 'POST',
    }).then((res) => res.ok, () => false)
    if (!ok) toast.error('Could not delete the email')
  }, [threadId, onClose, onThreadUpdate])

  // A task about this thread: "Follow up: <subject>", else its sender (the
  // first message that is not a draft), linked 'about' the thread's index row.
  // The one task path (makeTaskFromEntity: its toast opens the task).
  const [makingTask, setMakingTask] = useState(false)
  const handleMakeTask = useCallback(async () => {
    if (!thread?.indexId || makingTask) return
    const sender = thread.messages.find((m) => !m.isDraft)?.from ?? null
    setMakingTask(true)
    try {
      // Opened at once: its title carries the mail's subject, and teammates can see the task.
      await makeTaskFromEntity({ type: 'email_thread', id: thread.indexId, label: emailTaskLabel(thread.subject, sender) }, undefined, { openNow: true })
    } finally {
      setMakingTask(false)
    }
  }, [thread, makingTask])

  // Share to chat (migration 646): the owner shares this thread into a
  // channel or DM, read live there, stored nowhere. The chips under the
  // subject say where it is shared; a share or an Undo reloads them.
  const [shareOpen, setShareOpen] = useState(false)
  const [sharesKey, setSharesKey] = useState(0)
  const bumpShares = useCallback(() => setSharesKey((k) => k + 1), [])

  const handleToggleStar = useCallback(async () => {
    const newStarred = !starred
    setStarred(newStarred)
    onThreadUpdate?.({ type: 'patch', threadId, data: { is_starred: newStarred } })
    const ok = await fetch(`/api/account/email/threads/${threadId}/star`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starred: newStarred }),
    }).then((res) => res.ok, () => false)
    if (!ok) {
      setStarred(!newStarred)
      onThreadUpdate?.({ type: 'patch', threadId, data: { is_starred: !newStarred } })
    }
  }, [threadId, starred, onThreadUpdate])

  // Send a draft on this thread, as shown or as edited. One draft action at a
  // time (a send or a discard): the ref holds off a second click before the
  // disabled buttons render. An action can settle after the user has moved to
  // another thread, so the reload is for the thread still on screen only
  // (loadThread would put the old one there).
  const [sendingDraftId, setSendingDraftId] = useState<string | null>(null)
  const [discardingDraftId, setDiscardingDraftId] = useState<string | null>(null)
  const draftBusyRef = useRef(false)
  const shownThreadRef = useRef(threadId)
  shownThreadRef.current = threadId
  // The thread's waiting send, if any (send later): its draft shows "Scheduled · <time>".
  // Read with the thread, and again after a schedule, a send or a discard.
  const [scheduledAt, setScheduledAt] = useState<string | null>(null)
  const loadScheduled = useCallback(async () => {
    const forThread = threadId
    try {
      const res = await fetch(`/api/account/email/scheduled?thread_id=${encodeURIComponent(forThread)}`, { cache: 'no-store' })
      if (!res.ok) return
      const data = (await res.json()) as { scheduled?: Array<{ status?: string; send_at?: string }> }
      const waiting = (data.scheduled ?? []).find((r) => r.status === 'scheduled' && typeof r.send_at === 'string')
      if (shownThreadRef.current === forThread) setScheduledAt(waiting?.send_at ?? null)
    } catch {
      // No badge: nothing else depends on it.
    }
  }, [threadId])
  useEffect(() => {
    setScheduledAt(null)
    void loadScheduled()
  }, [loadScheduled, reloadKey])

  const handleSendDraft = useCallback(
    async (draftId: string, edits?: DraftEdits) => {
      if (draftBusyRef.current) return
      draftBusyRef.current = true
      setSendingDraftId(draftId)
      const sentThreadId = threadId
      try {
        const res = await fetch('/api/account/email/draft/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ thread_id: sentThreadId, draft_id: draftId, ...(edits ? { edits } : {}) }),
        })
        if (res.ok) {
          toast.success('Email sent')
          // Sent by hand: its schedule, if any, was cancelled.
          if (shownThreadRef.current === sentThreadId) setScheduledAt(null)
          onDraftSent?.(sentThreadId)
        } else {
          const data = await res.json().catch(() => ({}))
          toast.error(typeof data.error === 'string' ? data.error : 'Could not send the email')
          // 404: the draft changed or left the mailbox; show what is there now.
          if (res.status !== 404) return
        }
        if (shownThreadRef.current === sentThreadId) loadThread({ background: true })
      } catch {
        toast.error('Could not send the email')
      } finally {
        draftBusyRef.current = false
        setSendingDraftId(null)
      }
    },
    [threadId, loadThread, onDraftSent],
  )

  // Send a draft on this thread later (its Send later, as shown or as edited):
  // scheduled from the thread's own mailbox; the toast's Undo leaves it a
  // normal draft. The pane reloads (an edit gave the draft new words).
  const handleScheduleDraft = useCallback(
    async (message: EmailMessageData, at: Date, edits?: DraftEdits): Promise<boolean> => {
      const scheduledThreadId = threadId
      const row = await scheduleSend(
        {
          thread_id: scheduledThreadId,
          draft_id: message.id,
          ...(edits ? { edits } : {}),
          shown: { to: [...message.to, ...message.cc].map((r) => r.email), subject: message.subject },
        },
        at,
      )
      if (row && edits && shownThreadRef.current === scheduledThreadId) loadThread({ background: true })
      if (row && shownThreadRef.current === scheduledThreadId) setScheduledAt(row.send_at)
      return !!row
    },
    [threadId, loadThread],
  )

  // Discard a draft on this thread (the message's Discard, once confirmed). The
  // pane shows the thread without it; a thread that was nothing but the draft
  // is gone, and the parent closes it.
  const handleDiscardDraft = useCallback(
    async (draftId: string) => {
      if (draftBusyRef.current) return
      draftBusyRef.current = true
      setDiscardingDraftId(draftId)
      const discardedThreadId = threadId
      try {
        const res = await fetch('/api/account/email/draft/discard', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ thread_id: discardedThreadId, draft_id: draftId }),
        })
        const data = await res.json().catch(() => ({}))
        if (res.ok) {
          toast.success('Draft discarded')
          if (shownThreadRef.current === discardedThreadId) setScheduledAt(null)
          const threadRemains = data.thread_remains !== false
          onDraftDiscarded?.(discardedThreadId, threadRemains)
          if (!threadRemains) return
        } else {
          toast.error(typeof data.error === 'string' ? data.error : 'Could not discard the draft')
          // 404: the draft changed or left the mailbox; show what is there now.
          if (res.status !== 404) return
        }
        if (shownThreadRef.current === discardedThreadId) loadThread({ background: true })
      } catch {
        toast.error('Could not discard the draft')
      } finally {
        draftBusyRef.current = false
        setDiscardingDraftId(null)
      }
    },
    [threadId, loadThread, onDraftDiscarded],
  )

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex h-10 shrink-0 items-center gap-2 px-3">
          <Skeleton className="h-7 w-7 rounded" />
          <Skeleton className="h-7 w-7 rounded" />
          <div className="flex-1" />
          <Skeleton className="h-7 w-7 rounded" />
        </div>
        <div className="flex-1 p-5 space-y-3">
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-4 w-32" />
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      </div>
    )
  }

  if (!thread) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground" role="status">Couldn’t load this email.</p>
        <Button variant="outline" size="sm" onClick={() => loadThread()}>Try again</Button>
      </div>
    )
  }

  // The newest message sent (a draft isn't): a new reply landing changes
  // what listen mode reads, and so its key.
  const latest = [...thread.messages].reverse().find((message) => !message.isDraft)

  // `ph-no-capture`: PostHog session replay blocks the thread (subjects,
  // bodies, the reply draft) and autocapture skips it. It also renders alone,
  // outside the mail layout (the contact panel), so it carries its own.
  return (
    <div className="ph-no-capture flex flex-col h-full">
      {/* Read aloud (desktop only), with no button of its own: in listen mode
          (its toggle is in the top bar) the whole thread reads itself as it
          opens, oldest to newest, who wrote what and when, each message only
          its own words, without the quoted history, signature or footer,
          files counted, drafts left out (Liam, 2026-10-02: "it knows to read
          the entire conversation and not just the latest one"); closing the
          thread pauses it. A new reply makes it a new reading. The top bar
          offers the next thread beside the toggle while listen mode is on,
          as j does here. */}
      {latest && (
        <ListenTarget
          listenKey={`email-thread:${thread.threadId}:${latest.id}`}
          getSentences={() =>
            emailThreadToSentences({
              subject: thread.subject,
              messages: threadSpeechMessages(thread.messages, ownAddressSet),
            })
          }
          next={onNext ? { label: 'Next thread', go: onNext } : undefined}
        />
      )}

      {/* Detail header bar */}
      <div className="flex h-10 shrink-0 items-center gap-1 px-3">
        <TooltipProvider delayDuration={300}>
          {/* Prev / Next navigation */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={onPrev}
                disabled={!onPrev}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Previous (k)</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={onNext}
                disabled={!onNext}
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Next (j)</TooltipContent>
          </Tooltip>

          <div className="flex-1" />

          {/* Reply All — the chat assistant drafts a reply to everyone on the thread */}
          {onReplyRequest && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
                  onClick={() => onReplyRequest({ threadId })}
                >
                  <ReplyAll className="h-3.5 w-3.5" />
                  Reply All
                </Button>
              </TooltipTrigger>
              <TooltipContent>Draft AI reply to all participants</TooltipContent>
            </Tooltip>
          )}

          {/* Labels */}
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                <Tag className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-2" align="start">
              <LabelPickerContent
                grouped={scopedLabelsGrouped}
                selectedIds={threadLabels.map((l) => l.id)}
                onToggle={(id, isAttached) => toggleLabel(id, isAttached)}
              />
            </PopoverContent>
          </Popover>

          {/* Thread actions */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={handleToggleStar}>
                <Star className={cn('h-3.5 w-3.5', starred && 'fill-yellow-400 text-yellow-400')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Star</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={handleArchive}>
                <Archive className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Archive</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={handleTrash}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Delete</TooltipContent>
          </Tooltip>

          {/* Make a task about this thread ("Follow up: <subject>", else its
              sender), linked to it. Only an indexed thread can be linked; the
              server checks the mail is the person's own. */}
          {thread.indexId && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  aria-label="Make a task"
                  data-make-task=""
                  disabled={makingTask}
                  onClick={handleMakeTask}
                >
                  <CircleCheck className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Make a task</TooltipContent>
            </Tooltip>
          )}

          {/* Share to chat: read live by the people there, never copied. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                aria-label="Share to chat"
                data-email-share=""
                onClick={() => setShareOpen(true)}
              >
                <Send className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Share to chat</TooltipContent>
          </Tooltip>
        </TooltipProvider>

      </div>

      {/* Subject + meta */}
      <div className="shrink-0 px-5 pt-4 pb-3">
        <h2 className="select-text text-lg font-semibold leading-snug">{thread.subject}</h2>
        <div className="flex flex-wrap items-center gap-2 mt-1">
          {thread.metadata.needs_reply && (
            <span className="text-xs font-medium text-blue-500 bg-blue-500/10 px-2 py-0.5 rounded-full">
              To respond
            </span>
          )}
          {thread.contact && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <span className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-muted text-[10px] font-medium">
                {thread.contact.full_name.charAt(0).toUpperCase()}
              </span>
              {thread.contact.full_name}
              {thread.contact.company && ` @ ${thread.contact.company.name}`}
            </span>
          )}
          <EmailShareChips thread={{ threadId, accountId }} reloadKey={sharesKey} />
          {threadLabels.map((label) => (
            <Badge
              key={label.id}
              variant="outline"
              className="gap-1 pl-1.5 pr-0.5 py-0 text-[10px]"
            >
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: label.color }}
              />
              {label.name}
              <button
                onClick={() => toggleLabel(label.id, true)}
                className="ml-0.5 rounded-sm p-0.5 hover:bg-muted"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </Badge>
          ))}
        </div>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1">
        <div ref={messagesRootRef} className="px-5 pb-4 space-y-3">
          {thread.messages.map((message, index) => (
            <div
              key={message.id}
              data-email-message-id={message.id}
              // The draft the card opened on: ringed until the person moves on.
              className={cn(
                'rounded-xl transition-shadow duration-700 motion-reduce:transition-none',
                focusRing === message.id ? 'ring-2 ring-primary/40 ring-offset-2 ring-offset-background' : null,
              )}
            >
            <EmailMessage
              message={message}
              defaultExpanded={index === thread.messages.length - 1 || !!message.isDraft}
              onReply={
                onReplyRequest && !message.isDraft
                  ? () => onReplyRequest({ threadId, message: { id: message.id, fromEmail: message.from.email } })
                  : undefined
              }
              onSend={message.isDraft ? (edits) => handleSendDraft(message.id, edits) : undefined}
              sending={sendingDraftId === message.id}
              onSendLater={message.isDraft ? (at, edits) => handleScheduleDraft(message, at, edits) : undefined}
              scheduledAt={message.isDraft ? scheduledAt : null}
              onDiscard={message.isDraft ? () => handleDiscardDraft(message.id) : undefined}
              discarding={discardingDraftId === message.id}
            />
            </div>
          ))}
          {thread.indexId && <ThreadAgents threadIndexId={thread.indexId} />}
        </div>
      </ScrollArea>

      <EmailShareDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        thread={{ threadId, accountId, indexId: thread.indexId ?? null }}
        onShared={bumpShares}
        onUndone={bumpShares}
      />

    </div>
  )
}

// ── Agents (plan 2.4, page 6; row 12) ────────────────────────────────────────

const EntityActivitySection = dynamic(
  () => import('@/components/work/entity-activity-tab').then((m) => m.EntityActivitySection),
  { ssr: false },
)

/** Open or closed, as the person last left it (for the session): mounted only when open. */
let threadAgentsOpen = false

/**
 * The agents that worked on this thread (drafted a reply, read it), under the
 * messages: a section of the reading pane, not a tab. Closed, it loads nothing;
 * open, it is the entity tab keyed on the thread's index row.
 */
function ThreadAgents({ threadIndexId }: { threadIndexId: string }) {
  const [open, setOpen] = useState(threadAgentsOpen)
  return (
    <section aria-label="Thread agents" className="pt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          threadAgentsOpen = !open
          setOpen(!open)
        }}
        className="flex items-center gap-1.5 rounded-md px-1 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <Boxes className="h-3.5 w-3.5" />
        Agents
        <ChevronDown className={cn('h-3 w-3 transition-transform', !open && '-rotate-90')} />
      </button>
      {open && <EntityActivitySection entityType="email_thread" entityId={threadIndexId} />}
    </section>
  )
}
