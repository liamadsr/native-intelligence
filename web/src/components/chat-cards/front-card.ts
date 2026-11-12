/**
 * The card full screen now, for what sits outside the chat: the app rail
 * (app/account/(dashboard)/rail/app-rail.tsx) follows it for the selected
 * place (rail/selected-place.ts) and puts it away (Home). Each ShowToolCard
 * holds an entry while it is full screen (show-tool-card.tsx), whichever
 * chat's store it belongs to, so the rail needs no reach into the chat's card
 * store.
 *
 * And while one is held, <html> carries FRONT_CARD_ATTR, so beside the rail
 * the chat and the top bar under the full-screen layer stop painting
 * (tailwind.css): the page sits on the app's own background, beside the rail,
 * with no blur (Liam, 11-09). Held from the moment a card is asked full
 * screen, so a parked page waking to show (a few frames) shows the background
 * meanwhile, never a flash of the chat between two pages.
 *
 * Beside it, the page panel (app/account/(dashboard)/page-panel/; Liam,
 * 11-11: "I want the panel to persist when you open something, it should
 * just make room for both things to be open") stays on screen under a card,
 * and says how much of the row's left it covers on <html> (PAGE_PANEL_W_VAR):
 * the full-screen layer starts after it (show-tool-card.tsx), so the card
 * makes room for it.
 *
 * And the main chat's composer stays on screen under a card (Liam, 11-11:
 * "you can still see the main chat input even when you have a panel open"):
 * beside the rail only its dock keeps painting of the chat (tailwind.css),
 * and the chat panel says how tall the dock stands on <html>
 * (COMPOSER_RESERVE_VAR): the full-screen layer ends above it
 * (show-tool-card.tsx), so the card makes room for it too. A message sent
 * from it puts the card back in the chat (chat-panel.tsx, closeFrontCards).
 *
 * Flat cost: a module-level list written only when a card enters or leaves
 * full screen, read by one rail.
 *
 * Client-safe: no server imports.
 */
import type { CardSpec } from '@/lib/chat-cards/kinds'

export interface FrontCard {
  /** The card's id (its tool call or opened-card id). */
  id: string
  spec: CardSpec
  /** Put it back (out of full screen). */
  close: () => void
  /**
   * Put it back as a minimize the person asked for (an empty press): its
   * flight into the tile first, out of full screen a frame later
   * (minimized-card.ts minimizeSoon). Where absent, `close`.
   */
  minimize?: () => void
}

/** On <html> while a card is held full screen (from the ask, its layer drawn or waking). */
export const FRONT_CARD_ATTR = 'data-card-front'

/**
 * On <html> while the page panel is on screen: its width and its gutter on
 * both sides, from the app rail's edge (page-panel-frame.tsx pagePanelReserve).
 * Unset (0) without it, so the full-screen layer starts at the rail's edge.
 */
export const PAGE_PANEL_W_VAR = '--page-panel-w'

/**
 * On <html> while the main chat is mounted: how tall its composer dock stands,
 * px (chat-panel.tsx, from the dock's ResizeObserver; the dock sits at the
 * window's bottom). Unset (0) without it, so the layer runs to the bottom.
 */
export const COMPOSER_RESERVE_VAR = '--composer-reserve'

/** Write the main chat's composer dock height on <html> (COMPOSER_RESERVE_VAR); null clears it. */
export function setComposerReserve(px: number | null): void {
  if (typeof document === 'undefined') return
  const html = document.documentElement
  if (px === null) html.style.removeProperty(COMPOSER_RESERVE_VAR)
  else html.style.setProperty(COMPOSER_RESERVE_VAR, `${px}px`)
}

let entries: FrontCard[] = []
const listeners = new Set<() => void>()

function notify(): void {
  if (typeof document !== 'undefined') {
    if (entries.length) document.documentElement.setAttribute(FRONT_CARD_ATTR, '')
    else document.documentElement.removeAttribute(FRONT_CARD_ATTR)
  }
  for (const listener of [...listeners]) listener()
}

/** Hold `card` as full screen; the returned function lets it go. The latest held is in front. */
export function holdFrontCard(card: FrontCard): () => void {
  const entry = { ...card }
  entries = [...entries, entry]
  notify()
  return () => {
    if (!entries.includes(entry)) return
    entries = entries.filter((e) => e !== entry)
    notify()
  }
}

/** The card in front, or null with none full screen. Stable between changes (useSyncExternalStore). */
export function frontCard(): FrontCard | null {
  return entries.length ? entries[entries.length - 1] : null
}

export function subscribeFrontCard(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Put every full-screen card back: the chat in front again. */
export function closeFrontCards(): void {
  for (const entry of [...entries].reverse()) entry.close()
}

/**
 * Put the full-screen card back as a minimize the person asked for (Home on
 * the rail): the one in front by its own `minimize` (its flight into the
 * tile first, the same sequence as an empty press or Esc; Liam, 11-11: "the
 * entire open sequence needs to happen smoother"), anything under it, or a
 * card with none, by `close`.
 */
export function minimizeFrontCards(): void {
  const all = [...entries].reverse()
  all.forEach((entry, i) => {
    if (i === 0 && all.length === 1 && entry.minimize) entry.minimize()
    else entry.close()
  })
}
