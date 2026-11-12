/**
 * The side panel beside the main chat, as one small external store (Liam,
 * 10-15: "make it a lot more smoother so that they all fit nicely"): one
 * model, one motion and one space plan (space-plan.ts). Nothing here lives in
 * ChatPanel, so toggling the panel never re-renders the chat.
 *
 * One panel, two views (Liam, 11-11: "move the for you cards to the right
 * hand side panel then you should be able to switch between the agent
 * browser and context cards and the for you cards but you can't see both at
 * the same time"):
 *
 *   rightOpen      open or closed, remembered per device (RIGHT_OPEN_KEY).
 *   view           which of its views shows, remembered per device
 *                  (VIEW_KEY): `panel`, the sections (the agent's card, then
 *                  Agents · Plan · Context · Environment · Connectors), the
 *                  default; or `forYou`, the For you cards. Each view's
 *                  top-bar button (side-panel-toggles.tsx) opens the panel on
 *                  its view, or closes it when its view is the one showing
 *                  (toggleSidePanelView); ⌘\ opens and closes it on the view
 *                  it had (toggleRightPanel).
 *   forYouContent  For you has cards (told by the panel, side-panels.tsx).
 *                  With none, the For you view is never drawn (Liam's "hide
 *                  empty widgets"): the panel open on For you is not on
 *                  screen (rightShown) and the chat gets its room back, but
 *                  rightOpen and the view stay as saved, so it comes back on
 *                  For you when cards arrive. It never falls back to the
 *                  sections by itself.
 *   sections       the sections' cards: which the person opened (closed
 *                  until then: the high-level view, one row each) and their
 *                  order, dragged by hand, each remembered per device.
 *   pagePanel      the page panel beside the navigation has something to
 *                  show (told by page-panel/page-panel.tsx: the page on
 *                  screen has one, with rows, and the capture's notepad
 *                  doesn't hold the left; Liam, 11-11). Never saved: it
 *                  follows the page, and the space plan gives it the left
 *                  only where the row has room for it.
 *   pagePanelOpen  the page panel open or closed by its button, to the
 *                  right of Search in the app rail's header (Liam, 11-11:
 *                  "we also need a button for opening and closing the new
 *                  panel lets put it to the right of the search button"),
 *                  remembered per device (PAGE_PANEL_OPEN_KEY), open by
 *                  default. Kept as saved while the panel is hidden for
 *                  another reason (no rows, the notepad docked, no room).
 *   pagePanelPage  what it shows is a page's sub-nav, that page's card in
 *                  front (told by its host): the card draws no navigation of
 *                  its own from `md` up, so the sub-nav shows while it is
 *                  open, room or not (space-plan.ts leftPinned; Liam, 11-11:
 *                  "did you actually clean up the old one and remove it …
 *                  completely"). Home's Recent keeps the rules below. Never
 *                  saved.
 *   pagePanelFloatOk  opened by hand this session (setPagePanelOpen): where
 *                  the row has no room it may float over the chat's left
 *                  edge (side-panels.tsx planFor). Opened only as the device
 *                  remembered it, it shows only where it makes room, never
 *                  over the chat unasked. Never saved.
 *   pagePanelShown the page panel is on screen now (told by its host, from
 *                  the row's plan): what lights its button.
 *
 * Every read and write of storage is in try/catch: blocked storage keeps the
 * state in memory for the session. The server snapshot is closed, on the
 * sections, every card closed and in the default order, so hydration never
 * mismatches; the client then renders what the device saved. Another tab's
 * change arrives as a `storage` event.
 *
 * The chat's bottom anchor: a change that puts a panel on or off screen
 * changes the chat's width once, and its text re-wraps. The change notes how
 * far the person was from the chat's bottom (captureChatAnchor) and the row
 * puts them back there in the same frame (restoreChatAnchor), before paint.
 */

export type SectionId = 'computer' | 'agents' | 'plan' | 'context' | 'environment' | 'connections'

/** The right panel's two views: its sections, or the For you cards. */
export type SidePanelView = 'panel' | 'forYou'

