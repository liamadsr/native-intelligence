'use client'

/**
 * The card last minimized, at the bottom left, and the app's one rule for
 * empty presses while a card is full screen (Liam, 11-11).
 *
 * The rule (EmptyPressMinimizes): "anytime you click an empty area it does
 * close it … consistent across all the pages". From `md` up beside the rail,
 * while a card is in front, one window listener (capture phase, so before the
 * card's layer or anything else hears it) takes a primary press on any empty
 * part of the app (components/chat-cards/outside-card-press.ts
 * isEmptyAppPress: the card's layer around its frame, the chat row and shell
 * behind it, the composer's dock beside the composer box, under and around
 * the page panel) and puts the card in front away, which minimizes it into
 * the tile. It prevents the press, so the layer's own handler (the rule below
 * `md`) and the mousedown after it never act on it again. A popover open
 * takes its own outside press first. Below `md`: as before, the layer's.
 *
 * The tile (MinimizedCardTile; Liam, 11-11: "minimize and animate that same
 * way and go to the bottom left so that way it's always accessible and I can
 * just click on it again and bring it back into the view"):
 *
 *   Where   bottom left, just right of the rail: its left edge the page
 *           panel's (topBarLeftInset, under the top bar's first control),
 *           PANEL_GUTTER_PX above the window's bottom. Over the full-screen
 *           layer (z-50), over its own flight's copy (z-51: it takes over
 *           from the copy in one frame) and under the other flights (z-60). The page panel always
 *           ends above its band (space-plan.ts MINIMIZED_TILE_BAND_PX).
 *   Look    a mini window (Liam, 11-11: "I want it to have a preview of the
 *           window not just a tab like a square"): as wide as the page
 *           panel above it (Liam, 11-11: "the width should match the width
 *           of the sub-nav panel"), 296×185, the card's 16:10, the floating
 *           cards' skin and edge, the panel's 24px corners, a soft shadow;
 *           in it the frame's still copy
 *           as it left full screen (minimized-card.ts MinimizedCard.preview),
 *           scaled to cover it, and nothing over it (Liam, 11-11: the strip
 *           with the page's icon "is not needed"; its title is the button's
 *           label and tooltip). No copy (no frame on screen as it left): the
 *           card's page's icon (the rail's, else the card header's kind
 *           icon), large, on the muted surface. Narrower where the composer, centred in the chat,
 *           would be under it (minimizedTileWidth: at 1024px wide about
 *           160×100), 120px wide at the least.
 *   Preview inert, aria-hidden, under the pointer's notice, contained (its
 *           layout and paint stay in the tile), every animation, transition
 *           and backdrop blur in it off: one still copy, laid out once,
 *           fitted again only when the tile's size changes.
 *   Press   grows the card back out of it into full screen
 *           (minimized-card.ts restoreMinimized; lib/chat/tile-flight.ts: at
 *           the ⌘K palette's pace, round the page panel, from the preview's
 *           rectangle, so the window grows out of its own thumbnail; the
 *           tile goes in the frame the copy leaves it, the copy wearing its
 *           edge and shadow from there, and home leaves with the window's
 *           first move: components/chat-cards/flight-scene.ts). Hover lifts it a touch (no motion
 *           when reduced); hover or focus shows a × that clears it (the
 *           open view's close, on a round backing).
 *   Away    while any card is full screen it fades away (160ms, inert, out
 *           of the pointer's and the screen reader's way) and fades back as
 *           one is minimized (Liam, 11-11: "when I open the page full screen
 *           the preview should fade away … it should only show when you
 *           minimize"); a page switch leaves it as it was (minimized-card.ts
 *           minimizeCard). The fade is for going away, and for coming back
 *           when nothing flies in (reduced motion, no copy): a flight in
 *           hides it with no transition and shows it fully, transition-free,
 *           in the very frame its copy goes (tile-flight.ts flyIntoTile;
 *           Liam, 11-11: "it like flikers when it goes to the bottom left"),
 *           nothing coming in after: the copy lands in the box inside the
 *           tile's border, where the preview is drawn, wearing the tile's
 *           own border and shadow (TILE_LOOK, on the slot too, so a flight
 *           that starts before the tile is drawn reads them there; Liam,
 *           11-11: "it lands at the bottom square then the borders get
 *           around"). Its glass is inside its border (`bg-clip-padding`),
 *           as the open card's is, so the window is the same surface at
 *           both ends.
 *           Gone when the card is no more (minimizedAlive) or
 *           the workspace changes (`resetKey`). None below `md` or without the rail.
 *
 * Flat cost: without a minimized card, one empty invisible box (the tile's
 * slot, for a flight that starts before its card leaves: minimized-card.ts
 * minimizeSoon); one store watch, one still copy and one size watch on its
 * box while there is one; the press listener only while a card is in front.
 * Nothing on the server or while hydrating: drawn once mounted, into <body>.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { StillCopy } from '@/lib/chat/card-reply-flight'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CardSpec } from '@/lib/chat-cards/kinds'
import { applyCopyScroll, fitStillCopy } from '@/lib/chat/card-reply-flight'
import { flyIntoTile, landTileHome } from '@/lib/chat/tile-flight'
import { COLUMN_CARD_SKIN } from '@/components/attention/card-skin'
import { getMountedServerSnapshot, getMountedSnapshot, subscribeMounted, useHasTrafficLights } from '@/components/desktop-titlebar'
import { frontCard, subscribeFrontCard } from '@/components/chat-cards/front-card'
import { homeArrives } from '@/components/chat-cards/flight-scene'
import { isEmptyAppPress, popoverLayerOpen } from '@/components/chat-cards/outside-card-press'
import { KindIcon } from '@/components/chat-cards/show-tool-card'
import {
  besideAppRail,
  TILE_SLOT_ATTR,
  clearMinimized,
  minimizeIntoKey,
  minimizedAlive,
  minimizedCard,
  registerTileHost,
  restoreMinimized,
  subscribeMinimized,
  takeFlightIn,
  type MinimizedCard,
} from '@/components/chat-cards/minimized-card'
import { nextSelectedPlace, ownPageOfCard } from './rail/rail-pages'
import { GROUP_PAGE_ICONS, RAIL_ICONS } from './rail/rail-icons'
import { MINIMIZED_TILE_H_PX, MINIMIZED_TILE_MIN_W_PX, MINIMIZED_TILE_W_PX, PANEL_GUTTER_PX } from './side-panels/space-plan'
import { topBarLeftInset } from './top-bar/insets'

/**
 * The app's one rule for empty presses while a card is full screen, from
 * `md` up beside the rail: one capture listener on the window, there only
 * while a card is in front.
 */
