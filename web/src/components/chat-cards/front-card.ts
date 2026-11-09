/**
 * The card full screen now, for what sits outside the chat: the app rail
 * (app/account/(dashboard)/rail/app-rail.tsx) lights the page in front and
 * puts it away (Home, New). Each ShowToolCard holds an entry while it is full
 * screen (show-tool-card.tsx), whichever chat's store it belongs to, so the
 * rail needs no reach into the chat's card store.
 *
 * And while one is held, <html> carries FRONT_CARD_ATTR, so beside the rail
 * the chat and the top bar under the full-screen layer stop painting
 * (tailwind.css): the page sits on the app's own background, beside the rail,
 * with no blur (Liam, 11-09). Held from the moment a card is asked full
 * screen, so a parked page waking to show (a few frames) shows the background
 * meanwhile, never a flash of the chat between two pages.
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
}

/** On <html> while a card is held full screen (from the ask, its layer drawn or waking). */
export const FRONT_CARD_ATTR = 'data-card-front'

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
