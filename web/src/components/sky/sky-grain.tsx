/**
 * A photograph's grain over the sky: a small tiling noise image at a low
 * opacity, soft-light blended, over the canvas (and the CSS gradients) and
 * under the UI. It breaks up the smooth fill so a clear sky stops reading as
 * a flat colour hue, and hides any banding in the slow fades.
 *
 * Not in the shader: the canvas is drawn at a quarter resolution, so grain
 * there would upscale into blotches. Here the browser rasterises the SVG once
 * at full device resolution and composites it: static, no animation, no
 * per-frame work (WebKit keeps style and layout busy for a CSS animation).
 */

/**
 * The tile: fractal noise from feTurbulence, made grey and opaque, with its
 * contrast stretched around mid-grey (soft-light leaves mid-grey unchanged,
 * so the sky's average colour stays put). `stitchTiles` makes it tile with
 * no seams.
 */
const GRAIN_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'>" +
  "<filter id='g' x='0' y='0' width='100%' height='100%' color-interpolation-filters='sRGB'>" +
  "<feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' seed='7' stitchTiles='stitch'/>" +
  "<feColorMatrix type='matrix' values='1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 0 0 0 0 1'/>" +
  "<feComponentTransfer><feFuncR type='linear' slope='2.6' intercept='-0.8'/><feFuncG type='linear' slope='2.6' intercept='-0.8'/><feFuncB type='linear' slope='2.6' intercept='-0.8'/></feComponentTransfer>" +
  "</filter><rect width='200' height='200' filter='url(#g)'/></svg>"

export const SKY_GRAIN_IMAGE = `url("data:image/svg+xml,${encodeURIComponent(GRAIN_SVG)}")`
/** The tile's size in CSS pixels. */
export const SKY_GRAIN_TILE_PX = 200
/**
 * The grain's opacity per theme: barely there. Soft-light changes dark
 * colours relatively more, so the dark theme's sky (the signed-out pages'
 * dimmed one and the app's exposed for the dark alike) takes a little less.
 * The class below spells the same numbers (Tailwind needs them literal).
 */
export const SKY_GRAIN_OPACITY = { light: 0.06, dark: 0.045 } as const
const OPACITY_CLASS = 'opacity-[0.06] dark:opacity-[0.045]'

export function SkyGrain() {
  return (
    <div
      aria-hidden
      data-sky-grain=""
      className={`pointer-events-none absolute inset-0 ${OPACITY_CLASS}`}
      style={{
        backgroundImage: SKY_GRAIN_IMAGE,
        backgroundSize: `${SKY_GRAIN_TILE_PX}px ${SKY_GRAIN_TILE_PX}px`,
        backgroundRepeat: 'repeat',
        mixBlendMode: 'soft-light',
      }}
    />
  )
}
