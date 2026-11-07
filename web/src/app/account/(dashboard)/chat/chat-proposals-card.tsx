'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import type { ProposedChange } from '@/lib/proposed-changes/types'

/**
 * The in-chat proposals card (live-agent → chat merge, WS-2a). Renders the
 * meeting agent's staged proposals as compact chips inside a chat bubble —
 * accept/dismiss without leaving the conversation. Status is row-authoritative:
 * each chip reflects its own proposed_change row, kept live over Realtime, so
 * the chat card and the capture-page cards never disagree (both mirror the same
 * rows). This is the `data-proposals` part payload written by syncProposalsCard.
 */
export function ChatProposalsCard({
  captureId,
  proposalIds,
}: {
  captureId: string
  proposalIds: string[]
}) {
  const [rows, setRows] = useState<Record<string, ProposedChange>>({})
  const [busy, setBusy] = useState<Set<string>>(new Set())
  // This copy's own channel topic suffix: the browser's Supabase client is a
  // singleton, so two copies of the card (the HUD's live chat and the capture
  // page's, say) under one topic would share one channel, and the first to
  // close would remove it from under the other.
  const [instanceId] = useState(() => crypto.randomUUID())

  // Stable identity for the id set: proposalIds is a fresh array reference every
  // render (it comes off the message part), so keying effects on the array
  // itself would refetch every render. The joined key changes only when the
  // rolling card actually grows — which IS when we want to refetch.
  const idsKey = proposalIds.join(',')
  const idsKeyRef = useRef(idsKey)
  idsKeyRef.current = idsKey

  // Fetch the current state of the referenced proposals. The capture endpoint
  // returns ALL of the capture's changes; we index the ones this card names.
  const refetch = useCallback(async () => {
    try {
      const res = await fetch(`/api/account/captures/${captureId}/proposed-changes`)
      if (!res.ok) return
      const data = (await res.json()) as { changes?: ProposedChange[] }
      const wanted = new Set(idsKeyRef.current.split(',').filter(Boolean))
      const next: Record<string, ProposedChange> = {}
      for (const c of data.changes ?? []) if (wanted.has(c.id)) next[c.id] = c
      setRows(next)
    } catch {
      /* best-effort */
    }
  }, [captureId])

  // Refetch on mount and whenever the card grows (idsKey changes).
  useEffect(() => {
    void refetch()
  }, [refetch, idsKey])

  // Live status: the same proposed_change feed the capture page uses.
  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel(`chat-proposals:${captureId}:${instanceId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'proposed_change', filter: `capture_id=eq.${captureId}` },
        () => void refetch(),
      )
      .subscribe()
    // Catch-up after a socket recovery (e.g. desktop wake from sleep): the
    // watchdog re-establishes the connection, but events written while the
    // socket was dead were never delivered. Refetch to pick up any status
    // changes to this card's proposals that we missed during the gap.
    const onRecovered = () => void refetch()
    window.addEventListener('dial8:realtime-recovered', onRecovered)
    return () => {
      window.removeEventListener('dial8:realtime-recovered', onRecovered)
      supabase.removeChannel(channel)
    }
  }, [captureId, instanceId, refetch])

  const act = useCallback(
    async (id: string, kind: 'apply' | 'dismiss') => {
      setBusy((b) => new Set(b).add(id))
      // Optimistic: reflect the new status immediately.
      setRows((r) =>
        r[id] ? { ...r, [id]: { ...r[id], status: kind === 'apply' ? 'applied' : 'dismissed' } } : r,
      )
      try {
        const res = await fetch(`/api/account/captures/${captureId}/proposed-changes/${id}/${kind}`, {
          method: 'POST',
        })
        if (!res.ok) {
          toast.error(kind === 'apply' ? "Couldn't add that" : "Couldn't dismiss that")
          void refetch() // rollback to server truth on a refused request
        }
      } catch {
        toast.error(kind === 'apply' ? "Couldn't add that" : "Couldn't dismiss that")
        void refetch() // rollback to server truth on failure
      } finally {
        setBusy((b) => {
          const next = new Set(b)
          next.delete(id)
          return next
        })
      }
    },
    [captureId, refetch],
  )

  // Preserve the order the card names them in; skip ids we couldn't load.
  const ordered = proposalIds.map((id) => rows[id]).filter(Boolean) as ProposedChange[]
  if (ordered.length === 0) return null

  return (
    <div className="my-1 flex flex-col gap-1.5 rounded-2xl border border-border/60 bg-muted/30 p-2">
      {ordered.map((c) => {
        const isBusy = busy.has(c.id)
        const applied = c.status === 'applied'
        const dismissed = c.status === 'dismissed'
        return (
          <div
            key={c.id}
            className={cn(
              'flex items-center gap-2 rounded-xl px-2.5 py-1.5 text-sm transition',
              dismissed ? 'opacity-40' : 'bg-background/60',
            )}
          >
            <span className={cn('min-w-0 flex-1 truncate', dismissed && 'line-through')}>
              {c.title || c.display_text}
            </span>
            {applied ? (
              <span className="flex shrink-0 items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                <Check className="h-3.5 w-3.5" />
                Added
              </span>
            ) : dismissed ? (
              <span className="shrink-0 text-xs text-muted-foreground">Dismissed</span>
            ) : (
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => act(c.id, 'apply')}
                  className="flex h-6 items-center gap-1 rounded-full bg-foreground px-2 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-50"
                  title="Add to workspace"
                >
                  <Plus className="h-3 w-3" />
                  Add
                </button>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => act(c.id, 'dismiss')}
                  className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition hover:bg-muted disabled:opacity-50"
                  title="Dismiss"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
