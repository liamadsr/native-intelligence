/**
 * The side panels around the main chat, as one small external store (Liam,
 * 10-15: "make it a lot more smoother so that they all fit nicely"): the
 * right panel (Agents · Plan · Context · Environment · Connections) and the For you column on the
 * left share one model, one toggle each, one motion and one space plan
 * (space-plan.ts). Nothing here lives in ChatPanel, so toggling a panel never
 * re-renders the chat.
 *
 *   right     open or closed, remembered per device (RIGHT_OPEN_KEY).
 *   left      the For you column: open unless the person folded it away,
 *             remembered as it always was (FOR_YOU_COLLAPSED_KEY), and drawn
 *             only while it has cards and no live capture's notepad holds the
 *             left (leftContent, told by the column itself).
 *   sections  the right panel's cards: which the person opened (closed until
 *             then: the high-level view, one row each) and their order,
 *             dragged by hand, each remembered per device.
 *
 * Every read and write of storage is in try/catch: blocked storage keeps the
 * state in memory for the session. The server snapshot is closed, every card
 * closed and in the default order, so hydration never mismatches; the client
 * then renders what the device saved. Another tab's change arrives as a `storage` event.
 *
 * The chat's bottom anchor: a toggle whose panel moves the chat's content
 * changes the chat's width once, and its text re-wraps. The toggle notes how
 * far the person was from the chat's bottom (captureChatAnchor) and the row
 * puts them back there in the same frame (restoreChatAnchor), before paint.
 */

export type SectionId = 'computer' | 'agents' | 'plan' | 'context' | 'environment' | 'connections'

export interface SidePanelState {
  /** The right panel is open. */
  rightOpen: boolean
  /** The For you column is open (not folded away). */
  leftOpen: boolean
  /** The For you column has something to show, and the left is free for it. */
  leftContent: boolean
  /** The right panel's cards the person opened (closed by default: one row each). */
  sectionOpen: Readonly<Record<SectionId, boolean>>
  /** The right panel's cards in the person's order, every id once (a hidden one keeps its slot). */
  order: readonly SectionId[]
  /** Some connection needs the person (a reconnect, missing access…): the toggle's amber dot. */
  connectionsAttention: boolean
  /**
   * The person opened For you by hand this session: it may float over the
   * chat. Opened only as the device remembered it, it shows where it makes
   * room and waits, closed, where it would float (never over the chat
   * unasked). Session only.
   */
  leftFloatOk: boolean
  /** The live capture's notepad is docked on the chat's left (live-capture-dock.tsx): the chat's content moves over for it. */
  captureDock: boolean
  /** The For you column is on screen now (the row's space plan): what its toggle shows and flips. */
  leftShown: boolean
}

/** Remembered per device: the right panel open. */
export const RIGHT_OPEN_KEY = 'ni:side-panel:open'
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
/**
 * Remembered per device: the For you column folded away. A new name (11-09:
 * For you shows whenever it has cards, its toggle always there to fold it):
 * a fold remembered before then doesn't hide it now.
 */
export const FOR_YOU_COLLAPSED_KEY = 'ni:for-you-column:folded'

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
  leftOpen: false,
  leftContent: false,
  sectionOpen: NONE_OPEN,
  order: SECTION_IDS,
  connectionsAttention: false,
  leftFloatOk: false,
  captureDock: false,
  leftShown: false,
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
    leftOpen: readKey(FOR_YOU_COLLAPSED_KEY) !== '1',
    leftContent: false,
    sectionOpen: parseSectionOpen(readKey(SECTIONS_KEY)),
    order: parseOrder(readKey(ORDER_KEY)),
    connectionsAttention: false,
    leftFloatOk: false,
    captureDock: false,
    leftShown: false,
  }
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
  state = next
  emit()
}

/** The client snapshot (one object per change, so React sees no change until there is one). */
export function getSidePanelState(): SidePanelState {
  if (!state) state = readSaved()
  return state
}

/** The server snapshot: closed, every card closed, the default order. */
export function getServerSidePanelState(): SidePanelState {
  return SERVER
}

export function subscribeSidePanels(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && ![RIGHT_OPEN_KEY, SECTIONS_KEY, ORDER_KEY, FOR_YOU_COLLAPSED_KEY].includes(e.key)) return
    const saved = readSaved()
    const current = getSidePanelState()
    set({
      rightOpen: saved.rightOpen,
      leftOpen: saved.leftOpen,
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
  captureChatAnchor()
  writeKey(RIGHT_OPEN_KEY, open ? '1' : null)
  set({ rightOpen: open })
}

export function toggleRightPanel(): void {
  setRightPanelOpen(!getSidePanelState().rightOpen)
}

/** Open or fold the For you column by hand (its toggle): opened so, it may float over the chat. */
export function setForYouOpen(open: boolean): void {
  const current = getSidePanelState()
  if (current.leftOpen === open && (!open || current.leftFloatOk)) return
  captureChatAnchor()
  writeKey(FOR_YOU_COLLAPSED_KEY, open ? null : '1')
  set({ leftOpen: open, leftFloatOk: open })
}

/** The toggle: `shown` is whether the column is on screen now (the space plan's word, not just the saved state). */
export function toggleForYou(shown: boolean): void {
  setForYouOpen(!shown)
}

/** The For you column says whether it has anything to show (and room on the left to show it). */
export function setForYouContent(has: boolean): void {
  if (getSidePanelState().leftContent === has) return
  captureChatAnchor()
  set({ leftContent: has })
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

/** The live capture's notepad docks or goes (live-capture-dock.tsx): the space plan counts its push. */
export function setCaptureDockOpen(open: boolean): void {
  if (getSidePanelState().captureDock === open) return
  captureChatAnchor()
  set({ captureDock: open })
}

/** The row's space plan, as the rest of the shell reads it: For you on screen. */
export function reportSpacePlan(leftShown: boolean): void {
  set({ leftShown })
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
