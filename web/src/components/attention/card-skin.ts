/**
 * The one floating-card surface over the living sky (Liam, 10-16: "it
 * shouldn't feel like you have two side panels; you just have floating
 * cards"). The For you column's cards wear it (attention, review and question
 * cards: `surface: 'column'`), and so do the right side panel's sections
 * (side-panels/side-panels.tsx): Agents, Plan, Connectors.
 *
 * Glass, as the pages in the chat are (Liam, 10-16: the same see-through
 * background as the rest of the app, "so it's not just pure white"): the
 * page cards' own `bg-background/70 backdrop-blur-md` (chat-cards/
 * show-tool-card.tsx CardGlass), with a hairline lift, light and dark. The
 * cost it takes on: each card's backdrop-filter re-composites while the sky
 * moves (it moves only while calm, and holds still under a focus blur); a
 * few cards on screen, as the pages already pay it.
 *
 * A plain module (no React) so the side panel can wear it without pulling the
 * attention card in.
 */
export const COLUMN_CARD_SKIN =
  'bg-background/70 text-card-foreground shadow-sm shadow-black/[0.05] backdrop-blur-md dark:border-white/10 dark:shadow-black/30'

/** A whole floating card: the skin with the cards' own edge and corners (rounded-xl, border-border/60). */
export const FLOATING_CARD_CLASS = `rounded-xl border border-border/60 ${COLUMN_CARD_SKIN}`

/**
 * A card's verb, as the For you column's compact cards say it (Liam, 10-16:
 * "more like Hard where you just see the action button"): a small light pill
 * the card's sentence carries on from. The chat's reply chip
 * (chat/card-reply-chip.tsx) wears it too, so the attached card reads as the
 * card it came from.
 */
export const VERB_PILL_CLASS =
  'inline-flex h-6 shrink-0 items-center gap-1 rounded-lg border border-border/70 bg-background px-2 text-[12px] font-medium leading-none text-foreground shadow-sm shadow-black/[0.04] dark:border-white/10 dark:bg-white/[0.06]'
