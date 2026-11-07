/**
 * The agents' floating glass: the one material the live agent's HUD, the
 * live chat, an agent's chat and its notices share. Kept as class constants,
 * free of React. GlassBackdrop (glass-backdrop.tsx) supplies a single glass
 * sheet behind the HUD; its cards retain their fill and edge. Elsewhere,
 * each glass piece carries its own blur and legibility over page content:
 *   • frosted: a translucent fill with a heavy blur and a saturation lift
 *     (iOS notification glass), light in light mode, a lifted graphite (not
 *     black) in dark, each opaque enough that text reads over a busy page,
 *     a white in-app browser page in dark mode included (backdrop-filter
 *     can't blur a native page under the app, so the fill alone has to do);
 *   • a hairline edge (a dark one in light mode, a light one in dark) and, in
 *     dark, a top light: a brighter inner edge along the top and a faint
 *     sheen fading down from it, so a card reads as a lit piece standing off
 *     a dark page, not a dark rectangle on it;
 *   • a soft, diffuse shadow that lifts it off the page without a halo
 *     (deeper in dark, where a shadow has less to show against);
 *   • solid where the reader asks for less transparency.
 *
 * Small quiet text on it is BOT_GLASS_MUTED, not `text-muted-foreground`:
 * the page's muted grey is tuned for the page, and on a card with the page's
 * own text showing through it drops to about 3:1.
 *
 * Rounding is the caller's (`rounded-full` for a pill, BOT_GLASS_CARD's
 * radius for a card), as are padding and pointer events.
 */

/** The material alone: fill, blur, edge and shadow, for light and dark. */
export const BOT_GLASS = [
  'bot-glass',
  'border border-black/[0.07] bg-white/[0.84] text-foreground backdrop-blur-xl backdrop-saturate-[1.8]',
  'shadow-[0_1px_2px_rgb(0_0_0/0.04),0_6px_18px_-6px_rgb(0_0_0/0.14),0_16px_36px_-18px_rgb(0_0_0/0.18)]',
  // Dark: a graphite a clear step lighter than the page (rgb 15), lit from
  // the top: a 1px inner highlight and a sheen over its upper half.
  'dark:border-white/[0.1] dark:bg-[rgb(50_50_55/0.9)] dark:bg-[linear-gradient(180deg,rgb(255_255_255/0.045),rgb(255_255_255/0)_55%)]',
  'dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.11),0_1px_2px_rgb(0_0_0/0.4),0_6px_14px_-4px_rgb(0_0_0/0.45),0_18px_40px_-12px_rgb(0_0_0/0.8)]',
  '[@media(prefers-reduced-transparency:reduce)]:bg-popover [@media(prefers-reduced-transparency:reduce)]:backdrop-blur-none',
].join(' ')

/** A floating card: the material with the cards' rounding. */
export const BOT_GLASS_CARD = `${BOT_GLASS} rounded-[20px]`

/**
 * The person's own message: on the right, the primary fill, its corner
 * toward them squared (the teammate chat's, and the live agent HUD's).
 */
export const BOT_USER_BUBBLE = [
  'pointer-events-auto relative min-w-0 max-w-[85%] rounded-[18px] rounded-br-[6px] bg-primary px-3 py-[7px] text-primary-foreground',
  'shadow-[0_1px_2px_rgb(0_0_0/0.08),0_8px_18px_-10px_rgb(0_0_0/0.35)]',
].join(' ')

/** A floating pill (the name tag, a chip). */
export const BOT_GLASS_PILL = `${BOT_GLASS} rounded-full`

/**
 * Quiet text on the glass (a workspace under a name, an unpicked chip, the
 * stack's preview and count, a pager's "1 of 3"): at least 4.5:1 in the worst
 * case, the page's own text showing straight through the fill with no blur
 * (a native page under the app): 36% grey in light, 72% in dark.
 */
export const BOT_GLASS_MUTED = 'text-[hsl(0_0%_36%)] dark:text-[hsl(0_0%_72%)]'

/**
 * A quieter fill for things inside a card (a reading, a secondary button):
 * a tint of the text colour, no edge, so it never reads as a second card.
 */
export const BOT_GLASS_INSET = 'bg-black/[0.045] dark:bg-white/[0.07]'

/**
 * A glass piece fading in as it mounts (`@starting-style`): pair it with a
 * transition that includes opacity. Always on the glass itself, never on a
 * wrapper: an ancestor below full opacity turns `backdrop-filter` off until
 * it's back at 1 (the blur pops in at the end), while the card's own opacity
 * just cross-fades its blur in with it.
 */
export const BOT_GLASS_ENTER = 'starting:opacity-0'
