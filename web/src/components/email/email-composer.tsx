'use client'

/**
 * Mail's composer: Reply, Reply all, Forward and New email, written by the
 * person, in the thread (under its last message) or on its own. To, Cc and
 * Bcc are theirs to change; the message is rich text (compose-editor.tsx);
 * the subject and the threading come from what is replied to
 * (src/lib/email/compose.ts). Send goes through POST /api/account/email/send
 * (sendEmail), from the thread's own mailbox.
 *
 * Keys: ⌘/Ctrl+Enter sends; Esc closes it, keeping what is written (for this
 * person in this browser, src/lib/email/compose-drafts.ts) for next time.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Bold, ChevronDown, Forward, Italic, Link2, List, ListOrdered, Loader2, Reply, ReplyAll, Send, Trash2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  composeProblem,
  composeSendBody,
  composeStart,
  editorIsEmpty,
  forwardQuoteHtml,
  noReplyRecipients,
  type ComposeMode,
  type ComposeSource,
} from '@/lib/email/compose'
import { clearComposeDraft, readComposeDraft, writeComposeDraft } from '@/lib/email/compose-drafts'
import { EmailRecipientInput } from './email-recipient-input'
import { ComposeEditor, sanitizeComposeHtml, type ComposeEditorHandle } from './compose-editor'
import { sanitizeEmailHtml } from './email-sanitize'

export interface EmailComposerProps {
  mode: ComposeMode
  /** The message replied to or forwarded (null: a new email). */
  source: ComposeSource | null
  /** The thread it is on (a reply threads on it). */
  threadId?: string | null
  /** The mailbox it goes out from (the thread's own; New email's From). */
  accountId?: string | null
  /** That mailbox's address, shown as From. */
  fromAddress?: string | null
  /** The person's own addresses, lowercase: never replied to, shown as Me. */
  ownAddresses: ReadonlySet<string>
  /** Where what is written is kept when the composer closes (compose-drafts.ts). */
  draftKey: string
  /** Reply ↔ Reply all ↔ Forward, from the composer's own switch. */
  onModeChange?: (mode: Exclude<ComposeMode, 'new'>) => void
  /** Sent. */
  onSent?: (result: { message_id?: string; thread_id?: string | null }) => void
  /** Closed without sending (what is written is kept). */
  onClose: () => void
  /** Thrown away (what is written is cleared). */
  onDiscard?: () => void
  autoFocus?: boolean
  className?: string
}

const MODE_LABEL: Record<ComposeMode, string> = {
  reply: 'Reply',
  replyAll: 'Reply all',
  forward: 'Forward',
  new: 'New email',
}
const MODE_ICON = { reply: Reply, replyAll: ReplyAll, forward: Forward } as const

