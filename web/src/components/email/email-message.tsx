'use client'

import { useState } from 'react'
import { ChevronDown, Loader2, Paperclip, Pencil, Reply, Send, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import type { DraftEdits } from '@/lib/email/draft-edits'
import { DraftEditor, draftFormattingLost, draftTextOf } from './draft-editor'
import { EmailContent } from './email-content'
import { Linkify } from '@/components/ui/linkify'

interface EmailAddress {
  name: string | null
  email: string
}

interface EmailAttachment {
  name: string
  size: number
  mimeType: string
}

interface EmailMessageData {
  id: string
  threadId: string
  from: EmailAddress
  to: EmailAddress[]
  cc: EmailAddress[]
  subject: string
  date: string
  bodyHtml: string | null
  bodyText: string | null
  isUnread: boolean
  isStarred: boolean
  /** An unsent draft (an agent's reply awaiting review, or one the user saved). */
  isDraft?: boolean
  /** A held reply draft the person edited before a new message arrived on the thread (src/lib/email/hold.ts). */
  draftStale?: boolean
  hasAttachments: boolean
  attachments: EmailAttachment[]
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24))

  if (diffDays === 0) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  }
  return date.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: diffDays > 365 ? 'numeric' : undefined,
    hour: 'numeric', minute: '2-digit',
  })
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

interface EmailMessageProps {
  message: EmailMessageData
  defaultExpanded: boolean
  onReply?: () => void
  /** Sends this draft (draft messages only): as shown, or with the edits made in its editor. */
  onSend?: (edits?: DraftEdits) => void
  /** This draft's send is in flight. */
  sending?: boolean
  /** Discards this draft (draft messages only), once the user confirms: it is deleted from the mailbox. */
  onDiscard?: () => void
  /** This draft's discard is in flight. */
  discarding?: boolean
}

export function EmailMessage({
  message,
  defaultExpanded,
  onReply,
  onSend,
  sending = false,
  onDiscard,
  discarding = false,
}: EmailMessageProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [editing, setEditing] = useState(false)
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  // One thing at a time on a draft: a send or a discard in flight holds the other.
  const busy = sending || discarding
  const displayName = message.from.name || message.from.email
  // An edited draft is sent as a new plain-text message, so one carrying
  // files is sent only as it is.
  const editable = !!message.isDraft && !!onSend && !message.hasAttachments

  return (
    <div
      className={cn(
        'rounded-lg border',
        expanded ? 'bg-background' : 'bg-muted/30',
      )}
    >
      {/* Header (stays open while the draft is being edited, so no edit is lost) */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer"
        onClick={() => {
          if (!editing) setExpanded(!expanded)
        }}
      >
        <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center shrink-0 text-xs font-medium">
          {getInitials(displayName)}
        </div>

        <div className="flex-1 min-w-0">
          {/* select-text: sender name/address are things users copy out of a
              mail client — keep them selectable under [data-desktop]. */}
          <div className="select-text flex items-center gap-2">
            <span className="text-sm font-medium">{displayName}</span>
            <span className="text-xs text-muted-foreground">
              {'<'}
              {message.from.email}
              {'>'}
            </span>
            {message.isDraft && (
              <span className="shrink-0 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                Draft
              </span>
            )}
            {message.isDraft && message.draftStale && (
              <span className="shrink-0 rounded-full bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:text-sky-400">
                New reply since this draft
              </span>
            )}
          </div>
          {!expanded && (
            <p className="text-xs text-muted-foreground truncate mt-0.5">
              {message.bodyText?.substring(0, 100) || 'No preview'}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-muted-foreground">
            {formatDate(message.date)}
          </span>
          {message.hasAttachments && (
            <Paperclip className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          {onReply && (
            <button
              onClick={(e) => { e.stopPropagation(); onReply() }}
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="Reply with AI"
            >
              <Reply className="h-3.5 w-3.5" />
            </button>
          )}
          <ChevronDown
            className={cn(
              'h-4 w-4 text-muted-foreground transition-transform',
              expanded && 'rotate-180',
            )}
          />
        </div>
      </div>

      {onDiscard && (
        <ConfirmDialog
          open={confirmingDiscard}
          onOpenChange={setConfirmingDiscard}
          title="Discard this draft?"
          description="It's deleted from your mailbox and can't be sent."
          confirmLabel="Discard"
          onConfirm={() => {
            setConfirmingDiscard(false)
            onDiscard()
          }}
        />
      )}

      {/* The draft, being edited */}
      {expanded && editing && onSend && (
        <div className="px-4 pb-4">
          {draftFormattingLost(message.bodyHtml) && (
            <p className="mb-2 text-xs text-muted-foreground">Sent as plain text: this draft&apos;s formatting isn&apos;t kept.</p>
          )}
          <DraftEditor
            initial={{
              to: message.to.map((r) => r.email),
              cc: message.cc.map((r) => r.email),
              subject: message.subject,
              body: draftTextOf(message.bodyText, message.bodyHtml),
            }}
            sending={sending}
            onSend={(edits) => onSend(edits)}
            onCancel={() => setEditing(false)}
          />
        </div>
      )}

      {/* Body */}
      {expanded && !(editing && onSend) && (
        <div className="px-4 pb-4">
          <div className="select-text text-xs text-muted-foreground mb-3">
            <span>
              To: {message.to.map((r) => r.name || r.email).join(', ')}
            </span>
            {message.cc.length > 0 && (
              <span className="ml-3">
                CC: {message.cc.map((r) => r.name || r.email).join(', ')}
              </span>
            )}
          </div>

          <div className="email-body">
            {message.bodyHtml ? (
              <EmailContent
                html={message.bodyHtml}
                senderEmail={message.from.email}
              />
            ) : (
              <pre className="whitespace-pre-wrap text-sm font-sans text-foreground">
                <Linkify text={message.bodyText} />
              </pre>
            )}
          </div>

          {message.attachments && message.attachments.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {message.attachments.map((att, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 text-xs border rounded-md px-2 py-1.5 bg-muted/30"
                >
                  <Paperclip className="h-3 w-3" />
                  <span className="truncate max-w-[200px]">{att.name}</span>
                  <span className="text-muted-foreground">
                    {formatFileSize(att.size)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {message.isDraft && onSend && (
            <div className="mt-4 flex items-center gap-2 border-t border-border/40 pt-3">
              <Button size="sm" className="gap-1.5" onClick={() => onSend()} disabled={busy}>
                {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                {sending ? 'Sending…' : 'Send'}
              </Button>
              {editable && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 text-muted-foreground"
                  onClick={() => setEditing(true)}
                  disabled={busy}
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Edit
                </Button>
              )}
              {onDiscard && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto gap-1.5 text-muted-foreground hover:text-destructive"
                  onClick={() => setConfirmingDiscard(true)}
                  disabled={busy}
                >
                  {discarding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  {discarding ? 'Discarding…' : 'Discard'}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export type { EmailMessageData }
