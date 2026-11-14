'use client'

/**
 * A shared email thread in team chat (migration 646): the card a message
 * carrying a share draws. Read LIVE, stored nowhere: the card asks for its
 * sender, subject and first line when it comes into view, and Open reads the
 * thread from the owner's mailbox, read-only (no reply, forward or
 * download-all; each attachment downloads through the share on its own).
 * A share its owner took back says "No longer shared"; one the mailbox can't
 * give any more, "This email is no longer available". Its owner can un-share
 * it from the card's menu.
 *
 * `ph-no-capture`: session replay never records the mail, as the thread view.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, Mail, MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import {
  EMAIL_SHARE_REVOKED_TEXT,
  EMAIL_SHARE_UNAVAILABLE_TEXT,
  type EmailShareCardView,
  type EmailShareMessage,
  type EmailShareThreadView,
} from '@/lib/email-share/types'
import { EmailMessage, type EmailMessageData } from './email-message'
import { unshareEmail } from './email-share-dialog'

type CardState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'card'; card: EmailShareCardView } | { kind: 'hidden' }

const shareUrl = (id: string) => `/api/account/email/shares/${encodeURIComponent(id)}`

/** Calls `onVisible` once the element is on screen (at once where nothing can tell). */
function useOnVisible<T extends Element>(onVisible: () => void) {
  const ref = useRef<T | null>(null)
  const fired = useRef(false)
  useEffect(() => {
    const el = ref.current
    if (!el || fired.current) return
    const fire = () => {
      if (fired.current) return
      fired.current = true
      onVisible()
    }
    if (typeof IntersectionObserver === 'undefined') return fire()
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect()
        fire()
      }
    })
    io.observe(el)
    return () => io.disconnect()
  }, [onVisible])
  return ref
}

export function EmailShareCard({ shareId }: { shareId: string }) {
  const [state, setState] = useState<CardState>({ kind: 'idle' })
  const [open, setOpen] = useState(false)

  const load = useCallback(async () => {
    setState((s) => (s.kind === 'card' ? s : { kind: 'loading' }))
    try {
      const res = await fetch(`${shareUrl(shareId)}?view=card`, { cache: 'no-store' })
      if (!res.ok) return setState({ kind: 'hidden' })
      setState({ kind: 'card', card: (await res.json()) as EmailShareCardView })
    } catch {
      setState({ kind: 'hidden' })
    }
  }, [shareId])
  const ref = useOnVisible<HTMLDivElement>(load)

  const unshare = async () => {
    if (await unshareEmail(shareId)) {
      toast.success('Un-shared')
      setOpen(false)
      void load()
    } else toast.error("Couldn't un-share it")
  }

  const card = state.kind === 'card' ? state.card : null
  return (
    <div ref={ref} data-email-share-card={shareId} data-state={card?.state ?? state.kind} className="ph-no-capture mt-1.5 max-w-md rounded-xl border border-border bg-muted/40 p-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground">
          <Mail className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          {card === null ? (
            state.kind === 'hidden' ? (
              <p className="text-sm text-muted-foreground">{EMAIL_SHARE_UNAVAILABLE_TEXT}</p>
            ) : (
              <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Shared email
              </p>
            )
          ) : card.state === 'revoked' ? (
            <p className="text-sm text-muted-foreground" data-email-share-revoked="">{EMAIL_SHARE_REVOKED_TEXT}</p>
          ) : card.state === 'unavailable' ? (
            <p className="text-sm text-muted-foreground" data-email-share-unavailable="">{EMAIL_SHARE_UNAVAILABLE_TEXT}</p>
          ) : (
            <>
              {card.sender && <p className="truncate text-xs text-muted-foreground">{card.sender}</p>}
              <p className="truncate text-sm font-semibold text-foreground">{card.subject}</p>
              {card.firstLine && <p className="line-clamp-2 text-[13px] leading-snug text-muted-foreground">{card.firstLine}</p>}
              <div className="mt-2 flex items-center gap-2">
                <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={() => setOpen(true)} data-email-share-open="">
                  Open
                </Button>
                <span className="text-xs text-muted-foreground">
                  {card.messageCount === 1 ? '1 message' : `${card.messageCount} messages`}
                </span>
              </div>
            </>
          )}
        </div>
        {card?.mine && card.state !== 'revoked' && (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label="Shared email actions" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" data-email-share-menu="">
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem onSelect={() => void unshare()} data-email-share-unshare="">
                Un-share
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {open && <EmailShareThreadDialog shareId={shareId} onClose={() => setOpen(false)} onGone={() => void load()} />}
    </div>
  )
}

/** A shared message as the mail view's message draws it: read-only, never unread, starred or a draft. */
function asMessageData(m: EmailShareMessage, shareId: string): EmailMessageData {
  return {
    id: m.id,
    threadId: shareId,
    from: m.from,
    to: m.to,
    cc: m.cc,
    subject: m.subject,
    date: m.date,
    bodyHtml: m.bodyHtml,
    bodyText: m.bodyText,
    isUnread: false,
    isStarred: false,
    isDraft: false,
    hasAttachments: m.attachments.length > 0,
    attachments: m.attachments,
  }
}

type ThreadState = { kind: 'loading' } | { kind: 'thread'; thread: EmailShareThreadView } | { kind: 'closed'; text: string }

/** The shared thread, read-only, read live when it opens. */
export function EmailShareThreadDialog({ shareId, onClose, onGone }: { shareId: string; onClose: () => void; onGone?: () => void }) {
  const [state, setState] = useState<ThreadState>({ kind: 'loading' })
  useEffect(() => {
    let cancelled = false
    fetch(shareUrl(shareId), { cache: 'no-store' })
      .then(async (res) => {
        if (cancelled) return
        if (res.ok) return setState({ kind: 'thread', thread: (await res.json()) as EmailShareThreadView })
        const data = (await res.json().catch(() => ({}))) as { code?: string }
        setState({ kind: 'closed', text: data.code === 'revoked' ? EMAIL_SHARE_REVOKED_TEXT : EMAIL_SHARE_UNAVAILABLE_TEXT })
        onGone?.()
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'closed', text: EMAIL_SHARE_UNAVAILABLE_TEXT })
      })
    return () => {
      cancelled = true
    }
    // onGone is the card's reload: once per open is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareId])

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="ph-no-capture flex max-h-[85vh] flex-col sm:max-w-2xl" data-email-share-thread="">
        <DialogHeader>
          <DialogTitle className="select-text pr-6">{state.kind === 'thread' ? state.thread.subject : 'Shared email'}</DialogTitle>
          <DialogDescription>Shared from a teammate’s mailbox, read-only. Only the messages shared are shown.</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
          {state.kind === 'loading' ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading…
            </p>
          ) : state.kind === 'closed' ? (
            <p className="text-sm text-muted-foreground" role="status">{state.text}</p>
          ) : (
            <>
              {state.thread.missing > 0 && (
                <p className="text-xs text-muted-foreground" data-email-share-missing="">
                  {state.thread.missing === 1 ? '1 message is' : `${state.thread.missing} messages are`} no longer available.
                </p>
              )}
              {state.thread.messages.map((m, i) => (
                <EmailMessage
                  key={m.id}
                  message={asMessageData(m, shareId)}
                  defaultExpanded={i === state.thread.messages.length - 1}
                  attachmentHref={(a) =>
                    a.key ? `${shareUrl(shareId)}/attachment?message=${encodeURIComponent(m.id)}&key=${encodeURIComponent(a.key)}` : null
                  }
                />
              ))}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
