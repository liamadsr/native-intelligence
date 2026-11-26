'use client'

/**
 * The `;` menu (docs/plans/snippets.md): the person's snippets, narrowed by
 * what is typed after the `;`, opened at the text being typed. It looks and
 * answers keys as the `@` picker does (chat/command-menu.tsx): the same
 * rounded popover, rows with a tile, a title and a line under it, and the
 * footer of keys. ↑ ↓ move, ↵ or Tab inserts, Esc closes.
 *
 * The host keeps the focus: it hands its keys to `menuRef.handleKey` while the
 * menu shows (true: taken). Nothing runs while it is closed.
 */
import { useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { TextQuote, Users } from 'lucide-react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { filterSnippets } from '@/lib/snippets/match'
import { snippetPreview, type Snippet } from '@/lib/snippets/types'
import { PALETTE_ENTRANCE_EASING } from '@/lib/motion/palette-entrance'
import { prefersReducedMotion } from '@/lib/media-query'

export interface SnippetMenuHandle {
  /** A key pressed in the host's field. True: the menu took it. */
  handleKey: (e: KeyboardEvent | React.KeyboardEvent) => boolean
}

export interface SnippetMenuProps {
  open: boolean
  query: string
  snippets: readonly Snippet[]
  onPick: (snippet: Snippet) => void
  onDismiss: () => void
  /** Where the `;…` is (a real element, or a zero-size one placed over it). */
  anchorRef: React.RefObject<HTMLElement | null>
  menuRef?: React.Ref<SnippetMenuHandle>
  /** Which side of the anchor it opens on (a chat box: above; a document: below). */
  side?: 'top' | 'bottom'
  width?: number
  /** As wide as the anchor, less a little (a chat box), instead of `width`. */
  fitAnchor?: boolean
}

const TILE = 'flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground group-aria-selected:bg-background'

export function SnippetMenu({ open, query, snippets, onPick, onDismiss, anchorRef, menuRef, side = 'bottom', width = 380, fitAnchor = false }: SnippetMenuProps) {
  const rows = useMemo(() => filterSnippets(snippets, query), [snippets, query])
  const [highlighted, setHighlighted] = useState(0)
  const listId = useId()
  const listRef = useRef<HTMLDivElement>(null)
  // A new query starts at the top.
  const [seenQuery, setSeenQuery] = useState(query)
  if (seenQuery !== query) {
    setSeenQuery(query)
    setHighlighted(0)
  }
  const index = Math.min(highlighted, Math.max(rows.length - 1, 0))

  const shown = open && rows.length > 0

  useImperativeHandle(
    menuRef,
    () => ({
      handleKey: (e) => {
        if (!shown) return false
        if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
          setHighlighted((i) => (Math.min(i, rows.length - 1) + 1) % rows.length)
          return true
        }
        if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
          setHighlighted((i) => (Math.min(i, rows.length - 1) - 1 + rows.length) % rows.length)
          return true
        }
        if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
          if ('isComposing' in e && e.isComposing) return false
          onPick(rows[index])
          return true
        }
        if (e.key === 'Escape') {
          onDismiss()
          return true
        }
        return false
      },
    }),
    [shown, rows, index, onPick, onDismiss],
  )

  // The highlighted row stays in view.
  useEffect(() => {
    if (!shown) return
    listRef.current?.querySelector<HTMLElement>(`[data-snippet-index="${index}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [shown, index])

  const [fitWidth, setFitWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (!shown || !anchorRef.current) return
    const rect = anchorRef.current.getBoundingClientRect()
    if (fitAnchor) setFitWidth(Math.max(rect.width - 16, 260))
  }, [shown, anchorRef, side, query, fitAnchor])
  const menuWidth = fitAnchor && fitWidth ? fitWidth : width

  const keepFocus = (e: { preventDefault: () => void }) => e.preventDefault()
  if (!shown) return null
  return (
    <Popover open>
      <PopoverAnchor virtualRef={anchorRef as React.RefObject<HTMLElement>} />
      <PopoverContent
        side={side}
        align={fitAnchor ? 'center' : 'start'}
        sideOffset={6}
        data-snippet-menu=""
        className="flex flex-col overflow-hidden rounded-3xl border border-border bg-popover p-0 text-popover-foreground shadow-lg"
        style={{ width: Math.min(menuWidth, typeof window === 'undefined' ? menuWidth : window.innerWidth - 32), maxHeight: 'min(400px, var(--radix-popover-content-available-height))' }}
        onOpenAutoFocus={keepFocus}
        onCloseAutoFocus={keepFocus}
        onInteractOutside={keepFocus}
        onEscapeKeyDown={keepFocus}
        onMouseDown={keepFocus}
      >
        <Entrance>
          <div className="flex items-center justify-between px-4 pb-1 pt-3 text-[11px] font-medium text-muted-foreground">
            <span>Snippets</span>
            {query && <span className="font-mono">;{query}</span>}
          </div>
          <div ref={listRef} id={listId} role="listbox" aria-label="Snippets" className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-2 pb-2">
            {rows.map((s, i) => (
              <SnippetRow key={s.id} snippet={s} index={i} active={i === index} onHighlight={setHighlighted} onPick={onPick} />
            ))}
          </div>
          <div className="flex shrink-0 items-center gap-3 overflow-hidden whitespace-nowrap border-t border-border px-3.5 py-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              <span className="ml-0.5">move</span>
            </span>
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd>
              <span className="ml-0.5">insert</span>
            </span>
            <span className="ml-auto flex items-center gap-1">
              <Kbd>esc</Kbd>
              <span className="ml-0.5">close</span>
            </span>
          </div>
        </Entrance>
      </PopoverContent>
    </Popover>
  )
}

function SnippetRow({
  snippet,
  index,
  active,
  onHighlight,
  onPick,
}: {
  snippet: Snippet
  index: number
  active: boolean
  onHighlight: (i: number) => void
  onPick: (s: Snippet) => void
}) {
  const Icon = snippet.visibility === 'workspace' ? Users : TextQuote
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      data-snippet-index={index}
      data-snippet-shortcut={snippet.shortcut}
      onMouseMove={(e) => {
        if (!active && (e.movementX || e.movementY)) onHighlight(index)
      }}
      onClick={() => onPick(snippet)}
      className={cn(
        'group flex w-full items-center gap-3 rounded-xl px-2.5 py-1.5 text-left text-sm outline-none',
        active ? 'bg-accent text-accent-foreground' : 'text-foreground',
      )}
    >
      <span className={TILE} title={snippet.visibility === 'workspace' ? 'Shared with the workspace' : 'Yours'}>
        <Icon className="size-4" strokeWidth={1.75} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{snippet.name}</span>
        <span className="truncate text-xs text-muted-foreground">{snippetPreview(snippet.body)}</span>
      </span>
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">;{snippet.shortcut}</span>
      {active && (
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
          <Kbd>↵</Kbd>
          insert
        </span>
      )}
    </button>
  )
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-border bg-muted/60 px-1 font-sans text-[10px] font-medium text-muted-foreground">
      {children}
    </kbd>
  )
}

/** The `@` menu's arrival: a short rise and fade, once (none under reduced motion). */
function Entrance({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof el.animate !== 'function') return
    if (prefersReducedMotion()) return
    el.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 140, easing: PALETTE_ENTRANCE_EASING })
  }, [])
  return (
    <div ref={ref} className="flex min-h-0 flex-1 flex-col">
      {children}
    </div>
  )
}
