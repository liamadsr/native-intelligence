/**
 * Knowledge Map palette — a near-monochrome map with ONE accent, converted
 * once into PREMULTIPLIED float RGBA for the shaders.
 *
 * The reading order the values encode: dots first, labels second, edges last.
 * Node alphas are high enough that a disc reads as an object; edges are pale
 * enough to read as texture rather than as lines; labels sit below both. The
 * accent is the only thing here that leaves the greyscale axis at all, and it
 * means exactly one thing — "this is the neighbourhood you are pointing at".
 *
 * Premultiplied because the canvas is composited with `premultipliedAlpha:
 * true` and blended with `ONE, ONE_MINUS_SRC_ALPHA`: the fragment shader must
 * therefore emit `rgb * a`, not straight `rgb`. Doing the multiply here (7
 * colours, once per theme flip) rather than in the shader keeps the fragment
 * path a single `vec4` multiply.
 *
 * A theme flip is `setPalette()` on the renderer — a handful of uniform
 * writes, no buffer rewrite, because nodes carry a kind/flags byte rather than
 * a colour (architecture §5.1).
 */

import type { Palette } from './types'

type RGBA = [number, number, number, number]

/**
 * Per-theme values. Hard-coded rather than read from CSS variables because the
 * app's design tokens are deliberately greyscale (`--primary` is `0 0% 9%`),
 * so there is no brand accent to inherit — the map has to bring its own, and
 * it has to bring one for each ground.
 *
 * THE ACCENT IS A COOL NEUTRAL, and it has been three things in three weeks,
 * so the reasoning is worth keeping. It began as the foreground ink, which
 * made a hovered neighbourhood merely a slightly darker version of the map and
 * was hard to see at all. It became a violet, which was unmistakable and read
 * as a brand colour landing in the middle of an otherwise monochrome
 * instrument. It is now a steel blue-grey: far enough off the greyscale axis
 * to be a different ink rather than "the same dots, bolder", but nowhere near
 * chromatic enough to be a colour the map is making a statement in.
 *
 * What makes that legible is that it no longer has to carry the separation on
 * its own. DIM dropped to 0.16 when the violet went in, so the un-hovered map
 * recedes to a sixth of its strength; the highlight separates by being the
 * only thing left at full opacity, and the hue is a confirmation rather than
 * the signal. That is why the values below are defined by their LUMA against
 * each ground — deep on the light one, near-white on the dark one — rather
 * than by their saturation.
 */
const LIGHT = {
  claim: 'rgba(30,35,51,0.46)',
  entity: 'rgba(24,28,42,0.82)',
  edge: 'rgba(40,46,66,0.11)',
  label: 'rgba(34,40,58,0.56)',
  accent: 'rgba(46,74,104,1)',
} as const

const DARK = {
  claim: 'rgba(228,230,238,0.54)',
  entity: 'rgba(232,234,242,0.9)',
  edge: 'rgba(160,166,182,0.13)',
  label: 'rgba(220,224,234,0.6)',
  // Brighter AND fuller than `entity` (0.9 alpha), because on this ground the
  // base nodes are already near-white: a neutral accent that merely matched
  // them would make a hover read as nothing happening to anyone who did not
  // notice the rest of the map dim.
  accent: 'rgba(226,238,252,1)',
} as const

/**
 * Suggested (unverified) claims are drawn as hollow rings, so their fill alpha
 * only tints the stroke — give them slightly more presence than a filled claim
 * or the ring disappears at small radii.
 */
const SUGGESTED_ALPHA_SCALE = 1.15
/** Virtual `unfiled:<month>` hubs sit between a claim and a real entity. */
const VIRTUAL_ALPHA_SCALE = 0.85
/**
 * Everything not in the highlight set is multiplied by this while hovering.
 *
 * Lower than it was: the old highlight was drawn in the foreground colour, so
 * it differed from the base map only by being slightly darker, and the dim had
 * to stay mild for the two to stay distinguishable.
 *
 * THIS IS NOW THE PRIMARY SEPARATION, not a supporting one. The accent is a
 * cool neutral rather than the violet this value was first lowered for, so
 * what makes a hovered neighbourhood obvious is that everything else is at a
 * sixth strength while it stays at full. Raising this back toward 0.3 would
 * quietly undo the hover.
 */
const DIM = 0.16

/**
 * Read the live theme. `root` defaults to `<html>`, which is where the app's
 * `dark` class lives.
 */
