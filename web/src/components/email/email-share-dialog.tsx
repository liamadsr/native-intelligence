'use client'

/**
 * Share to chat (migration 646): the owner shares their email thread into a
 * channel or DM they can post in, with a note in their own words. Readers
 * there read it live from the owner's mailbox; nothing of the mail is stored
 * (src/lib/email-share). The toast says where it went, and its Undo deletes
 * the message it posted (which un-shares, leaving no stub in the channel).
 *
 * Opened from the thread view's toolbar (EmailShareDialog), and from the one
 * entity actions menu for an email thread (openEmailShareDialog, which mounts
 * the dialog in its own root: the menu that asked is gone by then).
 */
import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { toast } from 'sonner'
import { AlertTriangle, Hash, Loader2, User } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EMAIL_SHARE_NOTE_MAX, EMAIL_SHARE_OUTSIDE_WARNING, type EmailShareTarget } from '@/lib/email-share/types'

/** The thread to share: the thread view knows its provider id (and mailbox), the entity menu its index row. */
export interface EmailShareThreadRef {
  threadId?: string | null
  indexId?: string | null
  accountId?: string | null
}

/** Un-share (the owner's): access ends at once. True when it went. */
export async function unshareEmail(shareId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/account/email/shares/${encodeURIComponent(shareId)}`, { method: 'DELETE' })
    return res.ok
  } catch {
    return false
  }
}

async function errorOf(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown }
    return typeof data.error === 'string' && data.error ? data.error : fallback
  } catch {
    return fallback
  }
}

/**
 * Take back a share made a moment ago (the toast's Undo): its chat message is
 * deleted, which un-shares it (migration 646's trigger), so the channel keeps
 * no "No longer shared" stub. Should that delete fail, the share is still
 * ended. True when it went.
 */
export async function undoEmailShare(shareId: string, messageId: string | null): Promise<boolean> {
  if (messageId) {
    try {
      const res = await fetch(`/api/account/team-chat/messages/${encodeURIComponent(messageId)}`, { method: 'DELETE' })
      if (res.ok) return true
    } catch {
      // Un-shared below instead.
    }
  }
  return unshareEmail(shareId)
}

/**
 * Share the thread to one target. Toasts "Shared to <label>" with Undo
 * (the message goes, and the share with it), or why it couldn't. Resolves the
 * share's id, or null.
 */
export async function shareEmailThread(
  thread: EmailShareThreadRef,
  target: Pick<EmailShareTarget, 'id' | 'label'>,
  note: string,
  opts: { onUndone?: () => void } = {},
): Promise<string | null> {
  let res: Response
  try {
    res = await fetch('/api/account/email/shares', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(thread.threadId ? { threadId: thread.threadId } : {}),
        ...(thread.indexId ? { indexId: thread.indexId } : {}),
        ...(thread.accountId ? { accountId: thread.accountId } : {}),
        channelId: target.id,
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    })
  } catch {
    toast.error("Couldn't share it")
    return null
  }
  if (!res.ok) {
    toast.error(await errorOf(res, "Couldn't share it"))
    return null
  }
  const data = (await res.json().catch(() => null)) as { share?: { id?: unknown }; label?: unknown; message?: { id?: unknown } } | null
  const shareId = typeof data?.share?.id === 'string' ? data.share.id : null
  const messageId = typeof data?.message?.id === 'string' ? data.message.id : null
  const label = typeof data?.label === 'string' ? data.label : target.label
  toast.success(`Shared to ${label}`, {
    ...(shareId
      ? {
          action: {
            label: 'Undo',
            onClick: () => {
              void undoEmailShare(shareId, messageId).then((ok) => {
                if (ok) opts.onUndone?.()
                else toast.error("Couldn't un-share it")
              })
            },
          },
        }
      : {}),
  })
  return shareId
}

export function EmailShareDialog({
  open,
  onOpenChange,
  thread,
  onShared,
  onUndone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  thread: EmailShareThreadRef
  /** It was shared (the thread view reloads its chips). */
  onShared?: (shareId: string) => void
  /** Its toast's Undo un-shared it. */
  onUndone?: () => void
}) {
  const [targets, setTargets] = useState<EmailShareTarget[] | null>(null)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [sharing, setSharing] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setTargets(null)
    setPicked(null)
    setQuery('')
    setNote('')
    fetch('/api/account/email/shares/targets', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { targets: [] }))
      .then((d: { targets?: EmailShareTarget[] }) => {
        if (!cancelled) setTargets(Array.isArray(d.targets) ? d.targets : [])
      })
      .catch(() => {
        if (!cancelled) setTargets([])
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^#/, '')
    return (targets ?? []).filter((t) => !q || t.label.toLowerCase().replace(/^#/, '').includes(q))
  }, [targets, query])
  const target = (targets ?? []).find((t) => t.id === picked) ?? null

  const share = async () => {
    if (!target || sharing) return
    setSharing(true)
    const id = await shareEmailThread(thread, target, note, { onUndone })
    setSharing(false)
    if (id) {
      onShared?.(id)
      onOpenChange(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="ph-no-capture sm:max-w-md" data-email-share-dialog="">
        <DialogHeader>
          <DialogTitle>Share to chat</DialogTitle>
          <DialogDescription>
            People there read this thread live from your mailbox, as it is now. Nothing is copied, later replies stay private, and you can un-share at any time.
          </DialogDescription>
        </DialogHeader>
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a channel or person" aria-label="Find a channel or person" autoFocus />
        <div role="listbox" aria-label="Where to share" className="max-h-56 overflow-y-auto rounded-md border border-border">
          {targets === null ? (
            <p className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading…
            </p>
          ) : shown.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">{targets.length === 0 ? 'No channels or messages to share to yet' : 'Nothing matches'}</p>
          ) : (
            shown.map((t) => {
              const Icon = t.kind === 'channel' ? Hash : User
              return (
                <button
                  key={t.id}
                  type="button"
                  role="option"
                  aria-selected={picked === t.id}
                  data-share-target={t.id}
                  onClick={() => setPicked(t.id)}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent',
                    picked === t.id && 'bg-accent font-medium',
                  )}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{t.kind === 'channel' ? t.label.replace(/^#/, '') : t.label}</span>
                </button>
              )
            })
          )}
        </div>
        {target?.outside && (
          <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400" data-share-outside-warning="">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            {EMAIL_SHARE_OUTSIDE_WARNING}
          </p>
        )}
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={EMAIL_SHARE_NOTE_MAX}
          rows={2}
          placeholder="Add a note (optional)"
          aria-label="Note"
        />
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void share()} disabled={!target || sharing} data-share-submit="">
            {sharing && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Share
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Open the Share to chat dialog from anywhere (the entity actions menu): it is
 * mounted in a root of its own and taken down when it closes.
 */
export function openEmailShareDialog(thread: EmailShareThreadRef): void {
  if (typeof document === 'undefined') return
  const host = document.createElement('div')
  host.setAttribute('data-email-share-host', '')
  document.body.appendChild(host)
  const root = createRoot(host)
  const close = () => {
    // After the close animation, the root goes.
    setTimeout(() => {
      root.unmount()
      host.remove()
    }, 300)
  }
  function Host() {
    const [open, setOpen] = useState(true)
    return (
      <EmailShareDialog
        open={open}
        thread={thread}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) close()
        }}
      />
    )
  }
  root.render(<Host />)
}