export function EmptyPressMinimizes() {
  useEffect(() => {
    const onPress = (e: PointerEvent) => {
      if (e.button !== 0 || e.defaultPrevented) return
      const front = frontCard()
      if (!front || !besideAppRail() || popoverLayerOpen() || !isEmptyAppPress(e.target)) return
      // Nothing under it acts on the press once the card is gone (a link, the composer).
      e.preventDefault()
      // Its flight into the tile first, out of full screen a frame later (minimized-card.ts minimizeSoon).
      if (front.minimize) front.minimize()
      else front.close()
    }
    let on = false
    const sync = () => {
      const want = !!frontCard()
      if (want === on) return
      on = want
      if (on) window.addEventListener('pointerdown', onPress, true)
      else window.removeEventListener('pointerdown', onPress, true)
    }
    sync()
    const off = subscribeFrontCard(sync)
    return () => {
      off()
      if (on) window.removeEventListener('pointerdown', onPress, true)
    }
  }, [])
  return null
}

/** The card's page's icon, as the rail draws it; a card of no page: the card header's kind icon. */
function TileIcon({ spec, className }: { spec: CardSpec; className: string }) {
  const Icon = useMemo(() => {
    const own = ownPageOfCard(spec)
    return own ? (GROUP_PAGE_ICONS[own.slug] ?? RAIL_ICONS[own.id] ?? null) : null
  }, [spec])
  return Icon ? <Icon className={className} strokeWidth={1.75} /> : <KindIcon spec={spec} className={className} />
}

