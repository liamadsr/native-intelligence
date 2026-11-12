'use client'

/**
 * The page panel's place and motion (page-panel.tsx): beside the navigation,
 * where the For you column stood before its cards moved into the right side
 * panel (Liam, 11-11). Every page's panel wears it, so they all stand and
 * move the same way.
 *
 *   Where   just under the top bar (PANEL_TOP, as the right panel), its left
 *           edge under the bar's first control (topBarLeftInset: past the
 *           traffic lights in the Mac app), PAGE_PANEL_WIDTH_PX wide, down
 *           to the minimized card's band at the most (MINIMIZED_TILE_BAND_PX:
 *           the tile and a gutter above it; Liam, 11-11: "it should have a
 *           max size so then it becomes scrollable … never … colliding with
 *           the minimized left bottom view"), whether a tile shows or not,
 *           so nothing moves when one comes; and of that height, 80% at
 *           the most (PAGE_PANEL_HEIGHT_SHARE; Liam, 11-11: "the sub-menu
 *           goes too long it should stop 20% less"; pagePanelBottomCss, in
 *           CSS, so nothing measures); past that its card scrolls
 *           inside, its soft fades kept. Making room
 *           beside the chat's content (space-plan.ts), the composer, in
 *           that content's column, is never under it; floating over the
 *           chat's left edge (opened by hand where there's no room, Liam
 *           11-11: its button right of Search), it ends above the composer
 *           (side-panels.tsx useComposerReserve), as the right panel does,
 *           or above the tile's band when that is higher.
 *   Look    no box of its own: a click-through column holding one floating
 *           card on the sky (components/attention/card-skin.ts
 *           COLUMN_CARD_SKIN, the right panel's cards' surface and edge),
 *           as tall as what it holds, down to the column's bottom, then
 *           that scrolls inside it (the page's own panel draws the
 *           scroller). Its corners are the opened card's, 24px
 *           (PAGE_PANEL_CARD_CLASS; Liam, 11-11: its roundness didn't match
 *           the other panels'), not the right panel's small 12px cards';
 *           what it holds keeps clear of that curve (home-recents.tsx).
 *   Motion  it slides in and out from the left on a transform, as the right
 *           panel does (SLIDE_CLASS, none under reduced motion), its button
 *           closing and opening it the same way; nothing else moves (Liam:
 *           the less movement in the app, the better). Changing pages is
 *           not a slide (Liam, 11-11: it "feels a bit choppy"): the panel
 *           leaving goes at once and the next makes the search palette's
 *           entrance (PagePanelSwapContext, lib/motion/palette-entrance.ts).
 *           At once for real: the swap lasts one render (the host notes the
 *           new panel in a layout effect and renders again before the
 *           paint), so the browser never saw the frames with their slide
 *           off, and both slid past each other under the entrance (Liam,
 *           11-11, on a card opening from its tile: "the over all transition
 *           even with the sub-nav needs to be updated to be smoother"). Each
 *           frame now settles its style while its slide is off.
 *   Kept    mounted on its first showing, then kept, off screen and inert,
 *           so its list and scroll survive the time it is off.
 *   Held    changing pages, never an empty slot (Liam, 11-11: "it goes away
 *           completely and reappears every time"): while the next page's
 *           panel has nothing to show yet, the last one stays on screen,
 *           inert, a moment at most (PagePanelHeldContext, page-panel.tsx).
 *   A card  it stays on screen under a card full screen (Liam, 11-11: "I
 *           want the panel to persist when you open something, it should
 *           just make room for both things to be open"): it keeps painting
 *           while the chat row's other children don't (tailwind.css, it is
 *           the row's child marked `data-page-panel`), and the card's layer
 *           starts after it (pagePanelReserve, set on <html> by the host).
 */
import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { useHasTrafficLights } from '@/components/desktop-titlebar'
import { COLUMN_CARD_SKIN } from '@/components/attention/card-skin'
import { playEntrance } from '@/lib/motion/palette-entrance'
import { PANEL_TOP, SLIDE_CLASS, SLIDE_STYLE, useComposerReserve } from '../side-panels/side-panels'
import { MINIMIZED_TILE_BAND_PX, PAGE_PANEL_HEIGHT_SHARE, PAGE_PANEL_WIDTH_PX, PANEL_GUTTER_PX, type PanelMode } from '../side-panels/space-plan'
import { topBarLeftInset } from '../top-bar/insets'
import { PAGE_PANEL_ID } from './page-panel-types'

/**
 * The host says, for the render a page change happens in, that the slot
 * changes hands (one page's panel was on screen and another's takes its
 * place) rather than opening or closing (Liam, 11-11: the slide when you
 * change pages "feels a bit choppy … apply the same animation we have for
 * the search CMD+K page"). Then nothing slides: the one leaving is gone at
 * once and the one arriving makes the palette's entrance
 * (lib/motion/palette-entrance.ts). Opening and closing (its button, room
 * coming and going) still slide.
 */
export const PagePanelSwapContext = createContext(false)

/**
 * The page whose panel the host holds on screen while the next page's has
 * nothing to show yet (page-panel.tsx; Liam, 11-11: "it goes away completely
 * and reappears every time"): its frame stays where it is, inert (nothing in
 * it takes a press, a reader skips it), until the next one shows. Null: none
 * held.
 */
