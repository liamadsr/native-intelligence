'use client'

/**
 * Home's panel while the main composer is on Code (Liam, 11-16: "a new
 * coding view where if you start a new coding chat you'd see it in the
 * recent panel on the side and you see page for the coding details as you do
 * now"): the person's coding chats in place of the recents, in the recents'
 * own look (home-recents.tsx: the same frame, sections by day, rows).
 *
 *   What    every coding job of the person's in the workspace (code-chats-
 *           model.ts; Liam, 11-20: "any chat/agent that's working on
 *           something including the ones that were started from an action
 *           item"), newest first, in the recents' sections.
 *   A row   the request's first line (an action's job: the action's
 *           identifier and title), its folder for the pointer, and a short
 *           time; a dot while its agent waits on the person's answer, a
 *           quiet pulse while it works.
 *   Open    a click selects it: its conversation shows in the middle and
 *           its details in the right panel (chat/code-view-store.ts), in the
 *           dashboard itself, whoever does the work. The selected one's row
 *           is lit. "New chat" at the top clears the selection: the next
 *           send starts a new one.
 *   Empty   nothing at all: no panel (Liam's "hide empty widgets").
 *
 * Flat cost: one read when the panel comes on screen in the Code view, on
 * window focus while it shows, when a chat starts here (code-chats-store.ts)
 * and when a card in front closes. No timer. Fail-soft: a failed read keeps
 * the last list. `ph-no-capture`: a request can be private.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Code2, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { fetchSessions } from '@/components/local-agent/session-api'
import { selectCodeChat } from '../chat/code-view-store'
import { useCodeView } from '../chat/use-code-view'
import { useScrollFades } from '@/components/attention/scroll-fades'
import { getClientWorkspaceId } from '@/lib/workspace-fetch'
import { PagePanelFrame } from './page-panel-frame'
import { RECENTS_PAGE, RECENT_GROUP_LABEL, recentGroupOf, shortRecentTime, type RecentGroupKey } from './recents-model'
import { codeChatsOf, type CodeChatItem } from './code-chats-model'
import { codeChatsVersion, subscribeCodeChats } from './code-chats-store'
import type { PagePanelProps } from './page-panel-types'

/** The rail's lit tint (home-recents.tsx ROW_LIT), for the selected chat's row. */
const ROW_LIT = 'bg-foreground/[0.08] hover:bg-foreground/[0.08]'

const GROUP_ORDER: readonly RecentGroupKey[] = ['evening', 'afternoon', 'morning', 'yesterday', 'week', 'month', 'older']

/** The list under the recents' section headings, newest section first, empty ones left out. */
export function groupCodeChats(items: readonly CodeChatItem[], now: Date): Array<{ key: RecentGroupKey; label: string; items: CodeChatItem[] }> {
  const by = new Map<RecentGroupKey, CodeChatItem[]>()
  for (const item of items) {
    const key = recentGroupOf(item.at, now)
    const list = by.get(key)
    if (list) list.push(item)
    else by.set(key, [item])
  }
  return GROUP_ORDER.filter((key) => by.has(key)).map((key) => ({ key, label: RECENT_GROUP_LABEL[key], items: by.get(key)! }))
}

interface Read {
  workspaceId: string | null
  items: CodeChatItem[]
  readAt: Date | null
}

