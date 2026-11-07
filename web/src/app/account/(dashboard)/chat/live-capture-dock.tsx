'use client'

/**
 * The live capture's notepad, hovering on the LEFT of its chat (Liam, 10-09:
 * "a little notepad on the side"; "it comes out from the left side and hovers
 * there"), not a full screen over the chat.
 *
 * While a capture is active (recording, or recording and paused), the main
 * chat (there is one: docs/plans/one-chat.md) shows the capture's card as a
 * floating card on its left: about 456px wide and a little under two thirds of
 * the chat's height, centred on the chat's whole height (the top bar's inset
 * at both ends), its height capped on a short window to stay clear of the top
 * bar and the composer. The chat (its composer too) moves right only as far as
 * keeps its reading column a small gap clear of the card (dockPush), so the
 * two sit close and the chat stays wide; on a narrow window (the chat would
 * drop under 640px beside it) the card lies over the chat instead.
 *
 * It is the capture's own card, exactly as it draws in the chat (Liam: "I
 * wanted to use the existing one"): its glass, its header and controls, its
 * page and its round Full screen, only placed here, and without Close. It
 * cannot be put away: it leaves only when the capture stops or is discarded,
 * sliding away, and is then a page like any other (kept-card-host.tsx). Full screen is
 * the normal full screen; "Back to notes" puts it back here while the capture
 * records.
 *
 * The seam: this file is the spot and its motion only, no chrome of its own.
 * The docked card (ShowToolCard, inside the chat) reads
 * useLiveCaptureDockSlot(), draws itself into `slot.body` and attaches. The
 * spot slides in only once a card has attached, so a chat whose card is not
 * there shows nothing.
 *
 * Mounted once, around the main chat (main-chat-host.tsx); it costs nothing
 * while no capture is active.
 */
import * as React from 'react'
import { cn } from '@/lib/utils'
import {
  DOCK_COMPOSER_CLEARANCE_REM,
  DOCK_GUTTER_PX,
  DOCK_SLIDE_MS,
  dockMode,
  dockPush,
  dockWidth,
} from './live-capture-dock-store'
import { useActiveLiveCapture } from './use-live-capture-dock'
import { setCaptureDockOpen } from '../side-panels/side-panel-store'
import { LiveCaptureDockSlotProvider, type DockedCard, type LiveCaptureDockSlot } from '@/components/chat-cards/card-dock-slot'

export type { DockedCard, LiveCaptureDockSlot } from '@/components/chat-cards/card-dock-slot'
export { useLiveCaptureDockSlot, LiveCaptureDockSlotProvider } from '@/components/chat-cards/card-dock-slot'

/** The top bar's inset plus a little, at both ends of the column the card is centred in. */
const COLUMN_INSET = 'calc(var(--chat-top-inset, 0px) + 0.5rem)'

/**
 * The card's height: a little under two thirds of the column (Liam, 10-09:
 * half was a bit short), and on a short window no more than keeps it clear of
 * the composer (centred, its bottom stays the composer's height above the
 * chat's bottom). Never shorter than a few lines.
 */
export const DOCK_CARD_HEIGHT = `min(62%, calc(100% + 2 * (var(--chat-top-inset, 0px) + 0.5rem) - ${2 * DOCK_COMPOSER_CLEARANCE_REM}rem))`
export const DOCK_CARD_MIN_HEIGHT = 'min(9rem, 100%)'

/** The chat area's width, followed while `active` (nothing observed otherwise). */
function useWidth(ref: React.RefObject<HTMLElement | null>, active: boolean): number {
  const [width, setWidth] = React.useState(0)
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!active || !el) return
    const measure = () => setWidth(el.clientWidth)
    measure()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    observer?.observe(el)
    return () => observer?.disconnect()
  }, [ref, active])
  return width
}

const SLIDE = 'ease-out motion-reduce:transition-none'

/**
 * Around the main chat: the chat area (pushed right while the dock is out)
 * and the dock. `children` is the chat, rendered at the same place in the
 * tree whatever the dock does, so the chat never remounts.
 */
