'use client'

/**
 * Who a mail thread is shared with by an @-mention (migration 673, decision 1),
 * for the thread's OWNER. Removing the mention does not revoke the share, so
 * this is where the owner sees and ends them.
 *
 * Only the owner ever sees this: the list route (/thread-shares/mine) returns
 * the caller's OWN shares only, and `ThreadMentionShares` is mounted only in the
 * owner's own Mail thread view. `AllThreadMentionShares` is the same list across
 * every thread, for the person's settings.
 *
 * A row is a teammate, when it was shared, from what (the source record, opened
 * with its chip when it can be), and Stop sharing — which confirms, calls
 * DELETE /api/account/email/thread-shares/[id], and drops the row at once
 * (restored with an error if the call fails).
 */
import { useCallback, useEffect, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { toast } from 'sonner'
import { Loader2, Users2 } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { openMention } from '@/lib/entity-links/open-mention'

export interface MentionShareSource {
  type: string
  id: string | null
  label: string
}

export interface MentionShare {
  id: string
  threadIndexId: string | null
  providerThreadId: string
  granteeMemberId: string
  granteeName: string
  createdAt: string
  source: MentionShareSource
}

type Load = (input: string, init?: RequestInit) => Promise<Response>

function relative(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  try {
    return formatDistanceToNow(new Date(t), { addSuffix: true })
  } catch {
    return ''
  }
}

/** One teammate a thread is shared with, with Stop sharing (confirmed). */
function ShareRow({ share, onStop, fetchImpl }: { share: MentionShare; onStop: (id: string) => void; fetchImpl?: Load }) {
  const load = fetchImpl ?? ((input, init) => fetch(input, init))
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const when = relative(share.createdAt)
  const source = share.source

  const stop = async () => {
    setBusy(true)
    // Optimistic: the row goes now, and comes back if the delete fails.
    onStop(share.id)
    setConfirming(false)
    try {
      const res = await load(`/api/account/email/thread-shares/${encodeURIComponent(share.id)}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 404) throw new Error(String(res.status))
      toast.success(`Stopped sharing with ${share.granteeName}`)
    } catch {
      toast.error("Couldn't stop sharing. It's still shared.")
      onStop('') // signal the caller to reload (restore the row)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-mention-share={share.id} className="flex items-center gap-2 py-1 text-xs">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium">
        {share.granteeName.charAt(0).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-foreground">{share.granteeName}</span>
        {source.id ? (
          <>
            {' · from '}
            <button
              type="button"
              data-mention-share-source={share.id}
              className="underline-offset-2 hover:underline"
              onClick={() => void openMention({ type: source.type, id: source.id!, label: source.label }, 'mail-share')}
            >
              {source.label}
            </button>
          </>
        ) : (
          <span className="text-muted-foreground">{` · from ${source.label}`}</span>
        )}
        {when && <span className="text-muted-foreground">{` · ${when}`}</span>}
      </span>
      <button
        type="button"
        data-mention-share-stop={share.id}
        disabled={busy}
        className="shrink-0 font-medium text-muted-foreground underline-offset-2 hover:text-destructive hover:underline disabled:opacity-50"
        onClick={() => setConfirming(true)}
      >
        Stop sharing
      </button>
      <AlertDialog open={confirming} onOpenChange={(o) => !o && setConfirming(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop sharing this email with {share.granteeName}?</AlertDialogTitle>
            <AlertDialogDescription>They won’t be able to open it any more. Removing the mention wouldn’t have done this.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction data-mention-share-confirm={share.id} onClick={() => void stop()}>
              Stop sharing
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** Fetch the caller's own shares at `url`, with the rows and reload helpers. */
function useMentionShares(url: string, fetchImpl?: Load) {
  const load = fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init))
  const [shares, setShares] = useState<MentionShare[] | null>(null)

  const reload = useCallback(async () => {
    try {
      const res = await load(url, { cache: 'no-store' })
      const data = res.ok ? ((await res.json()) as { shares?: unknown }) : null
      setShares(Array.isArray(data?.shares) ? (data!.shares as MentionShare[]) : [])
    } catch {
      setShares([])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  useEffect(() => {
    void reload()
  }, [reload])

  return { shares, setShares, reload }
}

/**
 * The teammates one thread is shared with by mention. Mounted in the owner's
 * own Mail thread view. Nothing renders when there are no shares.
 */
export function ThreadMentionShares({
  threadIndexId,
  providerThreadId,
  fetchImpl,
}: {
  threadIndexId?: string | null
  providerThreadId?: string | null
  fetchImpl?: Load
}) {
  const query = threadIndexId
    ? `?thread=${encodeURIComponent(threadIndexId)}`
    : providerThreadId
      ? `?providerThread=${encodeURIComponent(providerThreadId)}`
      : null
  const { shares, setShares, reload } = useMentionShares(`/api/account/email/thread-shares/mine${query ?? ''}`, fetchImpl)

  const onStop = useCallback(
    (id: string) => {
      if (!id) return void reload()
      setShares((prev) => (prev ? prev.filter((s) => s.id !== id) : prev))
    },
    [reload, setShares],
  )

  if (!query || !shares || shares.length === 0) return null
  return (
    <div data-thread-mention-shares="" className="mt-2 rounded-lg border border-border/60 px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Users2 className="h-3.5 w-3.5" />
        Shared with
      </div>
      {shares.map((s) => (
        <ShareRow key={s.id} share={s} onStop={onStop} fetchImpl={fetchImpl} />
      ))}
    </div>
  )
}

/**
 * Every mail thread the person has shared by mention, across threads, for their
 * settings. The thread shows as "Email thread" (no subject is stored). Nothing
 * renders while loading or when there are none.
 */
export function AllThreadMentionShares({ fetchImpl }: { fetchImpl?: Load }) {
  const { shares, setShares, reload } = useMentionShares('/api/account/email/thread-shares/mine', fetchImpl)

  const onStop = useCallback(
    (id: string) => {
      if (!id) return void reload()
      setShares((prev) => (prev ? prev.filter((s) => s.id !== id) : prev))
    },
    [reload, setShares],
  )

  if (shares === null) {
    return (
      <div className="flex items-center gap-2 px-5 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading…
      </div>
    )
  }
  if (shares.length === 0) {
    return <div className="px-5 py-4 text-sm text-muted-foreground">You haven’t shared any emails by mention.</div>
  }
  return (
    <div data-all-mention-shares="" className="divide-y divide-dashed divide-border">
      {shares.map((s) => (
        <div key={s.id} className="flex items-center gap-3 px-5 py-3">
          <span className="min-w-0 flex-1 text-sm text-muted-foreground">Email thread</span>
          <div className="min-w-0 flex-[2]">
            <ShareRow share={s} onStop={onStop} fetchImpl={fetchImpl} />
          </div>
        </div>
      ))}
    </div>
  )
}
