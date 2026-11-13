'use client'

/**
 * Mail's Scheduled folder: the person's messages waiting to be sent later
 * (recipients, subject, when), each with Send now and Cancel (Cancel leaves it
 * a normal draft in Drafts), and the ones that failed, with why, until
 * dismissed. Drawn in the thread list's own row style. Reads
 * GET /api/account/email/scheduled (their own rows only), and again after
 * each change.
 */
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { AlertCircle, Clock, Loader2, Send, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { cancelScheduledSend, scheduledForLabel, type ScheduledSendView } from '@/lib/email/send-later'

interface ScheduledListProps {
  /** Bump to read again (the page's refresh). */
  refreshKey?: number
}

async function errorOf(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: unknown } | null
  return typeof data?.error === 'string' && data.error ? data.error : fallback
}

export function ScheduledList({ refreshKey = 0 }: ScheduledListProps) {
  const [rows, setRows] = useState<ScheduledSendView[] | null>(null)
  const [failedToLoad, setFailedToLoad] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/account/email/scheduled', { cache: 'no-store' })
      if (!res.ok) throw new Error(String(res.status))
      const data = (await res.json()) as { scheduled?: ScheduledSendView[] }
      setRows(data.scheduled ?? [])
      setFailedToLoad(false)
    } catch {
      setFailedToLoad(true)
      setRows((prev) => prev ?? [])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const act = async (id: string, run: () => Promise<void>) => {
    if (busyId) return
    setBusyId(id)
    try {
      await run()
    } finally {
      setBusyId(null)
      void load()
    }
  }

  const sendNow = (row: ScheduledSendView) =>
    act(row.id, async () => {
      const res = await fetch(`/api/account/email/scheduled/${encodeURIComponent(row.id)}/send-now`, { method: 'POST' })
      if (res.ok) toast.success('Email sent')
      else toast.error(await errorOf(res, 'Could not send the email'))
    })

  const cancel = (row: ScheduledSendView) =>
    act(row.id, async () => {
      if (await cancelScheduledSend(row.id)) toast.success('Kept as a draft')
    })

  const dismiss = (row: ScheduledSendView) =>
    act(row.id, async () => {
      const res = await fetch(`/api/account/email/scheduled/${encodeURIComponent(row.id)}`, { method: 'DELETE' })
      if (!res.ok) toast.error(await errorOf(res, 'Could not dismiss it'))
    })

  if (rows === null) {
    return (
      <div className="py-1" data-scheduled-list="loading">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="mx-1 flex items-start gap-3 rounded-lg px-3 py-2.5">
            <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-48" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="flex h-64 flex-col items-center justify-center text-muted-foreground" data-scheduled-list="empty">
        <Clock className="mb-2 h-8 w-8 opacity-50" />
        <p className="text-sm">{failedToLoad ? 'Could not read your scheduled emails' : 'Nothing scheduled'}</p>
      </div>
    )
  }

  const now = new Date()
  return (
    <ScrollArea className="h-full">
      <div className="py-1" data-scheduled-list="">
        {rows.map((row) => {
          const failed = row.status === 'failed'
          const sending = row.status === 'sending'
          const busy = busyId === row.id
          const to = (row.to_emails ?? []).join(', ')
          return (
            <div
              key={row.id}
              data-scheduled-row={row.id}
              data-status={row.status}
              className="group relative mx-1 flex items-start gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted/50 dark:hover:bg-primary/5"
            >
              <div className="mt-0.5 shrink-0">
                <div className={cn('flex h-8 w-8 items-center justify-center rounded-full bg-muted', failed && 'bg-destructive/10 text-destructive')}>
                  {failed ? <AlertCircle className="h-3.5 w-3.5" /> : <Clock className="h-3.5 w-3.5 text-muted-foreground" />}
                </div>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="min-w-0 truncate font-medium">{to || 'No recipients'}</span>
                  <span className={cn('ml-auto shrink-0 text-xs', failed ? 'text-destructive' : 'text-muted-foreground')}>
                    {failed ? 'Not sent' : sending ? 'Sending…' : scheduledForLabel(new Date(row.send_at), now)}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-sm text-muted-foreground">{row.subject || 'No subject'}</p>
                {failed && row.error && <p className="mt-0.5 text-xs text-destructive" data-scheduled-error="">{row.error}</p>}
                <div className="mt-1.5 flex items-center gap-1">
                  {failed ? (
                    <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs text-muted-foreground" disabled={busy} onClick={() => void dismiss(row)}>
                      <X className="h-3 w-3" />
                      Dismiss
                    </Button>
                  ) : (
                    !sending && (
                      <>
                        <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs" disabled={busy} onClick={() => void sendNow(row)}>
                          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                          Send now
                        </Button>
                        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs text-muted-foreground" disabled={busy} onClick={() => void cancel(row)}>
                          Cancel
                        </Button>
                      </>
                    )
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </ScrollArea>
  )
}
