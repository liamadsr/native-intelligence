'use client'

/**
 * The person's coding chats as their own list, for where Recent is not on
 * screen (docs/plans/one-home.md: the panel closed, a narrow window, a
 * phone): a new coding chat's clear middle draws it (chat/code-chat-stage.tsx),
 * so a chat can always be picked. Where Recent shows, the coding chats are
 * its rows (home-recents.tsx): this was Home's whole left panel on Code
 * before (Liam, 11-16), and is no longer.
 *
 *   What    every coding job of the person's in the workspace (code-chats-
 *           model.ts; Liam, 11-20: "any chat/agent that's working on
 *           something including the ones that were started from an action
 *           item"), newest first, in the recents' sections.
 *   A row   the request's first line (an action's job: the action's
 *           identifier and title), its folder for the pointer, and a short
 *           time; a dot while its agent waits on the person's answer, a
 *           quiet pulse while it works.
 *   Open    a click makes it the current chat (chat/current-chat-store.ts).
 *
 * Flat cost: one read when it comes on screen, on window focus while it
 * shows, and when a chat starts here (code-chats-store.ts). No timer.
 * Fail-soft: a failed read keeps the last list. `ph-no-capture`: a request
 * can be private.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Code2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { fetchSessions } from '@/components/local-agent/session-api'
import { openCodingChat } from '../chat/current-chat-store'
import { useCodeView } from '../chat/use-code-view'
import { getClientWorkspaceId } from '@/lib/workspace-fetch'
import { RECENTS_PAGE, groupRecents, shortRecentTime, type RecentGroup } from './recents-model'
import { codeChatsOf, type CodeChatItem } from './code-chats-model'
import { codeChatsVersion, subscribeCodeChats } from './code-chats-store'

/** The rail's lit tint (home-recents.tsx ROW_LIT), for the selected chat's row. */
const ROW_LIT = 'bg-foreground/[0.08] hover:bg-foreground/[0.08]'

/** The list under the recents' section headings (recents-model.ts groupRecents), newest first, empty ones left out. */
export function groupCodeChats(items: readonly CodeChatItem[], now: Date): RecentGroup<CodeChatItem>[] {
  return groupRecents(items, now)
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
 * The list itself: the chats under the recents' sections, and Show more.
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
  const open = useCallback((item: CodeChatItem) => openCodingChat(item.sessionId, { from: 'list' }), [])
  return (
    <>
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