export const PagePanelHeldContext = createContext<string | null>(null)

/**
 * The panel's one card: the floating cards' edge and skin, with the opened
 * card's 24px corners (chat-cards/card-glass.tsx CARD_GLASS_FRAME,
 * rounded-3xl) rather than FLOATING_CARD_CLASS's 12px (Liam, 11-11).
 */
export const PAGE_PANEL_CARD_CLASS = `rounded-3xl border border-border/60 ${COLUMN_CARD_SKIN}`

/**
 * What the panel covers of the row's left, from the app rail's edge: its
 * gutter, its width, and the same gutter again after it, so a full-screen
 * card's layer (show-tool-card.tsx) starts as clear of the panel as the
 * panel stands of the rail. The value of PAGE_PANEL_W_VAR (front-card.ts).
 */
export function pagePanelReserve(trafficLights: boolean): string {
  const inset = topBarLeftInset(trafficLights)
  const gutter = typeof inset === 'number' ? `${inset}px` : inset
  return `calc(${PAGE_PANEL_WIDTH_PX}px + 2 * ${gutter})`
}

/**
 * The panel's bottom, px above the row's (the window's): above the minimized
 * card's band always, and floating, above the composer dock (`composer`, its
 * height; 0 when not floating) and a gutter, whichever is higher.
 */
export function pagePanelBottom(composer: number): number {
  return Math.max(MINIMIZED_TILE_BAND_PX, composer > 0 ? composer + PANEL_GUTTER_PX : PANEL_GUTTER_PX)
}

/**
 * The panel's bottom as drawn (CSS, against the row's height): above
 * pagePanelBottom by a fifth of the height between PANEL_TOP and it, so the
 * panel takes PAGE_PANEL_HEIGHT_SHARE of that height at the most (Liam,
 * 11-11: "the sub-menu goes too long it should stop 20% less"). Its card
 * stays as tall as what it holds up to there. Tile or not, the same.
 */
export function pagePanelBottomCss(composer: number): string {
  const bottom = pagePanelBottom(composer)
  const cut = Math.round((1 - PAGE_PANEL_HEIGHT_SHARE) * 1000) / 1000
  return `calc(${bottom}px + ${cut} * (100% - ${PANEL_TOP} - ${bottom}px))`
}

export function PagePanelFrame({
  mode,
  active = true,
  label,
  page,
  children,
}: {
  mode: PanelMode
  /** Its page holds the slot: this frame is the one its button controls (PAGE_PANEL_ID). */
  active?: boolean
  label: string
  page: string
  children: ReactNode
}) {
  const shown = mode !== 'off'
  const [mounted, setMounted] = useState(shown)
  if (shown && !mounted) setMounted(true)
  // Its left edge under the top bar's first control (Liam, 11-09: they didn't line up).
  const trafficLights = useHasTrafficLights()
  // Floating over the chat it ends above the composer, never over it; and
  // always above the minimized card's tile and its gutter (Liam, 11-11),
  // whichever is higher.
  const composer = useComposerReserve(mode === 'float')
  const bottom = pagePanelBottomCss(composer)
  // A page change: no slide either way, and the one arriving eases in as the palette does, before its first paint.
  const swapping = useContext(PagePanelSwapContext)
  // Held on screen for the next page's panel: shown, but nothing in it answers.
  const heldPage = useContext(PagePanelHeldContext)
  const held = shown && heldPage === page
  const frameRef = useRef<HTMLElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const wasShown = useRef(false)
  useLayoutEffect(() => {
    if (swapping && shown !== wasShown.current) {
      // Changing hands: its place is taken (or left) now, while its slide is
      // off. The host's next render, before this paint, puts the slide back
      // on; unless the style is settled here, the browser only ever sees the
      // new place WITH the slide, and both panels slide past each other.
      const frame = frameRef.current
      if (frame) void getComputedStyle(frame).translate
    }
    if (shown && !wasShown.current && swapping) playEntrance(cardRef.current)
    wasShown.current = shown
  }, [shown, swapping])
  if (!mounted) return null
  return (
    <aside
      ref={frameRef}
      id={active ? PAGE_PANEL_ID : undefined}
      aria-label={label}
      data-page-panel={page}
      data-page-panel-mode={mode}
      data-page-panel-swap={swapping ? '' : undefined}
      data-page-panel-held={held ? '' : undefined}
      inert={!shown || held}
      aria-hidden={!shown || held || undefined}
      className={cn(
        'pointer-events-none absolute z-[25] flex flex-col',
        // Changing hands: it snaps (in or out) instead of sliding.
        swapping ? 'transition-none' : SLIDE_CLASS,
        shown ? 'visible translate-x-0' : 'invisible -translate-x-[calc(100%+1rem)]',
      )}
      style={{ ...(swapping ? null : SLIDE_STYLE), top: PANEL_TOP, left: topBarLeftInset(trafficLights), bottom, width: PAGE_PANEL_WIDTH_PX }}
    >
      {/* The one card: as tall as what it holds, down to the column's bottom; it takes the pointer, the column doesn't. */}
      <div ref={cardRef} data-page-panel-card="" className={cn('pointer-events-auto flex min-h-0 flex-col overflow-hidden', PAGE_PANEL_CARD_CLASS)}>
        {children}
      </div>
    </aside>
  )
}
