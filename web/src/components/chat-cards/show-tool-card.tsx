'use client'

/**
 * A page in the chat (docs/plans/one-agent-and-chat-pages.md, "The card"):
 * what a `show` result draws in a reply. Three states, as in Liam's reference:
 *
 *   inline      the page at a fixed height (about 420px), at the reading
 *               column's full width, under a slim header (Back and Forward,
 *               title, the page's search and Properties, Save as view), with
 *               big round Full screen and Close buttons over its corner;
 *   full screen the same card over the whole window, everything else blurred
 *               behind it (in the dashboard, beside the app rail, on the
 *               app's own background instead: front-card.ts); the X, the
 *               button under it, a click outside it or Esc puts it back;
 *   collapsed   one line, "Showed 12 actions · Due this week".
 *
 * Only the newest three cards in a chat are live (older ones fold to their
 * pill and mount again when expanded), and a card mounts only once it scrolls
 * into view. Its page then stays mounted, but far from what the chat shows a
 * while, it goes dormant (display: none) inside its fixed-height frame, and
 * wakes before it scrolls back into view. In a narrow host (the bot bubble, a
 * run chat) a card is its pill, and a click opens it full screen.
 *
 * This file is the light half (the frame); the page itself (./card-body.tsx)
 * loads lazily, the first time a card mounts. The frame owns the card's
 * history (./card-history.tsx), so a move to full screen and back keeps it;
 * the page reaches the header through its slots (./card-header-slot.tsx).
 * The page itself stays mounted across that move: it lives in a DOM node of
 * its own that moves between the inline frame and the full-screen layer
 * (BodySlot), so a calendar or a mailbox never loads again on the way.
 *
 * Every card is glass, as a window was: a translucent, blurred layer of its
 * own behind the content.
 *
 * A page the person opened (from `/`, a chip, a notification…) is not drawn
 * in the chat at all: it opens full screen, and its X puts it away. Its
 * ShowToolCard (`place="kept"`) is mounted by the chat's kept-card host
 * (chat/kept-card-host.tsx) only while it is full screen, docked beside the
 * chat (the live capture's), or one of the pages visited last. It draws
 * nothing of its own then but its full screen and its page, parked out of
 * sight at its full-screen size, so opening one again never loads it again.
 * Parked a while, the page goes dormant (display: none: no style or layout
 * work at all) and wakes, still out of sight, before it shows again.
 *
 * Each card redraws only when its own draw state changes (the store's
 * drawKey), not on every change to any card in the chat.
 */
import * as React from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { Bookmark, CalendarDays, LayoutList, Mail, Maximize2, Minimize2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { countLabel, type CardSpec } from '@/lib/chat-cards/kinds'
import type { EditionDefinition } from '@/lib/editions/manifest'
import { useWorkspaceEdition } from '@/app/account/workspace-switcher'
import type { ViewConfig } from '@/components/views/hooks/use-view'
import { announceViewsChanged } from '@/lib/views/views-changed'
import { ListenFramePulseHere, ListenFrameRegistry } from '@/components/read-aloud/listen-frame'
import { ListenModeToggle } from '@/components/read-aloud/listen-mode-toggle'
import { useChatCardHost } from './card-host'
import { CARD_FRAME_ATTR } from './card-frame-attr'
import { FULL_SCREEN_CONTROL_ATTR, isOutsideCardPress } from './outside-card-press'
import { ChatCardStore } from './card-store'
import { CardHistoryButtons, CardHistoryProvider, cardOwnsHistoryKeys, isHistoryKey } from './card-history'
import { CardHeaderSlotsProvider, type CardHeaderSlots } from './card-header-slot'
import { CARD_HEADER_ICON_BUTTON } from './card-header-button'
import { useLiveCaptureDockSlot } from './card-dock-slot'
import { CARD_GLASS_FRAME, CardGlass } from './card-glass'
import { holdFrontCard } from './front-card'


const CardBody = React.lazy(() => import('./card-body'))

/** The inline card's height. */
export const INLINE_CARD_HEIGHT = 420

function countText(spec: CardSpec, count: number | null, edition: EditionDefinition): string {
  return countLabel(spec, count, edition)
}

/** The kind's icon, in the header and the pill. */
function KindIcon({ spec, className }: { spec: CardSpec; className: string }) {
  if (spec.kind === 'calendar') return <CalendarDays className={className} strokeWidth={1.75} />
  if (spec.kind === 'mail') return <Mail className={className} strokeWidth={1.75} />
  return <LayoutList className={className} strokeWidth={1.75} />
}

/** Mount once on screen; until then, nothing heavy. */
function useSeen(ref: React.RefObject<HTMLElement | null>, active: boolean): boolean {
  const [seen, setSeen] = React.useState(false)
  React.useEffect(() => {
    if (!active || seen) return
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      setSeen(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true)
          observer.disconnect()
        }
      },
      { rootMargin: '200px 0px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, active, seen])
  return seen
}

/** The nearest ancestor that scrolls vertically (the chat's scroller); null: the window does. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const overflowY = getComputedStyle(p).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') return p
  }
  return null
}

/**
 * Is the card within about a window's height of what its chat shows? Observed
 * on the chat's own scroller: on the window's, the scroller clips a card out
 * of sight to nothing, whatever the margin. The margin is in px, the only unit
 * WebKit takes there. Without an IntersectionObserver, always near.
 */
function useNearView(ref: React.RefObject<HTMLElement | null>, active: boolean): boolean {
  const [near, setNear] = React.useState(true)
  React.useEffect(() => {
    const el = ref.current
    if (!active || !el || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1]
        if (entry) setNear(entry.isIntersecting)
      },
      { root: scrollParent(el), rootMargin: `${Math.round(window.innerHeight)}px 0px` },
    )
    observer.observe(el)
    return () => {
      observer.disconnect()
      setNear(true)
    }
  }, [ref, active])
  return near
}