/** The composer box's own inset in its reading column (chat-panel.tsx: the column's `px-2.5`). */
const COMPOSER_INSET_PX = 10

/**
 * The tile's width (CSS): MINIMIZED_TILE_W_PX, or less where the main
 * composer, centred in the chat strip right of the rail (tailwind.css
 * `.chat-reading-col`, min(90%, --chat-reading-max)), would be under it,
 * keeping a gutter before the composer's box; MINIMIZED_TILE_MIN_W_PX at the
 * least. `inset` is its left edge past the rail (topBarLeftInset). Its
 * height follows, at 16:10.
 */
export function minimizedTileWidth(inset: string | number): string {
  const lead = typeof inset === 'number' ? `${inset}px` : inset
  const strip = '(100vw - var(--app-rail-w, 0px))'
  const composerLeft = `(${strip} - min(0.9 * ${strip}, var(--chat-reading-max, 634px))) / 2 + ${COMPOSER_INSET_PX}px`
  return `clamp(${MINIMIZED_TILE_MIN_W_PX}px, calc(${composerLeft} - ${lead} - ${PANEL_GUTTER_PX}px), ${MINIMIZED_TILE_W_PX}px)`
}

/**
 * The preview's box: the frame's still copy in it (once per copy), scaled to
 * cover the box, and fitted again only when the box's size changes. The box
 * takes the copy out as it goes, so a tile cleared or replaced lets it go.
 * Every animation, transition and blur in it is off, and nothing in it takes
 * the pointer (the tile's own button is over it).
 */
function TilePreview({ preview, spec }: { preview: StillCopy | null; spec: CardSpec }) {
  const boxRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box || !preview) return
    box.replaceChildren(preview.copy)
    const fit = () => fitStillCopy(preview, box.clientWidth || MINIMIZED_TILE_W_PX, box.clientHeight || MINIMIZED_TILE_H_PX)
    fit()
    // Its scrollers where the page's stood (a chat at its newest message), as the window left.
    applyCopyScroll(preview.copy)
    const watch = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null
    watch?.observe(box)
    return () => {
      watch?.disconnect()
      box.replaceChildren()
    }
  }, [preview])
  if (!preview) {
    return (
      <div aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center bg-muted/60">
        <TileIcon spec={spec} className="size-7 text-muted-foreground/70" />
      </div>
    )
  }
  return (
    <div
      ref={boxRef}
      aria-hidden
      inert
      data-minimized-card-preview=""
      className={cn(
        'pointer-events-none absolute inset-0 isolate overflow-hidden [contain:strict]',
        // Still: nothing in the copy runs (a kept clone's CSS animations keep WebKit busy), blurs or takes the pointer.
        '[&_*]:[animation:none]! [&_*]:[transition:none]! [&_*]:[backdrop-filter:none]! [&_*]:[-webkit-backdrop-filter:none]! [&_*]:pointer-events-none!',
      )}
    />
  )
}

const noWatch = () => () => {}

