'use client'

/**
 * Where the owner's thread is shared (migration 646): one chip per live share,
 * "Shared to #sales · Un-share", under the thread's subject. Only the owner
 * sees these (the route lists the caller's own thread's shares). Un-share ends
 * the access at once; the chat message stays, its card saying "No longer
 * shared". Nothing shared: nothing drawn.
 */
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Send } from 'lucide-react'
import type { EmailShareChip } from '@/lib/email-share/types'
import { unshareEmail, type EmailShareThreadRef } from './email-share-dialog'

function sharesUrl(thread: EmailShareThreadRef): string | null {
  const params = new URLSearchParams()
  if (thread.indexId) params.set('index', thread.indexId)
  else if (thread.threadId) params.set('thread', thread.threadId)
  else return null
  if (thread.accountId) params.set('account', thread.accountId)
  return `/api/account/email/shares?${params.toString()}`
}

export function EmailShareChips({ thread, reloadKey = 0 }: { thread: EmailShareThreadRef; reloadKey?: number }) {
  const [shares, setShares] = useState<EmailShareChip[]>([])
  const url = sharesUrl(thread)

  const load = useCallback(async () => {
    if (!url) return setShares([])
    try {
      const res = await fetch(url, { cache: 'no-store' })
      const data = res.ok ? ((await res.json()) as { shares?: unknown }) : null
      setShares(Array.isArray(data?.shares) ? (data.shares as EmailShareChip[]) : [])
    } catch {
      setShares([])
    }
  }, [url])

  useEffect(() => {
    void load()
  }, [load, reloadKey])

  if (shares.length === 0) return null
  return (
    <>
      {shares.map((s) => (
        <span
          key={s.id}
          data-email-share-chip={s.id}
          className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 px-2 py-0.5 text-xs text-violet-700 dark:text-violet-300"
        >
          <Send className="h-3 w-3" />
          Shared to {s.label}
          <span aria-hidden>·</span>
          <button
            type="button"
            data-email-unshare={s.id}
            className="font-medium underline-offset-2 hover:underline"
            onClick={async () => {
              setShares((prev) => prev.filter((x) => x.id !== s.id))
              if (await unshareEmail(s.id)) toast.success(`Un-shared from ${s.label}`)
              else {
                toast.error("Couldn't un-share it")
                void load()
              }
            }}
          >
            Un-share
          </button>
        </span>
      ))}
    </>
  )
}
