/**
 * A blur that fades out (Liam, 2026-10-18, docs/plans/chat-ui-polish.md Phase
 * 7): as blurry as it gets at its strong edge, then less and less blurry
 * toward its soft edge, to nothing, instead of one flat blurry band with a
 * short edge. What scrolls under the top bar (or behind the composer) goes
 * soft gradually.
 *
 * A progressive blur: FADE_LAYERS stacked `backdrop-filter`s of falling
 * strength, each masked to its own stretch with soft, overlapping ends. At
 * the strong edge they all stack (about the old single layer's 12px); going
 * toward the soft edge the strong ones drop out first, so the strength steps
 * down smoothly, with no seam where one ends.
 *
 * Every layer runs from the strong edge to where it is gone, and nowhere
 * else: no layer has an edge inside the blur that its mask doesn't hide. A
 * backdrop-filter blurs only inside its own box, so two layers butting
 * against each other draw a line in what's behind them (Liam, 10-19: the
 * composer dock's old full-strength layer under a fade band drew one across
 * the clouds, and it rose with the dock when a card was attached). Ending
 * each layer where its mask has already faded it to nothing also spares the
 * pixels it would blur only to hide.
 *
 * Cost: each layer re-composites while the sky moves or the chat scrolls;
 * four is the budget (measure the desktop app's WebContent CPU before adding
 * any).
 */
import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'

/**
 * Each layer: its blur, and where (0 = the strong end, 1 = the soft end of
 * the fade) it starts fading out and where it is gone.
 */
export const FADE_LAYERS: ReadonlyArray<{ blur: number; from: number; to: number }> = [
  { blur: 10, from: 0, to: 0.35 },
  { blur: 5, from: 0.2, to: 0.6 },
  { blur: 2.5, from: 0.45, to: 0.82 },
  { blur: 1, from: 0.65, to: 1 },
]

function pct(n: number): string {
  return `${Math.round(n * 1000) / 10}%`
}

/** A layer's mask: opaque from the strong end until `from`, gone by `to` (fractions of the layer's own box). */
export function fadeMask(direction: 'down' | 'up', from: number, to: number): string {
  return `linear-gradient(${direction === 'down' ? 'to bottom' : 'to top'}, #000 ${pct(from)}, transparent ${pct(to)})`
}

/**
 * A layer's box and mask: from the strong edge to `to` of the whole, so its
 * mask, scaled to that box, fades it to nothing exactly at the box's far end.
 */
export function layerPlace(direction: 'down' | 'up', layer: { from: number; to: number }): { box: CSSProperties; mask: string } {
  return {
    box: { [direction === 'down' ? 'top' : 'bottom']: 0, height: pct(layer.to) },
    mask: fadeMask(direction, layer.from / layer.to, 1),
  }
}

/**
 * `direction`: where it fades to: `down` (strong at the top, the top bar's) or
 * `up` (strong at the bottom, the composer dock's). Position and size it with
 * `className` / `style`; it never takes a pointer.
 */
export function FadingBlur({ direction, className, style }: { direction: 'down' | 'up'; className?: string; style?: CSSProperties }) {
  return (
    <div aria-hidden data-fading-blur={direction} className={cn('pointer-events-none', className)} style={style}>
      {FADE_LAYERS.map((layer) => {
        const { box, mask } = layerPlace(direction, layer)
        return (
          <div
            key={layer.blur}
            data-fading-blur-layer={layer.blur}
            className="absolute inset-x-0"
            style={{
              ...box,
              backdropFilter: `blur(${layer.blur}px)`,
              WebkitBackdropFilter: `blur(${layer.blur}px)`,
              maskImage: mask,
              WebkitMaskImage: mask,
            }}
          />
        )
      })}
    </div>
  )
}