/**
 * Every card's ⌘/Ctrl+[ and ] handler, behind ONE window listener rather than
 * one per card in the chat. Each handler is asked in turn, as their own
 * listeners were, until one takes the key (defaultPrevented).
 */
const historyKeyHandlers = new Set<(e: KeyboardEvent) => void>()

function onHistoryKey(e: KeyboardEvent): void {
  if (isHistoryKey(e) === null) return
  for (const handle of [...historyKeyHandlers]) {
    if (e.defaultPrevented) return
    handle(e)
  }
}

function addHistoryKeyHandler(handle: (e: KeyboardEvent) => void): () => void {
  if (!historyKeyHandlers.size) window.addEventListener('keydown', onHistoryKey)
  historyKeyHandlers.add(handle)
  return () => {
    historyKeyHandlers.delete(handle)
    if (!historyKeyHandlers.size) window.removeEventListener('keydown', onHistoryKey)
  }
}

/** Is another layer (a popover, a menu, a dialog) open, which Esc should close first? */
function anotherLayerOpen(): boolean {
  // `data-chat-card-layer`: a page's own layer inside a card (the flow canvas).
  return !!document.querySelector(
    '[data-radix-popper-content-wrapper], [role="dialog"][data-state="open"], [role="menu"][data-state="open"], [data-chat-card-layer]',
  )
}

function HeaderButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`inline-flex size-7 items-center justify-center ${CARD_HEADER_ICON_BUTTON}`}
    >
      {children}
    </button>
  )
}

/**
 * The card's own big controls, round and dark over its corner (Liam's
 * reference), so that a card can be opened full screen, or put away, reads at
 * a glance rather than hiding among the header's small buttons.
 */
function OverlayButton({ label, onClick, testId, children }: { label: string; onClick: () => void; testId?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      data-testid={testId}
      className="pointer-events-auto inline-flex size-11 items-center justify-center rounded-full bg-foreground/90 text-background shadow-lg shadow-black/20 backdrop-blur-sm transition-colors hover:bg-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      {children}
    </button>
  )
}

/**
 * A full-screen card's size: a wide screen (16:10) as large as the window
 * allows, up to 1440px across, centred. Filling the height under a width cap
 * turned it near square on a big window. The stage is a size container, so
 * the card's width can read the room's height: the width that keeps 16:10
 * within it, less the controls' row under the card.
 *
 * Narrow windows (a phone, a desktop window dragged thin) are the exception:
 * there the WINDOW's width is what stops the card, and holding 16:10 left it
 * a short strip with dead space above and below (Liam, 10-25). So the card
 * takes the room's full height once the window's width binds, and grows
 * taller the narrower the window gets. The height
 *
 *   max(width / 1.6,  room - (100cqw - width) * 10)
 *
 * is 16:10 whenever the 1440px cap binds (100cqw runs past the card's width,
 * so the second term falls away within a few pixels), the full room whenever
 * the window's width binds (100cqw IS the card's width), and the full room
 * too when the room's height binds (16:10 of it is the room). Continuous,
 * no breakpoint to jump at.
 */
const FULL_SCREEN_STAGE = 'flex min-h-0 w-full flex-1 items-center justify-center [container-type:size]'
const FULL_SCREEN_COLUMN = 'flex flex-col'
/**
 * The column and the frame's size, for a room: the stage less the controls'
 * row under the card (a card from the chat: its Minimize), or less a small
 * margin (a page the person opened: no row, its X is in its header).
 * Plain inline CSS (not Tailwind arbitrary values), so the math is exactly
 * what reaches the browser.
 */
function fullScreenSizes(room: string): { column: React.CSSProperties; frame: React.CSSProperties } {
  /** The card's width: 16:10 of the room, the 1440px cap, or the window's width. */
  const width = `min(100cqw, 1440px, calc(${room} * 1.6))`
  return {
    column: { width },
    frame: { height: `max(calc(${width} / 1.6), calc(${room} - (100cqw - ${width}) * 10))` },
  }
}
const FULL_SCREEN_WITH_CONTROLS = fullScreenSizes('calc(100cqh - 3.75rem)')
const FULL_SCREEN_PAGE = fullScreenSizes('calc(100cqh - 1rem)')
/** The full-screen layer: the window from the app rail's edge and under its header (rail/app-rail.tsx; 0 without the rail). */
const FULL_SCREEN_LAYER_STYLE: React.CSSProperties = { left: 'var(--app-rail-w, 0px)', top: 'var(--app-header-bottom, 0px)' }
/** The row under the card (the button and its gap: 3.75rem, as the column allows). */
const FULL_SCREEN_CONTROLS = 'flex h-[3.75rem] shrink-0 items-end justify-end gap-2'