export function MinimizedCardTile({ resetKey = null }: { resetKey?: string | null }) {
  useEffect(() => registerTileHost(), [])
  // Another workspace: its cards are not this one's.
  const keyRef = useRef(resetKey)
  useEffect(() => {
    if (keyRef.current === resetKey) return
    keyRef.current = resetKey
    clearMinimized()
  }, [resetKey])

  const card = useSyncExternalStore(subscribeMinimized, minimizedCard, () => null)
  // Its card full screen again: the tile steps aside meanwhile.
  const watchCard = useCallback((listener: () => void) => (card ? card.store.watch(listener) : noWatch()), [card])
  const open = useSyncExternalStore(
    watchCard,
    () => !!card && card.store.fullScreen() === card.id,
    () => false,
  )
  // Any card full screen: the tile fades away meanwhile, and back as one is
  // minimized (Liam, 11-11: "when I open the page full screen the preview
  // should fade away"). Kept mounted, so it can fade, but inert and out of
  // the pointer's and the screen reader's way while away.
  const anyFront = useSyncExternalStore(subscribeFrontCard, () => !!frontCard(), () => false)
  // Drawn ahead of its card leaving (its flight in the air: minimized-card.ts minimizeSoon): not away.
  const away = (open || anyFront) && !card?.staged
  // Its card no more (dropped, folded for good, its chat gone): no tile.
  useEffect(() => {
    if (!card) return
    const check = () => {
      if (!minimizedAlive(card)) clearMinimized(card)
    }
    check()
    return card.store.watch(check)
  }, [card])

  // Its frame's copy, taken as it left full screen, flies in (tile-flight.ts
  // flyIntoTile: round the page panel, at the ⌘K palette's pace), shrinking
  // into the preview's rectangle: the window into its own thumbnail (its
  // preview is in by now, TilePreview's layout effect running first). The
  // tile shows, whole and transition-free, in the frame the copy goes.
  const tileRef = useRef<HTMLDivElement>(null)
  // A flight already in the air for it (an empty press or Esc launched it
  // before the card left: minimized-card.ts minimizeSoon) lands here instead.
  useLayoutEffect(() => {
    if (!card || away) return
    const snapshot = takeFlightIn(card.id)
    if (snapshot) {
      // The card has left already (a send, Minimize): home is back in this
      // commit, so it fades in behind the window's back, clear until the
      // window is off it (flight-scene.ts: its glass never over the chat).
      if (flyIntoTile(snapshot, tileRef.current)) homeArrives({ delay: HOME_AFTER_WINDOW_MS })
      return
    }
    return landTileHome(minimizeIntoKey(card.id), tileRef.current)
  }, [card, away])

  const trafficLights = useHasTrafficLights()
  // Nothing on the server or while hydrating (the slot draws even with no
  // tile): only once mounted, and only into <body>, never in the shell's tree.
  const mounted = useSyncExternalStore(subscribeMounted, getMountedSnapshot, getMountedServerSnapshot)
  if (!mounted || typeof document === 'undefined') return null
  return createPortal(
    <>
      {/* Where the tile is drawn, there with no tile too: a flight launched before the card leaves goes here (minimizeSoon). */}
      <div {...{ [TILE_SLOT_ATTR]: '' }} aria-hidden className={cn(TILE_LOOK, 'pointer-events-none invisible')} style={tileBoxStyle(trafficLights)} />
      {card && <Tile card={card} tileRef={tileRef} trafficLights={trafficLights} away={away} />}
    </>,
    document.body,
  )
}

/** The tile's box: fixed at the bottom left, from `md` beside the rail, at 16:10 (tileBoxStyle places it). */
const TILE_BOX = 'fixed hidden aspect-[16/10] rounded-3xl md:[html[data-app-rail]_&]:block'

/**
 * The tile's look: its box, the floating cards' skin and edge, its soft
 * shadow. On the slot too (invisible), so a flight that starts before the
 * tile is drawn knows the edge it lands in (tile-flight.ts tileEndOf). The
 * glass stops at its border (`bg-clip-padding`), as the open card's glass
 * does, so the flying window's own glass is the tile's at the handover.
 */
const TILE_LOOK = cn('overflow-hidden border border-border/60', TILE_BOX, COLUMN_CARD_SKIN, 'bg-clip-padding shadow-md shadow-black/[0.08] dark:shadow-black/40')

