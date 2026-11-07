/**
 * The line that ties a card to the message it goes with (Liam, 10-18, as in
 * a messaging app's reply): one stroke, one corner and one tone wherever the
 * chat draws it.
 *
 *   ┐ `down-from-right`: from a card's right side, across and down to just
 *     above the bubble under it (the For you card the person replied to,
 *     card-reply-chip.tsx CardReplyQuote).
 *   ╰ `into-left`: from just under the bubble above, down and into a card's
 *     left side (a report's deliverable, teammate-report-chip.tsx).
 *
 * A reply joined to the message it answers draws a bigger ┐ in full ink,
 * bubble to bubble (REPLY_LINK_STROKE, below).
 *
 * Drawn in the sky's ink (--sky-ink), so it shows in both themes, day or night.
 * Placed in the card's own box (the card is `relative`): it reaches out of
 * the card by `--thread-hook-reach` (the message column's gap-2) less a hair,
 * so it never touches the bubble it points at.
 */
import { cn } from '@/lib/utils'

// The sky's ink (tailwind.css --sky-ink), not the theme's: the line sits on the sky, which the theme
// alone doesn't decide (the dark theme's light foreground vanished on a light day sky: Liam, 10-18).
const STROKE = 'pointer-events-none absolute w-3 border-[hsl(var(--sky-ink)/0.45)]'

export function ThreadHook({ shape }: { shape: 'down-from-right' | 'into-left' }) {
  return (
    <span
      aria-hidden
      data-thread-hook={shape}
      className={cn(
        STROKE,
        shape === 'down-from-right'
          ? 'left-full top-1/2 ml-1.5 h-[calc(50%+0.5rem-3px)] rounded-tr-[8px] border-r-[1.5px] border-t-[1.5px]'
          : 'bottom-1/2 right-full mr-1.5 h-[calc(50%+0.5rem-3px)] rounded-bl-[8px] border-b-[1.5px] border-l-[1.5px]',
      )}
    />
  )
}

/**
 * The compact ┐ that points a reply at the message it answers (reply-link.ts,
 * message-reply-chip.tsx ReplyLinkHook; GEN-353, Liam's references): one
 * 26px glyph, 3px stroke, 8px corner, the sky's ink at full strength (dark on
 * a light sky, light on a dark one). Its place is measured; `group/hook` on
 * the host fades it a little under the pointer.
 */
export const REPLY_LINK_STROKE =
  'pointer-events-none absolute border-[hsl(var(--sky-ink))] transition-opacity group-hover/hook:opacity-70 motion-reduce:transition-none'
