'use client'

import { useState, useCallback } from 'react'
import {
  Send,
  Loader2,
  ChevronDown,
  ChevronUp,
  Check,
  Mail,
  Pencil,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import { plainTextToHtml } from '@/lib/email/plain-text-to-html'
import { Linkify } from '@/components/ui/linkify'

interface EmailDraftData {
  to: string[]
  subject: string
  body: string
  cc?: string[]
  bcc?: string[]
  draft_id?: string
  thread_id?: string
  in_reply_to_message_id?: string
}

interface EmailDraftCardProps {
  draft: EmailDraftData
  /** Called after send succeeds */
  onSent?: () => void
}

/** The bare address in `Name <a@b.c>` or `a@b.c`. */
function bareAddress(value: string): string {
  const inBrackets = value.match(/<([^<>\s]+)>/)
  return (inBrackets ? inBrackets[1] : value).trim()
}

/** A field's comma-separated addresses, bare, blanks dropped. */
function parseAddressList(text: string): string[] {
  return text.split(',').map(bareAddress).filter(Boolean)
}

const sameAddresses = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

export function EmailDraftCard({ draft, onSent }: EmailDraftCardProps) {
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [discarded, setDiscarded] = useState(false)
  const [editing, setEditing] = useState(false)
  // Once the user has opened the editor, the edited text is what the card
  // shows and sends, even after "Done editing" closes it again.
  const [edited, setEdited] = useState(false)
  const [editBody, setEditBody] = useState(draft.body)
  const [editSubject, setEditSubject] = useState(draft.subject)
  const [editCc, setEditCc] = useState(draft.cc?.join(', ') ?? '')
  const [editBcc, setEditBcc] = useState(draft.bcc?.join(', ') ?? '')
  const [showCc, setShowCc] = useState((draft.cc?.length ?? 0) > 0)
  const [showBcc, setShowBcc] = useState((draft.bcc?.length ?? 0) > 0)
  const [expanded, setExpanded] = useState(true)

  const handleSend = useCallback(async () => {
    if (sending || sent) return
    setSending(true)
    try {
      const bodyText = edited ? editBody : draft.body
      const subjectText = edited ? editSubject : draft.subject

      let res: Response
      if (draft.draft_id && draft.thread_id) {
        // The draft sits in the mailbox it was created in, which is not always
        // the user's first one (the agent can draft from another account), so
        // it is sent the way Mail's thread view sends it: the mailbox that
        // holds its thread sends the draft itself. Sending a fresh copy through
        // the default account instead is what failed with a 404 whenever the
        // thread lives in another mailbox. Edits go along only when there are
        // some, so an untouched draft leaves as it was written.
        const cc = parseAddressList(editCc)
        const bcc = parseAddressList(editBcc)
        const changed =
          bodyText !== draft.body ||
          subjectText !== draft.subject ||
          !sameAddresses(cc, (draft.cc ?? []).map(bareAddress)) ||
          !sameAddresses(bcc, (draft.bcc ?? []).map(bareAddress))
        res = await fetch('/api/account/email/draft/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            thread_id: draft.thread_id,
            draft_id: draft.draft_id,
            ...(changed
              ? { edits: { to: draft.to.map(bareAddress), cc, bcc, subject: subjectText, body: bodyText } }
              : {}),
          }),
        })
      } else {
        // No draft at the mailbox to send (the tool did not report one): send
        // what the card shows as a new message.
        const bodyHtml = plainTextToHtml(bodyText)
        // The Cc/Bcc fields start as the draft's, so an emptied field means "none".
        const ccList = editCc.split(',').map((s) => s.trim()).filter(Boolean)
        const bccList = editBcc.split(',').map((s) => s.trim()).filter(Boolean)

        res = await fetch('/api/account/email/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: draft.to,
            cc: ccList,
            bcc: bccList,
            subject: subjectText,
            body_html: bodyHtml,
            body_text: bodyText,
            thread_id: draft.thread_id,
            in_reply_to_message_id: draft.in_reply_to_message_id,
            provider_draft_id: draft.draft_id,
          }),
        })
      }

      if (res.ok) {
        setSent(true)
        setEditing(false)
        toast.success('Email sent')
        onSent?.()
      } else {
        const data = await res.json().catch(() => ({}))
        toast.error(data.error || 'Failed to send email')
      }
    } catch {
      toast.error('Failed to send email')
    } finally {
      setSending(false)
    }
  }, [sending, sent, edited, editBody, editSubject, editCc, editBcc, draft, onSent])

  const handleDiscard = useCallback(async () => {
    if (draft.draft_id) {
      let res: Response
      try {
        res = await fetch('/api/account/email/draft/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ draft_id: draft.draft_id }),
        })
      } catch {
        res = { ok: false } as Response
      }
      if (!res.ok) {
        // Nothing was released: keep the card so the discard can be retried.
        toast.error('Couldn’t discard the draft. Try again.')
        return
      }
      const data = await res.json().catch(() => ({}))
      if (data?.mailbox_deleted === false) {
        // Released here, but the mailbox refused (or had no token): the draft is
        // still in the person's Drafts folder, where it could be sent by mistake.
        setDiscarded(true)
        toast.error('Draft discarded here, but it’s still in your mailbox’s Drafts folder.')
        return
      }
    }
    setDiscarded(true)
    toast.success('Draft discarded')
  }, [draft.draft_id])

  if (discarded) return null

  const bodyText = edited ? editBody : draft.body
  const subjectText = edited ? editSubject : draft.subject

  // `ph-no-capture`: PostHog session replay blocks the draft (recipients,
  // subject, body) and autocapture skips it. Native Intelligence never stores mail text.
  return (
    // `data-chat-panel`: the reply's line about the draft rides its foot (tailwind.css).
    <div data-chat-panel="draft" className="ph-no-capture my-2 overflow-hidden rounded-xl border border-border/60 bg-background shadow-sm">
      {/* Header */}
      <button
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-muted/30"
      >
        <Mail className="h-4 w-4 shrink-0 text-indigo-500" />
        <span className="flex-1 truncate text-sm font-medium">
          {subjectText || '(no subject)'}
        </span>
        {sent && (
          <Badge variant="secondary" className="gap-1 text-green-600">
            <Check className="h-3 w-3" />
            Sent
          </Badge>
        )}
        {expanded ? (
          <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
      </button>

      {expanded && (
        <>
          {/* Recipients */}
          <div className="space-y-1 border-t border-border/40 px-4 py-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="w-8 shrink-0 text-muted-foreground">To</span>
              <span className="flex-1 text-foreground">{draft.to.join(', ')}</span>
              {!sent && (!showCc || !showBcc) && (
                <div className="flex gap-1">
                  {!showCc && (
                    <button
                      onClick={() => setShowCc(true)}
                      className="rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      Cc
                    </button>
                  )}
                  {!showBcc && (
                    <button
                      onClick={() => setShowBcc(true)}
                      className="rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      Bcc
                    </button>
                  )}
                </div>
              )}
            </div>
            {showCc && (
              <div className="flex items-center gap-2">
                <span className="w-8 shrink-0 text-muted-foreground">Cc</span>
                {!sent ? (
                  <input
                    value={editCc}
                    onChange={(e) => setEditCc(e.target.value)}
                    placeholder="Add recipients, comma-separated"
                    className="flex-1 rounded border border-border/40 bg-transparent px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                    autoFocus
                  />
                ) : (
                  <span className="text-foreground">{editCc || draft.cc?.join(', ')}</span>
                )}
              </div>
            )}
            {showBcc && (
              <div className="flex items-center gap-2">
                <span className="w-8 shrink-0 text-muted-foreground">Bcc</span>
                {!sent ? (
                  <input
                    value={editBcc}
                    onChange={(e) => setEditBcc(e.target.value)}
                    placeholder="Add recipients, comma-separated"
                    className="flex-1 rounded border border-border/40 bg-transparent px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                ) : (
                  <span className="text-foreground">{editBcc || draft.bcc?.join(', ')}</span>
                )}
              </div>
            )}
            {editing && (
              <div className="flex items-center gap-2">
                <span className="w-8 shrink-0 text-muted-foreground">Subj</span>
                <input
                  value={editSubject}
                  onChange={(e) => setEditSubject(e.target.value)}
                  className="flex-1 rounded border border-border/40 bg-transparent px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
            )}
          </div>

          {/* Body */}
          <div className="border-t border-border/40 px-4 py-3">
            {editing ? (
              <Textarea
                value={editBody}
                onChange={(e) => setEditBody(e.target.value)}
                className="min-h-[100px] resize-none border-0 p-0 text-sm shadow-none focus-visible:ring-0"
                autoFocus
              />
            ) : (
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
                <Linkify text={bodyText} />
              </p>
            )}
          </div>

          {/* Actions */}
          {!sent && (
            <div className="flex items-center gap-2 border-t border-border/40 px-4 py-2.5">
              <Button
                size="sm"
                onClick={handleSend}
                disabled={sending || draft.to.length === 0}
                className="gap-1.5"
              >
                {sending ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Sending...
                  </>
                ) : (
                  <>
                    <Send className="h-3.5 w-3.5" />
                    Send
                  </>
                )}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditing((e) => !e)
                  setEdited(true)
                }}
                className="gap-1.5 text-muted-foreground"
              >
                <Pencil className="h-3.5 w-3.5" />
                {editing ? 'Done editing' : 'Edit'}
              </Button>
              <div className="flex-1" />
              <Button
                variant="ghost"
                size="sm"
                onClick={handleDiscard}
                className="gap-1.5 text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/**
 * Try to extract email draft data from a create_email_draft tool result.
 * Returns null if the data doesn't match the expected shape.
 */
export function extractDraftFromToolResult(
  args?: Record<string, unknown>,
  result?: unknown,
): EmailDraftData | null {
  if (!args) return null

  const to = args.to
  if (!Array.isArray(to) || to.length === 0) return null

  const resultObj = result as Record<string, unknown> | undefined
  const draftId =
    resultObj && typeof resultObj.draft_id === 'string'
      ? resultObj.draft_id
      : undefined
  // The tool reports the draft's own thread (a new email has one too) and its
  // subject as it was filed ("Re:" added for a reply); the model's input is
  // only what it asked for.
  const threadId =
    resultObj && typeof resultObj.thread_id === 'string'
      ? resultObj.thread_id
      : typeof args.thread_id === 'string'
        ? args.thread_id
        : undefined
  const subject =
    resultObj && typeof resultObj.subject === 'string'
      ? resultObj.subject
      : typeof args.subject === 'string'
        ? args.subject
        : ''

  return {
    to: to as string[],
    subject,
    body: typeof args.body === 'string' ? args.body : '',
    cc: Array.isArray(args.cc) ? (args.cc as string[]) : undefined,
    bcc: Array.isArray(args.bcc) ? (args.bcc as string[]) : undefined,
    draft_id: draftId,
    thread_id: threadId,
    in_reply_to_message_id:
      typeof args.in_reply_to === 'string'
        ? args.in_reply_to
        : typeof args.in_reply_to_message_id === 'string'
          ? args.in_reply_to_message_id
          : undefined,
  }
}
