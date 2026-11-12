/**
 * The card last minimized, kept at hand in a tile at the bottom left (Liam,
 * 11-11: "I want whatever you have open like calendar teams or whatever it is
 * to kind of minimize and animate that same way and go to the bottom left so
 * that way it's always accessible and I can just click on it again and bring
 * it back into the view so it's like minimizing and maximizing kind of so I
 * always have like the last thing I looked at on the bottom left").
 *
 *   In      a card minimized (a press on an empty part of the app, Esc, the
 *           page's X, Home on the rail, a chat card's Minimize, a send from
 *           the composer: nothing else full screen after it) becomes the
 *           tile's card; another card taking its place (a page switch) does
 *           not (Liam, 11-11: "it should only show when you minimize the one
 *           of the pages"), beside the rail from
 *           `md` up: show-tool-card.tsx calls minimizeCard the moment its
 *           store lets it go, while its frame is still on screen, so the
 *           frame's copy can fly into the tile once the tile draws it
 *           (lib/chat/tile-flight.ts flyIntoTile: at the ⌘K palette's pace,
 *           around the page panel, compositor only).
 *   Out     a click on the tile grows the card back out of it (restoreMinimized:
 *           tile-flight.ts launchTileFlight at once, the card full screen
 *           half way through the flight, so its page and its sub-nav arrive
 *           as the window lands, landTileFlight on the frame as it mounts
 *           under the copy). The tile is there only
 *           while no card is full screen (minimized-card-tile.tsx: it fades
 *           away as one opens; Liam, 11-11: "when I open the page full screen
 *           the preview should fade away").
 *   As one  each way is one sequence (Liam, 11-11: "the entire open sequence
 *           needs to happen smoother"; ./flight-scene.ts says why the window
 *           looked see-through): opening, home (the chat, the top bar, its
 *           Recent panel when the page brings a sub-nav) leaves with the
 *           window's first move and the page's sub-nav arrives as it lands;
 *           closing, the page's sub-nav leaves with the window and home
 *           arrives as it lands.
 *   Owner   none new: the card stays where it went (a page in its place in
 *           the chat's card store, a chat card back in its message); the tile
 *           holds its store and id, a shortcut to enterFullScreen. One tile:
 *           the newest card minimized replaces it.
 *   Gone    when its card is no more: dropped from its store (another
 *           conversation, a workspace switch), folded for good (collapsed),
 *           or its store no longer used by anything (its chat gone; ChatCardStore
 *           attached). In memory only: a reload starts without it.
 *   Preview the tile is a mini window, not a tab (Liam, 11-11: "I want it to
 *           have a preview of the window not just a tab like a square"): a
 *           still copy of the frame as it left full screen (card-reply-
 *           flight.ts stillCopyOf: the flight's light copy with nothing in
 *           it that moves, loads, takes focus or a name), under reduced
 *           motion too. One per tile, kept on the tile's card
 *           (MinimizedCard.preview): made only when a card minimizes, dropped
 *           with it when the tile is cleared or replaced. The flights' copies
 *           are clones of it (tile-flight.ts flightCopyOf: the page is
 *           walked once; Liam, 11-11: "its better but the animation isnt as
 *           smooth").
 *
 * No tile below `md` or without the app rail (a phone: cards leave full
 * screen as before), and none where no tile is drawn (registerTileHost: the
 * dashboard shell draws it). Under reduced motion or without the Web
 * Animations API the tile still comes and goes, without the flight.
 *
 * Flat cost: one module-level entry and its preview's copy, written when a
 * card leaves full screen.
 *
 * Client-safe: no server imports.
 */
import type { CardSpec } from '@/lib/chat-cards/kinds'
import { canFly, stillCopyOf, type StillCopy } from '@/lib/chat/card-reply-flight'
import { cancelTileFlight, flightCopyOf, launchIntoTile, launchTileFlight, tileEndOf, type TileSnapshot } from '@/lib/chat/tile-flight'
import { homeArrives, homeLeaves, pagePanelOnScreen, panelLeaves } from './flight-scene'

/** The minimize and restore flights' travel: the ⌘K palette's curve over a time long enough to see (lib/chat/tile-flight.ts). */
export { MINIMIZE_FLIGHT_MS } from '@/lib/chat/tile-flight'
import type { ChatCardStore } from './card-store'
import { closeFrontCards } from './front-card'

export interface MinimizedCard {
  /** The card's id in its store. */
  id: string
  spec: CardSpec
  store: ChatCardStore
  /** The frame's still copy as it left full screen (the tile's preview); none when it had no frame on screen. */
  preview?: StillCopy | null
  /**
   * Drawn ahead of its card leaving full screen: its flight into the tile is
   * in the air (minimizeSoon), the tile drawn for the handover, not away
   * though its card is still in front, and not to be pressed yet.
   */
  staged?: boolean
}

