'use client'

/**
 * Returns true when a keydown event should be handled as a bare mail
 * keyboard shortcut (e.g. "c" to compose).  Returns false when any modifier
 * key is held so that browser/OS shortcuts like Cmd+C or Ctrl+C are not
 * intercepted.
 *
 * Exported for unit testing.
 */
export function isMailShortcutHandleable(e: {
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
}): boolean {
  return !e.metaKey && !e.ctrlKey && !e.altKey
}

import { useState, useCallback, useEffect, useRef, useMemo, useId } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  markSelfRefetched,
  wasSelfRefetchedRecently,
  repairIdFromRecoveredEvent,
} from '@/lib/supabase/realtime-recovery'
import { useEntityListSync } from '@/hooks/use-entity-sync'
import { useIsWindowFocused } from '@/components/views/unified-view-layout'
import { useWorkspaceId } from '@/app/account/workspace-switcher'
import { Mail, Pencil, RefreshCw } from 'lucide-react'
import { fillHeaders, withCachedHeaders } from '@/lib/email/header-cache'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable'
import { EmailThreadList } from './email-thread-list'
import type { EmailThread } from './email-thread-item'
import { EmailThreadDetail } from './email-thread-detail'
import { AccountFilterDropdown } from '@/components/account-filter-dropdown'
import { ViewToolbar } from '@/components/views/view-toolbar'
import { PageTitle } from '@/components/views/page-title'
import { ExpandableSearch, type ExpandableSearchHandle } from '@/components/views/expandable-search'
import { useView, useViewConfig, type CardConfigSource } from '@/components/views/hooks/use-view'
import type { ViewFilter } from '@/lib/views/types'
import type { EmailReplyRequest } from '@/lib/email/reply-in-chat'
import { getJsonOnce } from '@/lib/email/inflight-get'
import { publishMailCard, unpublishMailCard } from '@/components/chat-cards/mail-card-controls'
import { MAIL_FOLDER_ENTRIES as folders, type FolderCounts } from './mail-folders'
import { ScheduledList } from './scheduled-list'
import { useOwnSubnavShown } from '@/app/account/(dashboard)/page-panel/subnav-on-screen'

const EMAIL_THREADS_CHANNEL = 'email-threads-realtime'
// The self-refetch dedup key must be PER INSTANCE, not the bare channel name.
// Every Mail tab stays mounted (display:none when inactive), so several
// EmailLayouts share the module-scoped mark map: one instance's mark would
// otherwise suppress a DIFFERENT instance's genuine catch-up, and that instance
// would never set its dirty flag either — it just silently skips the gap.
const selfRefetchKey = (instanceId: string) => `${EMAIL_THREADS_CHANNEL}:${instanceId}`

/** What a mail card shows now: where the person left it. */
export interface MailCardState {
  folder: string
  search: string
  /** Only unread threads. */
  unread?: boolean
  accounts: string[] | null
  /** The thread open in the card, and its sender (for the agent's note). */
  threadId: string | null
  threadFrom?: string | null
  /** A draft in the card's first thread to open on (its mailbox message id): read once, at mount. */
  draftId?: string | null
}

/**
 * A mail card in the chat (docs/plans/one-agent-and-chat-pages.md, P2): the
 * same Mail, but its folder, search, accounts and thread are the card's own,
 * from props, never the page's state or the module-wide open signal.
 */
export interface MailCardOptions {
  /** Where the card opens: the agent's folder, search, thread, or where the person left it. Read at mount. */
  initial: MailCardState
  /** Full screen: the page's two panes. Inline: one pane, the list or the open thread. */
  fullScreen: boolean
  /** The person changed the folder, search, accounts or open thread. */
  onStateChange?: (state: MailCardState) => void
  /**
   * Where the card's history is (chat-cards/card-history.tsx): the folder and
   * thread. When Back or Forward moves it somewhere the layout is not, the
   * layout goes there (a thread by its id, loaded or not). Applying it reports
   * the new state like any move, and never records a visit of its own.
   */
  place?: { folder: string; threadId: string | null }
  /** The threads listed and their total (null until the first page loads). */
  onThreads?: (threads: EmailThread[], total: number | null) => void
  /**
   * The card's id (its tool call or opened-card id): with one, the card says
   * where it is to the Mail sub-nav beside the rail and takes its moves
   * (chat-cards/mail-card-controls.ts; Liam, 11-11: "see and select all the
   * accounts … the inbox, faves, sent … and any tags that are available for
   * email"). Full screen from `md` up, that sub-nav is its account and
   * folder control: the card has no dropdown or Select of its own there.
   */
  id?: string
  /** Put the card full screen (the sub-nav's rows, with another card in front). */
  show?: () => void
}

interface EmailLayoutProps {
  onReplyRequest?: (request: EmailReplyRequest) => void
  /** A card in the chat (see MailCardOptions). */
  card?: MailCardOptions
}

/** A card's view config: no saved views, no drafts (never the page's). */
const MAIL_CARD_CONFIG: CardConfigSource = { baseline: {} }

/** True when a key event comes from inside a chat card. */
function inChatCard(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('[data-chat-card], [data-chat-card-fullscreen]')
}

