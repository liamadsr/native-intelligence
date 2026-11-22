'use client'

import { useState } from 'react'
import { Forward, Loader2, Paperclip, Pencil, Reply, ReplyAll, Send, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import type { DraftEdits } from '@/lib/email/draft-edits'
import { DraftEditor, draftFormattingLost, draftTextOf } from './draft-editor'
import { SendLaterButton } from './send-later-button'
import { scheduledForLabel } from '@/lib/email/send-later'
import { EmailContent } from './email-content'
import { Linkify } from '@/components/ui/linkify'
import { EmailAttachments } from './email-attachments'
import { EmailInviteCard } from './email-invite-card'
import { EmailAttachedInvite } from './email-attached-invite'
import type { CalendarInvite } from '@/lib/email/calendar-invite'

interface EmailAddress {
  name: string | null
  email: string
}

interface EmailAttachment {
  name: string
  size: number
  mimeType: string
  /** A shared message's attachment key (migration 646): it downloads through the share. */
  key?: string
}

interface EmailMessageData {
  id: string
  threadId: string
  from: EmailAddress
  to: EmailAddress[]
  cc: EmailAddress[]
  /** Its Reply-To, when it names one: a reply goes there. */
  replyTo?: EmailAddress[]
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
  /** The calendar invitation the message carries, when it has one (drawn as a card above the body). */
  invite?: CalendarInvite
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

/**
 * A message's date as the card shows it: the time today, "Sep 9" this year,
 * "Sep 9, 2024" before. The full date and time is its title.
 */
export function formatMessageDate(dateStr: string, now: Date = new Date()): string {
  const date = new Date(dateStr)
  if (Number.isNaN(date.getTime())) return ''
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  }
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  })
}