/**
 * A parked page's size before it was ever full screen (the live capture's,
 * docked first): about a full-screen card's on a laptop.
 */
const PARKED_SIZE = { width: 1200, height: 690 }

/**
 * Interactive (listen mode) over a full-screen card, top right: the top bar's
 * own toggle is under the card's layer, and its controls (the mic, Next)
 * should stay at hand while a card is in front. It reads the app's listen
 * state, so it is the same switch as the bar's.
 */
function FullScreenInteractive() {
  return (
    <div {...{ [FULL_SCREEN_CONTROL_ATTR]: '' }} className="absolute right-4 top-3 z-10 flex items-center">
      <ListenModeToggle />
    </div>
  )
}

/** Save the card as a named saved view: the person's page, with their changes. */
function SaveAsView({ spec, configRef }: { spec: CardSpec; configRef: React.RefObject<ViewConfig | null> }) {
  const [naming, setNaming] = React.useState(false)
  const [name, setName] = React.useState(spec.title)
  const [saving, setSaving] = React.useState(false)
  if (spec.kind !== 'list') return null

  const save = async () => {
    const trimmed = name.trim()
    if (!trimmed || saving) return
    setSaving(true)
    const c = configRef.current
    const body = {
      name: trimmed,
      entity_type: spec.entity_type,
      visibility: 'personal',
      layout: c?.layout ?? spec.layout ?? 'list',
      filters: c?.filters ?? spec.filters.map((f, i) => ({ id: `card-${i}`, ...f })),
      grouping: c ? c.grouping : (spec.grouping ?? null),
      ordering: c?.ordering ?? spec.ordering ?? [],
      ...(c?.display_properties ? { display_properties: c.display_properties } : spec.columns ? { display_properties: spec.columns } : {}),
      // The completed-items setting the person sees.
      ...(c ? { completed_filter: c.completed_filter, show_completed: c.show_completed } : {}),
    }
    try {
      const res = await fetch('/api/account/views', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) throw new Error(String(res.status))
      toast.success(`Saved as view “${trimmed}”`)
      // The card's views menu (and any page's tabs) pick the new view up.
      announceViewsChanged()
      setNaming(false)
    } catch {
      toast.error('Could not save the view. Try again.')
    } finally {
      setSaving(false)
    }
  }

  if (!naming) {
    return (
      <HeaderButton label="Save as view" onClick={() => setNaming(true)}>
        <Bookmark className="size-3.5" strokeWidth={1.75} />
      </HeaderButton>
    )
  }
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            setNaming(false)
          }
        }}
        aria-label="View name"
        className="h-6 w-40 rounded-md border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
      />
      <button type="submit" disabled={saving || !name.trim()} className="h-6 rounded-md px-2 text-xs font-medium hover:bg-muted disabled:opacity-50">
        Save
      </button>
    </form>
  )
}

/**
 * The card's page lives in a DOM node of its own, made once per card and moved
 * between the inline frame and the full-screen layer (BodySlot), so the page in
 * it stays the same instance across the move: no remount, nothing fetched
 * again. Its React home never moves (see ShowToolCard's return).
 */
function useBodyHost(): HTMLDivElement | null {
  const [host] = React.useState(() => {
    if (typeof document === 'undefined') return null
    const el = document.createElement('div')
    el.className = 'h-full min-h-0'
    el.setAttribute('data-card-body-host', '')
    return el
  })
  return host
}

/** Scroll offsets inside a page between its slots: a node out of the document forgets them. */
const keptScroll = new WeakMap<HTMLElement, Array<[Element, number, number]>>()

/** A dormant page's node (display: none): it has no offsets to read, so its saved ones stand. */
const dormantHosts = new WeakSet<HTMLElement>()

function readScroll(host: HTMLElement): Array<[Element, number, number]> {
  const scrolled: Array<[Element, number, number]> = []
  for (const el of host.querySelectorAll('*')) if (el.scrollTop || el.scrollLeft) scrolled.push([el, el.scrollTop, el.scrollLeft])
  return scrolled
}

function restoreScroll(host: HTMLElement): void {
  for (const [el, top, left] of keptScroll.get(host) ?? []) {
    el.scrollTop = top
    el.scrollLeft = left
  }
}

/**
 * display: none cancels a page's CSS animations, and showing it starts them
 * over: a row's fade-in would play again on a page long since drawn. A woken
 * page's one-shot animations end where they ended before; endless ones (a
 * spinner) just run.
 */
function finishOneShotAnimations(host: HTMLElement): void {
  if (typeof host.getAnimations !== 'function') return
  for (const animation of host.getAnimations({ subtree: true })) {
    if (animation.effect?.getTiming().iterations === Infinity) continue
    try {
      animation.finish()
    } catch {
      // An animation with no end to go to: leave it.
    }
  }
}

/**
 * Where the card's page is drawn now: holds its node while mounted. An inline
 * card's page dormant in its frame (`dormant`): display: none while asleep,
 * displayed again while it wakes.
 */