export function readPalette(root?: HTMLElement): Palette {
  const el = root ?? (typeof document === 'undefined' ? undefined : document.documentElement)
  const isDark = el?.classList.contains('dark') ?? false
  const t = isDark ? DARK : LIGHT

  const claim = parseCssColor(t.claim)!
  const entity = parseCssColor(t.entity)!
  const edge = parseCssColor(t.edge)!
  const label = parseCssColor(t.label)!
  const accent = parseCssColor(t.accent)!

  return {
    claim: premultiply(claim),
    claimSuggested: premultiply(scaleAlpha(claim, SUGGESTED_ALPHA_SCALE)),
    entity: premultiply(entity),
    virtual: premultiply(scaleAlpha(entity, VIRTUAL_ALPHA_SCALE)),
    edge: premultiply(edge),
    accent: premultiply(accent),
    label: premultiply(label),
    dim: DIM,
    isDark,
  }
}

/**
 * Minimal CSS colour parser for the handful of forms this app emits: `#rgb`,
 * `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()/rgba()` and `hsl()/hsla()` in both
 * the legacy comma syntax and the modern space syntax. Returns STRAIGHT
 * (non-premultiplied) rgba in 0..1, or null when the string is not one of
 * those — callers fall back to a hard-coded colour rather than render nothing.
 */
export function parseCssColor(input: string): RGBA | null {
  const s = input.trim().toLowerCase()
  if (!s) return null
  if (s === 'transparent') return [0, 0, 0, 0]
  if (s.startsWith('#')) return parseHex(s)

  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(s)
  if (!fn) return null
  // `rgb(1 2 3 / 50%)` and `rgb(1, 2, 3, 0.5)` both reduce to 3-4 numbers.
  const parts = fn[2]
    .replace(/\//g, ' ')
    .split(/[\s,]+/)
    .filter(Boolean)
  if (parts.length < 3 || parts.length > 4) return null

  const alpha = parts.length === 4 ? parseAlpha(parts[3]) : 1
  if (alpha === null) return null

  if (fn[1].startsWith('rgb')) {
    const rgb = parts.slice(0, 3).map((p) => parseChannel(p, 255))
    if (rgb.some((v) => v === null)) return null
    return [rgb[0]!, rgb[1]!, rgb[2]!, alpha]
  }

  const h = parseFloat(parts[0])
  const sat = parsePercent(parts[1])
  const lig = parsePercent(parts[2])
  if (!Number.isFinite(h) || sat === null || lig === null) return null
  const [r, g, b] = hslToRgb(((h % 360) + 360) % 360, sat, lig)
  return [r, g, b, alpha]
}

/** `rgb * a` — what a premultiplied-alpha pipeline expects. */
export function premultiply(c: RGBA): RGBA {
  return [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]]
}

function scaleAlpha(c: RGBA, factor: number): RGBA {
  return [c[0], c[1], c[2], clamp01(c[3] * factor)]
}

function parseHex(s: string): RGBA | null {
  const hex = s.slice(1)
  const expand = (ch: string) => parseInt(ch + ch, 16) / 255
  if (hex.length === 3 || hex.length === 4) {
    if (!/^[0-9a-f]+$/.test(hex)) return null
    return [
      expand(hex[0]),
      expand(hex[1]),
      expand(hex[2]),
      hex.length === 4 ? expand(hex[3]) : 1,
    ]
  }
  if (hex.length === 6 || hex.length === 8) {
    if (!/^[0-9a-f]+$/.test(hex)) return null
    const byte = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255
    return [byte(0), byte(2), byte(4), hex.length === 8 ? byte(6) : 1]
  }
  return null
}

function parseChannel(p: string, scale: number): number | null {
  if (p.endsWith('%')) {
    const v = parseFloat(p)
    return Number.isFinite(v) ? clamp01(v / 100) : null
  }
  const v = parseFloat(p)
  return Number.isFinite(v) ? clamp01(v / scale) : null
}

function parseAlpha(p: string): number | null {
  if (p.endsWith('%')) {
    const v = parseFloat(p)
    return Number.isFinite(v) ? clamp01(v / 100) : null
  }
  const v = parseFloat(p)
  return Number.isFinite(v) ? clamp01(v) : null
}

function parsePercent(p: string): number | null {
  const v = parseFloat(p)
  if (!Number.isFinite(v)) return null
  return clamp01(v / 100)
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  // Standard CSS Color 4 formula (hue in degrees, s/l already 0..1).
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return [f(0), f(8), f(4)]
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}