export interface SidePanelState {
  /** The right panel is open (on screen unless its view is For you with no cards: rightShown). */
  rightOpen: boolean
  /** Which view the panel shows: its sections, or the For you cards. */
  view: SidePanelView
  /** For you has cards to show (told by the panel). */
  forYouContent: boolean
  /** The right panel's cards the person opened (closed by default: one row each). */
  sectionOpen: Readonly<Record<SectionId, boolean>>
  /** The right panel's cards in the person's order, every id once (a hidden one keeps its slot). */
  order: readonly SectionId[]
  /** Some connection needs the person (a reconnect, missing access…): the toggle's amber dot. */
  connectionsAttention: boolean
  /** The live capture's notepad is docked on the chat's left (live-capture-dock.tsx): the chat's content moves over for it. */
  captureDock: boolean
  /** The page panel has something to show beside the navigation (page-panel/page-panel.tsx). */
  pagePanel: boolean
  /** What the page panel shows is a page's sub-nav, with that page's card in front: it shows while open, room or not. Never saved. */
  pagePanelPage: boolean
  /** The page panel is open (its button in the rail's header), remembered per device; open by default. */
  pagePanelOpen: boolean
  /** The page panel was opened by hand this session: it may float over the chat where there is no room. Never saved. */
  pagePanelFloatOk: boolean
  /** The page panel is on screen now (the row's plan, told by its host): what its button shows and flips. */
  pagePanelShown: boolean
}

/** Remembered per device: the right panel open. */
export const RIGHT_OPEN_KEY = 'ni:side-panel:open'
/** Remembered per device: the panel's view, `for-you` (absent: the sections, the default). */
export const VIEW_KEY = 'ni:side-panel:view'
/**
 * Remembered per device: which of the right panel's cards are open, as
 * `{"open":[ids]}`. The key held, before the cards closed by default, a plain
 * JSON list of the ids the person FOLDED: that reads as every card closed, so
 * a device from before starts on the high-level view too (Liam, 10-16), and
 * the next open writes the new shape. Missing (never touched), every card is
 * closed.
 */
export const SECTIONS_KEY = 'ni:side-panel:collapsed'
/** Remembered per device: the right panel's cards in the person's order (JSON list of ids). */
export const ORDER_KEY = 'ni:side-panel:order'
/** Remembered per device: the page panel closed, `0` (absent: open, the default). */
export const PAGE_PANEL_OPEN_KEY = 'ni:page-panel:open'

/**
 * Every card, in the order it shows until the person drags one. A saved order
 * from before a card existed (Environment, 10-21; Context, 10-22) gets it
 * after the saved ones; the computer card (10-23, "at the top of the right
 * hand side panel") goes before them.
 */
export const SECTION_IDS: readonly SectionId[] = ['computer', 'agents', 'plan', 'context', 'environment', 'connections']
/** A card new to a saved order that belongs at the top of it. */
const LEAD_IDS: readonly SectionId[] = ['computer']

/**
 * Cards closed until the person opens them, except the computer card: its
 * preview is the point, so it shows open until the person closes it.
 */
const NONE_OPEN: Readonly<Record<SectionId, boolean>> = { computer: true, agents: false, plan: false, context: false, environment: false, connections: false }

const isSectionId = (v: unknown): v is SectionId => typeof v === 'string' && (SECTION_IDS as readonly string[]).includes(v)

const SERVER: SidePanelState = {
  rightOpen: false,
  view: 'panel',
  forYouContent: false,
  sectionOpen: NONE_OPEN,
  order: SECTION_IDS,
  connectionsAttention: false,
  captureDock: false,
  pagePanel: false,
  pagePanelPage: false,
  pagePanelOpen: true,
  pagePanelFloatOk: false,
  pagePanelShown: false,
}

function readKey(key: string): string | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeKey(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    // Storage blocked or full: it holds in memory for this session.
  }
}

/** VIEW_KEY read: For you only as written; anything else (missing, junk) the sections. */
export function parseView(raw: string | null): SidePanelView {
  return raw === 'for-you' ? 'forYou' : 'panel'
}

/**
 * SECTIONS_KEY read: `{"open":[…],"known":[…]}`; a card the save didn't know
 * yet (`known` absent: the cards before the computer card) keeps its default.
 * The legacy list of folded ids (any list), junk or missing: the defaults.
 */
