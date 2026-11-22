'use client'

/**
 * Mail's composer: Reply, Reply all, Forward and New email, written by the
 * person, in the thread (under its last message) or on its own. To, Cc and
 * Bcc are theirs to change; the message is rich text (compose-editor.tsx);
 * the subject and the threading come from what is replied to
 * (src/lib/email/compose.ts).
 *
 *  - Send goes through POST /api/account/email/send (sendEmail), from the
 *    thread's own mailbox, after a few seconds of "Sending… Undo"
 *    (src/lib/email/undo-send.ts): Undo brings it back here, and nothing left.
 *  - Send later schedules it (POST /api/account/email/scheduled: saved as a
 *    draft in the mailbox, threaded for a reply, sent at the time).
 *  - Save draft puts it in the mailbox as a draft (POST save-draft, threaded
 *    for a reply), where the thread shows it with its own Send and Edit.
 *  - Files go with it (3 MB each, 6 MB in all: compose-attachments.ts).
 *  - Draft with AI fills it from the thread's AI draft when there is one (the
 *    person reviews it and sends it; that draft is replaced), or asks the chat
 *    to write one (lib/email/reply-in-chat.ts), which fills it in when it lands.
 *
 * Keys: ⌘/Ctrl+Enter sends; Esc closes it, keeping what is written (for this
 * person in this browser, src/lib/email/compose-drafts.ts) for next time.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  Bold,
  ChevronDown,
  FileText,
  Forward,
  Italic,
  Link2,
  List,
  ListOrdered,
  Loader2,
  Paperclip,
  Reply,
  ReplyAll,
  Send,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  composeDraftBody,
  composeProblem,
  composeScheduleBody,
  composeSendBody,
  composeStart,
  editorIsEmpty,
  forwardQuoteHtml,
  noReplyRecipients,
  type ComposeMode,
  type ComposeSendInput,
  type ComposeSource,
} from '@/lib/email/compose'
import { attachmentsProblem, base64Bytes, type ComposeAttachmentWire } from '@/lib/email/compose-attachments'
import { clearComposeDraft, readComposeDraft, writeComposeDraft } from '@/lib/email/compose-drafts'
import { plainTextToHtml } from '@/lib/email/plain-text-to-html'
import { scheduleSend } from '@/lib/email/send-later'
import { queueSend, UNDO_SEND_MS } from '@/lib/email/undo-send'
import { EmailRecipientInput } from './email-recipient-input'
import { ComposeEditor, sanitizeComposeHtml, type ComposeEditorHandle } from './compose-editor'
import { sanitizeEmailHtml } from './email-sanitize'
import { SendLaterButton } from './send-later-button'
import { formatFileSize } from './email-attachments'

/** An AI-written draft on the thread, as the thread view has it. */
export interface ComposeAiDraft {
  /** Its mailbox message id (what the send replaces). */
  id: string
  to: ReadonlyArray<{ email: string }>
  cc: ReadonlyArray<{ email: string }>
  subject: string
  bodyHtml: string | null
  bodyText: string | null
}

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
  /** New email: the mailboxes it can go from (a picker when there are two or more). */
  fromOptions?: ReadonlyArray<{ id: string; email: string }>
  onFromChange?: (accountId: string) => void
  /** The person's own addresses, lowercase: never replied to, shown as Me. */
  ownAddresses: ReadonlySet<string>
  /** Where what is written is kept when the composer closes (compose-drafts.ts). */
  draftKey: string
  /** Reply ↔ Reply all ↔ Forward, from the composer's own switch. */
  onModeChange?: (mode: Exclude<ComposeMode, 'new'>) => void
  /** The thread's AI draft, when it has one: Draft with AI fills the composer from it. */
  aiDraft?: ComposeAiDraft | null
  /** Ask the chat to draft it (none: Draft with AI only uses a draft that exists). */
  onRequestAiDraft?: () => void
  /** Send was pressed: the composer can close (it goes once the Undo time is up). */
  onSent?: () => void
  /** It went: the mailbox has it. */
  onDelivered?: (result: { message_id?: string; thread_id?: string | null }) => void
  /** Undo (or a failed send): open the composer again; what was written is there. */
  onReopen?: () => void
  /** Saved as a draft in the mailbox, or scheduled. */
  onSavedToMailbox?: () => void
  /** Closed without sending (what is written is kept). */
  onClose: () => void
  /** Thrown away (what is written is cleared). */
  onDiscard?: () => void
  /** How long Undo is offered (tests: 0). */
  undoMs?: number
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