function fullDate(dateStr: string): string {
  const date = new Date(dateStr)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/**
 * Who a message went to, as the card's muted "to …" reads: "Me" for the
 * person's own addresses, a first name (else the address's local part) for
 * anyone else, the first two then "+N". Empty: no recipients. Pure.
 */
export function recipientsLabel(
  to: readonly EmailAddress[],
  cc: readonly EmailAddress[],
  own: ReadonlySet<string> | undefined,
): string {
  const seen = new Set<string>()
  const names: string[] = []
  for (const r of [...to, ...cc]) {
    const email = r.email?.trim().toLowerCase()
    if (!email || seen.has(email)) continue
    seen.add(email)
    names.push(own?.has(email) ? 'Me' : r.name?.trim().split(/\s+/)[0] || email.split('@')[0])
  }
  // "Me" first: it is what the reader looks for.
  names.sort((a, b) => (a === 'Me' ? -1 : b === 'Me' ? 1 : 0))
  if (names.length <= 2) return names.join(', ')
  return `${names.slice(0, 2).join(', ')} +${names.length - 2}`
}

/** One line of a message, for its collapsed card. */
export function messageSnippet(message: Pick<EmailMessageData, 'bodyText' | 'bodyHtml'>): string {
  const text = message.bodyText?.trim()
    ? message.bodyText
    : (message.bodyHtml ?? '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
  // Not the quoted history: the snippet is what this message says.
  const own = (text ?? '').split(/\n(?:>|On .{4,200}wrote:)/)[0]
  return own.replace(/\s+/g, ' ').trim().slice(0, 160)
}

interface EmailMessageProps {
  message: EmailMessageData
  defaultExpanded: boolean
  /** Opens the composer replying to this message (absent: no Reply on the card). */
  onReply?: () => void
  /** Opens the composer replying to everyone on this message. */
  onReplyAll?: () => void
  /** Opens the composer forwarding this message. */
  onForward?: () => void
  /** Sends this draft (draft messages only): as shown, or with the edits made in its editor. */
  onSend?: (edits?: DraftEdits) => void
  /** This draft's send is in flight. */
  sending?: boolean
  /**
   * Send later (draft messages only): as shown, or with its editor's edits, at
   * the time picked. Resolves true once scheduled (the editor then closes).
   */
  onSendLater?: (at: Date, edits?: DraftEdits) => Promise<boolean>
  /** This draft waits to be sent at this time (send later): shown as a badge. */
  scheduledAt?: string | null
  /** Discards this draft (draft messages only), once the user confirms: it is deleted from the mailbox. */
  onDiscard?: () => void
  /** This draft's discard is in flight. */
  discarding?: boolean
  /** Where an attachment downloads from (a shared thread's, through its share); none: listed only. */
  attachmentHref?: (attachment: EmailAttachment) => string | null
  /** Where an attached calendar file is read as an invitation (the person's own mailbox only); none: it stays a chip. */
  inviteHref?: (attachment: EmailAttachment) => string | null
  /** The person's own addresses (lowercase): which guest of an invitation they are. */
  ownAddresses?: ReadonlySet<string>
}

export function EmailMessage({
  message,
  defaultExpanded,
  onReply,
  onReplyAll,
  onForward,
  onSend,
  sending = false,
  onSendLater,
  scheduledAt = null,
  onDiscard,
  discarding = false,
  attachmentHref,
  inviteHref,
  ownAddresses,
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

  const toLabel = recipientsLabel(message.to, message.cc, ownAddresses)
  const date = formatMessageDate(message.date)
  const iconButton = 'rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground'

  // Collapsed: one calm line (who, what it says, when); a click opens it.
  if (!expanded) {
    return (
      <button
        type="button"
        data-email-message-collapsed=""
        onClick={() => setExpanded(true)}
        className="group flex w-full items-center gap-3 rounded-2xl bg-foreground/[0.025] px-4 py-2.5 text-left transition-colors hover:bg-foreground/[0.05] dark:bg-white/[0.035] dark:hover:bg-white/[0.06]"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-foreground/[0.07] text-[11px] font-medium text-foreground/80">
          {getInitials(displayName)}
        </span>
        <span className="shrink-0 text-sm font-medium">{displayName}</span>
        {message.isDraft && <DraftBadge />}
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{messageSnippet(message) || 'No preview'}</span>
        {message.hasAttachments && <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Has attachments" />}
        <span className="shrink-0 text-xs text-muted-foreground" title={fullDate(message.date)}>{date}</span>
      </button>
    )
  }

  return (
    <div
      data-email-message-card=""
      className="rounded-2xl bg-foreground/[0.025] px-5 pb-5 pt-4 dark:bg-white/[0.035]"
    >
      {/* Header (stays open while the draft is being edited, so no edit is lost) */}
      <div
        className="flex cursor-pointer items-center gap-3"
        onClick={() => {
          if (!editing) setExpanded(false)
        }}
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-foreground/[0.07] text-xs font-medium text-foreground/80">
          {getInitials(displayName)}
        </div>

        {/* select-text: sender name/address are things users copy out of a
            mail client — keep them selectable under [data-desktop]. */}
        <div className="min-w-0 flex-1 select-text">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
            <span className="truncate text-sm font-semibold" title={message.from.email}>{displayName}</span>
            {message.from.name && message.from.name !== message.from.email && (
              <span className="hidden truncate text-xs text-muted-foreground/70 sm:inline">{message.from.email}</span>
            )}
            {message.isDraft && <DraftBadge />}
            {message.isDraft && scheduledAt && (
              <span data-scheduled-badge="" className="shrink-0 rounded-full bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:text-violet-300">
                Scheduled · {scheduledForLabel(new Date(scheduledAt), new Date())}
              </span>
            )}
            {message.isDraft && message.draftStale && (
              <span className="shrink-0 rounded-full bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:text-sky-400">
                New reply since this draft
              </span>
            )}
          </div>
          {toLabel && (
            <p
              className="truncate text-xs text-muted-foreground"
              title={[...message.to, ...message.cc].map((r) => (r.name ? `${r.name} <${r.email}>` : r.email)).join(', ')}
            >
              to {toLabel}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          {message.hasAttachments && <Paperclip className="mr-1 h-3.5 w-3.5 text-muted-foreground" aria-label="Has attachments" />}
          {onReply && (
            <button type="button" onClick={onReply} className={iconButton} aria-label="Reply" title="Reply (r)" data-message-reply="">
              <Reply className="h-4 w-4" />
            </button>
          )}
          {onReplyAll && (
            <button type="button" onClick={onReplyAll} className={iconButton} aria-label="Reply all" title="Reply all (a)" data-message-reply-all="">
              <ReplyAll className="h-4 w-4" />
            </button>
          )}
          {onForward && (
            <button type="button" onClick={onForward} className={iconButton} aria-label="Forward" title="Forward (f)" data-message-forward="">
              <Forward className="h-4 w-4" />
            </button>
          )}
          <span className="ml-1.5 text-xs text-muted-foreground" title={fullDate(message.date)}>{date}</span>
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
      {editing && onSend && (
        <div className="pt-4">
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
            onSendLater={
              onSendLater
                ? async (edits, at) => {
                    // Scheduled: the composer closes; the draft waits in the mailbox.
                    if (await onSendLater(at, edits)) setEditing(false)
                  }
                : undefined
            }
            onCancel={() => setEditing(false)}
          />
        </div>
      )}

      {/* Body */}
      {!(editing && onSend) && (
        <div className="pt-4">
          {message.invite && !message.isDraft && <EmailInviteCard invite={message.invite} ownAddresses={ownAddresses} />}
          {/* No invitation in the message itself: one that came only as an attached .ics is read from the file. */}
          {!message.invite && !message.isDraft && inviteHref && (
            <EmailAttachedInvite attachments={message.attachments ?? []} hrefFor={inviteHref} ownAddresses={ownAddresses} />
          )}

          <div className="email-body text-[15px] leading-relaxed">
            {message.bodyHtml ? (
              <EmailContent
                html={message.bodyHtml}
                senderEmail={message.from.email}
              />
            ) : (
              <pre className="whitespace-pre-wrap font-sans text-[15px] leading-relaxed text-foreground">
                <Linkify text={message.bodyText} />
              </pre>
            )}
          </div>

          {message.attachments && message.attachments.length > 0 && (
            <EmailAttachments attachments={message.attachments} hrefFor={attachmentHref} />
          )}

          {message.isDraft && onSend && (
            <div className="mt-4 flex items-center gap-2 pt-1">
              <Button size="sm" className="gap-1.5" onClick={() => onSend()} disabled={busy}>
                {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                {sending ? 'Sending…' : 'Send'}
              </Button>
              {onSendLater && <SendLaterButton disabled={busy} onSchedule={(at) => onSendLater(at)} />}
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

function DraftBadge() {
  return (
    <span className="shrink-0 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
      Draft
    </span>
  )
}

export type { EmailMessageData, EmailAttachment }