/** The flight a card grows back out of the tile on (its frame lands it: show-tool-card.tsx). */
export function minimizedFlightKey(id: string): string {
  return `minimized:${id}`
}

/** The flight into the tile of a card leaving full screen a frame later (minimizeSoon; the tile lands it: tile-flight.ts landTileHome). */
export function minimizeIntoKey(id: string): string {
  return `minimize:${id}`
}

/** On the tile's slot: where the tile is drawn, there even with no tile (minimized-card-tile.tsx). */
export const TILE_SLOT_ATTR = 'data-minimized-tile-slot'

/** From `md` up, beside the app rail: where the tile is drawn (tailwind.css `md`, rail/app-rail.tsx APP_RAIL_ATTR). */
const DESKTOP_QUERY = '(min-width: 48rem)'
const APP_RAIL_ATTR = 'data-app-rail'

export function besideAppRail(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(DESKTOP_QUERY).matches && document.documentElement.hasAttribute(APP_RAIL_ATTR)
}

let current: MinimizedCard | null = null
/** The frame's copy taken as it left full screen, waiting for the tile to draw it (takeFlightIn). */
let flightIn: { id: string; snapshot: TileSnapshot } | null = null
/** The card growing back out of the tile, its page a frame away (restoreMinimized). */
let restoring: MinimizedCard | null = null
/** The card flying into the tile, leaving full screen a frame later (minimizeSoon), and its preview. */
let leaving: { id: string; store: ChatCardStore; preview: StillCopy | null } | null = null
let hosts = 0
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

