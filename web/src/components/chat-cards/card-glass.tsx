/**
 * A card's window look on main, on its own so a light page can wear it
 * without the card machinery (the landing page's demo cards:
 * components/landing/demo-card.tsx). ShowToolCard (show-tool-card.tsx) draws
 * every chat card with these.
 */

/**
 * The glass behind a card's content: main's window glass. The translucent bg
 * and the blur live on a sibling PAINTED BEHIND the content, never on the
 * frame itself: a composited descendant (tiptap's contenteditable) would make
 * the blur sample the opaque shell instead.
 */
export function CardGlass() {
  return <div data-card-glass="" className="pointer-events-none absolute inset-0 z-0 rounded-3xl bg-background/70 backdrop-blur-md" />
}

/** A window's frame on main: a fine border, a soft shadow and ring. */
export const CARD_GLASS_FRAME =
  'rounded-3xl border border-border/60 shadow-lg shadow-black/5 ring-1 ring-black/5 dark:shadow-black/30 dark:ring-white/5'
