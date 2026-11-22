'use client'

/**
 * A mail thread a teammate shared with you by an @-mention (migration 673,
 * decision 1), read-only. Given the mention's email_thread index row id, it
 * asks GET /api/account/email/thread-shares?thread=<id> for the caller's own
 * share, then loads GET /api/account/email/thread-shares/<shareId> and renders
 * the thread with the SAME read-only view the chat email card uses
 * (EmailShareMessages), read live from the owner's mailbox and stored nowhere.
 *
 * States: loading, the thread, "not shared with you", and error / busy. The
 * viewer is mounted once in the dashboard shell (SharedEmailThreadMount) and
 * opens on the `ni:open-shared-email` window event.
 *
 * `ph-no-capture`: session replay never records the mail, as the thread view.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EMAIL_SHARE_UNAVAILABLE_TEXT, type EmailShareThreadView } from '@/lib/email-share/types'
import { OPEN_SHARED_EMAIL_EVENT, type OpenSharedEmailDetail } from '@/lib/email-share/open-shared-thread'
import { BusyLine, EmailShareMessages } from './email-share-card'

/** The thread view the thread-share route returns (the channel share's shape, minus id/mine). */
type SharedView = Pick<EmailShareThreadView, 'subject' | 'messages' | 'missing' | 'blockedImages'>

type State =
  | { kind: 'loading' }
  | { kind: 'thread'; view: SharedView; images: boolean }
  | { kind: 'not-shared' }
  | { kind: 'unavailable' }
  | { kind: 'busy' }

const NOT_SHARED_TEXT = 'This email isn’t shared with you, or is no longer shared.'

export function SharedEmailThreadDialog({ threadIndexId, onClose }: { threadIndexId: string; onClose: () => void }) {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const shareIdRef = useRef<string | null>(null)

  const load = useCallback(
    async (images: boolean, isCurrent: () => boolean = () => true) => {
      try {
        // The caller's own share for this thread index row (404 when not a grantee).
        if (!shareIdRef.current) {
          const found = await fetch(`/api/account/email/thread-shares?thread=${encodeURIComponent(threadIndexId)}`, { cache: 'no-store' })
          if (!isCurrent()) return
          if (found.status === 404) return setState({ kind: 'not-shared' })
          if (!found.ok) return setState({ kind: found.status >= 500 ? 'busy' : 'not-shared' })
          const data = (await found.json()) as { shareId?: unknown }
          if (typeof data.shareId !== 'string') return setState({ kind: 'not-shared' })
          shareIdRef.current = data.shareId
        }
        const res = await fetch(`/api/account/email/thread-shares/${encodeURIComponent(shareIdRef.current)}${images ? '?images=1' : ''}`, { cache: 'no-store' })
        if (!isCurrent()) return
        if (res.ok) return setState({ kind: 'thread', view: (await res.json()) as SharedView, images })
        if (res.status >= 500) return setState({ kind: 'busy' })
        if (res.status === 404) return setState({ kind: 'not-shared' })
        return setState({ kind: 'unavailable' })
      } catch {
        if (isCurrent()) setState({ kind: 'busy' })
      }
    },
    [threadIndexId],
  )

  useEffect(() => {
    let current = true
    shareIdRef.current = null
    setState({ kind: 'loading' })
    void load(false, () => current)
    return () => {
      current = false
    }
  }, [load])

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="ph-no-capture flex max-h-[85vh] flex-col sm:max-w-2xl" data-shared-email-thread="">
        <DialogHeader>
          <DialogTitle className="select-text pr-6">{state.kind === 'thread' ? state.view.subject : 'Shared email'}</DialogTitle>
          <DialogDescription>Shared with you from a teammate’s mailbox, read-only. Only the messages shared are shown.</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
          {state.kind === 'loading' ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading…
            </p>
          ) : state.kind === 'not-shared' ? (
            <p className="text-sm text-muted-foreground" role="status" data-shared-email-not-shared="">{NOT_SHARED_TEXT}</p>
          ) : state.kind === 'unavailable' ? (
            <p className="text-sm text-muted-foreground" role="status" data-shared-email-unavailable="">{EMAIL_SHARE_UNAVAILABLE_TEXT}</p>
          ) : state.kind === 'busy' ? (
            <BusyLine
              onRetry={() => {
                setState({ kind: 'loading' })
                void load(false)
              }}
            />
          ) : (
            <EmailShareMessages
              thread={state.view}
              images={state.images}
              onLoadImages={() => void load(true)}
              attachmentHref={(messageId, key) =>
                shareIdRef.current
                  ? `/api/account/email/thread-shares/${encodeURIComponent(shareIdRef.current)}/attachment?message=${encodeURIComponent(messageId)}&key=${encodeURIComponent(key)}`
                  : null
              }
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Mounted once in the dashboard shell: opens the read-only viewer when a
 * grantee's email_thread chip fires `ni:open-shared-email`.
 */
export function SharedEmailThreadMount() {
  const [threadIndexId, setThreadIndexId] = useState<string | null>(null)
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<OpenSharedEmailDetail>).detail
      if (detail && typeof detail.threadIndexId === 'string') setThreadIndexId(detail.threadIndexId)
    }
    window.addEventListener(OPEN_SHARED_EMAIL_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_SHARED_EMAIL_EVENT, onOpen)
  }, [])
  if (!threadIndexId) return null
  return <SharedEmailThreadDialog key={threadIndexId} threadIndexId={threadIndexId} onClose={() => setThreadIndexId(null)} />
}
