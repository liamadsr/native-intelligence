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
 * The header's spacing (Liam, 11-23: "the create buttons at times clash with
 * the other elements in the top right header they should always look well
 * spaced and balanced"): whatever has a surface of its own there (a pill
 * button, a capsule of segments, a field) keeps 2px of margin each side
 * (tailwind.css, `[data-card-header] .ni-header-spaced`), whichever wrappers
 * the page put it in: 4px off a round icon button beside it, 6px off another
 * surface. Round icon buttons keep their 2px gap. In every class below that
 * draws a surface; add it to any other surface a page puts in the header.
 */
export const CARD_HEADER_SPACED = 'ni-header-spaced'

/**
 * A page's own action in the card's header, with words (New spreadsheet, New
 * canvas, New table): a pill on the header's glass, like the layout switcher's
 * capsule beside it.
 */
export const CARD_HEADER_PILL_BUTTON =
  'ni-header-spaced inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-foreground/[0.06] px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-foreground/[0.1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none [&_svg]:size-3.5'

/**
 * A page's sections, views or filters in the card's header (Calendar's views,
 * the inbox's filters, a page's tabs): a capsule of 24px segments, the one in
 * use lifted. Its segments are CARD_HEADER_SEGMENT (words) or CARD_HEADER_SEGMENT_ICON.
 */
export const CARD_HEADER_CAPSULE = 'ni-header-spaced flex h-6 shrink-0 items-center overflow-hidden rounded-full bg-foreground/[0.05]'

/** One segment with words; chosen by aria-selected (tabs), aria-checked (radios), aria-pressed or data-state=on/active. */
export const CARD_HEADER_SEGMENT =
  'flex h-full items-center whitespace-nowrap px-2.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-selected:bg-foreground/[0.1] aria-selected:font-medium aria-selected:text-foreground aria-checked:bg-foreground/[0.1] aria-checked:font-medium aria-checked:text-foreground aria-pressed:bg-foreground/[0.1] aria-pressed:font-medium aria-pressed:text-foreground data-[state=on]:bg-foreground/[0.1] data-[state=on]:font-medium data-[state=on]:text-foreground data-[state=active]:bg-foreground/[0.1] data-[state=active]:font-medium data-[state=active]:text-foreground motion-reduce:transition-none'

/** One segment with an icon only (28px wide). */
export const CARD_HEADER_SEGMENT_ICON =
  'flex h-full w-7 items-center justify-center text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-selected:bg-foreground/[0.1] aria-selected:text-foreground aria-checked:bg-foreground/[0.1] aria-checked:text-foreground aria-pressed:bg-foreground/[0.1] aria-pressed:text-foreground data-[state=on]:bg-foreground/[0.1] data-[state=on]:text-foreground motion-reduce:transition-none'

/** A field in the card's header (a site to look up, a topic): 24px, round, a faint tint, no border. */
export const CARD_HEADER_FIELD =
  'ni-header-spaced h-6 min-w-0 rounded-full border-0 bg-foreground/[0.05] px-3 text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-ring'

/** A choice in the card's header (a country, a language, a type): words and a chevron, no surface until hovered. */
export const CARD_HEADER_CHOICE =
  'inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs text-foreground transition-colors hover:bg-foreground/[0.06] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-foreground/[0.06] [&_svg]:size-3.5 [&_svg]:text-muted-foreground'