function BodySlot({ host, className, dormant }: { host: HTMLElement | null; className?: string; dormant?: 'asleep' | 'waking' }) {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useLayoutEffect(() => {
    const slot = ref.current
    if (!slot || !host) return
    slot.appendChild(host)
    restoreScroll(host)
    if (!dormantHosts.has(host)) keptScroll.delete(host)
    return () => {
      if (host.parentNode !== slot) return
      if (!dormantHosts.has(host)) keptScroll.set(host, readScroll(host))
      slot.removeChild(host)
    }
  }, [host])
  return (
    <div
      ref={ref}
      className={className}
      {...(dormant ? { 'data-card-dormant': dormant === 'asleep' ? '' : 'waking' } : {})}
      style={dormant === 'asleep' ? { display: 'none' } : undefined}
    />
  )
}

/**
 * How long a kept page waits parked, laid out out of sight, before it goes
 * dormant (display: none). Parked, every element of it is still styled and
 * laid out with the rest of the window: three heavy pages parked made each
 * whole-window style pass several times dearer in the desktop app's WebKit
 * (10-19), and a reload, which parks none, "fixed" it. Dormant, its React
 * tree, its data and its scroll offsets stay; only drawing stops.
 */
export const DORMANT_AFTER_MS = 15_000

/**
 * The frames a dormant page gets, displayed again but still parked out of
 * sight, before it shows: its ResizeObservers, virtual lists and measured
 * layouts saw it at zero size while dormant, and settle at its real size here
 * first. With a time cap, since a hidden window runs no frames.
 */
const WAKE_FRAMES = 3
const WAKE_MAX_MS = 150

/**
 * How long an inline card's page waits more than a window's height from what
 * the chat shows before it goes dormant, in its frame. Its frame is a fixed
 * height, so nothing around it moves; scrolled back within a window's height,
 * it wakes there, still out of sight.
 */
export const INLINE_DORMANT_AFTER_MS = 5_000

/**
 * A jump (the jump-to-bottom spring, a page key) can carry the chat past that
 * window's height in a frame, and the observer reports only after the frame
 * has painted. So while asleep, the card checks each scroll of its chat, before
 * the frame paints, and wakes there if the next steps could bring it into
 * view: the spring scrolls from requestAnimationFrame, which this sees a frame
 * late, and its steps grow at most about 1.6x a frame.
 */
const WAKE_AHEAD_STEPS = 3