/** A card that left before its flight began: how long home stays clear while the window flies off it, ms (the palette's curve has it out of the chat's column by then). */
const HOME_AFTER_WINDOW_MS = 90

/** Where the tile's box goes: right of the rail at the page panel's left edge, PANEL_GUTTER_PX above the bottom. */
function tileBoxStyle(trafficLights: boolean): React.CSSProperties {
  const inset = topBarLeftInset(trafficLights)
  return {
    left: `calc(var(--app-rail-w, 0px) + ${typeof inset === 'number' ? `${inset}px` : inset})`,
    bottom: PANEL_GUTTER_PX,
    width: minimizedTileWidth(inset),
  }
}

function Tile({
  card,
  tileRef,
  trafficLights,
  away,
}: {
  card: MinimizedCard
  tileRef: React.RefObject<HTMLDivElement | null>
  trafficLights: boolean
  /** A card is full screen: faded away, inert. */
  away: boolean
}) {
  const title = card.spec.title
  return (
    <div
      ref={tileRef}
      data-minimized-card={card.id}
      data-card-kind={card.spec.kind}
      data-minimized-away={away ? '' : undefined}
      inert={away || !!card.staged}
      aria-hidden={away || undefined}
      // `ph-no-capture`: a title can be private, and the preview shows the page.
      className={cn(
        // Over its flight's copy (z-51): it takes over from the copy in one frame.
        'ph-no-capture group/tile z-[52]',
        TILE_LOOK,
        // Its fade as a card opens or is minimized: the palette's 160ms (lib/motion/palette-entrance.ts).
        'transition-[opacity,translate,box-shadow] duration-[160ms] hover:shadow-lg motion-safe:hover:-translate-y-0.5 motion-reduce:transition-none',
        away ? 'pointer-events-none opacity-0' : 'opacity-100',
      )}
      style={tileBoxStyle(trafficLights)}
    >
      {/* The whole tile is its button; the preview and the strip lie under it, the × over it. */}
      <button
        type="button"
        // Its place brings its own panel (a page's own card: rail/selected-place.ts): home's leaves with the window's first move.
        onClick={() => restoreMinimized(tileRef.current, { panelChanges: nextSelectedPlace({ place: 'home', frontId: null }, { id: card.id, spec: card.spec }, false) !== 'home' })}
        aria-label={`Reopen ${title}`}
        title={title}
        className="absolute inset-0 z-10 rounded-[inherit] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      />
      <TilePreview preview={card.preview ?? null} spec={card.spec} />
      {/* Clear it: the open view's header close (show-tool-card.tsx
          `data-card-header-close`: a 28px circle, the X at size-4 and 1.75,
          muted to foreground, the same hover tint), on a round backing of the
          panels' floating skin with its 1px edge so it reads on any page
          (Liam, 11-11: "make it match the x button on the open view with the
          round border behind it"). Top right, inside the tile's 24px corner
          curve; shown on hover and while the keyboard is on the tile. */}
      <button
        type="button"
        onClick={() => clearMinimized()}
        aria-label={`Clear ${title}`}
        title="Clear"
        data-minimized-card-clear=""
        className={cn(
          'absolute right-2.5 top-2.5 z-20 grid size-7 place-items-center rounded-full border border-border/60 opacity-0',
          COLUMN_CARD_SKIN,
          // After the skin (its own text colour is the cards'): the close's muted X.
          'text-muted-foreground',
          // The hover tint over the skin (a tint of its own, so the backing stays).
          'before:absolute before:inset-0 before:rounded-full before:transition-colors hover:before:bg-foreground/[0.06]',
          'transition-[opacity,color] hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/tile:opacity-100 group-has-[:focus-visible]/tile:opacity-100 motion-reduce:transition-none',
        )}
      >
        <X className="relative size-4" strokeWidth={1.75} />
      </button>
    </div>
  )
}
