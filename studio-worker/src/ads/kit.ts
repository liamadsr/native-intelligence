/**
 * A brand kit made ready to draw with: its palette as CSS custom properties,
 * its two type roles as @font-face rules over the font files the job staged,
 * its logo masks as data URLs, and the template roles resolved to palette
 * tokens. Everything an ad template needs to stay on-brand comes from here:
 * TYPE-1 casing, no synthetic cuts, balanced headlines, the logo masks.
 *
 * The font families go into the CSS as escaped strings and every file as an
 * escaped url() at its fenced address (fence.ts): the family is checked
 * against the contract's grammar again here.
 */
import type { BrandKit, KitFontRole, TemplateRole } from '../../../web/src/lib/studio/server/ads-contract.ts'
import { cssString, cssUrl, family } from './escape.ts'
import { maskDataUrl, pngSizeOf } from './raster.ts'

const FORMAT: Record<string, string> = { otf: 'opentype', ttf: 'truetype', woff: 'woff', woff2: 'woff2' }
/** Default weights by name when a kit gives none. */
const WEIGHTS: Record<string, number> = { thin: 200, light: 300, regular: 400, medium: 500, bold: 700 }

export type StagedFace = { path: string; weight: string; style: 'normal' | 'italic' }
export type AdsKit = {
  kit: BrandKit
  name: string
  palette: Record<string, string>
  logoOn: Record<string, string>
  logo: { primary: string; mark: string; primaryRatio: number; markRatio: number }
  fonts: { serif: KitFontRole & { weights: Record<string, number> }; sans: KitFontRole & { weights: Record<string, number> } }
  /** Font files by role, as staged (the motion editor parts and glyph outlines read them). */
  faces: { serif: StagedFace[]; sans: StagedFace[] }
  css: string
  /** The palette token a template role draws with (throws a sentence when the kit has none). */
  tok: (role: TemplateRole | string) => string
}

const weightsOf = (role: KitFontRole) => ({ ...WEIGHTS, ...role.weights })

/** The token for a role or a token name: the kit's mapping, a token of that name, or a sentence saying what is missing. */
export function tokenFor(kit: Pick<BrandKit, 'roles' | 'palette'>, name: string): string {
  const own = (o: object, k: string) => Object.hasOwn(o, k) && /^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(k)
  if (own(kit.palette, name)) return name
  const mapped = Object.hasOwn(kit.roles, name) ? (kit.roles as Record<string, string | undefined>)[name] : undefined
  if (mapped && own(kit.palette, mapped)) return mapped
  if (name === 'white') return 'white'
  throw new Error(`The brand kit has no colour for "${name}": map it under roles (roles.${name} = one of the palette's tokens)`)
}

/** The kit ready to draw: CSS, logo ratios and masks, roles resolved. `urlOf` is the address a staged font file is served at. */
export async function buildKit(kit: BrandKit, logos: { primary: string; mark: string }, faces: { serif: StagedFace[]; sans: StagedFace[] }, urlOf: (path: string) => string): Promise<AdsKit> {
  const palette = { ...kit.palette }
  // White is always there for type and logos on photos, even when the palette leaves it out.
  if (!('white' in palette) && !kit.roles.white) palette.white = '#FFFFFF'
  const k = { ...kit, palette }
  const [p, m] = await Promise.all([pngSizeOf(logos.primary), pngSizeOf(logos.mark)])
  const serif = { ...kit.fonts.serif, family: family(kit.fonts.serif.family), weights: weightsOf(kit.fonts.serif) }
  const sans = { ...kit.fonts.sans, family: family(kit.fonts.sans.family), weights: weightsOf(kit.fonts.sans) }
  const weight = (w: unknown) => {
    const v = String(w)
    if (!/^\d{1,4}( \d{1,4})?$/.test(v)) throw new Error(`"${v.slice(0, 20)}" is not a font weight`)
    return v
  }
  const fontFaces = (name: string, list: StagedFace[]) =>
    list.map((f) => `@font-face{font-family:${cssString(name)};src:${cssUrl(urlOf(f.path))} format('${FORMAT[f.path.split('.').pop()!.toLowerCase()] ?? 'opentype'}');font-weight:${weight(f.weight)};font-style:${f.style === 'italic' ? 'italic' : 'normal'};font-display:block}`).join('\n')
  for (const [t, v] of Object.entries(palette)) if (!/^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(t) || !/^#[\da-fA-F]{6}$/.test(v)) throw new Error(`The palette's "${t.slice(0, 40)}" is not a token with a #RRGGBB colour`)
  const vars = Object.entries(palette).map(([t, v]) => `--${t}:${v};`).join('')
  const [primaryMask, markMask] = await Promise.all([maskDataUrl(logos.primary, 1600), maskDataUrl(logos.mark, 600)])
  const css = [
    fontFaces(serif.family, faces.serif),
    fontFaces(sans.family, faces.sans),
    `:root{${vars}}`,
    // Never fake a cut the brand didn't supply (no synthetic italic or bold).
    `*{box-sizing:border-box;margin:0;padding:0;font-synthesis:none}html,body{width:100%;height:100%;overflow:hidden}`,
    `body{font-family:${cssString(serif.family)};-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision;font-optical-sizing:auto}`,
    // TYPE-1: the serif is never caps; the sans is always caps, tracked 15%.
    `.serif{font-family:${cssString(serif.family)};text-transform:${kit.rules.casing.serifCaps ? 'uppercase' : 'none'};font-weight:${serif.weights.light}}`,
    `.serif.thin{font-weight:${serif.weights.thin}}.serif.body{font-weight:${serif.weights.regular};letter-spacing:0.04em}`,
    `.caps{font-family:${cssString(sans.family)};text-transform:${kit.rules.casing.sansCaps ? 'uppercase' : 'none'};letter-spacing:0.15em;font-weight:${sans.weights.medium}}`,
    `.caps.bold{font-weight:${sans.weights.bold}}`,
    // Balanced lines: no headline ends on a single stranded word.
    `[data-role=headline],[data-role=quote],[data-role=offer]{text-wrap:balance}`,
    `.logo{-webkit-mask:${cssUrl(primaryMask)} center/contain no-repeat;mask:${cssUrl(primaryMask)} center/contain no-repeat}`,
    `.mark{-webkit-mask:${cssUrl(markMask)} center/contain no-repeat;mask:${cssUrl(markMask)} center/contain no-repeat}`,
  ].join('\n')
  return {
    kit: k,
    name: kit.name,
    palette,
    logoOn: kit.logoOn,
    logo: { ...logos, primaryRatio: p.width / p.height, markRatio: m.width / m.height },
    fonts: { serif, sans },
    faces,
    css,
    tok: (role) => tokenFor(k, role),
  }
}

/** The approved logo colour (a token) for a ground (a token), or throws: the logo may only sit on an approved ground (LOGO-5). */
export function logoColour(kit: AdsKit, background: string, allowPhoto = true): string {
  const c = kit.logoOn[background]
  if (c) return c
  // On photography the ads use the kit's photo colour, a white wordmark by default (LOGO-5a).
  if (background === 'photo' && allowPhoto) return kit.kit.logoOnPhoto ?? kit.tok('white')
  throw new Error(`The logo has no approved treatment on "${background}" (approved: ${Object.keys(kit.logoOn).join(', ') || 'none: add logoOn to the brand kit'})`)
}