export function ShowToolCard({
  toolCallId,
  spec,
  count: shownCount,
  number,
  opened = false,
  place = 'inline',
}: {
  toolCallId: string
  spec: CardSpec
  count: number | null
  /** The card's number for the conversation, from its show result. */
  number?: number | null
  /**
   * The person opened it from `/` (lib/chat-cards/opened-card.ts): it sits in
   * their own message, which spans the reading column, so it draws at the
   * column's width rather than breaking out of a reply's 80%, and its pill
   * says Opened.
   */
  opened?: boolean
  /**
   * Where it draws when not full screen: in its message (`inline`), or
   * nowhere but its parked page (`kept`, a page the person opened, mounted by
   * the chat's kept-card host while it is kept; the live capture's draws in
   * its dock).
   */
  place?: 'inline' | 'kept'
}) {
  const kept = place === 'kept'
  const host = useChatCardHost()
  // A host without a store (the narrow ones) gives each card its own.
  const ownStore = React.useMemo(() => {
    if (host.store) return null
    const store = new ChatCardStore()
    store.setCards([{ id: toolCallId, spec, number, opened }])
    return store
  }, [host.store, toolCallId, spec, number, opened])
  const store = host.store ?? ownStore!
  // This card's own draw state only: a change to another card leaves it be.
  const drawKey = React.useCallback(() => store.drawKey(toolCallId), [store, toolCallId])
  const drawn = React.useSyncExternalStore(store.subscribe, drawKey, drawKey)

  const fullScreen = store.fullScreen() === toolCallId
  // A kept card has no inline frame: out of full screen it is put away.
  const collapsed = kept ? !fullScreen : host.wide ? store.isCollapsed(toolCallId) : !fullScreen
  const [liveCount, setLiveCount] = React.useState<number | null>(shownCount)
  const configRef = React.useRef<ViewConfig | null>(null)
  const frameRef = React.useRef<HTMLDivElement>(null)
  // The full-screen card's own frame (header and page): a press anywhere
  // else on its layer, but a control, puts it back (isOutsideCardPress).
  const fullScreenFrameRef = React.useRef<HTMLDivElement>(null)
  const seen = useSeen(frameRef, !collapsed && !fullScreen)
  // The page: drawn once the card is on screen (or full screen), and kept
  // mounted from then on, inline and full screen alike, until the card folds
  // to its pill. A kept card keeps its page as long as it is mounted (the host mounts it
  // while it is one of the pages visited last), parked out of sight between
  // visits; it goes with the card when the host lets the card go.
  const bodyHost = useBodyHost()
  // The live capture's card, docked beside its chat while it records
  // (chat/live-capture-dock.tsx): the card itself, as it draws inline, in the
  // dock's spot, the same page that goes full screen. The card the store just
  // let go stays there while the dock slides away. `dockMatch` holds while it
  // is full screen too (the spot keeps the card's "full screen" line).
  const dock = useLiveCaptureDockSlot()
  const dockMatch =
    kept && !!dock && (store.docked() === toolCallId || (dock.ending && store.dockReleased() === toolCallId))
  const docked = dockMatch && !fullScreen && !!dock?.body
  const bodyShown = fullScreen ? true : kept ? docked : !collapsed && seen
  const [bodyKept, setBodyKept] = React.useState(false)
  const letsPageGo = !kept && collapsed && !fullScreen
  if (bodyShown && !bodyKept) setBodyKept(true)
  if (!bodyShown && bodyKept && letsPageGo) setBodyKept(false)
  const bodyMounted = bodyShown || bodyKept

  // Is the focus in the inline card (its frame, or a popover it opened: React's
  // focus events cross portals)? With full screen, what makes it the card in
  // front for its Properties (card-body.tsx). A blur waits a task for the
  // focus that may follow it, so moving between the card and its popover never
  // reads as leaving.
  const [focusWithin, setFocusWithin] = React.useState(false)
  const blurTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  React.useEffect(() => () => {
    if (blurTimer.current) clearTimeout(blurTimer.current)
  }, [])
  const onFrameFocus = React.useCallback(() => {
    if (blurTimer.current) clearTimeout(blurTimer.current)
    blurTimer.current = null
    setFocusWithin(true)
  }, [])
  const onFrameBlur = React.useCallback(() => {
    if (blurTimer.current) clearTimeout(blurTimer.current)
    blurTimer.current = setTimeout(() => {
      blurTimer.current = null
      setFocusWithin(false)
    }, 0)
  }, [])

  // A page goes dormant (display: none), its tree and data kept: a kept page
  // parked DORMANT_AFTER_MS, an inline card's page more than a window's height
  // from what the chat shows INLINE_DORMANT_AFTER_MS (never while the focus is
  // in it: display: none would drop the focus). Wanted on screen again (full
  // screen, its dock, or back within that window's height), it wakes where it
  // sleeps, out of sight (WAKE_FRAMES), and only then moves or shows, so what
  // shows is already laid out at its size.
  const [dormant, setDormant] = React.useState(false)
  // Let go (folded to its pill): its page, mounted again, starts awake.
  if (dormant && !bodyMounted) setDormant(false)
  const inline = !kept && host.wide && !collapsed && bodyMounted
  const near = useNearView(frameRef, inline)
  const wanted = fullScreen || (kept ? dockMatch && !!dock?.body : near)
  const shownFullScreen = fullScreen && !dormant
  const dockHost = dockMatch && !dormant ? (dock?.body ?? null) : null
  const parked = kept && bodyMounted && (dormant || (!fullScreen && !dockHost))
  const resting = kept ? parked : inline && !fullScreen && !near && !focusWithin
  const sleeping = dormant && !wanted
  React.useEffect(() => {
    if (!resting || dormant || !bodyHost) return
    const timer = window.setTimeout(() => {
      keptScroll.set(bodyHost, readScroll(bodyHost))
      dormantHosts.add(bodyHost)
      setDormant(true)
    }, kept ? DORMANT_AFTER_MS : INLINE_DORMANT_AFTER_MS)
    return () => window.clearTimeout(timer)
  }, [resting, dormant, bodyHost, kept])
  // Awake, its scroll offsets are read where it is again.
  React.useLayoutEffect(() => {
    if (!dormant && bodyHost) dormantHosts.delete(bodyHost)
  }, [dormant, bodyHost])
  React.useLayoutEffect(() => {
    if (!dormant || !wanted || !bodyHost) return
    // Displayed again (this commit), still out of sight: parked, or far down the chat.
    dormantHosts.delete(bodyHost)
    restoreScroll(bodyHost)
    finishOneShotAnimations(bodyHost)
    let frames = 0
    let raf = 0
    let cap = 0
    let woke = false
    const wake = () => {
      woke = true
      cancelAnimationFrame(raf)
      window.clearTimeout(cap)
      restoreScroll(bodyHost)
      finishOneShotAnimations(bodyHost)
      setDormant(false)
    }
    // A list drawn again only now has its height back: restore its offsets each frame.
    const step = () => {
      restoreScroll(bodyHost)
      if (++frames >= WAKE_FRAMES) wake()
      else raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    cap = window.setTimeout(wake, WAKE_MAX_MS)
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(cap)
      // Put away again before it woke: dormant still, its saved offsets standing.
      if (!woke) dormantHosts.add(bodyHost)
    }
  }, [dormant, wanted, bodyHost])
  // Asleep in its frame: a scroll that could bring it into view within
  // WAKE_AHEAD_STEPS steps of its chat wakes it in that scroll's event, before
  // the frame paints. Displayed again there and then; React catches up after.
  const asleepInline = !kept && sleeping
  React.useEffect(() => {
    const frame = frameRef.current
    if (!asleepInline || !frame || !bodyHost) return
    const scroller = scrollParent(frame)
    const offset = () => (scroller ? scroller.scrollTop : window.scrollY)
    let last = offset()
    let woke = false
    const check = () => {
      const now = offset()
      const step = Math.abs(now - last)
      last = now
      if (woke) return
      const view = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight }
      const box = frame.getBoundingClientRect()
      if (Math.max(box.top - view.bottom, view.top - box.bottom, 0) > WAKE_AHEAD_STEPS * step) return
      woke = true
      const slot = bodyHost.parentElement
      if (slot) slot.style.display = ''
      dormantHosts.delete(bodyHost)
      restoreScroll(bodyHost)
      finishOneShotAnimations(bodyHost)
      // A list drawn again only now has its height back: its offsets again for a few frames.
      let frames = 0
      const settle = () => {
        restoreScroll(bodyHost)
        if (++frames < WAKE_FRAMES) requestAnimationFrame(settle)
      }
      requestAnimationFrame(settle)
      setDormant(false)
    }
    const target = scroller ?? window
    target.addEventListener('scroll', check, { passive: true })
    window.addEventListener('resize', check)
    return () => {
      target.removeEventListener('scroll', check)
      window.removeEventListener('resize', check)
    }
  }, [asleepInline, bodyHost])

  // A kept card's page waits, parked between visits, at the size it last had
  // full screen: measured as it goes full screen (its node is in the
  // full-screen layer by then, BodySlot's layout effect running first), so it
  // opens again without laying out anew.
  const [parkedSize, setParkedSize] = React.useState(PARKED_SIZE)
  React.useLayoutEffect(() => {
    if (!kept || !shownFullScreen || !bodyHost?.isConnected) return
    const rect = bodyHost.getBoundingClientRect()
    const width = Math.round(rect.width)
    const height = Math.round(rect.height)
    if (width > 0 && height > 0) setParkedSize((was) => (was.width === width && was.height === height ? was : { width, height }))
  }, [kept, shownFullScreen, bodyHost])
  // Tell the dock its card is here (it slides in then), while docked or full
  // screen from the dock (the dock keeps its place meanwhile).
  const dockAttach = dockMatch && !dormant ? dock?.attach : undefined
  React.useEffect(() => {
    if (!dockAttach) return
    return dockAttach({ title: spec.title, fullScreen, enterFullScreen: () => store.enterFullScreen(toolCallId) })
  }, [dockAttach, spec.title, fullScreen, store, toolCallId])
  // Back and Forward inside the card: kept in the chat's card store by the
  // card's id, so a remount (a card opened during a turn joining the thread
  // once it settles) keeps its steps.
  const history = store.history(toolCallId)
  // The header's slots for the page's own controls (the Properties button).
  const [slots, setSlots] = React.useState<CardHeaderSlots>({ left: null, right: null })
  const leftSlotRef = React.useCallback((left: HTMLElement | null) => setSlots((s) => (s.left === left ? s : { ...s, left })), [])
  const rightSlotRef = React.useCallback((right: HTMLElement | null) => setSlots((s) => (s.right === right ? s : { ...s, right })), [])

  // A card that goes full screen takes the keyboard: its frame gets the
  // focus (unless something inside it already has it). Keys belong to where
  // the focus is, so the page beside it keeps its own once clicked.
  const fullScreenRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const frame = fullScreenRef.current
    if (!shownFullScreen || !frame || frame.contains(document.activeElement)) return
    frame.focus({ preventScroll: true })
  }, [shownFullScreen])

  // ⌘/Ctrl+[ and ] walk the card's history: the card the focus is in, or the
  // one full screen. One window listener for every card (addHistoryKeyHandler), not one each.
  React.useEffect(() => {
    return addHistoryKeyHandler((e) => {
      const delta = isHistoryKey(e)
      if (delta === null || e.defaultPrevented) return
      if (!cardOwnsHistoryKeys({ elements: [frameRef.current, fullScreenRef.current], fullScreen })) return
      e.preventDefault()
      history.go(delta)
    })
  }, [fullScreen, history])

  // Esc puts a full-screen card back, unless a popover inside it is open.
  React.useEffect(() => {
    if (!fullScreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || anotherLayerOpen()) return
      store.exitFullScreen()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullScreen, store])

  // Full screen, it is the card in front for the app rail (front-card.ts):
  // the rail lights its page, Home or New put it back, and beside the rail
  // the chat under its layer stops painting. From the moment it is asked for
  // (a parked page still waking counts), so the rail answers the click at
  // once. Before paint, so a switch from one page to the next never shows a
  // frame of the chat between them.
  React.useLayoutEffect(() => {
    if (!fullScreen) return
    return holdFrontCard({
      id: toolCallId,
      spec,
      close: () => {
        if (store.fullScreen() === toolCallId) store.exitFullScreen()
      },
    })
    // `spec` as it went full screen: a card's kind never changes under its id,
    // and a reply's spec may be a new object each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullScreen, toolCallId, store])

  // In the workspace's words ("12 jobs" in a service business: src/lib/editions/words.ts).
  const edition = useWorkspaceEdition()
  const label = `${countText(spec, liveCount, edition)} · ${spec.title}`
  // The page, drawn again only when what it is given changes or the store
  // redraws this card (`drawn`): the frame's own changes (its count, near or
  // far, dormant) leave a heavy page be, mid-scroll too.
  const focused = fullScreen || focusWithin
  const onConfig = React.useCallback((c: ViewConfig) => {
    configRef.current = c
  }, [])
  const onClose = React.useCallback(() => store.collapse(toolCallId), [store, toolCallId])
  const body = React.useMemo(
    () => (
      <React.Suspense fallback={<div className="p-4 text-xs text-muted-foreground">Loading…</div>}>
        <CardHistoryProvider value={history}>
        <CardHeaderSlotsProvider value={slots}>
        <CardBody
          toolCallId={toolCallId}
          spec={spec}
          store={store}
          fullScreen={fullScreen}
          focused={focused}
          onCount={setLiveCount}
          onConfig={onConfig}
          onClose={onClose}
        />
        </CardHeaderSlotsProvider>
        </CardHistoryProvider>
      </React.Suspense>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `drawn`: the page redraws whenever the card would have
    [history, slots, toolCallId, spec, store, fullScreen, focused, onConfig, onClose, drawn],
  )

  // The page's React home, which never moves: its node is moved instead
  // (BodySlot). Focus inside it still reaches here, for the inline card's
  // focusWithin, whichever frame its node sits in.
  const bodyAnchor = (
    <div hidden data-card-body-anchor="" onFocus={onFrameFocus} onBlur={onFrameBlur}>
      {bodyHost && bodyMounted ? createPortal(body, bodyHost, 'body') : null}
    </div>
  )

  // Listen mode reads what the card shows (an email, a document): the card in
  // front (full screen) is the one it reads and pulses around. The pulse fills
  // the frame it is drawn in, header and page together, as one card.
  const pulse = <ListenFramePulseHere focused={fullScreen} drawn />

  // A page the person opened, full screen (kept, not the live capture's
  // notes): closed from its header. A card from the chat closes with its
  // Minimize, under it: back into its message.
  const pageClose = kept && shownFullScreen && !dockMatch
  const header = (
    // The title and the controls only: the count and the card's number are
    // the agent's business (its note), not the reader's. A container, for the
    // page's own controls in its slots.
    // Back and Forward lead it, as they led a window's header.
    <div data-card-header="" className="@container relative z-10 flex h-10 shrink-0 items-center gap-2 border-b px-4">
      <div className="flex shrink-0 items-center">
        <CardHistoryButtons history={history} />
      </div>
      <div ref={leftSlotRef} data-card-header-slot="left" className="flex shrink-0 items-center empty:hidden" />
      <KindIcon spec={spec} className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-[6rem] flex-1 truncate text-[13px] font-medium sm:flex-none">{spec.title}</span>
      <div className="ml-auto flex items-center gap-0.5">
        <div ref={rightSlotRef} data-card-header-slot="right" className="flex shrink-0 items-center empty:hidden" />
        <SaveAsView spec={spec} configRef={configRef} />
        {/* A page the person opened (the app rail, `/`): its one close, here
            in its own header (Liam, 11-09: the floating X "feels so out of
            place", and Minimize did the same as it). */}
        {pageClose && (
          <button
            type="button"
            onClick={() => store.exitFullScreen()}
            aria-label="Close"
            title="Close"
            data-testid="card-close"
            data-card-header-close=""
            className="ml-1 grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
          >
            <X className="size-4" strokeWidth={1.75} />
          </button>
        )}
      </div>
    </div>
  )

  const pill = (
    <button
      type="button"
      data-chat-card-pill={toolCallId}
      onClick={() => (host.wide ? store.expand(toolCallId) : store.enterFullScreen(toolCallId))}
      className="inline-flex max-w-full items-center gap-2 self-start rounded-full border bg-background/60 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <KindIcon spec={spec} className="size-3.5 shrink-0" />
      <span className="truncate">{opened ? 'Opened' : 'Showed'} {label}</span>
    </button>
  )

  // What the card is, on its roots (data-chat-card / data-chat-card-fullscreen),
  // for UI automation (src/lib/automation/README.md): its kind, and a list's entity.
  const kindAttrs = { 'data-card-kind': spec.kind, 'data-card-entity': spec.kind === 'list' ? spec.entity_type : undefined }
  // The docked capture's goes back to its notes; a card from the chat, into its message.
  const minimizeLabel = dockMatch ? 'Back to notes' : 'Back into the chat'
  const sizes = pageClose ? FULL_SCREEN_PAGE : FULL_SCREEN_WITH_CONTROLS

  const overlay = !shownFullScreen
    ? null
    : // The whole window, over the top bar and the composer too (the layer
      // sits on <body>).
      createPortal(
          <div
            ref={fullScreenRef}
            data-chat-card-fullscreen={toolCallId}
            {...kindAttrs}
            // Takes the focus when it opens, so the page's keys (a mail card's
            // j/k, Esc) are the card's until the person clicks elsewhere.
            tabIndex={-1}
            // Everything behind the card goes soft and grey (tailwind.css), so
            // the card is what's in focus. z-50 like Radix's popovers, which
            // open after it and so paint over it. In the dashboard it starts
            // at the app rail's edge (--app-rail-w) and, beside the rail, has
            // no veil (`card-page-layer`): the page sits on the app's own
            // background and the rail stays at hand.
            // pt-14 below `md` (clear of the Mac app's traffic lights, no rail
            // header there); from `md` up the layer starts under the rail's
            // header already.
            className="card-focus-backdrop card-page-layer fixed inset-y-0 right-0 z-50 flex flex-col items-center px-4 pb-6 pt-14 outline-none sm:px-16 md:pt-2"
            style={FULL_SCREEN_LAYER_STYLE}
            // A press anywhere outside the card (the space all round, beside
            // the button under it) puts it back in its message.
            onPointerDown={(e) => {
              if (!isOutsideCardPress(e, fullScreenFrameRef.current)) return
              e.preventDefault()
              store.exitFullScreen()
            }}
          >
            {/* No floating X (Liam, 11-09: "feels so out of place"): a page
                closes from its header, a card from the chat with Minimize
                under it, and either with Esc or a press outside it. */}
            <FullScreenInteractive />
            <div className={FULL_SCREEN_STAGE}>
            <div className={FULL_SCREEN_COLUMN} style={sizes.column}>
              <div ref={fullScreenFrameRef} {...{ [CARD_FRAME_ATTR]: '' }} className={cn('relative flex w-full flex-col overflow-hidden shadow-2xl', CARD_GLASS_FRAME)} style={sizes.frame}>
                <CardGlass />
                {header}
                <BodySlot host={bodyHost} className="relative z-10 min-h-0 flex-1" />
                {pulse}
              </div>
              {/* Minimize: for a card from the chat (back into its message) or
                  the capture's notes; a page the person opened has its X in
                  its header instead (Liam, 11-09: the two did the same). */}
              {!pageClose && (
                <div className={FULL_SCREEN_CONTROLS}>
                  <OverlayButton label={minimizeLabel} onClick={() => store.exitFullScreen()} testId="card-minimize">
                    <Minimize2 className="size-4" strokeWidth={2} />
                  </OverlayButton>
                </div>
              )}
            </div>
            </div>
          </div>,
          document.body,
        )

  // The card in its frame, as it draws in its message: its glass, its header
  // (Back and Forward, the title, the page's controls in its slots, Save as
  // view), its page and its round Full screen and Close over its corner. In
  // the live capture's notepad (`inDock`) the same card fills the dock's spot,
  // without Close: it leaves only when the capture ends.
  const frame = (inDock: boolean) => (
    <div
      ref={frameRef}
      data-chat-card={toolCallId}
      {...kindAttrs}
      {...(inDock ? { 'data-chat-card-docked': '' } : {})}
      // Open in its message: the reply's line about it rides its foot (tailwind.css, data-chat-panel).
      {...(!inDock && !shownFullScreen ? { 'data-chat-panel': 'card' } : {})}
      // Focusable, so a click on the card (or a focus nothing inside can
      // hold any longer) keeps the focus in it, and its keys with it.
      tabIndex={-1}
      onFocus={onFrameFocus}
      onBlur={onFrameBlur}
      // The message column holds at 80% of the reading column when it has a
      // card (chat-message.tsx), so 125% of it is the column's full width.
      // An opened card's message already spans the column.
      className={cn(
        'relative max-w-none overflow-hidden outline-none',
        CARD_GLASS_FRAME,
        inDock ? 'h-full w-full' : opened ? 'w-full' : 'w-[125%]',
      )}
      // Still its page while a dormant page wakes in it to go full screen.
      style={inDock || shownFullScreen ? undefined : { height: INLINE_CARD_HEIGHT }}
    >
      <CardGlass />
      {shownFullScreen ? (
        <div className="relative z-10 flex h-10 items-center gap-2 px-4 text-xs text-muted-foreground">
          <LayoutList className="size-3.5" strokeWidth={1.75} />
          <span className="truncate">{label} · full screen</span>
          <button type="button" onClick={() => store.exitFullScreen()} className="ml-auto rounded-full px-2.5 py-1 transition-colors hover:bg-foreground/[0.06] hover:text-foreground">
            Put back
          </button>
        </div>
      ) : (
        <div className="relative z-10 flex h-full min-h-0 flex-col">
          {header}
          <BodySlot host={bodyHost} className="min-h-0 flex-1" dormant={!inDock && dormant ? (sleeping ? 'asleep' : 'waking') : undefined} />
          {pulse}
          {/* Over the pulse; between them, the page underneath still takes
              its clicks. */}
          <div className="pointer-events-none absolute bottom-3 right-3 z-30 flex items-center gap-2">
            <OverlayButton label="Full screen" onClick={() => store.enterFullScreen(toolCallId)}>
              <Maximize2 className="size-4" strokeWidth={2} />
            </OverlayButton>
            {!inDock && (
              <OverlayButton label="Close" onClick={() => store.collapse(toolCallId)} testId="card-close">
                <X className="size-4" strokeWidth={2} />
              </OverlayButton>
            )}
          </div>
        </div>
      )}
    </div>
  )

  if (kept) {
    // Between visits the kept page waits out of sight at its full-screen size
    // (visibility hidden keeps its layout: a detached node would measure zero
    // and a virtual list or a ResizeObserver inside it would empty out), then
    // goes dormant (display: none) until it is wanted again, and wakes here.
    // Docked: the card itself, in the live capture's notepad spot beside the chat.
    return (
      <ListenFrameRegistry>
        {bodyAnchor}
        {dockHost ? createPortal(frame(true), dockHost, `dock:${toolCallId}`) : null}
        {parked && (
          <div
            aria-hidden
            inert
            data-card-parked={toolCallId}
            {...(dormant ? { 'data-card-dormant': sleeping ? '' : 'waking' } : {})}
            className="pointer-events-none invisible fixed left-[-200vw] top-0 overflow-hidden"
            style={{ width: parkedSize.width, height: parkedSize.height, ...(sleeping ? { display: 'none' } : {}) }}
          >
            <BodySlot host={bodyHost} className="h-full min-h-0" />
          </div>
        )}
        {overlay}
      </ListenFrameRegistry>
    )
  }

  if (collapsed) return (
    <ListenFrameRegistry>
      {bodyAnchor}
      {pill}
      {overlay}
    </ListenFrameRegistry>
  )

  return (
    <ListenFrameRegistry>
      {bodyAnchor}
      {frame(false)}
      {overlay}
    </ListenFrameRegistry>
  )
}