export function parseSectionOpen(raw: string | null): Readonly<Record<SectionId, boolean>> {
  if (!raw) return NONE_OPEN
  try {
    const saved = JSON.parse(raw) as unknown
    if (Array.isArray(saved)) return NONE_OPEN
    const open = (saved as { open?: unknown } | null)?.open
    if (!Array.isArray(open)) return NONE_OPEN
    const knownRaw = (saved as { known?: unknown }).known
    const known = Array.isArray(knownRaw) ? knownRaw : SECTION_IDS.filter((id) => !LEAD_IDS.includes(id))
    return Object.fromEntries(SECTION_IDS.map((id) => [id, known.includes(id) ? open.includes(id) : NONE_OPEN[id]])) as Record<SectionId, boolean>
  } catch {
    return NONE_OPEN
  }
}

/** ORDER_KEY read: the known ids once each, in the saved order, any the list lacks after them in the default order. */
export function parseOrder(raw: string | null): readonly SectionId[] {
  if (!raw) return SECTION_IDS
  let saved: unknown
  try {
    saved = JSON.parse(raw)
  } catch {
    return SECTION_IDS
  }
  if (!Array.isArray(saved)) return SECTION_IDS
  const kept = [...new Set(saved.filter(isSectionId))]
  const missing = SECTION_IDS.filter((id) => !kept.includes(id))
  const order = [...missing.filter((id) => LEAD_IDS.includes(id)), ...kept, ...missing.filter((id) => !LEAD_IDS.includes(id))]
  return order.every((id, i) => id === SECTION_IDS[i]) ? SECTION_IDS : order
}

/**
 * `order` with `id` moved to `to` among the `visible` cards only: the visible
 * cards trade the slots they held, a hidden card keeps its own (so Plan coming
 * back shows where it was). `to` is clamped; an id not visible is no move.
 */
export function moveAmongVisible(
  order: readonly SectionId[],
  visible: readonly SectionId[],
  id: SectionId,
  to: number,
): readonly SectionId[] {
  const shown = order.filter((s) => visible.includes(s))
  const from = shown.indexOf(id)
  const target = Math.max(0, Math.min(shown.length - 1, to))
  if (from < 0 || from === target) return order
  shown.splice(from, 1)
  shown.splice(target, 0, id)
  let next = 0
  return order.map((s) => (visible.includes(s) ? shown[next++] : s))
}

function readSaved(): SidePanelState {
  return {
    rightOpen: readKey(RIGHT_OPEN_KEY) === '1',
    view: parseView(readKey(VIEW_KEY)),
    forYouContent: false,
    sectionOpen: parseSectionOpen(readKey(SECTIONS_KEY)),
    order: parseOrder(readKey(ORDER_KEY)),
    connectionsAttention: false,
    captureDock: false,
    pagePanel: false,
    pagePanelPage: false,
    pagePanelOpen: readKey(PAGE_PANEL_OPEN_KEY) !== '0',
    pagePanelFloatOk: false,
    pagePanelShown: false,
  }
}

/**
 * The panel is on screen: open, on the sections or on For you with cards.
 * Open on For you with none, it waits off screen (rightOpen and the view
 * kept), and the space plan gives the chat its room back.
 */
export function rightShown(s: Pick<SidePanelState, 'rightOpen' | 'view' | 'forYouContent'>): boolean {
  return s.rightOpen && (s.view === 'panel' || s.forYouContent)
}

/** The view on screen now, or null with the panel off screen: what lights its button. */
export function shownView(s: Pick<SidePanelState, 'rightOpen' | 'view' | 'forYouContent'>): SidePanelView | null {
  return rightShown(s) ? s.view : null
}

/** The page panel asks the row for the left: it has something to show and is open. */
export function pagePanelWanted(s: Pick<SidePanelState, 'pagePanel'> & Partial<Pick<SidePanelState, 'pagePanelOpen'>>): boolean {
  return s.pagePanel && s.pagePanelOpen !== false
}

const listeners = new Set<() => void>()
/** Null until the first client read: the saved state is read lazily, never at import. */
let state: SidePanelState | null = null

