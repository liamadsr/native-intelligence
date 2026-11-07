'use client'

import { useCallback, useEffect, useState, useRef } from 'react'
import { ThinkingOrb } from 'thinking-orbs'
import { Mail } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { EmailThreadItem, type EmailThread } from './email-thread-item'
import type { ThreadUpdate } from './email-thread-detail'
import { fillHeaders, withCachedHeaders } from '@/lib/email/header-cache'
import { getJsonOnce } from '@/lib/email/inflight-get'
import { ensureIndexed } from '@/lib/email/ensure-indexed'

/**
 * The list once per provider_thread_id, first (most recent) one kept. The
 * route can list a thread more than once: it is indexed once per workspace its
 * mailbox is linked to. Rows are keyed by it, and a repeated key makes React
 * lose one of the two rows: its DOM is never removed and outlives every later
 * list, so a folder switch left the Inbox's repeated threads on screen above
 * the Drafts.
 */
function uniqueThreads(threads: EmailThread[]): EmailThread[] {
  const seen = new Set<string>()
  return threads.filter((t) => {
    if (seen.has(t.provider_thread_id)) return false
    seen.add(t.provider_thread_id)
    return true
  })
}

interface EmailThreadListProps {
  folder: string
  onThreadSelect: (thread: EmailThread) => void
  selectedThreadId: string | null
  search?: string
  refreshKey?: number
  accountIds?: string[] | null
  extraParams?: Record<string, string>
  onThreadsLoaded?: (threads: EmailThread[]) => void
  onSetterReady?: (setter: React.Dispatch<React.SetStateAction<EmailThread[]>>) => void
  onThreadAction?: () => void
  onThreadUpdate?: (update: ThreadUpdate) => void
  /** The folder's total (a chat card's count), on each first page. */
  onTotal?: (total: number) => void
}

