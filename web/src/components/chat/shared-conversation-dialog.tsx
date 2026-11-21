'use client'

/**
 * The read-only viewer for an agent chat (docs/plans/mentions-everywhere.md,
 * JOB 2): the caller's own past chat, or one a teammate shared by @-mentioning
 * it. ONE instance is mounted globally in the dashboard; it opens on a
 * `ni:open-conversation` window event (openConversation in
 * src/lib/chat/open-conversation.ts) and reads
 * GET /api/account/conversations/[id]/shared — the one route a grantee reads
 * through (the chat tables stay owner-only under RLS).
 *
 * It shows the title, "Shared by <name>" (or "Your chat"), and the messages as
 * simple bubbles. Nothing is editable: a reader only reads.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { MessageContent } from '@/components/ui/message'
import { Loader } from '@/components/ui/loader'
import { cn } from '@/lib/utils'
import { OPEN_CONVERSATION_EVENT, parseOpenConversationDetail } from '@/lib/chat/open-conversation'
import type { SharedConversationPayload } from '@/lib/chat/shared-conversation'

type ViewState =
  | { status: 'loading'; title: string | null }
  | { status: 'loaded'; data: SharedConversationPayload }
  | { status: 'not-found' }
  | { status: 'error' }

export function SharedConversationDialog() {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<ViewState>({ status: 'loading', title: null })
  // Guards a stale fetch from landing after a newer open (or a close).
  const loadIdRef = useRef(0)

  const load = useCallback(async (id: string, title: string | null) => {
    const token = ++loadIdRef.current
    setView({ status: 'loading', title })
    setOpen(true)
    try {
      const res = await fetch(`/api/account/conversations/${encodeURIComponent(id)}/shared`, { cache: 'no-store' })
      if (loadIdRef.current !== token) return
      if (res.status === 404) {
        setView({ status: 'not-found' })
        return
      }
      if (!res.ok) {
        setView({ status: 'error' })
        return
      }
      const data = (await res.json()) as SharedConversationPayload
      if (loadIdRef.current !== token) return
      setView({ status: 'loaded', data })
    } catch {
      if (loadIdRef.current !== token) return
      setView({ status: 'error' })
    }
  }, [])

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = parseOpenConversationDetail((e as CustomEvent).detail)
      if (detail) void load(detail.id, detail.title ?? null)
    }
    window.addEventListener(OPEN_CONVERSATION_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_CONVERSATION_EVENT, onOpen)
  }, [load])

  const onOpenChange = useCallback((next: boolean) => {
    if (!next) {
      // A close invalidates any in-flight read.
      loadIdRef.current++
    }
    setOpen(next)
  }, [])

  const heading =
    view.status === 'loaded'
      ? view.data.title || 'Chat'
      : view.status === 'loading'
        ? view.title || 'Chat'
        : 'Chat'
  const subtitle =
    view.status === 'loaded'
      ? view.data.role === 'owner'
        ? 'Your chat'
        : view.data.ownerName
          ? `Shared by ${view.data.ownerName}`
          : 'Shared with you'
      : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-5 py-3">
          <DialogTitle className="truncate text-base">{heading}</DialogTitle>
          {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {view.status === 'loading' && (
            <div className="flex h-24 items-center justify-center">
              <Loader variant="circular" />
            </div>
          )}

          {view.status === 'not-found' && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              This chat isn&apos;t shared with you, or no longer exists.
            </p>
          )}

          {view.status === 'error' && (
            <p className="py-6 text-center text-sm text-muted-foreground">Couldn&apos;t load this chat. Try again.</p>
          )}

          {view.status === 'loaded' && (
            view.data.messages.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">This chat has no messages.</p>
            ) : (
              <div className="flex flex-col gap-4">
                {view.data.messages.map((m, i) => (
                  <div key={m.id || i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                    <MessageContent
                      markdown={m.role === 'assistant'}
                      className={cn(
                        'max-w-[85%]',
                        m.role === 'user' ? 'bg-primary/10' : 'bg-secondary',
                      )}
                    >
                      {m.text}
                    </MessageContent>
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