function emit(): void {
  for (const listener of listeners) listener()
}

function set(patch: Partial<SidePanelState>): void {
  const current = getSidePanelState()
  const next = { ...current, ...patch }
  if ((Object.keys(next) as Array<keyof SidePanelState>).every((k) => next[k] === current[k])) return
  // A panel comes on or goes off screen: the chat's width changes once, so its place is noted first.
  if (rightShown(next) !== rightShown(current) || pagePanelWanted(next) !== pagePanelWanted(current)) captureChatAnchor()
  state = next
  emit()
}

/** The client snapshot (one object per change, so React sees no change until there is one). */
export function getSidePanelState(): SidePanelState {
  if (!state) state = readSaved()
  return state
}

/** The server snapshot: closed, on the sections, every card closed, the default order. */
export function getServerSidePanelState(): SidePanelState {
  return SERVER
}

export function subscribeSidePanels(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && ![RIGHT_OPEN_KEY, VIEW_KEY, SECTIONS_KEY, ORDER_KEY, PAGE_PANEL_OPEN_KEY].includes(e.key)) return
    const saved = readSaved()
    const current = getSidePanelState()
    set({
      rightOpen: saved.rightOpen,
      view: saved.view,
      pagePanelOpen: saved.pagePanelOpen,
      sectionOpen: sameOpen(saved.sectionOpen, current.sectionOpen) ? current.sectionOpen : saved.sectionOpen,
      order: saved.order.join() === current.order.join() ? current.order : saved.order,
    })
  }
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
  }
}

export function setRightPanelOpen(open: boolean): void {
  if (getSidePanelState().rightOpen === open) return
  writeKey(RIGHT_OPEN_KEY, open ? '1' : null)
  set({ rightOpen: open })
}

/** The panel's view, remembered per device; its open state untouched. */
export function setSidePanelView(view: SidePanelView): void {
  if (getSidePanelState().view === view) return
  writeKey(VIEW_KEY, view === 'forYou' ? 'for-you' : null)
  set({ view })
}

/**
 * ⌘\: the panel off screen if it is on, else on, on the view it had. Open
 * on For you with no cards (nothing on screen), the key opens the sections:
 * a key press always shows or hides something.
 */
export function toggleRightPanel(): void {
  const current = getSidePanelState()
  if (rightShown(current)) {
    setRightPanelOpen(false)
    return
  }
  if (current.view === 'forYou' && !current.forYouContent) setSidePanelView('panel')
  setRightPanelOpen(true)
}

/**
 * A view's top-bar button (side-panel-toggles.tsx): the panel closes when
 * that view is the one on screen, else it opens on it (switched in place,
 * no slide, when the other view was showing). For you's button shows only
 * with cards.
 */
export function toggleSidePanelView(view: SidePanelView): void {
  if (shownView(getSidePanelState()) === view) {
    setRightPanelOpen(false)
    return
  }
  setSidePanelView(view)
  setRightPanelOpen(true)
}

/** The panel says whether For you has cards (with none, its view is never drawn). */
export function setForYouContent(has: boolean): void {
  set({ forYouContent: has })
}

const sameOpen = (a: Readonly<Record<SectionId, boolean>>, b: Readonly<Record<SectionId, boolean>>) =>
  SECTION_IDS.every((id) => a[id] === b[id])

/** Open or close one of the right panel's cards, remembered (in SECTIONS_KEY's new shape). */
export function setSectionOpen(id: SectionId, open: boolean): void {
  const current = getSidePanelState().sectionOpen
  if (current[id] === open) return
  const next = { ...current, [id]: open }
  writeKey(SECTIONS_KEY, JSON.stringify({ open: SECTION_IDS.filter((k) => next[k]), known: SECTION_IDS }))
  set({ sectionOpen: next })
}

/** Move a card to `to` among the cards showing now (moveAmongVisible), remembered. */
export function moveSection(id: SectionId, to: number, visible: readonly SectionId[]): void {
  const current = getSidePanelState().order
  const next = moveAmongVisible(current, visible, id, to)
  if (next === current) return
  writeKey(ORDER_KEY, JSON.stringify(next))
  set({ order: next })
}