export function EmailLayout({ onReplyRequest, card }: EmailLayoutProps) {
  const titleRowRef = useRef<HTMLDivElement>(null)
  // A card is fixed as one for its life: read once.
  const [cardInit] = useState(() => card?.initial ?? null)
  const isCard = cardInit !== null
  // The Mail sub-nav beside the rail on screen (Liam, 11-11): only then is it
  // the card's account and folder control (page-panel/subnav-on-screen.ts).
  const mailSubnavShown = useOwnSubnavShown(isCard ? 'mail' : null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [activeFolder, setActiveFolder] = useState(() => cardInit?.folder ?? 'inbox')
  // A history target may be outside the loaded list. Its provider ID is enough
  // for the detail to fetch it; do not depend on pagination to restore a visit.
  const [selectedThread, setSelectedThread] = useState<(Partial<EmailThread> & Pick<EmailThread, 'provider_thread_id'>) | null>(() =>
    cardInit?.threadId ? { provider_thread_id: cardInit.threadId, ...(cardInit.threadFrom ? { from_name: cardInit.threadFrom } : {}) } : null,
  )
  // Bumped to force the mounted EmailThreadDetail to reload its messages/drafts
  // when the open thread changes underneath it — a new reply lands (thread-index
  // UPDATE moves message_count/last_message_at) or an email_draft row for this
  // thread is created/updated/deleted. The detail panel patches its own summary
  // but never refetches on its own, so it would otherwise show a stale message
  // list while the list row shows a fresher count.
  const [selectedThreadReloadKey, setSelectedThreadReloadKey] = useState(0)
  const [counts, setCounts] = useState<FolderCounts>({})
  const [search, setSearch] = useState(() => cardInit?.search ?? '')
  // A card's own "only unread" (the page has its saved views for that).
  const [unreadOnly, setUnreadOnly] = useState(() => !!cardInit?.unread)
  const [threads, setThreads] = useState<EmailThread[]>([])
  const [syncing, setSyncing] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [filterAccountIds, setFilterAccountIds] = useState<string[] | null>(() => cardInit?.accounts ?? null)
  // A card's tag filter, set from the Mail sub-nav (Liam, 11-11: "any tags
  // that are available for email"): its threads in every folder but Spam and
  // Trash. Picking a folder clears it, and so does the sub-nav leaving: the
  // card never keeps a filter nothing on screen shows.
  const [labelId, setLabelId] = useState<string | null>(null)
  const [importStatus, setImportStatus] = useState<string | null>(null)
  const listSetThreadsRef = useRef<React.Dispatch<React.SetStateAction<EmailThread[]>> | null>(null)
  // Realtime header refills (no stored mail: a row's subject is fetched live):
  // the rows whose newest message changed, gathered and asked for in ONE
  // debounced, batched call, and only those still in the list.
  const threadsRef = useRef<EmailThread[]>([])
  threadsRef.current = threads
  const pendingHeaderRowsRef = useRef(new Map<string, string | null>())
  const headerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const queueHeaderRefill = useCallback((id: string, providerMessageId: string | null) => {
    pendingHeaderRowsRef.current.set(id, providerMessageId)
    if (headerTimerRef.current) return
    headerTimerRef.current = setTimeout(() => {
      headerTimerRef.current = null
      const listed = new Set(threadsRef.current.map((t) => t.id as string))
      const rows = [...pendingHeaderRowsRef.current.entries()]
        .filter(([rowId]) => listed.has(rowId))
        .map(([rowId, provider_message_id]) => ({ id: rowId, provider_message_id }))
      pendingHeaderRowsRef.current.clear()
      if (!rows.length) return
      void fillHeaders(rows).then(() => {
        listSetThreadsRef.current?.((prev) => withCachedHeaders(prev))
      })
    }, 600)
  }, [])
  useEffect(() => () => {
    if (headerTimerRef.current) clearTimeout(headerTimerRef.current)
  }, [])
  const searchInputRef = useRef<ExpandableSearchHandle>(null)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Tracks whether the email realtime channel dropped, so the next successful
  // re-SUBSCRIBE triggers a catch-up refresh (see the channel status handler).
  const hadFailureRef = useRef(false)
  // Mirror of selectedThread for realtime handlers — lets the UPDATE callback
  // compare the incoming row against the open thread without a stale closure or
  // nesting setState inside a state updater.
  const selectedThreadRef = useRef<typeof selectedThread>(null)
  selectedThreadRef.current = selectedThread
  // True only in the FOCUSED window (always true outside one). Several Mail
  // views can be on screen at once (a page and a card), so everything that
  // must happen exactly once gates on this: the keyboard shortcuts, and
  // taking a pending folder hand-off.
  const isWindowFocused = useIsWindowFocused()
  const isWindowFocusedRef = useRef(isWindowFocused)
  isWindowFocusedRef.current = isWindowFocused
  // The workspace whose thread copies this view lists, for the realtime
  // handlers (registered once).
  const workspaceId = useWorkspaceId()
  const workspaceIdRef = useRef(workspaceId)
  workspaceIdRef.current = workspaceId
  // Stable for the life of this component instance — scopes the dedup mark so
  // sibling EmailLayouts never suppress each other (see selfRefetchKey).
  const instanceId = useId()
  const dedupKey = selfRefetchKey(instanceId)

  // Custom views system
  const {
    views, activeViewId, activeView, setActiveViewId,
    createView, updateView, deleteView, duplicateView,
  } = useView('email_thread', undefined, undefined, { standalone: isCard, listViews: !isCard })
  const {
    config, updateConfig, isDirty, overrides, saveOverrides, discardOverrides,
  } = useViewConfig(activeView, 'email_thread', updateView, false, undefined, 'workspace', isCard ? MAIL_CARD_CONFIG : undefined)
  const hasFilters = config.filters.length > 0

  // Convert view filters to query params for EmailThreadList
  const viewFilterParams = useMemo(() => {
    const params: Record<string, string> = {}
    for (const filter of config.filters) {
      if (filter.field === 'folder' && filter.operator === 'is' && typeof filter.value === 'string') {
        params.folder = filter.value
      }
      if (filter.field === 'from_email' && filter.operator === 'is' && typeof filter.value === 'string') {
        params.from_email = filter.value
      }
      if (filter.field === 'from_email' && filter.operator === 'contains' && typeof filter.value === 'string') {
        params.from_email_contains = filter.value
      }
      if (filter.field === 'is_unread' && filter.operator === 'is') {
        params.is_unread = String(filter.value)
      }
      if (filter.field === 'is_starred' && filter.operator === 'is') {
        params.is_starred = String(filter.value)
      }
      if (filter.field === 'needs_reply' && filter.operator === 'is') {
        params.needs_reply = String(filter.value)
      }
      if (filter.field === 'has_attachments' && filter.operator === 'is') {
        params.has_attachments = String(filter.value)
      }
      if (filter.field === 'auto_classified' && filter.operator === 'is' && typeof filter.value === 'string') {
        params.auto_classified = filter.value
      }
    }
    return params
  }, [config.filters])

  // When a custom view has a folder filter, use that instead of the dropdown
  const effectiveFolder = viewFilterParams.folder || activeFolder

  // A card lists only the mailboxes show and read_card read (`readable`: the
  // person's enabled ones, searched the same way), so its count is theirs.
  const listParams = useMemo(
    () =>
      isCard
        ? { readable: '1', ...(unreadOnly ? { unread_only: 'true' } : {}), ...(labelId ? { label_id: labelId } : {}) }
        : viewFilterParams,
    [isCard, unreadOnly, labelId, viewFilterParams],
  )

  // The Sync button doubles as the import indicator: it spins + disables while
  // a manual sync is in flight OR a background import is genuinely running
  // (importStatus is only set for fresh, non-stale import rows — see the
  // sync-status poll). Its tooltip reflects whichever is happening.
  const isSyncBusy = syncing || importStatus !== null
  const importLabel =
    importStatus === 'importing_recent'
      ? 'Importing recent emails…'
      : syncing
        ? 'Syncing emails…'
        : 'Sync emails'

  const fetchCounts = useCallback(async () => {
    try {
      // One request in flight (src/lib/email/inflight-get.ts): opening Mail asks once.
      const data = await getJsonOnce<FolderCounts>('/api/account/email/counts')
      if (data) setCounts(data)
    } catch {
      // Network error
    }
  }, [])

  const handleSync = useCallback(async () => {
    setSyncing(true)
    try {
      await fetch('/api/account/email/sync', { method: 'POST' })
      setRefreshKey(k => k + 1)
      fetchCounts()
    } catch {
      // Network error
    } finally {
      setSyncing(false)
    }
  }, [fetchCounts])

  // Debounced server-side refresh. Used when realtime tells us threads were
  // added/removed: we refetch from the server (which applies workspace/account
  // and folder scoping) rather than optimistically injecting rows that might
  // not belong in the current view. Coalesces bursts (e.g. a backfill).
  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    refreshTimerRef.current = setTimeout(() => {
      setRefreshKey(k => k + 1)
      fetchCounts()
    }, 800)
  }, [fetchCounts])

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    }
  }, [])

  useEffect(() => {
    fetchCounts()
  }, [fetchCounts])

  // Poll sync status to detect background imports (drives the spinning Sync
  // button + its tooltip).
  //
  // `initial_import_status` is sticky: nothing resets it to 'complete' when an
  // import dies, stalls, or is abandoned (process restart, error, dropped
  // Inngest event). Trusting it directly makes the indicator spin forever. So
  // we only treat a row as *actively* importing if it's both in an importing
  // state AND its row was written recently — a stale row is treated as done.
  useEffect(() => {
    // A card shows no Sync button: nothing to drive.
    if (isCard) return
    let timer: ReturnType<typeof setInterval> | null = null

    async function checkSyncStatus() {
      try {
        const res = await fetch('/api/account/email/sync-status')
        if (!res.ok) return
        const { syncStates } = await res.json()
        // An import row is "fresh" only if it was touched within the staleness
        // window. updated_at advances on every step write during an import, so
        // a genuinely-running import stays fresh; a stuck one goes quiet.
        const STALE_MS = 2 * 60 * 1000
        const now = Date.now()
        const active = (syncStates as Array<Record<string, unknown>> | undefined)?.find((s) => {
          const status = s.initial_import_status as string | null
          if (!status || status === 'complete') return false
          const stamp = (s.updated_at || s.initial_import_started_at) as string | null
          if (!stamp) return false
          return now - new Date(stamp).getTime() < STALE_MS
        })
        const newStatus = (active?.initial_import_status as string | undefined) || null
        setImportStatus(newStatus)
      } catch {
        // Network error — skip
      }
    }

    checkSyncStatus()
    timer = setInterval(checkSyncStatus, 10000)
    return () => { if (timer) clearInterval(timer) }
  }, [isCard])

  // Central-socket recovery. use-realtime-entities.ts tears down and reconnects
  // the shared Supabase socket on wake/online, then fires this event once it
  // re-subscribes. The inbox rides the SAME socket (its bespoke channel is
  // multiplexed over it), so a central recovery means our channel just came
  // back too — refetch threads + counts to catch what we missed.
  //
  // Skipped when our OWN channel already caught up moments ago (one repair
  // knocks every channel, so both signals describe the same gap).
  useEffect(() => {
    const onRecovered = (event: Event) => {
      // Deduped only against this instance's own mark for this exact repair —
      // a second real repair inside the window is a different gap and still
      // refreshes.
      if (wasSelfRefetchedRecently(dedupKey, repairIdFromRecoveredEvent(event))) return
      scheduleRefresh()
      // The immediate counts fetch the global handler has always run: the badge
      // is the visible half of the catch-up and scheduleRefresh only repaints it
      // 800ms later.
      fetchCounts()
    }
    window.addEventListener('ni:realtime-recovered', onRecovered)
    return () => window.removeEventListener('ni:realtime-recovered', onRecovered)
  }, [scheduleRefresh, fetchCounts, dedupKey])

  // Drafts folder count: email_draft events (create/update/delete of a draft,
  // from AI generation, a teammate, or another tab) flow on the entity bus.
  // Refresh counts so the Drafts badge stays live. Debounced to coalesce the
  // burst when a batch of drafts is generated.
  useEntityListSync(['email_draft'], fetchCounts, { refetchOnRecovered: false })

  // When an email_draft event targets the OPEN thread, reload the detail panel
  // so its drafts refetch (loadThread pulls fresh `drafts`). Scoped to the
  // selected thread's provider id; unrelated draft events are ignored.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const providerThreadId = selectedThread?.provider_thread_id
    if (!providerThreadId) return
    const onDraftEvent = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        entityType?: string
        fields?: Record<string, unknown>
      }
      if (!detail || detail.entityType !== 'email_draft') return
      // Match on provider_thread_id, but treat an ABSENT key as a match:
      // realtime DELETE payloads carry an empty fields {} (Supabase strips the
      // old row to its PK) and locally-emitted events may omit fields entirely,
      // so a draft deletion or bare emit for the open thread still reloads.
      // Only reject events that carry a *different* provider_thread_id.
      const ptid = detail.fields?.provider_thread_id
      if (ptid != null && ptid !== providerThreadId) return
      setSelectedThreadReloadKey((k) => k + 1)
    }
    window.addEventListener('ni:entity-created', onDraftEvent)
    window.addEventListener('ni:entity-updated', onDraftEvent)
    window.addEventListener('ni:entity-deleted', onDraftEvent)
    return () => {
      window.removeEventListener('ni:entity-created', onDraftEvent)
      window.removeEventListener('ni:entity-updated', onDraftEvent)
      window.removeEventListener('ni:entity-deleted', onDraftEvent)
    }
  }, [selectedThread?.provider_thread_id])

  // Supabase Realtime: subscribe to email_thread_index changes for live updates
  // RLS policy (auth.uid() = user_id) ensures we only receive our own rows
  useEffect(() => {
    const supabase = createClient()
    // A thread has a copy per workspace its mailbox is linked to, and this
    // view lists the current workspace's: the others' inserts and updates are
    // not about it. Before the workspace is known, every copy counts, as it
    // always did.
    const isOwnCopy = (row: unknown) => {
      const ws = workspaceIdRef.current
      return !ws || (row as { workspace_id?: string } | null)?.workspace_id === ws
    }

    let disposed = false
    // One channel PER INSTANCE. realtime-js hands back the EXISTING channel
    // for a topic it already has, so two mounted Mail views on the bare name
    // shared one channel object — and the first to unmount (closing a window,
    // closing a tab) removed it out from under the other, which silently
    // stopped live updates there.
    const channel = supabase
      .channel(`${EMAIL_THREADS_CHANNEL}:${instanceId.replace(/[^A-Za-z0-9_-]/g, '')}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'email_thread_index',
        },
        (payload) => {
          if (!isOwnCopy(payload.new)) return
          // A new thread landed. Refetch from the server so workspace/account
          // and folder scoping are applied correctly instead of blindly
          // injecting a row that may belong to another folder/workspace.
          scheduleRefresh()
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'email_thread_index',
        },
        (payload) => {
          if (!isOwnCopy(payload.new)) return
          const row = payload.new as any
          // The index holds no subject or preview (no stored mail): the row's
          // header comes from the live headers call, re-asked when its newest
          // message changes (src/lib/email/header-cache.ts, memory only).
          const patch: Partial<EmailThread> = {
            from_email: row.from_email,
            provider_message_id: row.provider_message_id,
            is_unread: row.is_unread,
            is_starred: row.is_starred,
            has_attachments: row.has_attachments,
            needs_reply: row.needs_reply,
            message_count: row.message_count,
            last_message_at: row.last_message_at,
          }
          listSetThreadsRef.current?.((prev) =>
            prev.map((t) =>
              t.provider_thread_id === row.provider_thread_id ? { ...t, ...patch } : t,
            ),
          )
          setThreads((prev) =>
            prev.map((t) =>
              t.provider_thread_id === row.provider_thread_id ? { ...t, ...patch } : t,
            ),
          )
          if (typeof row.id === 'string') queueHeaderRefill(row.id, row.provider_message_id ?? null)
          // If a new message arrived in the OPEN thread (its summary counters
          // moved), the mounted detail panel is now showing a stale message
          // list. Bump the reload key so it refetches — patching the list-row
          // summary alone doesn't pull the new message body.
          const open = selectedThreadRef.current
          if (open && open.provider_thread_id === row.provider_thread_id) {
            const messageActivityChanged =
              open.message_count !== row.message_count ||
              open.last_message_at !== row.last_message_at
            if (messageActivityChanged) setSelectedThreadReloadKey((k) => k + 1)
          }
          setSelectedThread((prev) =>
            prev && prev.provider_thread_id === row.provider_thread_id
              ? { ...prev, ...patch }
              : prev,
          )
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'email_thread_index',
        },
        (payload) => {
          // A DELETE carries only the row's id (RLS strips the old row to its
          // primary key), so the row goes by id. The list holds this
          // workspace's copies only, so another workspace's copy going (its
          // mailbox unlinked there) matches nothing here.
          const goneId = (payload.old as { id?: string } | null)?.id
          if (!goneId) return
          listSetThreadsRef.current?.((prev) => prev.filter((t) => t.id !== goneId))
          setThreads((prev) => prev.filter((t) => t.id !== goneId))
          setSelectedThread((prev) => (prev && prev.id === goneId ? null : prev))
          fetchCounts()
        },
      )
      // Reconnect recovery: mirror use-realtime-entities.ts. On a successful
      // re-SUBSCRIBE after a prior failure, refetch threads + counts — this
      // channel missed every INSERT/UPDATE/DELETE during the gap. (The central
      // hook owns the shared-socket wake/online force-reconnect; we only react
      // to recovery here, both from this channel's own status and from the
      // `ni:realtime-recovered` event it dispatches.)
      .subscribe((status) => {
        // Our own removeChannel (unmount, or React's dev double mount) closes
        // the channel too: that is not a gap to recover from.
        if (disposed) return
        if (status === 'SUBSCRIBED' && hadFailureRef.current) {
          hadFailureRef.current = false
          // Mark first: the dedup is about "THIS INSTANCE has already
          // accounted for this gap". The key is per-instance, so this never
          // speaks for a sibling Mail view (see selfRefetchKey).
          markSelfRefetched(dedupKey)
          scheduleRefresh()
          // Same pairing as the global handler: the badge is the visible half
          // of the catch-up and must not wait on the 800ms debounce.
          fetchCounts()
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          hadFailureRef.current = true
        }
      })

    return () => {
      disposed = true
      supabase.removeChannel(channel)
    }
  }, [fetchCounts, scheduleRefresh, dedupKey, instanceId, queueHeaderRefill])

  // Prev/next thread navigation
  const selectedIndex = useMemo(() => {
    if (!selectedThread) return -1
    return threads.findIndex(
      (t) => t.provider_thread_id === selectedThread.provider_thread_id,
    )
  }, [threads, selectedThread])

  const canGoPrev = selectedIndex > 0
  const canGoNext = selectedIndex >= 0 && selectedIndex < threads.length - 1

  // The user's own addresses: the mailboxes the list's rows belong to (each
  // row names its connected account), and the open thread's. In listen mode
  // what they sent in a thread reads as "you". One stable list per set, so the
  // detail isn't handed a new one on every list update.
  const ownAddressesKey = useMemo(() => {
    const addresses = new Set<string>()
    for (const thread of [...threads, selectedThread]) {
      const address = thread?.connected_account?.account_email?.trim().toLowerCase()
      if (address) addresses.add(address)
    }
    return [...addresses].sort().join('\n')
  }, [threads, selectedThread])
  const ownAddresses = useMemo(() => (ownAddressesKey ? ownAddressesKey.split('\n') : []), [ownAddressesKey])

  const handlePrevThread = useCallback(() => {
    if (canGoPrev) {
      const thread = threads[selectedIndex - 1]
      setSelectedThread(thread)
    }
  }, [canGoPrev, threads, selectedIndex])

  const handleNextThread = useCallback(() => {
    if (canGoNext) {
      const thread = threads[selectedIndex + 1]
      setSelectedThread(thread)
    }
  }, [canGoNext, threads, selectedIndex])

  const handleThreadSelect = useCallback((thread: EmailThread) => {
    setSelectedThread(thread)
    if (thread.is_unread) {
      // Optimistically mark as read in the thread list so blue dot disappears
      const markRead = (prev: EmailThread[]) =>
        prev.map((t) =>
          t.provider_thread_id === thread.provider_thread_id
            ? { ...t, is_unread: false }
            : t,
        )
      listSetThreadsRef.current?.(markRead)
      setThreads(markRead)
      setCounts((prev) => ({
        ...prev,
        inbox_unread: Math.max(0, (prev.inbox_unread || 0) - 1),
      }))
    }
  }, [])

  const handleFolderChange = useCallback((folder: string) => {
    setActiveFolder(folder)
    setSelectedThread(null)
    setLabelId(null)
    // Scheduled lists no threads: j/k have nothing to move through there.
    if (folder === 'scheduled') setThreads([])
  }, [])

  const handleThreadsLoaded = useCallback((list: EmailThread[]) => {
    setThreads(list)
  }, [])

  // A card reports where the person left it (the agent hears about it, and it
  // survives a reload or the move to full screen).
  const cardRef = useRef(card)
  cardRef.current = card
  const reportedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!isCard) return
    const state: MailCardState = {
      folder: activeFolder,
      search,
      unread: unreadOnly,
      accounts: filterAccountIds,
      threadId: selectedThread?.provider_thread_id ?? null,
      threadFrom: selectedThread?.from_name ?? selectedThread?.from_email ?? null,
    }
    const key = JSON.stringify([state.folder, state.search, state.unread, state.accounts, state.threadId])
    if (reportedRef.current === null) {
      // The first state is where the card opened: nothing changed yet.
      reportedRef.current = key
      return
    }
    if (reportedRef.current === key) return
    reportedRef.current = key
    cardRef.current?.onStateChange?.(state)
  }, [isCard, activeFolder, search, unreadOnly, filterAccountIds, selectedThread?.provider_thread_id, selectedThread?.from_name, selectedThread?.from_email])

  // Back or Forward in the card moved its place: go there, unless already there
  // (the place follows the person's own moves too).
  const placeFolder = card?.place?.folder
  const placeThread = card?.place?.threadId ?? null
  const appliedPlaceRef = useRef(card?.place ? JSON.stringify([placeFolder, placeThread]) : null)
  useEffect(() => {
    if (!isCard || placeFolder === undefined) return
    const key = JSON.stringify([placeFolder, placeThread])
    if (appliedPlaceRef.current === key) return
    appliedPlaceRef.current = key
    if (placeFolder !== activeFolder) setActiveFolder(placeFolder)
    if (placeThread !== (selectedThreadRef.current?.provider_thread_id ?? null)) {
      setSelectedThread(placeThread ? { provider_thread_id: placeThread } : null)
    }
    // Only a move of the place applies it; the layout's own state is read, not followed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCard, placeFolder, placeThread])

  // The Mail sub-nav beside the rail (Liam, 11-11): where this card is, and
  // its moves (chat-cards/mail-card-controls.ts). The folder is the Select's
  // move (a step in the card's history), the mailboxes the dropdown's.
  const cardId = isCard ? card?.id : undefined
  useEffect(() => {
    if (!cardId) return
    publishMailCard({
      cardId,
      folder: activeFolder,
      accounts: filterAccountIds,
      labelId,
      counts,
      setFolder: handleFolderChange,
      setAccounts: setFilterAccountIds,
      setLabel: (id) => {
        setLabelId(id)
        if (id) setSelectedThread(null)
      },
      show: () => cardRef.current?.show?.(),
    })
  }, [cardId, activeFolder, filterAccountIds, labelId, counts, handleFolderChange])
  useEffect(() => (cardId ? () => unpublishMailCard(cardId) : undefined), [cardId])

  // The list's total, for the card's count.
  const [listTotal, setListTotal] = useState<number | null>(null)
  useEffect(() => {
    if (isCard) cardRef.current?.onThreads?.(threads, listTotal)
  }, [isCard, threads, listTotal])

  // Simple counts refresh for thread list's own hover actions (archive/trash)
  const handleThreadAction = useCallback(() => {
    fetchCounts()
  }, [fetchCounts])

  /**
   * Single handler for all optimistic thread updates from both the detail
   * view and the list's hover actions. Keeps list + detail in sync.
   *
   * - patch:  merge partial fields into the thread (star, labels, etc.)
   * - remove: remove thread from list + clear detail if it's the active one
   */
  const handleThreadUpdate = useCallback((update: import('./email-thread-detail').ThreadUpdate) => {
    // The layout's own copy (j/k, Prev/Next, the card) follows the list.
    if (update.type === 'remove') {
      const drop = (prev: EmailThread[]) => prev.filter((t) => t.provider_thread_id !== update.threadId)
      listSetThreadsRef.current?.(drop)
      setThreads(drop)
      setSelectedThread((prev) =>
        prev && prev.provider_thread_id === update.threadId ? null : prev,
      )
      fetchCounts()
    } else if (update.type === 'patch') {
      const patch = (prev: EmailThread[]) =>
        prev.map((t) =>
          t.provider_thread_id === update.threadId
            ? { ...t, ...update.data }
            : t,
        )
      listSetThreadsRef.current?.(patch)
      setThreads(patch)
      setSelectedThread((prev) =>
        prev && prev.provider_thread_id === update.threadId
          ? { ...prev, ...update.data }
          : prev,
      )
    }
  }, [fetchCounts])

  // A draft sent from the open thread: the thread is no longer a draft, so
  // Drafts drops it (as Archive and Delete drop theirs); anywhere else it
  // stays, answered. Either way the Drafts badge recounts.
  const handleDraftSent = useCallback((threadId: string) => {
    if (effectiveFolder === 'drafts') {
      handleThreadUpdate({ type: 'remove', threadId })
      return
    }
    handleThreadUpdate({ type: 'patch', threadId, data: { needs_reply: false } })
    fetchCounts()
  }, [effectiveFolder, handleThreadUpdate, fetchCounts])

  // A draft discarded from the open thread: Drafts drops the thread, and so
  // does any folder when the draft was all there was of it; anywhere else it
  // stays (the pane reloads it) and the Drafts badge recounts.
  const handleDraftDiscarded = useCallback((threadId: string, threadRemains: boolean) => {
    if (effectiveFolder === 'drafts' || !threadRemains) {
      handleThreadUpdate({ type: 'remove', threadId })
      return
    }
    fetchCounts()
  }, [effectiveFolder, handleThreadUpdate, fetchCounts])

  // Keyboard shortcuts
  useEffect(() => {
    // Which Mail view a key is for, so it acts exactly once: a card acts on
    // keys from inside its own frame (a full-screen card's frame takes focus
    // when it opens), and the page on keys from anywhere else, never from
    // inside a card. Where the focus is decides, never what is on screen.
    const cardOwns = (e: KeyboardEvent) => {
      const frame = rootRef.current?.closest('[data-chat-card], [data-chat-card-fullscreen]')
      return !!frame && e.target instanceof Node && frame.contains(e.target)
    }
    const pageOwns = (e: KeyboardEvent) => isWindowFocusedRef.current && !inChatCard(e.target)

    function handleKeyDown(e: KeyboardEvent) {
      // Every Mail view stays mounted — in background tabs, and in every window
      // of the active tab — and each registers this same window listener. Only
      // the one the user is working in may act, or j/k would step every open
      // thread list at once.
      if (e.defaultPrevented || !(isCard ? cardOwns(e) : pageOwns(e))) return
      if (
        e.target instanceof Element &&
        e.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')
      )
        return

      // Don't intercept OS/browser shortcuts (e.g. cmd+c, ctrl+c, cmd+/, etc.)
      if (!isMailShortcutHandleable(e)) return

      switch (e.key) {
        case 'c':
          document.dispatchEvent(new Event('open-create-email'))
          break
        case 'Escape':
          if (selectedThread) {
            setSelectedThread(null)
            // In a card, closing the thread is all Esc does (not leaving full screen).
            if (isCard) e.preventDefault()
          }
          break
        case '/':
          e.preventDefault()
          e.stopPropagation()
          searchInputRef.current?.focus()
          break
        case 'j':
          if (selectedThread && canGoNext) handleNextThread()
          break
        case 'k':
          if (selectedThread && canGoPrev) handlePrevThread()
          break
      }
    }

    // Mail owns its search shortcut while focused, before the document-level
    // page picker can use the same key to open the Agents library.
    const handleSearchShortcut = (event: KeyboardEvent) => {
      if (event.key === '/') handleKeyDown(event)
    }
    // A card listens first (window capture), so its Esc closes its thread
    // before the full-screen card hears Esc, and its keys never reach the page.
    if (isCard) {
      window.addEventListener('keydown', handleKeyDown, true)
      return () => window.removeEventListener('keydown', handleKeyDown, true)
    }
    document.addEventListener('keydown', handleSearchShortcut, true)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleSearchShortcut, true)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [selectedThread, canGoNext, canGoPrev, handleNextThread, handlePrevThread, isCard])

  const accountFilter = (
    <AccountFilterDropdown
      capability="email"
      selectedAccountIds={filterAccountIds}
      onSelectionChange={setFilterAccountIds}
      triggerClassName="min-w-0 [&>span]:max-w-24 [&>span]:truncate"
    />
  )

  const folderSelect = (
    <Select value={activeFolder} onValueChange={handleFolderChange}>
      <SelectTrigger className="h-7 gap-1.5 rounded-full border border-border bg-transparent px-3 text-xs shadow-sm hover:bg-muted/50 focus:ring-0 focus:ring-offset-0 dark:shadow-none">
        {(() => {
          const f = folders.find((f) => f.id === activeFolder)
          if (!f) return null
          const Icon = f.icon
          const count = f.countKey ? counts[f.countKey] : undefined
          return (
            <>
              <Icon className="h-3 w-3 shrink-0" />
              <span>{f.label}</span>
              {count ? (
                <span data-folder-count="" className="text-[10px] font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">
                  {count}
                  {f.countUnit ? ` ${f.countUnit}` : ''}
                </span>
              ) : null}
            </>
          )
        })()}
      </SelectTrigger>
      <SelectContent>
        {folders.map((folder) => {
          const Icon = folder.icon
          const count = folder.countKey ? counts[folder.countKey] : undefined
          return (
            <SelectItem key={folder.id} value={folder.id}>
              <div className="flex items-center gap-2">
                <Icon className="h-3.5 w-3.5" />
                <span>{folder.label}</span>
                {count ? (
                  <span className="ml-auto text-xs text-muted-foreground">
                    {count}
                    {folder.countUnit ? ` ${folder.countUnit}` : ''}
                  </span>
                ) : null}
              </div>
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
  )

  const searchBox = (
    <ExpandableSearch
      ref={searchInputRef}
      value={search}
      onChange={setSearch}
      placeholder="Search mail…"
      label="Search mail"
    />
  )

  const composeButton = (
    <Button variant="ghost" size="sm" className="h-7 w-7 p-0" aria-label="New email" onClick={() => document.dispatchEvent(new Event('open-create-email'))}>
      <Pencil className="h-3.5 w-3.5" />
    </Button>
  )

  // The Scheduled folder is the person's scheduled sends (no thread list behind it).
  const threadList = effectiveFolder === 'scheduled' && !labelId ? (
    <ScheduledList refreshKey={refreshKey} search={search} />
  ) : (
    <EmailThreadList
      folder={labelId ? 'all' : effectiveFolder}
      onThreadSelect={handleThreadSelect}
      selectedThreadId={selectedThread?.provider_thread_id ?? null}
      search={search}
      refreshKey={refreshKey}
      accountIds={filterAccountIds}
      extraParams={listParams}
      onThreadsLoaded={handleThreadsLoaded}
      onSetterReady={(setter) => { listSetThreadsRef.current = setter }}
      onThreadAction={handleThreadAction}
      onThreadUpdate={handleThreadUpdate}
      onTotal={isCard ? setListTotal : undefined}
    />
  )

  const threadDetail = selectedThread ? (
    <EmailThreadDetail
      threadId={selectedThread.provider_thread_id}
      accountId={selectedThread.account_id ?? null}
      // The draft the card opened on, while its own thread is the one open.
      focusDraftId={cardInit?.draftId && selectedThread.provider_thread_id === cardInit.threadId ? cardInit.draftId : null}
      reloadKey={selectedThreadReloadKey}
      isStarred={selectedThread.is_starred}
      onThreadUpdate={handleThreadUpdate}
      onClose={() => setSelectedThread(null)}
      onPrev={canGoPrev ? handlePrevThread : undefined}
      onNext={canGoNext ? handleNextThread : undefined}
      onReplyRequest={onReplyRequest}
      onDraftSent={handleDraftSent}
      onDraftDiscarded={handleDraftDiscarded}
      ownAddresses={ownAddresses}
    />
  ) : null

  // A card in the chat: its own slim row (the card's header is its title), no
  // saved views; inline one pane (the list, or the open thread), full screen
  // the page's two panes.
  // `ph-no-capture` on both roots: PostHog session replay blocks the whole
  // subtree (rrweb blockClass) and autocapture skips it. Native Intelligence never stores
  // mail text, and a replay would.
  if (isCard) {
    // Full screen from `md` up, the Mail sub-nav beside the rail is the
    // card's one account and folder control (Liam, 11-11: "did you actually
    // clean up the old one and remove it from the panel complely or did you
    // do something the lazy way?"): these two exist only below `md` (the
    // phone's layout, no rail, no sub-nav), in CSS, so the browser decides
    // before the first paint and nothing shows then goes. Only while that
    // sub-nav is on screen, though (Liam, 11-11): with a capture's notepad
    // on the left, the panel closed, or the card opened from home (Recent
    // beside it), they are the card's own again. Inline in the chat (no
    // sub-nav beside it) they are the card's own, as always.
    const ownNav = card?.fullScreen && mailSubnavShown ? 'contents md:hidden' : 'contents'
    return (
      <div ref={rootRef} className="ph-no-capture flex h-full flex-col" data-mail-card="">
        <div className="flex h-9 shrink-0 items-center gap-1.5 px-3">
          <div data-mail-own-nav="" className={ownNav}>
            {accountFilter}
            {folderSelect}
          </div>
          <button
            type="button"
            aria-pressed={unreadOnly}
            data-unread-toggle=""
            onClick={() => setUnreadOnly((v) => !v)}
            className={cn(
              'h-7 rounded-full border px-2.5 text-xs transition-colors',
              unreadOnly ? 'border-foreground/20 bg-foreground/10 font-medium text-foreground' : 'border-border text-muted-foreground hover:bg-muted/50',
            )}
          >
            Unread
          </button>
          <div className="flex-1" />
          {searchBox}
          {composeButton}
        </div>
        {card?.fullScreen ? (
          <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0">
            <ResizablePanel id="email-card-list" defaultSize={35} minSize={20}>
              <div className="h-full overflow-hidden">{threadList}</div>
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel id="email-card-detail" defaultSize={65} minSize={20}>
              {threadDetail ?? (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Choose an email to read it here</div>
              )}
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          <div className="min-h-0 flex-1 overflow-hidden">{threadDetail ?? threadList}</div>
        )}
      </div>
    )
  }

  return (
    <div ref={rootRef} className="ph-no-capture flex h-full flex-col">
      {/* Row 1: Main header — title + actions */}
      <>
        <div ref={titleRowRef} className={cn('relative flex h-12 shrink-0 items-center gap-1.5 px-5')}>
          <PageTitle label="Mail" as="h2" />
          <div className="flex shrink-0 items-center gap-2">
            {accountFilter}
            {folderSelect}
          </div>

          <div className="flex-1" />

          {searchBox}

          <div className="flex shrink-0 items-center gap-1">
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={handleSync}
                  disabled={isSyncBusy}
                  aria-label={importLabel}
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', isSyncBusy && 'animate-spin')} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{importLabel}</TooltipContent>
            </Tooltip>
          </TooltipProvider>

          {composeButton}
          </div>
        </div>
      </>

      {/* Two-panel split: list | detail */}
      <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0">
        <ResizablePanel id="email-list" defaultSize={35} minSize={20}>
          <div className="flex h-full flex-col">
            {/* Custom views toolbar */}
            <ViewToolbar
              entityType="email_thread"
              views={views}
              activeViewId={activeViewId}
              onViewChange={setActiveViewId}
              onCreateView={createView}
              onUpdateView={updateView}
              onDuplicateView={duplicateView}
              onDeleteView={deleteView}
              config={config}
              onConfigChange={updateConfig}
              isDirty={isDirty}
              overrides={overrides}
              onSaveDraft={saveOverrides}
              onDiscardDraft={discardOverrides}
            />

            {/* Thread list */}
            <div className="flex-1 overflow-hidden">
              {threadList}
            </div>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel id="email-detail" defaultSize={65} minSize={20}>
          {threadDetail ?? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <div className="text-center">
                <Mail className="h-12 w-12 mx-auto mb-3 opacity-20" />
                <p className="text-sm font-medium">It&apos;s empty here</p>
                <p className="text-xs mt-1">Choose an email to view details</p>
                <div className="flex items-center justify-center gap-2 mt-4">
                  <Button variant="outline" size="sm" onClick={() => document.dispatchEvent(new Event('open-create-email'))}>
                    <Pencil className="h-3.5 w-3.5 mr-1.5" />
                    Send email
                  </Button>
                </div>
              </div>
            </div>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>

    </div>
  )
}