export function LiveCaptureDockLayout({ children }: { children: React.ReactNode }) {
  const live = useActiveLiveCapture()
  const captureId = live?.captureId ?? null

  // The capture that just ended stays docked while the panel slides away, so
  // its page leaves with the panel rather than before it.
  const [attachedCard, setAttachedCard] = React.useState<{ captureId: string; card: DockedCard } | null>(null)
  const [prevCapture, setPrevCapture] = React.useState(captureId)
  const [ending, setEnding] = React.useState<string | null>(null)
  if (captureId !== prevCapture) {
    setPrevCapture(captureId)
    setEnding(!captureId && prevCapture && attachedCard?.captureId === prevCapture ? prevCapture : null)
  }
  React.useEffect(() => {
    if (!ending) return
    const timer = setTimeout(() => setEnding(null), DOCK_SLIDE_MS)
    return () => clearTimeout(timer)
  }, [ending])
  const dockCapture = captureId ?? ending
  // Only a card attached for the capture docked now counts.
  const card = attachedCard && attachedCard.captureId === dockCapture ? attachedCard.card : null

  const rowRef = React.useRef<HTMLDivElement>(null)
  const width = useWidth(rowRef, !!dockCapture)
  const [body, setBody] = React.useState<HTMLDivElement | null>(null)

  // One card at a time, for the capture docked now (a new capture makes a new
  // attach, which its card calls again); a late detach (the card that attached
  // before) never takes a newer one's place away.
  const attachedRef = React.useRef<object | null>(null)
  const attach = React.useCallback(
    (next: DockedCard) => {
      const token = {}
      attachedRef.current = token
      if (dockCapture) setAttachedCard({ captureId: dockCapture, card: next })
      return () => {
        if (attachedRef.current !== token) return
        attachedRef.current = null
        setAttachedCard(null)
      }
    },
    [dockCapture],
  )

  const slot = React.useMemo<LiveCaptureDockSlot | null>(
    () => (dockCapture ? { captureId: dockCapture, body, ending: !captureId, attach } : null),
    [dockCapture, body, captureId, attach],
  )

  const open = !!live && !!card
  const mode = dockMode(width)
  const push = open && mode === 'push'
  // Only as far as clears the card (dockPush): the chat stays near it.
  const pushPx = push ? dockPush(width) : 0

  // The side panels' space plan hears the dock is out: the chat's content
  // moves over with the push, so the right panel measures its free space
  // from there.
  React.useLayoutEffect(() => {
    setCaptureDockOpen(open)
  }, [open])
  React.useLayoutEffect(() => () => setCaptureDockOpen(false), [])

  return (
    <LiveCaptureDockSlotProvider value={slot}>
      <div
        ref={rowRef}
        data-live-capture-dock-row={open ? mode : 'off'}
        className="relative flex min-h-0 w-full flex-1"
      >
        {/* The chat area: the whole row, or what the dock leaves of it. Set
            once as the dock comes and goes, never animated (a `left` drawn
            frame by frame re-lays the whole chat each frame): only the dock
            slides, on a transform, as the side panels do. */}
        <div
          data-live-capture-chat-area=""
          className="absolute inset-y-0 right-0 flex min-h-0 flex-col"
          style={{ left: pushPx }}
        >
          {children}
        </div>
        {dockCapture && (
          // The column the card is centred in: the chat's whole height, the
          // top bar's inset at both ends. Click-through but for the card.
          <aside
            aria-label="Live capture notes"
            aria-hidden={!open || undefined}
            inert={!open}
            data-live-capture-dock={dockCapture}
            data-live-capture-dock-mode={mode}
            className={cn(
              'pointer-events-none absolute inset-y-0 z-30 flex flex-col justify-center',
              // Tailwind 4's translate-x-* sets `translate`, so that is what transitions.
              'transition-[translate,visibility]',
              SLIDE,
              open ? 'visible translate-x-0' : 'invisible -translate-x-[calc(100%+1.5rem)]',
            )}
            style={{
              left: DOCK_GUTTER_PX,
              width: dockWidth(width),
              paddingTop: COLUMN_INSET,
              paddingBottom: COLUMN_INSET,
              transitionDuration: `${DOCK_SLIDE_MS}ms`,
            }}
          >
            {/* The card's spot: the capture's own card is moved in here
                (ShowToolCard, docked), looking as it does in the chat. */}
            <div
              ref={setBody}
              data-live-capture-dock-body=""
              className="pointer-events-auto relative flex w-full min-h-0 flex-col"
              style={{ height: DOCK_CARD_HEIGHT, minHeight: DOCK_CARD_MIN_HEIGHT }}
            />
          </aside>
        )}
      </div>
    </LiveCaptureDockSlotProvider>
  )
}