export function setConnectionsAttention(attention: boolean): void {
  set({ connectionsAttention: attention })
}

/**
 * The page panel says whether it has something to show here, and whether
 * that is a page's sub-nav with its card in front (page-panel/page-panel.tsx).
 */
export function setPagePanelContent(has: boolean, page = false): void {
  set({ pagePanel: has, pagePanelPage: has && page })
}

/**
 * Open or close the page panel by hand (its button), remembered per device.
 * Opened so, it may float over the chat where the row has no room for it
 * (pagePanelFloatOk, this session only): a press always shows something.
 */
export function setPagePanelOpen(open: boolean): void {
  const current = getSidePanelState()
  if (current.pagePanelOpen === open && (!open || current.pagePanelFloatOk)) return
  writeKey(PAGE_PANEL_OPEN_KEY, open ? null : '0')
  set({ pagePanelOpen: open, pagePanelFloatOk: open })
}

/** The page panel's button: closed while it is on screen, else opened by hand. */
export function togglePagePanel(): void {
  setPagePanelOpen(!getSidePanelState().pagePanelShown)
}

/** The page panel's host says whether it is on screen now (the row's plan). */
export function setPagePanelShown(shown: boolean): void {
  set({ pagePanelShown: shown })
}

/** The live capture's notepad docks or goes (live-capture-dock.tsx): the space plan counts its push. */
export function setCaptureDockOpen(open: boolean): void {
  if (getSidePanelState().captureDock === open) return
  captureChatAnchor()
  set({ captureDock: open })
}

// ── The chat's bottom anchor ───────────────────────────────────────────────

/**
 * The main chat's thread (ChatContainerContent, marked by chat-panel.tsx).
 * What scrolls is its parent: use-stick-to-bottom's scroll element, inside
 * the role="log" root, which itself never scrolls.
 */
export const CHAT_THREAD_SELECTOR = '#ni-chat-strip-slot [data-main-chat-thread]'

/** Within this of the bottom, the chat is AT its bottom: use-stick-to-bottom keeps it there. */
const AT_BOTTOM_PX = 2

let pendingAnchor: { el: HTMLElement; fromBottom: number } | null = null

/**
 * How the chat stops following its bottom (use-stick-to-bottom's stopScroll),
 * registered by the main chat (ChatFeedPublisher). A chat scrolled up keeps
 * its place through the width change: without this, a scroll its lock had
 * not yet counted as an escape (a programmatic one, or one landing while the
 * thread was still settling after a reload) would be pulled to the bottom by
 * the re-wrapped text's resize.
 */
let holdChatScroll: (() => void) | null = null

export function registerChatScrollHold(hold: (() => void) | null): () => void {
  holdChatScroll = hold
  return () => {
    if (holdChatScroll === hold) holdChatScroll = null
  }
}

/** The element that scrolls the main chat's conversation, or null. */
export function chatScroller(doc: Document = document): HTMLElement | null {
  return doc.querySelector<HTMLElement>(CHAT_THREAD_SELECTOR)?.parentElement ?? null
}

/** Note how far the chat is from its bottom, before a toggle changes its width. */
export function captureChatAnchor(): void {
  if (typeof document === 'undefined') return
  const el = chatScroller()
  if (!el) {
    pendingAnchor = null
    return
  }
  const fromBottom = Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight)
  pendingAnchor = { el, fromBottom }
  // Scrolled up: it stays where it is, never pulled down by the resize.
  if (fromBottom > AT_BOTTOM_PX) holdChatScroll?.()
}

/** Put the chat back that far from its bottom (in a layout effect, before paint). One use per capture. */
export function restoreChatAnchor(): void {
  const anchor = pendingAnchor
  pendingAnchor = null
  if (!anchor || !anchor.el.isConnected) return
  const top = Math.max(0, anchor.el.scrollHeight - anchor.el.clientHeight - anchor.fromBottom)
  if (anchor.el.scrollTop !== top) anchor.el.scrollTop = top
}

/** Test seam: forget the session's state and any pending anchor. */
export function resetSidePanelStore(): void {
  state = null
  pendingAnchor = null
  holdChatScroll = null
}