/** A file as the browser gives it, read to base64. */
function readFile(file: File): Promise<ComposeAttachmentWire> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.onload = () => {
      const url = String(reader.result ?? '')
      resolve({
        name: file.name || 'attachment',
        mime_type: file.type || 'application/octet-stream',
        content_base64: url.slice(url.indexOf(',') + 1),
      })
    }
    reader.readAsDataURL(file)
  })
}

/** An AI draft's words as the editor takes them. */
function aiDraftHtml(draft: ComposeAiDraft): string {
  if (draft.bodyHtml) return sanitizeComposeHtml(draft.bodyHtml)
  return plainTextToHtml(draft.bodyText ?? '')
    .replace(/^<div[^>]*>/, '')
    .replace(/<\/div>$/, '')
    .replace(/<div>/g, '<p>')
    .replace(/<\/div>/g, '</p>')
}

export function EmailComposer({
  mode,
  source,
  threadId = null,
  accountId = null,
  fromAddress = null,
  fromOptions,
  onFromChange,
  ownAddresses,
  draftKey,
  onModeChange,
  aiDraft = null,
  onRequestAiDraft,
  onSent,
  onDelivered,
  onReopen,
  onSavedToMailbox,
  onClose,
  onDiscard,
  undoMs = UNDO_SEND_MS,
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
  const [files, setFiles] = useState<ComposeAttachmentWire[]>(kept?.files ?? [])
  const [replacesDraftId, setReplacesDraftId] = useState<string | null>(kept?.replacesDraftId ?? null)
  // Waiting for the chat's draft (Draft with AI with none on the thread yet).
  const [aiWaitingSince, setAiWaitingSince] = useState<string | null>(null)
  const [busy, setBusy] = useState<null | 'saving' | 'scheduling'>(null)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkValue, setLinkValue] = useState('')
  const editorRef = useRef<ComposeEditorHandle>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const quoteHtml = useMemo(
    () => (start.mode === 'forward' && source ? forwardQuoteHtml(source, sanitizeEmailHtml) : null),
    [start.mode, source],
  )
  const fileSizes = files.map((f) => ({ name: f.name, size: base64Bytes(f.content_base64) }))
  const filesIssue = attachmentsProblem(fileSizes)
  const problem = composeProblem({ to, cc, bcc, subject }, html.length, start.mode) ?? filesIssue
  const noReply = start.mode === 'reply' || start.mode === 'replyAll' ? noReplyRecipients(to) : []

  // What is written, kept as it changes: closing the tab keeps it too.
  const latest = useRef({ to, cc, bcc, subject, html, files, replacesDraftId })
  latest.current = { to, cc, bcc, subject, html, files, replacesDraftId }
  const keep = useCallback(
    (editorHtml?: string) => {
      const now = { ...latest.current, html: editorHtml ?? latest.current.html }
      const written =
        !editorIsEmpty(now.html) ||
        now.subject !== start.subject ||
        now.to.join() !== start.to.join() ||
        now.cc.join() !== start.cc.join() ||
        now.bcc.length > 0 ||
        now.files.length > 0
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
        replacesDraftId: now.replacesDraftId,
        files: now.files,
      })
    },
    [draftKey, start, source?.id],
  )
  useEffect(() => {
    const t = setTimeout(() => keep(), 400)
    return () => clearTimeout(t)
  }, [to, cc, bcc, subject, html, files, replacesDraftId, keep])

  const close = useCallback(() => {
    keep(editorRef.current?.getHTML())
    onClose()
  }, [keep, onClose])

  const discard = useCallback(() => {
    clearComposeDraft(draftKey)
    ;(onDiscard ?? onClose)()
  }, [draftKey, onDiscard, onClose])

  /** What the composer holds, checked; null (and said why) when it can't go. */
  const ready = useCallback(
    (requireBody: boolean): ComposeSendInput | null => {
      const editorHtml = sanitizeComposeHtml(editorRef.current?.getHTML() ?? latest.current.html)
      const now = latest.current
      const issue =
        composeProblem({ to: now.to, cc: now.cc, bcc: now.bcc, subject: now.subject }, editorHtml.length, start.mode) ??
        attachmentsProblem(now.files.map((f) => ({ name: f.name, size: base64Bytes(f.content_base64) })))
      if (issue) {
        toast.error(issue)
        return null
      }
      if (requireBody && editorIsEmpty(editorHtml) && start.mode !== 'forward' && now.files.length === 0) {
        toast.error('Write a message first')
        editorRef.current?.focus()
        return null
      }
      return {
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
        replacesDraftId: now.replacesDraftId,
        attachments: now.files,
      }
    },
    [start, quoteHtml, threadId, accountId],
  )

  const send = useCallback(() => {
    const input = ready(true)
    if (!input) return
    const body = composeSendBody(input)
    // Kept until it has gone: Undo, or a failed send, opens it again as it was.
    keep(input.editorHtml)
    const label = start.mode === 'forward' ? 'Forwarded' : 'Sent'
    const go = async () => {
      try {
        const res = await fetch('/api/account/email/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const data = (await res.json().catch(() => ({}))) as { error?: unknown; message_id?: string; thread_id?: string | null }
        if (!res.ok) throw new Error(typeof data.error === 'string' && data.error ? data.error : 'Could not send the email')
        clearComposeDraft(draftKey)
        toast.success(label)
        onDelivered?.(data)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not send the email', {
          ...(onReopen ? { action: { label: 'Open', onClick: onReopen } } : {}),
        })
      }
    }
    if (undoMs <= 0) {
      onSent?.()
      void go()
      return
    }
    const queued = queueSend(go, undoMs)
    toast('Sending…', {
      duration: undoMs,
      action: {
        label: 'Undo',
        onClick: () => {
          if (queued.undo()) onReopen?.()
        },
      },
    })
    onSent?.()
  }, [ready, keep, start.mode, draftKey, onDelivered, onReopen, onSent, undoMs])

  const saveDraft = useCallback(async () => {
    if (busy) return
    const input = ready(false)
    if (!input) return
    if (input.to.length === 0) {
      toast.error('Add a To recipient to save a draft')
      return
    }
    setBusy('saving')
    try {
      const res = await fetch('/api/account/email/save-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(composeDraftBody(input)),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: unknown }
      if (!res.ok) {
        toast.error(typeof data.error === 'string' && data.error ? data.error : 'Could not save the draft')
        return
      }
      // The AI draft it was filled from is superseded by this one.
      if (input.replacesDraftId && threadId) {
        void fetch('/api/account/email/draft/discard', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ thread_id: threadId, draft_id: input.replacesDraftId }),
        }).catch(() => {})
      }
      clearComposeDraft(draftKey)
      toast.success('Draft saved')
      onSavedToMailbox?.()
    } catch {
      toast.error('Could not save the draft')
    } finally {
      setBusy(null)
    }
  }, [busy, ready, threadId, draftKey, onSavedToMailbox])

  const scheduleAt = useCallback(
    async (at: Date) => {
      const input = ready(true)
      if (!input) return
      const body = composeScheduleBody(input)
      if (!body) {
        toast.error('Pick the mailbox to send from')
        return
      }
      setBusy('scheduling')
      try {
        const row = await scheduleSend(body as Parameters<typeof scheduleSend>[0], at)
        if (!row) return
        clearComposeDraft(draftKey)
        onSavedToMailbox?.()
      } finally {
        setBusy(null)
      }
    },
    [ready, draftKey, onSavedToMailbox],
  )

  // Draft with AI: the thread's AI draft into the composer.
  const fillFromAi = useCallback(
    (draft: ComposeAiDraft) => {
      const toList = draft.to.map((r) => r.email.toLowerCase()).filter(Boolean)
      const ccList = draft.cc.map((r) => r.email.toLowerCase()).filter(Boolean)
      if (toList.length) setTo(toList)
      if (ccList.length) {
        setCc(ccList)
        setShowCc(true)
      }
      if (draft.subject.trim()) setSubject(draft.subject)
      const words = aiDraftHtml(draft)
      editorRef.current?.setHTML(words)
      setHtml(words)
      setReplacesDraftId(draft.id)
      setAiWaitingSince(null)
      editorRef.current?.focus()
    },
    [],
  )
  const draftWithAi = () => {
    if (aiDraft && aiDraft.id !== replacesDraftId) {
      fillFromAi(aiDraft)
      return
    }
    if (!onRequestAiDraft) return
    setAiWaitingSince(aiDraft?.id ?? '')
    onRequestAiDraft()
  }
  // The chat's draft landed on the thread: in it goes, if nothing is written yet.
  useEffect(() => {
    if (aiWaitingSince === null || !aiDraft || aiDraft.id === aiWaitingSince) return
    if (editorIsEmpty(editorRef.current?.getHTML() ?? latest.current.html)) fillFromAi(aiDraft)
    else {
      setAiWaitingSince(null)
      toast('The AI draft is ready', { action: { label: 'Use it', onClick: () => fillFromAi(aiDraft) } })
    }
  }, [aiDraft, aiWaitingSince, fillFromAi])

  const addFiles = async (list: FileList | null) => {
    if (!list?.length) return
    const picked = [...list]
    const next = [...latest.current.files.map((f) => ({ name: f.name, size: base64Bytes(f.content_base64) })), ...picked.map((f) => ({ name: f.name, size: f.size }))]
    const issue = attachmentsProblem(next)
    if (issue) {
      toast.error(issue)
      return
    }
    try {
      const read = await Promise.all(picked.map(readFile))
      setFiles((prev) => [...prev, ...read])
    } catch {
      toast.error('Could not read that file')
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      e.stopPropagation()
      send()
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
      'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-40',
      active && 'bg-foreground/[0.08] text-foreground',
    )
  const ModeIcon = start.mode === 'new' ? Send : MODE_ICON[start.mode]
  const replyName = source && start.mode !== 'forward' ? source.from.name || source.from.email : null
  const canAi = !!aiDraft || !!onRequestAiDraft
  const aiWaiting = aiWaitingSince !== null

  return (
    <div
      data-email-composer={start.mode}
      onKeyDown={onKeyDown}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        void addFiles(e.dataTransfer.files)
      }}
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
                    onClick={() => {
                      keep(editorRef.current?.getHTML())
                      onModeChange(m)
                    }}
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
        {fromOptions && fromOptions.length > 1 && onFromChange ? (
          <label className="flex min-w-0 items-center gap-1">
            <span>from</span>
            <select
              aria-label="From"
              data-compose-from=""
              value={accountId ?? ''}
              onChange={(e) => onFromChange(e.target.value)}
              className="max-w-[200px] truncate rounded-md bg-transparent py-0.5 text-xs text-foreground/80 outline-none hover:bg-foreground/[0.06]"
            >
              {fromOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.email}
                </option>
              ))}
            </select>
          </label>
        ) : (
          fromAddress && (
            <span className="hidden truncate sm:inline" title="Sent from this mailbox">
              from {fromAddress}
            </span>
          )
        )}
        <button type="button" onClick={close} aria-label="Close composer" title="Close (Esc) — keeps what you wrote" className="rounded-md p-1 hover:bg-foreground/[0.06] hover:text-foreground">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Recipients */}
      <div className="space-y-0.5 border-b border-border/50 pb-1.5 text-sm">
        <div className="flex items-start gap-2">
          <span className="w-12 shrink-0 pt-1.5 text-xs text-muted-foreground">To</span>
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
            <span className="w-12 shrink-0 pt-1.5 text-xs text-muted-foreground">Cc</span>
            <div className="min-w-0 flex-1" data-compose-cc="">
              <EmailRecipientInput values={cc} onChange={setCc} placeholder="Add recipients" />
            </div>
          </div>
        )}
        {showBcc && (
          <div className="flex items-start gap-2">
            <span className="w-12 shrink-0 pt-1.5 text-xs text-muted-foreground">Bcc</span>
            <div className="min-w-0 flex-1" data-compose-bcc="">
              <EmailRecipientInput values={bcc} onChange={setBcc} placeholder="Add recipients" />
            </div>
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-xs text-muted-foreground">Subject</span>
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
      {replacesDraftId && (
        <p className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground" data-compose-from-ai="">
          <Sparkles className="h-3 w-3 text-violet-500" aria-hidden />
          Written from the AI draft. Read it over; sending replaces that draft.
        </p>
      )}
      {aiWaiting && (
        <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground" data-compose-ai-waiting="">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          Drafting in chat… it fills in here when it’s ready.
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

      {files.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2" data-compose-files="">
          {files.map((f, i) => (
            <span key={`${f.name}-${i}`} data-compose-file={f.name} className="inline-flex max-w-[260px] items-center gap-1.5 rounded-lg bg-foreground/[0.04] py-1 pl-2 pr-1 text-xs">
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate font-medium">{f.name}</span>
              <span className="shrink-0 text-muted-foreground">{formatFileSize(base64Bytes(f.content_base64))}</span>
              <button
                type="button"
                aria-label={`Remove ${f.name}`}
                onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                className="rounded p-0.5 text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          {filesIssue && <span className="self-center text-xs text-destructive">{filesIssue}</span>}
        </div>
      )}

      {/* Send, formatting, and the rest */}
      <div className="mt-3 flex flex-wrap items-center gap-1">
        <Button
          size="sm"
          className="h-8 gap-1.5 rounded-full px-3.5"
          onClick={send}
          disabled={!!busy || !!problem}
          title={problem ?? 'Send (⌘↵)'}
          data-compose-send=""
        >
          <Send className="h-3.5 w-3.5" />
          Send
        </Button>
        {/* Scheduling names the mailbox it goes from: none known, none offered. */}
        <SendLaterButton disabled={!!busy || !!problem || !accountId} onSchedule={scheduleAt} className="h-8" />
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
        <button type="button" className={toolButton(false)} onClick={() => fileInputRef.current?.click()} aria-label="Attach files" title="Attach files (3 MB each, 6 MB in all)" data-compose-attach="">
          <Paperclip className="h-3.5 w-3.5" />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          data-compose-file-input=""
          onChange={(e) => {
            void addFiles(e.target.files)
            e.target.value = ''
          }}
        />
        {canAi && start.mode !== 'forward' && (
          <button
            type="button"
            onClick={draftWithAi}
            disabled={aiWaiting}
            data-compose-ai=""
            title={aiDraft ? 'Fill this in from the AI draft on this thread' : 'Ask the assistant to draft it; you review and send'}
            className="ml-1 inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-medium text-violet-700 transition-colors hover:bg-violet-500/10 disabled:opacity-50 dark:text-violet-300"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {aiDraft && aiDraft.id !== replacesDraftId ? 'Use AI draft' : 'Draft with AI'}
          </button>
        )}
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={() => void saveDraft()}
          disabled={!!busy}
          data-compose-save=""
          title="Save it as a draft in your mailbox"
        >
          {busy === 'saving' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save draft'}
        </Button>
        <button type="button" onClick={discard} className={toolButton(false)} aria-label="Discard" title="Discard">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
