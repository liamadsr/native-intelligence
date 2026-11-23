/**
 * The chat card header's small icon buttons: Back / Forward, the page's
 * Properties.
 *
 * Round, with a faint tint of the text colour on hover, not an opaque
 * `bg-muted` box. The card is glass with 24px corners (rounded-3xl), and a
 * square, solid hover box parked in that corner read as a patch stuck on the
 * frame. A circle echoes the corner's curve, and a tint lets the glass show
 * through (it works the same in dark mode, where the foreground is light).
 * The header's padding (show-tool-card.tsx, `px-4` on an `h-10` row) keeps
 * the circles clear of the corner's curve.
 */
export const CARD_HEADER_ICON_BUTTON =
  'rounded-full text-muted-foreground/70 transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

/** The same button while what it opens is open (the Properties popover). */
export const CARD_HEADER_ICON_BUTTON_ACTIVE = 'bg-foreground/[0.06] text-foreground'

/**
 * A page's own action in the card's header, with words (New spreadsheet, New
 * canvas, New table): a pill on the header's glass, like the layout switcher's
 * capsule beside it.
 */
export const CARD_HEADER_PILL_BUTTON =
  'inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-foreground/[0.06] px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-foreground/[0.1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none'