export function EmailComposer({
  mode,
  source,
  threadId = null,
  accountId = null,
  fromAddress = null,
  ownAddresses,
  draftKey,
  onModeChange,
  onSent,
  onClose,
  onDiscard,
  autoFocus = true,
  className,
}: EmailComposerProps) {
  const start = useMemo(() => composeStart(mode, source, ownAddresses), [mode, source, ownAddresses])
  // What this person left here last time, for this same message and mode.
  const kept = useMemo(() => {
    const draft = readComposeDraft(draftKey)
    return draft && draft.mode === start.mode && draft.sourceId === (source?.id ?? null) ? draft : null
  }, [draftKey, start.mode, source?.id])

  const [to, setTo] = useState<string[]>(kept?.to ?? start.to)
  const [cc, setCc] = useState<string[]>(kept?.cc ?? start.cc)
  const [bcc, setBcc] = useState<string[]>(kept?.bcc ?? start.bcc)
  const [showCc, setShowCc] = useState((kept?.cc ?? start.cc).length > 0)
  const [showBcc, setShowBcc] = useState((kept?.bcc ?? []).length > 0)
  const [subject, setSubject] = useState(kept?.subject ?? start.subject)
  const [editingSubject, setEditingSubject] = useState(start.mode === 'forward' || start.mode === 'new')
  const [html, setHtml] = useState(kept?.html ?? '')
  const [sending, setSending] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkValue, setLinkValue] = useState('')
  const editorRef = useRef<ComposeEditorHandle>(null)

  // A different message or mode: start again from it.
  const startKey = `${start.mode}:${source?.id ?? ''}`
  const lastStartKey = useRef(startKey)
  useEffect(() => {
    if (lastStartKey.current === startKey) return
    lastStartKey.current = startKey
    setTo(start.to)
    setCc(start.cc)
    setShowCc(start.cc.length > 0)
    setSubject(start.subject)
    setEditingSubject(start.mode === 'forward' || start.mode === 'new')
  }, [startKey, start])

  const quoteHtml = useMemo(
    () => (start.mode === 'forward' && source ? forwardQuoteHtml(source, sanitizeEmailHtml) : null),
    [start.mode, source],
  )
  const problem = composeProblem({ to, cc, bcc, subject }, html.length, start.mode)
  const noReply = start.mode === 'reply' || start.mode === 'replyAll' ? noReplyRecipients(to) : []

  // What is written, kept as it changes: closing the tab keeps it too.
  const latest = useRef({ to, cc, bcc, subject, html })
  latest.current = { to, cc, bcc, subject, html }
  const keep = useCallback(() => {
    const now = latest.current
    const written = !editorIsEmpty(now.html) || now.subject !== start.subject || now.to.join() !== start.to.join() || now.cc.join() !== start.cc.join() || now.bcc.length > 0
    if (!written) {
      clearComposeDraft(draftKey)
      return
    }
    writeComposeDraft(draftKey, {
      mode: start.mode,
      sourceId: source?.id ?? null,
      to: now.to,
      cc: now.cc,
      bcc: now.bcc,
      subject: now.subject,
      html: now.html,
      savedAt: Date.now(),
    })
  }, [draftKey, start, source?.id])
  useEffect(() => {
    const t = setTimeout(keep, 400)
    return () => clearTimeout(t)
  }, [to, cc, bcc, subject, html, keep])

  const close = useCallback(() => {
    keep()
    onClose()
  }, [keep, onClose])

  const discard = useCallback(() => {
    clearComposeDraft(draftKey)
    ;(onDiscard ?? onClose)()
  }, [draftKey, onDiscard, onClose])

  const send = useCallback(async () => {
    if (sending) return
    const editorHtml = sanitizeComposeHtml(editorRef.current?.getHTML() ?? html)
    const now = latest.current
    const issue = composeProblem({ to: now.to, cc: now.cc, bcc: now.bcc, subject: now.subject }, editorHtml.length, start.mode)
    if (issue) {
      toast.error(issue)
      return
    }
    if (editorIsEmpty(editorHtml) && start.mode !== 'forward') {
      toast.error('Write a message first')
      editorRef.current?.focus()
      return
    }
    const body = composeSendBody({
      mode: start.mode,
      to: now.to,
      cc: now.cc,
      bcc: now.bcc,
      subject: now.subject,
      editorHtml,
      quoteHtml,
      threadId,
      inReplyTo: start.inReplyTo,
      accountId,
    })
    setSending(true)
    try {
      const res = await fetch('/api/account/email/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: unknown; message_id?: string; thread_id?: string | null }
      if (!res.ok) {
        toast.error(typeof data.error === 'string' && data.error ? data.error : 'Could not send the email')
        return
      }
      clearComposeDraft(draftKey)
      toast.success(start.mode === 'forward' ? 'Forwarded' : 'Sent')
      onSent?.(data)
    } catch {
      toast.error('Could not send the email')
    } finally {
      setSending(false)
    }
  }, [sending, html, start, quoteHtml, threadId, accountId, draftKey, onSent])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      e.stopPropagation()
      void send()
    } else if (e.key === 'Escape') {
      // Esc here closes the composer only, never the thread behind it.
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }

  const applyLink = () => {
    editorRef.current?.setLink(linkValue)
    setLinkOpen(false)
    setLinkValue('')
  }

  const toolButton = (active: boolean) =>
    cn(
      'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground',
      active && 'bg-foreground/[0.08] text-foreground',
    )
  const ModeIcon = start.mode === 'new' ? Send : MODE_ICON[start.mode]
  const replyName = source && start.mode !== 'forward' ? source.from.name || source.from.email : null

  return (
    <div
      data-email-composer={start.mode}
      onKeyDown={onKeyDown}
      className={cn(
        'ph-no-capture rounded-2xl bg-background/80 px-5 pb-4 pt-3 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.18)] ring-1 ring-border/60 backdrop-blur-sm dark:bg-white/[0.045] dark:shadow-none',
        className,
      )}
    >
      {/* Which kind, and from whom */}
      <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
        {onModeChange && start.mode !== 'new' ? (
          <Popover>
            <PopoverTrigger asChild>
              <button type="button" data-compose-mode="" className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 font-medium text-foreground/80 hover:bg-foreground/[0.06]">
                <ModeIcon className="h-3.5 w-3.5" />
                {MODE_LABEL[start.mode]}
                <ChevronDown className="h-3 w-3" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-40 p-1" align="start">
              {(['reply', 'replyAll', 'forward'] as const).map((m) => {
                const Icon = MODE_ICON[m]
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => onModeChange(m)}
                    className={cn('flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent', m === start.mode && 'font-medium')}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {MODE_LABEL[m]}
                  </button>
                )
              })}
            </PopoverContent>
          </Popover>
        ) : (
          <span className="inline-flex items-center gap-1 px-1.5 py-1 font-medium text-foreground/80">
            <ModeIcon className="h-3.5 w-3.5" />
            {MODE_LABEL[start.mode]}
          </span>
        )}
        {replyName && <span className="truncate">to {replyName}</span>}
        <span className="flex-1" />
        {fromAddress && <span className="hidden truncate sm:inline" title="Sent from this mailbox">from {fromAddress}</span>}
        <button type="button" onClick={close} aria-label="Close composer" title="Close (Esc) — keeps what you wrote" className="rounded-md p-1 hover:bg-foreground/[0.06] hover:text-foreground">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Recipients */}
      <div className="space-y-0.5 border-b border-border/50 pb-1.5 text-sm">
        <div className="flex items-start gap-2">
          <span className="w-10 shrink-0 pt-1.5 text-xs text-muted-foreground">To</span>
          <div className="min-w-0 flex-1" data-compose-to="">
            <EmailRecipientInput values={to} onChange={setTo} placeholder="Add recipients" />
          </div>
          <div className="flex shrink-0 gap-0.5 pt-0.5">
            {!showCc && (
              <button type="button" onClick={() => setShowCc(true)} className="rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground">
                Cc
              </button>
            )}
            {!showBcc && (
              <button type="button" onClick={() => setShowBcc(true)} className="rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground">
                Bcc
              </button>
            )}
          </div>
        </div>
        {showCc && (
          <div className="flex items-start gap-2">
            <span className="w-10 shrink-0 pt-1.5 text-xs text-muted-foreground">Cc</span>
            <div className="min-w-0 flex-1" data-compose-cc="">
              <EmailRecipientInput values={cc} onChange={setCc} placeholder="Add recipients" />
            </div>
          </div>
        )}
        {showBcc && (
          <div className="flex items-start gap-2">
            <span className="w-10 shrink-0 pt-1.5 text-xs text-muted-foreground">Bcc</span>
            <div className="min-w-0 flex-1" data-compose-bcc="">
              <EmailRecipientInput values={bcc} onChange={setBcc} placeholder="Add recipients" />
            </div>
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="w-10 shrink-0 text-xs text-muted-foreground">Subject</span>
          {editingSubject ? (
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              aria-label="Subject"
              placeholder="Subject"
              className="h-7 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditingSubject(true)}
              title="Change the subject"
              data-compose-subject=""
              className="h-7 min-w-0 flex-1 truncate text-left text-sm text-muted-foreground hover:text-foreground"
            >
              {subject}
            </button>
          )}
        </div>
      </div>
      {noReply.length > 0 && (
        <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-400" data-compose-noreply="">
          {noReply.join(', ')} {noReply.length === 1 ? "doesn't" : "don't"} take replies.
        </p>
      )}

      {/* The message */}
      <div className="pt-3">
        <ComposeEditor
          ref={editorRef}
          initialHtml={kept?.html ?? ''}
          autoFocus={autoFocus && start.mode !== 'forward' && start.mode !== 'new'}
          onChange={setHtml}
          placeholder={start.mode === 'forward' ? 'Add a note…' : start.mode === 'new' ? 'Write your email…' : 'Write your reply…'}
        />
      </div>

      {quoteHtml && source && (
        <details className="mt-3 rounded-xl bg-foreground/[0.03] px-3 py-2 text-xs text-muted-foreground" data-compose-forwarded="">
          <summary className="cursor-pointer select-none">Forwarded message from {source.from.name || source.from.email}</summary>
          <p className="mt-1 whitespace-pre-wrap">{(source.bodyText ?? '').slice(0, 600)}</p>
        </details>
      )}

      {/* Send, formatting, and the rest */}
      <div className="mt-3 flex flex-wrap items-center gap-1">
        <Button
          size="sm"
          className="h-8 gap-1.5 rounded-full px-3.5"
          onClick={() => void send()}
          disabled={sending || !!problem}
          title={problem ?? 'Send (⌘↵)'}
          data-compose-send=""
        >
          {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          {sending ? 'Sending…' : 'Send'}
        </Button>
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <button type="button" className={toolButton(!!editorRef.current?.isActive('bold'))} onClick={() => editorRef.current?.toggleBold()} aria-label="Bold" title="Bold (⌘B)">
          <Bold className="h-3.5 w-3.5" />
        </button>
        <button type="button" className={toolButton(!!editorRef.current?.isActive('italic'))} onClick={() => editorRef.current?.toggleItalic()} aria-label="Italic" title="Italic (⌘I)">
          <Italic className="h-3.5 w-3.5" />
        </button>
        <Popover
          open={linkOpen}
          onOpenChange={(open) => {
            setLinkOpen(open)
            if (open) setLinkValue(editorRef.current?.currentLink() ?? '')
          }}
        >
          <PopoverTrigger asChild>
            <button type="button" className={toolButton(!!editorRef.current?.isActive('link'))} aria-label="Link" title="Link">
              <Link2 className="h-3.5 w-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-2" align="start">
            <form
              className="flex items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault()
                applyLink()
              }}
            >
              <input
                autoFocus
                value={linkValue}
                onChange={(e) => setLinkValue(e.target.value)}
                placeholder="https://…"
                aria-label="Link address"
                className="h-8 min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 text-sm outline-none"
              />
              <Button type="submit" size="sm" className="h-8">
                {linkValue.trim() ? 'Link' : 'Remove'}
              </Button>
            </form>
          </PopoverContent>
        </Popover>
        <button type="button" className={toolButton(!!editorRef.current?.isActive('bulletList'))} onClick={() => editorRef.current?.toggleBulletList()} aria-label="Bulleted list" title="Bulleted list">
          <List className="h-3.5 w-3.5" />
        </button>
        <button type="button" className={toolButton(!!editorRef.current?.isActive('orderedList'))} onClick={() => editorRef.current?.toggleOrderedList()} aria-label="Numbered list" title="Numbered list">
          <ListOrdered className="h-3.5 w-3.5" />
        </button>
        <span className="flex-1" />
        <button type="button" onClick={discard} className={toolButton(false)} aria-label="Discard" title="Discard">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