export function EmailThreadList({
  folder,
  onThreadSelect,
  selectedThreadId,
  search = '',
  refreshKey,
  accountIds = null,
  extraParams,
  onThreadsLoaded,
  onSetterReady,
  onThreadAction,
  onThreadUpdate,
  onTotal,
}: EmailThreadListProps) {
  const [threads, setThreads] = useState<EmailThread[]>([])
  const [loading, setLoading] = useState(true)
  const hasLoadedOnce = useRef(false)

  // Expose setter to parent for optimistic updates (use ref to avoid render-cycle issues)
  const onSetterReadyRef = useRef(onSetterReady)
  onSetterReadyRef.current = onSetterReady
  useEffect(() => {
    onSetterReadyRef.current?.(setThreads)
  }, [])
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [page, setPage] = useState(1)
  // A search pages by the provider's cursor (each mailbox's page token), not by offset.
  const searchCursorRef = useRef<string | null>(null)
  // The search text the list last asked for (the load and the debounced
  // search share it, so opening Mail asks once, not once per effect).
  const fetchedSearchRef = useRef(search)
  const searchRef = useRef(search)
  searchRef.current = search
  // Only the newest first-page request paints: a slower answer to an older
  // search (provider searches vary) never replaces a newer one.
  const firstPageGenRef = useRef(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const onThreadsLoadedRef = useRef(onThreadsLoaded)
  onThreadsLoadedRef.current = onThreadsLoaded
  const onTotalRef = useRef(onTotal)
  onTotalRef.current = onTotal
  // Set when a fetch lands; the effect below hands the committed list to the
  // parent. An append's list only exists once React runs the updater, which
  // can be after a microtask, so the parent is told from the commit instead.
  const notifyLoadedRef = useRef(false)
  useEffect(() => {
    if (!notifyLoadedRef.current) return
    notifyLoadedRef.current = false
    onThreadsLoadedRef.current?.(threads)
  }, [threads])

  const fetchThreads = useCallback(async (searchQuery: string, pageNum: number = 1, append: boolean = false) => {
    const gen = pageNum === 1 ? ++firstPageGenRef.current : firstPageGenRef.current
    if (pageNum === 1) fetchedSearchRef.current = searchQuery
    if (pageNum === 1 && !hasLoadedOnce.current) {
      setLoading(true)
    } else if (pageNum > 1) {
      setLoadingMore(true)
    }
    try {
      const params = new URLSearchParams({ folder, page: String(pageNum), per_page: '50' })
      if (searchQuery) params.set('search', searchQuery)
      if (searchQuery && append && searchCursorRef.current) params.set('cursor', searchCursorRef.current)
      if (accountIds?.length) params.set('accountIds', accountIds.join(','))
      if (extraParams) {
        for (const [k, v] of Object.entries(extraParams)) {
          if (v && k !== 'folder') params.set(k, v)
        }
      }
      // One request per URL in flight (src/lib/email/inflight-get.ts).
      const data = await getJsonOnce<{ threads?: EmailThread[]; total?: number; has_more?: boolean; cursor?: string | null }>(
        `/api/account/email/threads?${params}`,
      )
      if (gen !== firstPageGenRef.current) return
      if (data) {
        // First pass: the index rows (ids, flags, addresses) with whatever
        // headers this browser already holds; the rest arrive in a second pass.
        const loaded = withCachedHeaders(uniqueThreads(data.threads || []))
        // A search row came with the provider's own header: nothing to fill.
        const unfilled = loaded.filter((t) => !t.live)
        if (unfilled.length) {
          void fillHeaders(unfilled).then(() => {
            setThreads((prev) => withCachedHeaders(prev))
          })
        }
        searchCursorRef.current = searchQuery && typeof data.cursor === 'string' ? data.cursor : null
        // The parent hears the list once it commits (the effect above).
        notifyLoadedRef.current = true
        if (append) {
          setThreads(prev => {
            // Offset paging: new mail between two page fetches pushes a page-1
            // thread onto page 2.
            const listed = new Set(prev.map((t) => t.provider_thread_id))
            return [...prev, ...loaded.filter((t) => !listed.has(t.provider_thread_id))]
          })
        } else {
          setThreads(loaded)
        }
        if (pageNum === 1 && typeof data.total === 'number') onTotalRef.current?.(data.total)
        setHasMore(data.has_more ?? false)
        setPage(pageNum)
      }
    } catch {
      // Network error
    } finally {
      setLoading(false)
      setLoadingMore(false)
      hasLoadedOnce.current = true
    }
  }, [folder, accountIds, extraParams])

  // Fetch on folder change or refresh, with the search as it stands now.
  useEffect(() => {
    setPage(1)
    setHasMore(false)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    fetchThreads(searchRef.current, 1, false)
  }, [folder, fetchThreads, refreshKey])

  // Debounced fetch when the search text changes. Not on mount, and not for
  // text the list already asked for: the load above did that.
  const fetchThreadsRef = useRef(fetchThreads)
  fetchThreadsRef.current = fetchThreads
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (search === fetchedSearchRef.current) return
    debounceRef.current = setTimeout(() => {
      setPage(1)
      setHasMore(false)
      fetchThreadsRef.current(search, 1, false)
    }, 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [search])

  // Infinite scroll via IntersectionObserver
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loadingMore && !loading) {
          fetchThreads(search, page + 1, true)
        }
      },
      { root: scrollContainerRef.current, threshold: 0.1 },
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, loadingMore, loading, page, search, fetchThreads])

  // A search result the index doesn't have is indexed before an action runs
  // on it (src/lib/email/ensure-indexed.ts); its row then carries the index id.
  const indexFirst = useCallback(async (thread: EmailThread) => {
    const id = await ensureIndexed(thread)
    if (!id) return
    setThreads((prev) =>
      prev.map((t) =>
        t.provider_thread_id === thread.provider_thread_id && t.account_id === thread.account_id ? { ...t, id, indexed: true } : t,
      ),
    )
  }, [])

  const handleToggleStar = useCallback(
    async (thread: EmailThread) => {
      const newStarred = !thread.is_starred
      setThreads((prev) =>
        prev.map((t) =>
          t.provider_thread_id === thread.provider_thread_id
            ? { ...t, is_starred: newStarred }
            : t,
        ),
      )
      onThreadUpdate?.({ type: 'patch', threadId: thread.provider_thread_id, data: { is_starred: newStarred } })
      try {
        await indexFirst(thread)
        const res = await fetch(`/api/account/email/threads/${thread.provider_thread_id}/star`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ starred: newStarred }),
        })
        if (!res.ok) throw new Error(`star failed: ${res.status}`)
      } catch {
        setThreads((prev) =>
          prev.map((t) =>
            t.provider_thread_id === thread.provider_thread_id
              ? { ...t, is_starred: !newStarred }
              : t,
          ),
        )
        onThreadUpdate?.({ type: 'patch', threadId: thread.provider_thread_id, data: { is_starred: !newStarred } })
      }
    },
    [onThreadUpdate, indexFirst],
  )

  const handleArchive = useCallback(
    async (thread: EmailThread) => {
      // Optimistic remove
      setThreads((prev) => prev.filter((t) => t.provider_thread_id !== thread.provider_thread_id))
      onThreadUpdate?.({ type: 'remove', threadId: thread.provider_thread_id })
      try {
        await indexFirst(thread)
        const res = await fetch(`/api/account/email/threads/${thread.provider_thread_id}/archive`, {
          method: 'POST',
        })
        if (!res.ok) throw new Error(`archive failed: ${res.status}`)
        onThreadAction?.()
      } catch {
        // Revert — re-fetch
        setPage(1)
        fetchThreads(search, 1, false)
      }
    },
    [fetchThreads, search, onThreadAction, onThreadUpdate, indexFirst],
  )

  const handleTrash = useCallback(
    async (thread: EmailThread) => {
      // Optimistic remove
      setThreads((prev) => prev.filter((t) => t.provider_thread_id !== thread.provider_thread_id))
      onThreadUpdate?.({ type: 'remove', threadId: thread.provider_thread_id })
      try {
        await indexFirst(thread)
        const res = await fetch(`/api/account/email/threads/${thread.provider_thread_id}/trash`, {
          method: 'POST',
        })
        if (!res.ok) throw new Error(`trash failed: ${res.status}`)
        onThreadAction?.()
      } catch {
        // Revert — re-fetch
        setPage(1)
        fetchThreads(search, 1, false)
      }
    },
    [fetchThreads, search, onThreadAction, onThreadUpdate, indexFirst],
  )

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden">
        {loading ? (
          <div className="py-1">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-start gap-3 mx-1 rounded-lg px-3 py-2.5">
                <Skeleton className="h-8 w-8 rounded-full shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-48" />
                  <Skeleton className="h-3 w-full max-w-[250px]" />
                </div>
              </div>
            ))}
          </div>
        ) : threads.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
            <Mail className="h-8 w-8 mb-2 opacity-50" />
            <p className="text-sm">No emails in {folder}</p>
          </div>
        ) : (
          <div className="py-1">
            {threads.map((thread) => (
              <EmailThreadItem
                key={thread.provider_thread_id}
                thread={thread}
                isSelected={selectedThreadId === thread.provider_thread_id}
                onClick={() => onThreadSelect(thread)}
                onToggleStar={(e) => { e.stopPropagation(); handleToggleStar(thread) }}
                onArchive={(e) => { e.stopPropagation(); handleArchive(thread) }}
                onTrash={(e) => { e.stopPropagation(); handleTrash(thread) }}
              />
            ))}

            {/* Sentinel for infinite scroll */}
            <div ref={sentinelRef} className="h-1" />

            {loadingMore && (
              <div className="flex items-center justify-center py-4">
                <ThinkingOrb state="working" size={20} theme="auto" />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