export function subscribeMinimized(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The tile's card, or null. Stable between changes (useSyncExternalStore). */
export function minimizedCard(): MinimizedCard | null {
  return current
}

/** A tile is drawn (the dashboard shell's): minimizeCard does nothing without one. Returns its release. */
export function registerTileHost(): () => void {
  hosts += 1
  let released = false
  return () => {
    if (released) return
    released = true
    hosts -= 1
    if (!hosts) clearMinimized()
  }
}

/** Can its card still be brought back: in its store, not folded for good, the store still in use? */
export function minimizedAlive(card: MinimizedCard): boolean {
  return !!card.store.card(card.id) && !card.store.state(card.id).collapsed && card.store.attached()
}

/**
 * `card` just left full screen (its store let it go), its frame `frame` still
 * on screen: it becomes the tile's card, the frame's copy waiting to fly into
 * the tile. Nothing below `md`, without a tile drawn, or for a card that no
 * longer is.
 */
export function minimizeCard(card: MinimizedCard, frame: HTMLElement | null): void {
  if (!hosts || !besideAppRail() || !minimizedAlive(card)) return
  // A switch, not a minimize: another card took its place full screen (the
  // rail, a sub-nav row, Search, a record opened over it). The tile is left
  // as it was (Liam, 11-11: "when I switch pages it also come back it should
  // only show when you minimize the one of the pages"). Its store already
  // says so as it lets the card go: every page and record the shell opens is
  // a card of the main chat's store.
  const now = card.store.fullScreen()
  if (now !== null && now !== card.id) return
  // Its flight already landed (minimizeSoon): its preview was taken then, its tile drawn.
  const soon = leaving && leaving.id === card.id && leaving.store === card.store ? leaving : null
  leaving = null
  if (soon && current?.staged && current.id === card.id && current.store === card.store) {
    current = { ...current, spec: card.spec, staged: false }
    notify()
    return
  }
  // The tile's preview: kept, so it may not move (stillCopyOf), with or without the flight;
  // the flight's copy is a clone of it (no second walk over the page).
  const preview = soon ? soon.preview : stillCopyOf(frame)
  const snapshot = soon ? null : flightCopyOf(preview)
  flightIn = snapshot ? { id: card.id, snapshot } : null
  current = { id: card.id, spec: card.spec, store: card.store, preview }
  notify()
}

/**
 * Minimize `card` (full screen, its frame `frame` on screen) with its flight
 * first (an empty press, Esc, the page's X, Home on the rail): the frame's
 * copy sets off for the tile's place now, the page's sub-nav leaving with it
 * (flight-scene.ts panelLeaves), the tile is drawn at once for the handover
 * (staged), and `exit` (its store letting it go, the shell's render after
 * it: the chat row, the page panel; ~150ms in development) runs half way
 * through the flight (tile-flight.ts TILE_HANDOFF_MS), where the window is
 * all but in the tile: home (the chat, its panel) arrives as the window
 * lands, not a beat after it (Liam, 11-11: "the over all transition even
 * with the sub-nav needs to be updated to be smoother"), and nothing else
 * runs on the main thread while the window is on its way out (Liam, 11-11:
 * "its better but the animation isnt as smooth", "it still flikers"). Where
 * it would not minimize (below `md`, no tile drawn, no flight) `exit` runs
 * at once, as before. A second ask while one is under way does nothing.
 */
export function minimizeSoon(card: MinimizedCard, frame: HTMLElement | null, exit: () => void): void {
  if (leaving && leaving.id === card.id && leaving.store === card.store) return
  const would = !!hosts && !!frame && besideAppRail() && minimizedAlive(card) && card.store.fullScreen() === card.id && canFly()
  const slot = would ? document.querySelector<HTMLElement>(`[${TILE_SLOT_ATTR}]`) : null
  const to = tileEndOf(slot)
  if (!slot || !to) {
    exit()
    return
  }
  const preview = stillCopyOf(frame)
  const key = minimizeIntoKey(card.id)
  const before = current
  const mine = { id: card.id, store: card.store, preview }
  let scene: Array<() => void> = []
  // Not minimized after all (another card took the front, the tile went): the tile as it was.
  const unstage = () => {
    if (leaving === mine) leaving = null
    if (current?.staged && current.id === card.id && current.store === card.store) {
      current = before && minimizedAlive(before) ? before : null
      notify()
    }
  }
  const handoff = () => {
    // Home fades in from the commit the card leaves in (flight-scene.ts homeArrives: told by the card letting go).
    scene.push(homeArrives())
    exit()
    if (leaving === mine) unstage()
  }
  const cancelled = () => {
    for (const release of scene) release()
    scene = []
    unstage()
  }
  if (!launchIntoTile(key, flightCopyOf(preview), to, frame, { handoff, cancelled })) {
    exit()
    return
  }
  // The page's own sub-nav goes with its window; home's panel stays where it is (it is home's).
  const panel = pagePanelOnScreen()
  if (panel !== null && panel !== 'home') scene.push(panelLeaves())
  leaving = mine
  current = { id: card.id, spec: card.spec, store: card.store, preview, staged: true }
  notify()
}

/** The frame's copy waiting to fly into the tile for card `id` (once: taken by the tile as it draws it). */
export function takeFlightIn(id: string): TileSnapshot | null {
  if (!flightIn || flightIn.id !== id) return null
  const { snapshot } = flightIn
  flightIn = null
  return snapshot
}

/** Clear the tile (its ×; or `only` that card, when it is still the tile's). */
export function clearMinimized(only?: MinimizedCard): void {
  if (!current || (only && (current.id !== only.id || current.store !== only.store))) return
  current = null
  flightIn = null
  leaving = null
  notify()
}

/** Check the tile's card still is (a chat let go of its cards: its cards unmounting ask this). */
export function recheckMinimized(): void {
  if (current && !minimizedAlive(current)) clearMinimized()
}

/**
 * The tile clicked: its card grows back out of it (`tile`) into full screen
 * (tile-flight.ts launchTileFlight, from the preview's copy to where the frame
 * stood). The flight starts at once, and home leaves with its first move
 * (flight-scene.ts homeLeaves: the chat and the top bar gone before the
 * window is over them, so its glass is never seen through; Liam, 11-11: "the
 * panel is transparent and you see thorugh it and looks broken"), home's
 * panel too when the card's place brings its own (`panelChanges`: the tile
 * knows the card's place). The card goes full screen half way through the
 * flight (TILE_HANDOFF_MS), its frame mounting hidden under the copy and
 * taking over in the frame the copy lands, its sub-nav arriving meanwhile.
 * Without a flight, at once, as before. Whatever is in front goes first,
 * into the tile in its turn. False (and the tile cleared) when the card is
 * no more.
 */
export function restoreMinimized(tile: HTMLElement | null, { panelChanges = false }: { panelChanges?: boolean } = {}): boolean {
  const card = current
  if (!card) return false
  if (restoring === card || card.staged) return true
  if (!minimizedAlive(card)) {
    clearMinimized()
    return false
  }
  const key = minimizedFlightKey(card.id)
  let scene: Array<() => void> = []
  const letGo = () => {
    for (const release of scene) release()
    scene = []
  }
  const open = () => {
    restoring = null
    if (!minimizedAlive(card)) {
      letGo()
      cancelTileFlight(key)
      clearMinimized(card)
      return
    }
    closeFrontCards()
    card.store.enterFullScreen(card.id)
    // The flight waits for the frame to land it (a parked page wakes first); none came: let it go.
    if (card.store.fullScreen() !== card.id) {
      letGo()
      cancelTileFlight(key)
    }
  }
  restoring = card
  const flying = launchTileFlight(key, tile, flightCopyOf(card.preview ?? null), {
    handoff: open,
    cancelled: () => {
      if (restoring === card) restoring = null
      letGo()
    },
  })
  if (!flying) {
    open()
    return true
  }
  scene.push(homeLeaves())
  if (panelChanges && pagePanelOnScreen() !== null) scene.push(panelLeaves())
  return true
}

export function __resetMinimizedForTests(): void {
  current = null
  flightIn = null
  restoring = null
  leaving = null
  hosts = 0
  listeners.clear()
}
