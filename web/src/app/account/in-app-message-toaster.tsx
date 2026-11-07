'use client'

import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useInAppMessages, isUnseen, type InAppMessage } from './in-app-message-context'
import { messageMeta, MESSAGE_ICON_CHIP, MESSAGE_LABEL } from './in-app-message-meta'

/**
 * Fires a persistent, lower-right toast for each unseen admin message
 * (announcement / tip / feedback prompt). Toasts stack newest-first, persist
 * until the user opens or dismisses them, and re-surface across sessions until
 * the message is read. Clicking a toast opens the detail popup.
 *
 * Renders nothing — it only drives the global <Toaster> mounted in the shell.
 */
export function InAppMessageToaster() {
  const { messages, open, markDelivered, dismiss } = useInAppMessages()
  // Toast ids we've already shown, so re-polls don't duplicate them.
  const shownRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const unseenIds = new Set(messages.filter(isUnseen).map((m) => m.id))

    // Add: toast each newly-unseen message once.
    for (const m of messages.filter(isUnseen)) {
      if (shownRef.current.has(m.id)) continue
      shownRef.current.add(m.id)
      markDelivered(m.id)
      showToast(m, { onOpen: open, onDismiss: dismiss })
    }

    // Reconcile: dismiss any toast whose message is no longer unseen — e.g. it
    // was answered/dismissed through the inbox answer panel or in another tab.
    // Without this the duration:Infinity toast would linger as an orphan (and
    // become a dead click once the message drops out of the poll).
    for (const id of shownRef.current) {
      if (!unseenIds.has(id)) {
        toast.dismiss(`iam-${id}`)
        shownRef.current.delete(id)
      }
    }
  }, [messages, open, markDelivered, dismiss])

  return null
}

function showToast(
  m: InAppMessage,
  { onOpen, onDismiss }: { onOpen: (id: string) => void; onDismiss: (id: string) => void },
) {
  const meta = messageMeta(m.message_type)
  const Icon = meta.icon

  toast.custom(
    (t) => (
      <div
        role="button"
        tabIndex={0}
        onClick={() => {
          onOpen(m.id)
          toast.dismiss(t)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onOpen(m.id)
            toast.dismiss(t)
          }
        }}
        className="group relative flex w-[356px] cursor-pointer items-start gap-3 rounded-lg border border-border bg-card p-3 text-card-foreground shadow-lg transition-colors hover:bg-accent/40"
      >
        <span className={cn('mt-0.5 h-7 w-7 shrink-0', MESSAGE_ICON_CHIP)}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className={MESSAGE_LABEL}>{meta.label}</p>
          <p className="mt-0.5 truncate text-sm font-medium">{m.message_title}</p>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{m.message_body}</p>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onDismiss(m.id)
            toast.dismiss(t)
          }}
          className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    ),
    { id: `iam-${m.id}`, duration: Infinity },
  )
}