/** The person's coding chats, read as the header says. */
export function useCodeChats(active: boolean, frontId: string | null): { items: CodeChatItem[]; readAt: Date | null } {
  const workspaceId = getClientWorkspaceId()
  const [state, setState] = useState<Read>({ workspaceId, items: [], readAt: null })
  const inFlight = useRef(false)
  const again = useRef(false)
  const read = useCallback(async (): Promise<void> => {
    if (inFlight.current) {
      again.current = true
      return
    }
    inFlight.current = true
    const forWorkspace = getClientWorkspaceId()
    try {
      const res = await fetchSessions()
      // The window moved to another workspace meanwhile, or the read failed: the last list stands.
      if (!res.ok || getClientWorkspaceId() !== forWorkspace) return
      setState({ workspaceId: forWorkspace, items: codeChatsOf(res.value), readAt: new Date() })
    } finally {
      inFlight.current = false
      if (again.current) {
        again.current = false
        void read()
      }
    }
  }, [])

  // A chat started here: read again.
  const version = useSyncExternalStore(subscribeCodeChats, codeChatsVersion, codeChatsVersion)
  useEffect(() => {
    if (!active) return
    void read()
    const onFocus = () => void read()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [active, workspaceId, version, read])
  // The page in front closing (or another taking its place): what it did moves up.
  const lastFront = useRef(frontId)
  useEffect(() => {
    const was = lastFront.current
    lastFront.current = frontId
    if (active && was !== null && was !== frontId) void read()
  }, [active, frontId, read])

  // Another workspace's list never shows.
  const mine = state.workspaceId === workspaceId
  return { items: mine ? state.items : [], readAt: mine ? state.readAt : null }
}

/**
 * The list itself: New chat, then the chats under the recents' sections, and
 * Show more. In the panel beside the navigation (CodeChatsPanel), and in the
 * Code view's middle where that panel isn't on screen (a narrow window, or
 * the panel closed: chat/code-chat-stage.tsx), so a chat can always be picked.
 */
export function CodeChatsRows({ items, readAt, onLimit }: { items: readonly CodeChatItem[]; readAt: Date; onLimit?: (shown: number) => void }) {
  const [limit, setLimit] = useState(RECENTS_PAGE)
  const windowed = useMemo(() => items.slice(0, limit), [items, limit])
  const groups = useMemo(() => groupCodeChats(windowed, readAt), [windowed, readAt])
  const rest = items.length - windowed.length
  useEffect(() => {
    onLimit?.(windowed.length)
  }, [onLimit, windowed.length])
  const { selected } = useCodeView()
  const open = useCallback((item: CodeChatItem) => selectCodeChat(item.sessionId), [])
  return (
    <>
      {/* A new chat: nothing selected, so the next send starts one. */}
      <button
        type="button"
        data-code-chats-new=""
        aria-pressed={selected === null}
        onClick={() => selectCodeChat(null)}
        className={cn(
          'flex h-8 w-full items-center gap-2.5 rounded-xl px-2 text-left text-[13px] text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none',
          selected === null ? ROW_LIT : 'hover:bg-muted/60',
        )}
      >
        <span aria-hidden className="flex w-4 shrink-0 items-center justify-center text-muted-foreground">
          <Plus className="size-4" strokeWidth={1.75} />
        </span>
        New chat
      </button>
      {groups.map((group) => (
        <section key={group.key} data-code-chats-group={group.key} aria-labelledby={`code-chats-${group.key}`}>
          <h3 id={`code-chats-${group.key}`} className="px-2 pb-1 pt-1 text-[11px] font-medium text-muted-foreground">
            {group.label}
          </h3>
          <ul className="flex flex-col">
            {group.items.map((item) => (
              <li key={item.key}>
                <button
                  type="button"
                  data-code-chat={item.key}
                  data-code-chat-needs-you={item.needsYou ? '' : undefined}
                  data-code-chat-working={item.working ? '' : undefined}
                  aria-current={item.key === selected ? 'true' : undefined}
                  onClick={() => open(item)}
                  title={[item.action?.identifier, item.title, item.folder].filter(Boolean).join(' · ')}
                  className={cn(
                    'flex h-8 w-full items-center gap-2.5 rounded-xl px-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none',
                    item.key === selected ? ROW_LIT : 'hover:bg-muted/60',
                  )}
                >
                  <span aria-hidden className="flex w-4 shrink-0 items-center justify-center text-muted-foreground">
                    <Code2 className={cn('size-4', item.working && 'motion-safe:animate-pulse')} strokeWidth={1.75} />
                  </span>
                  <span className={cn('min-w-0 flex-1 truncate text-[13px] text-foreground', item.needsYou && 'font-medium')}>
                    {/* The action it works, by its identifier: which actions are being worked on. */}
                    {item.action?.identifier && (
                      <span data-code-chat-row-action={item.action.id} className="mr-1.5 text-[11px] font-normal tabular-nums text-muted-foreground">
                        {item.action.identifier}
                      </span>
                    )}
                    {item.title}
                  </span>
                  {item.needsYou && (
                    <span className="size-1.5 shrink-0 rounded-full bg-primary">
                      <span className="sr-only">, needs your answer</span>
                    </span>
                  )}
                  {item.working && !item.needsYou && <span className="sr-only">, working</span>}
                  <time dateTime={item.at} className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {shortRecentTime(item.at, readAt)}
                  </time>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {rest > 0 && (
        <button
          type="button"
          data-code-chats-more=""
          onClick={() => setLimit((n) => n + RECENTS_PAGE)}
          className="mx-0.5 mb-0.5 inline-flex h-7 items-center justify-center rounded-full border border-border/60 bg-background/70 text-xs font-medium text-muted-foreground transition-colors hover:bg-background/85 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none dark:border-white/10"
        >
          Show {Math.min(RECENTS_PAGE, rest)} more
        </button>
      )}
    </>
  )
}

export function CodeChatsPanel({ active, mode, front, onContent, shown = true }: PagePanelProps & { shown?: boolean }) {
  const { items, readAt } = useCodeChats(active, front?.id ?? null)
  const has = items.length > 0 && readAt !== null
  const known = readAt !== null
  useEffect(() => {
    onContent('home', known ? has : null)
  }, [known, has, onContent])
  const [drawn, setDrawn] = useState(0)
  const fades = useScrollFades<HTMLDivElement>(drawn)

  if (!shown || !has || !readAt) return null
  return (
    <PagePanelFrame mode={mode} active={active} label="Coding chats" page="home">
      <div
        ref={fades.scrollerRef}
        onScroll={fades.onScroll}
        data-recents-scroller=""
        data-recents-fades={fades.which}
        className="min-h-0 overflow-y-auto overscroll-contain px-1.5 py-2.5 scrollbar-hide-deep [overflow-anchor:none]"
        style={fades.style}
      >
        <div ref={fades.contentRef} data-code-chats="" className="ph-no-capture flex flex-col gap-3">
          <CodeChatsRows items={items} readAt={readAt} onLimit={setDrawn} />
        </div>
      </div>
    </PagePanelFrame>
  )
}
