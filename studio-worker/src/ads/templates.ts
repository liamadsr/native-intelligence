/**
 * Static ad templates, one per proven pattern of a brand's playbook (AD-1…AD-12). A template turns an ad spec into
 * the body of an HTML page for one size. Brand rules are built in: colours come only from the palette (through the
 * kit's template roles), the serif is never caps and the sans always is, the logo sits only on an approved ground
 * (or on a photo, in the kit's photo colour), and in 9:16 every word and the logo stay inside y 20–78% (the Stories
 * safe band).
 *
 * Colours are named by the role they play (ground, groundAlt, deep, ink, accent, muted, line, highlight, star, white;
 * see ads-contract.ts), which the kit maps to its own tokens. Copy is HTML-escaped; addresses and font names are
 * escaped for the attribute or the CSS they go into (escape.ts). Every template draws text through `text()` (data-role,
 * data-bg) and the logo through `logo()`, which the renderer's passes and the brand check read.
 */
import type { AdImg, AdSpec, SizeKey } from '../../../web/src/lib/studio/server/ads-contract.ts'
import { attr, cssString, cssUrl, family, html } from './escape.ts'
import { logoColour, type AdsKit } from './kit.ts'

// (Kept here rather than imported, so the templates stay a pure function of the kit and the spec.)
export const SIZES: Record<SizeKey, { w: number; h: number; label: string }> = {
  square: { w: 1080, h: 1080, label: '1:1' },
  portrait: { w: 1080, h: 1350, label: '4:5' },
  story: { w: 1080, h: 1920, label: '9:16' },
  landscape: { w: 1200, h: 628, label: '1.91:1' },
}
export const SIZE_ORDER: SizeKey[] = ['square', 'portrait', 'story', 'landscape']
/** The spec as it applies to one size (bySize merged over it, copy merged key by key). */
export function forSize(spec: AdSpec, size: SizeKey): AdSpec {
  const o = spec.bySize?.[size]
  return o ? ({ ...spec, ...o, copy: { ...spec.copy, ...(o.copy ?? {}) } } as AdSpec) : spec
}
/** Fraction of the height text and logo must stay within, per size (CHANNEL-2). */
export const SAFE: Record<SizeKey, [number, number]> = { square: [0.025, 0.975], portrait: [0.025, 0.975], story: [0.2, 0.78], landscape: [0.03, 0.97] }

type Ctx = { kit: AdsKit; spec: AdSpec; size: SizeKey; w: number; h: number; url: (img: AdImg) => string }
/** The four grounds, and the ink each takes (COLOR-2). */
type GroundRole = 'ground' | 'groundAlt' | 'deep' | 'ink'
const INK: Record<GroundRole, { head: string; sub: string; accent: string }> = {
  ground: { head: 'ink', sub: 'muted', accent: 'accent' },
  groundAlt: { head: 'deep', sub: 'deep', accent: 'deep' },
  deep: { head: 'groundAlt', sub: 'accent', accent: 'accent' },
  ink: { head: 'ground', sub: 'accent', accent: 'accent' },
}

/** A colour (role or token) as a CSS variable. */
const v = (c: Ctx, name: string) => `var(--${c.kit.tok(name)})`
/** A shade from the kit ("r,g,b") at an alpha. */
const shadeOf = (c: Ctx, which: 'dark' | 'light' | 'glass' | 'warm' | 'deep', a: number | string) => `rgba(${c.kit.kit.shades[which]},${a})`

/** A ground named in a spec (a role or a token) as its token and its role (for the ink table). */
function groundOf(c: Ctx, name: string | undefined, fallback: GroundRole): { tok: string; role: GroundRole } {
  const asked = name ?? fallback
  if (asked in INK) return { tok: c.kit.tok(asked), role: asked as GroundRole }
  const tok = c.kit.tok(asked)
  const role = (Object.keys(INK) as GroundRole[]).find((r) => { try { return c.kit.tok(r) === tok } catch { return false } })
  if (!role) throw new Error(`${c.spec.id}: "${asked}" is not one of the kit's grounds (ground, groundAlt, deep, ink)`)
  return { tok, role }
}
const ink = (c: Ctx, g: GroundRole) => INK[g]

const esc = html
const lines = (x: string | string[] | undefined) => (Array.isArray(x) ? x : x ? [x] : []).map(esc).join('<br>')
const one = (x: string | string[] | undefined) => (Array.isArray(x) ? x.join(' ') : x ?? '')

function box(x: number, y: number, w: number, h: number, extra = '') {
  return `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;${extra}`
}
function photo(c: Ctx, img: AdImg | undefined, x: number, y: number, w: number, h: number, extra = '') {
  if (!img) throw new Error(`${c.spec.id}: this template needs an image`)
  const [fx, fy] = img.focus ?? [0.5, 0.5]
  // data-img/fx/fy let the renderer map faces in the photo onto the frame and re-frame it to keep them clear of text.
  return `<div data-photo data-img="${attr(c.url(img))}" data-fx="${fx}" data-fy="${fy}" style="${attr(box(x, y, w, h, `background:${cssUrl(c.url(img))} ${fx * 100}% ${fy * 100}%/cover no-repeat;${extra}`))}"></div>`
}
/** The primary logo, centred on cx at top y, width lw, in the approved colour for its ground (a token, or 'photo'). */
function logo(c: Ctx, ground: string, cx: number, y: number, lw: number, kind: 'logo' | 'mark' = 'logo', colourOverride?: string) {
  const colour = colourOverride ?? logoColour(c.kit, ground)
  const ratio = kind === 'logo' ? c.kit.logo.primaryRatio : c.kit.logo.markRatio, lh = lw / ratio
  return `<div class="${kind}" data-role="logo" data-bg="${ground}" data-ink="${colour}" style="${box(cx - lw / 2, y, lw, lh, `background:var(--${colour})`)}"></div>`
}
const logoH = (c: Ctx, lw: number) => lw / c.kit.logo.primaryRatio
/** The logo inside a flex flow (cards), rather than absolutely placed. */
function logoFlow(c: Ctx, ground: string, lw: number, extra = '') {
  const colour = logoColour(c.kit, ground)
  return `<div class="logo" data-role="logo" data-bg="${ground}" data-ink="${colour}" style="position:relative;flex:none;width:${lw}px;height:${logoH(c, lw)}px;background:var(--${colour});${extra}"></div>`
}
/** A text block, auto-shrunk to fit its box (data-fit). `ground` is the token behind it, or 'photo'. */
function text(role: string, cls: string, html: string, ground: string, style: string) {
  return html ? `<div data-role="${role}" data-bg="${ground}" data-fit class="${cls}" style="${style}">${html}</div>` : ''
}
/** An organic wave edge (LAYOUT-5) in the panel colour, rising from y by amp. */
function wave(c: Ctx, groundTok: string, y: number, amp: number) {
  const W = c.w
  return `<svg style="${box(0, y - amp, W, amp + 2)}" viewBox="0 0 ${W} ${amp + 2}" preserveAspectRatio="none"><path d="M0 ${amp * 0.55} C ${W * 0.28} ${-amp * 0.35}, ${W * 0.62} ${amp * 1.25}, ${W} ${amp * 0.2} L ${W} ${amp + 2} L 0 ${amp + 2} Z" fill="var(--${groundTok})"/></svg>`
}

// ------------------------------------------------------------------------------------------------- AD-1 / AD-8
/** Photo above, a ground panel below with a soft wave edge: serif headline, caps line, logo (LAYOUT-4). */
function serifCard(c: Ctx) {
  const { w, h, size } = c, G = groundOf(c, c.spec.ground, 'ground'), g = G.tok, k = ink(c, G.role), m = Math.round(w * 0.07)
  const copy = c.spec.copy
  if (size === 'landscape') {
    const pw = Math.round(w * 0.5), tx = pw + m, tw = w - pw - 2 * m, lw = 250
    return `<div style="${box(0, 0, w, h, `background:var(--${g})`)}"></div>${photo(c, c.spec.image, 0, 0, pw, h)}
      <div style="${box(tx, 0, tw, h, 'display:flex;flex-direction:column;justify-content:center;gap:22px;padding-bottom:70px')}">
        ${text('kicker', 'caps bold', esc(one(copy.kicker)), g, `position:relative;font-size:20px;color:${v(c, k.sub)}`)}
        ${text('headline', 'serif', lines(copy.headline), g, `position:relative;font-size:62px;line-height:1.02;color:${v(c, k.head)}`)}
        ${text('sub', 'caps', esc(one(copy.sub)), g, `position:relative;font-size:19px;line-height:1.5;color:${v(c, k.sub)}`)}
      </div>${logo(c, g, tx + lw / 2, h - m - logoH(c, lw), lw)}`
  }
  const split = { square: 0.6, portrait: 0.6, story: 0.47 }[size], top = Math.round(h * split), amp = Math.round(w * 0.07)
  const lw = 230, lgY = size === 'story' ? Math.round(h * 0.78) - logoH(c, lw) - 6 : h - m - logoH(c, lw)
  const textTop = top + Math.round(amp * 0.25), textBottom = lgY - Math.round(logoH(c, lw) * 1.6)
  return `${photo(c, c.spec.image, 0, 0, w, top + amp)}<div style="${box(0, top, w, h - top, `background:var(--${g})`)}"></div>${wave(c, g, top, amp)}
    <div style="${box(m, textTop, w - 2 * m, textBottom - textTop, 'display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;gap:20px')}">
      ${text('kicker', 'caps bold', esc(one(copy.kicker)), g, `position:relative;font-size:22px;color:${v(c, k.sub)}`)}
      ${text('headline', 'serif', lines(copy.headline), g, `position:relative;font-size:${size === 'story' ? 80 : 74}px;line-height:1.02;color:${v(c, k.head)}`)}
      ${text('sub', 'caps', esc(one(copy.sub)), g, `position:relative;font-size:22px;line-height:1.5;color:${v(c, k.sub)}`)}
    </div>${logo(c, g, w / 2, lgY, lw)}`
}

/** Full-bleed photo, warm shade at the bottom, serif headline in the ground colour, the logo on the photo. */
function serifFull(c: Ctx) {
  const { w, h, size } = c, copy = c.spec.copy, m = Math.round(w * 0.07), lw = 260
  const shade = size === 'landscape'
    ? `linear-gradient(90deg, ${shadeOf(c, 'warm', 0.82)} 0%, ${shadeOf(c, 'warm', 0.55)} 45%, ${shadeOf(c, 'warm', 0)} 75%)`
    : `linear-gradient(0deg, ${shadeOf(c, 'warm', 0.9)} 0%, ${shadeOf(c, 'warm', 0.74)} ${size === 'story' ? 42 : 38}%, ${shadeOf(c, 'warm', 0)} ${size === 'story' ? 66 : 64}%)`
  if (size === 'landscape') {
    return `${photo(c, c.spec.image, 0, 0, w, h)}<div style="${box(0, 0, w, h, `background:${shade}`)}"></div>
      <div style="${box(m, 0, w * 0.5, h, 'display:flex;flex-direction:column;justify-content:center;gap:20px;padding-bottom:60px')}">
        ${text('headline', 'serif', lines(copy.headline), 'photo', `position:relative;font-size:64px;line-height:1.02;color:${v(c, 'ground')}`)}
        ${text('sub', 'caps', esc(one(copy.sub)), 'photo', `position:relative;font-size:19px;line-height:1.5;color:${v(c, 'ground')}`)}
      </div>${logo(c, 'photo', m + lw / 2, h - m - logoH(c, lw), lw)}`
  }
  const lgY = size === 'story' ? Math.round(h * 0.78) - logoH(c, lw) - 6 : h - m - logoH(c, lw)
  const textBottom = lgY - Math.round(logoH(c, lw) * 1.8), textH = size === 'story' ? 520 : 380
  return `${photo(c, c.spec.image, 0, 0, w, h)}<div style="${box(0, 0, w, h, `background:${shade}`)}"></div>
    <div style="${box(m, textBottom - textH, w - 2 * m, textH, 'display:flex;flex-direction:column;justify-content:flex-end;align-items:center;text-align:center;gap:22px')}">
      ${text('headline', 'serif', lines(copy.headline), 'photo', `position:relative;font-size:${size === 'story' ? 92 : 86}px;line-height:1.0;color:${v(c, 'ground')}`)}
      ${text('sub', 'caps', esc(one(copy.sub)), 'photo', `position:relative;font-size:23px;line-height:1.5;color:${v(c, 'ground')}`)}
    </div>${logo(c, 'photo', w / 2, lgY, lw)}`
}

// ------------------------------------------------------------------------------------------------------- AD-2
/** Tracked caps statement on a ground, beside (or above) a photo. */
function capsStatement(c: Ctx) {
  const { w, h, size } = c, G = groundOf(c, c.spec.ground, 'deep'), g = G.tok, k = ink(c, G.role), copy = c.spec.copy, m = Math.round(w * 0.07), lw = 260
  if (size === 'story') {
    const ph = Math.round(h * 0.4), tTop = Math.round(h * 0.45), lgY = Math.round(h * 0.78) - logoH(c, lw) - 6
    return `<div style="${box(0, 0, w, h, `background:var(--${g})`)}"></div>${photo(c, c.spec.image, 0, 0, w, ph)}
      <div style="${box(m, tTop, w - 2 * m, lgY - tTop - 80, 'display:flex;flex-direction:column;justify-content:center;gap:28px')}">
        ${text('headline', 'caps bold', lines(copy.headline), g, `position:relative;font-size:86px;line-height:1.12;color:${v(c, k.head)}`)}
        ${text('sub', 'serif', esc(one(copy.sub)), g, `position:relative;font-size:40px;line-height:1.2;color:${v(c, k.sub)}`)}
      </div>${logo(c, g, m + lw / 2, lgY, lw)}`
  }
  const cw = Math.round(w * 0.5), tw = cw - 2 * m
  const fs = size === 'landscape' ? 50 : 70, lgY = h - m - logoH(c, lw)
  return `<div style="${box(0, 0, w, h, `background:var(--${g})`)}"></div>${photo(c, c.spec.image, cw, 0, w - cw, h)}
    <div style="${box(m, m, tw, lgY - m - 40, 'display:flex;flex-direction:column;justify-content:center;gap:26px')}">
      ${text('headline', 'caps bold', lines(copy.headline), g, `position:relative;font-size:${fs}px;line-height:1.14;color:${v(c, k.head)}`)}
      ${text('sub', 'serif', esc(one(copy.sub)), g, `position:relative;font-size:${size === 'landscape' ? 26 : 34}px;line-height:1.22;color:${v(c, k.sub)}`)}
    </div>${logo(c, g, m + lw / 2, lgY, lw)}`
}

// ------------------------------------------------------------------------------------------------------- AD-3
/** A calendar invite as the hook: the reader is "invited"; Accept is the CTA. Brand type, not the system font. */
function uiCalendar(c: Ctx) {
  const { w, h, size } = c, copy = c.spec.copy, card = c.kit.tok('ground')
  const cw = size === 'landscape' ? 560 : Math.round(w * 0.78), fs = size === 'landscape' ? 0.86 : 1, lw = 210
  // The card sizes to its content and centres in the safe band (right-hand side in landscape).
  const [top, bottom] = size === 'story' ? [h * 0.2, h * 0.78] : [0, h]
  const place = size === 'landscape' ? 'align-items:center;justify-content:flex-end;padding-right:50px' : 'align-items:center;justify-content:center'
  const accent = c.kit.tok('accent')
  return `${photo(c, c.spec.image, 0, 0, w, h)}<div style="${box(0, 0, w, h, `background:${shadeOf(c, 'warm', 0.18)}`)}"></div>
    <div style="${box(0, top, w, bottom - top, `display:flex;${place}`)}">
      <div style="position:relative;width:${cw}px;padding:${46 * fs}px;display:flex;flex-direction:column;gap:${18 * fs}px;background:var(--${card});border-radius:28px;box-shadow:0 30px 80px ${shadeOf(c, 'deep', 0.28)}">
        <div style="position:relative;display:flex;align-items:center;gap:14px"><div style="width:16px;height:16px;border-radius:50%;background:${v(c, 'accent')}"></div>
          ${text('label', 'caps bold', esc(one(copy.label)), card, `position:relative;font-size:${20 * fs}px;color:${v(c, 'muted')}`)}</div>
        ${text('headline', 'serif', lines(copy.headline), card, `position:relative;font-size:${66 * fs}px;line-height:1.04;color:${v(c, 'ink')}`)}
        ${text('when', 'caps', esc(one(copy.when)), card, `position:relative;font-size:${21 * fs}px;line-height:1.6;color:${v(c, 'ink')}`)}
        ${text('sub', 'caps', esc(one(copy.sub)), card, `position:relative;font-size:${18 * fs}px;line-height:1.6;color:${v(c, 'muted')}`)}
        <div style="position:relative;height:1px;background:${v(c, 'line')};margin-top:6px"></div>
        <div style="position:relative;display:flex;gap:18px;margin-top:4px">
          <div style="flex:1;height:${70 * fs}px;border-radius:14px;border:1.5px solid ${v(c, 'line')};display:flex;align-items:center;justify-content:center">${text('decline', 'caps bold', esc(one(copy.decline ?? 'Later')), card, `position:relative;font-size:${19 * fs}px;color:${v(c, 'muted')}`)}</div>
          <div data-cta-bg style="flex:1;height:${70 * fs}px;border-radius:14px;background:${v(c, 'accent')};display:flex;align-items:center;justify-content:center">${text('cta', 'caps bold', esc(one(copy.cta ?? 'Accept')), accent, `position:relative;font-size:${19 * fs}px;color:${v(c, 'deep')}`)}</div>
        </div>
        ${logoFlow(c, card, lw, `align-self:center;margin-top:${26 * fs}px`)}
      </div>
    </div>`
}

// ------------------------------------------------------------------------------------------------------- AD-7
/** Word tiles in a checkerboard with photo tiles, the logo on its own tile. */
function mosaic(c: Ctx) {
  const { w, h, size } = c, words = (Array.isArray(c.spec.copy.words) ? c.spec.copy.words : c.spec.copy.words ? [c.spec.copy.words] : []) as string[]
  const imgs = c.spec.images ?? [], g = c.kit.tok('groundAlt')
  if (size === 'landscape') {
    const lw = 260, pw = Math.round(w * 0.46), cw = (w - pw) / 2, ch = h / 2
    const tiles = imgs.slice(0, 4).map((img, i) => photo(c, img, pw + (i % 2) * cw, Math.floor(i / 2) * ch, cw, ch)).join('')
    return `<div style="${box(0, 0, pw, h, `background:var(--${g})`)}"></div>${tiles}
      ${text('headline', 'caps bold', words.map(esc).join('<br>'), g, `${box(70, 120, pw - 140, 300)};font-size:62px;line-height:1.25;color:${v(c, 'deep')}`)}
      ${logo(c, g, 70 + lw / 2, h - 70 - logoH(c, lw), lw)}`
  }
  const rows = size === 'story' ? 4 : 3, cols = 3, tw = w / cols, th = h / rows
  // Word and logo cells; every other cell is a photo. Story keeps words in rows 1–2 (inside the safe band).
  const layout: Record<string, string> = size === 'story'
    ? { '1,0': 'w0', '1,2': 'w1', '2,1': 'w2', '2,0': 'logo' } : { '0,1': 'w0', '1,0': 'w1', '1,2': 'w2', '2,1': 'logo' }
  let out = '', p = 0
  for (let r = 0; r < rows; r++) for (let col = 0; col < cols; col++) {
    const what = layout[`${r},${col}`], x = col * tw, y = r * th
    if (!what) { out += photo(c, imgs[p++ % Math.max(1, imgs.length)], x, y, tw, th); continue }
    out += `<div style="${box(x, y, tw, th, `background:var(--${g})`)}"></div>`
    if (what === 'logo') out += logo(c, g, x + tw / 2, y + th / 2 - logoH(c, tw * 0.8) / 2, tw * 0.8)
    else out += text('headline', 'caps bold', esc(words[+what.slice(1)] ?? ''), g, `${box(x + 20, y, tw - 40, th)};display:flex;align-items:center;justify-content:center;font-size:64px;letter-spacing:0.18em;color:${v(c, 'deep')}`)
  }
  return out
}

// ------------------------------------------------------------------------------------------------------- AD-4
/** A verbatim customer review on a deep card over a softened photo. */
function review(c: Ctx) {
  const { w, h, size } = c, copy = c.spec.copy, g = c.kit.tok('deep'), land = size === 'landscape'
  const cw = land ? 600 : Math.round(w * 0.8), lw = 210, avatarBg = c.kit.tok('accent')
  const star = (s: number) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><path fill="${v(c, 'highlight')}" d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6L2.5 9.4l6.6-.8z"/></svg>`
  const [top, bottom] = size === 'story' ? [h * 0.2, h * 0.78] : [0, h]
  const place = land ? 'align-items:flex-end;justify-content:center;padding-right:50px' : 'align-items:center;justify-content:center'
  // The count sits over the photo, so the photo is shaded hard enough for it to read (COLOR-2).
  return `${photo(c, c.spec.image, 0, 0, w, h)}<div style="${box(0, 0, w, h, `background:${shadeOf(c, 'deep', 0.62)}`)}"></div>
    <div style="${box(0, top, w, bottom - top, `display:flex;flex-direction:column;gap:${land ? 22 : 34}px;${place}`)}">
      <div style="position:relative;width:${cw}px;display:flex;align-items:center;justify-content:center;gap:16px">
        ${text('label', 'caps bold', esc(one(copy.count)), 'photo', `position:relative;font-size:${land ? 26 : 32}px;color:${v(c, 'ground')}`)}${star(land ? 32 : 40)}
        ${text('label', 'caps bold', esc(one(copy.reviewsLabel ?? 'Reviews')), 'photo', `position:relative;font-size:${land ? 26 : 32}px;color:${v(c, 'ground')}`)}</div>
      <div style="position:relative;width:${cw}px;padding:${land ? 40 : 50}px;display:flex;flex-direction:column;gap:22px;background:var(--${g});border-radius:28px">
        <div style="position:relative;display:flex;align-items:center;gap:18px">
          <div style="width:64px;height:64px;border-radius:50%;background:var(--${avatarBg});display:flex;align-items:center;justify-content:center">${text('avatar', 'caps bold', esc(one(copy.initials)), avatarBg, `position:relative;font-size:22px;letter-spacing:0.05em;color:${v(c, 'deep')}`)}</div>
          <div style="display:flex;gap:6px">${star(30).repeat(5)}</div></div>
        ${text('quote', 'serif', esc(one(copy.quote)), g, `position:relative;font-size:${land ? 32 : 42}px;line-height:1.2;color:${v(c, 'groundAlt')}`)}
        ${text('name', 'caps bold', esc(one(copy.name)), g, `position:relative;font-size:20px;color:${v(c, 'accent')}`)}
        ${logoFlow(c, g, lw, 'align-self:center;margin-top:14px')}
      </div>
    </div>`
}

// ------------------------------------------------------------------------------------------------------ AD-11
/** A dated, valued offer on the ground: serif hook, photo in a circle, plain offer, code pill, end date. */
function offer(c: Ctx) {
  const { w, h, size } = c, copy = c.spec.copy, g = c.kit.tok('ground'), k = ink(c, 'ground'), m = Math.round(w * 0.07), lw = 230
  const accent = c.kit.tok('accent')
  const pill = (t: string) => `<div data-cta-bg style="position:relative;display:inline-flex;align-self:center;padding:14px 30px;border-radius:999px;background:var(--${accent})">${text('cta', 'caps bold', esc(t), accent, `position:relative;font-size:22px;color:${v(c, 'deep')}`)}</div>`
  if (size === 'landscape') {
    const d = 470
    return `<div style="${box(0, 0, w, h, `background:var(--${g})`)}"></div>${photo(c, c.spec.image, w - d - 60, (h - d) / 2, d, d, 'border-radius:50%')}
      <div style="${box(m, 40, w - d - 2 * m - 60, h - 160, 'display:flex;flex-direction:column;justify-content:center;gap:18px')}">
        ${text('headline', 'serif', lines(copy.headline), g, `position:relative;font-size:54px;line-height:1.04;color:${v(c, k.head)}`)}
        ${text('offer', 'serif body', esc(one(copy.offer)), g, `position:relative;font-size:24px;line-height:1.3;color:${v(c, k.head)}`)}
        <div style="position:relative;display:flex">${pill(one(copy.code))}</div>
        ${text('date', 'caps', esc(one(copy.date)), g, `position:relative;font-size:17px;color:${v(c, k.sub)}`)}
      </div>${logo(c, g, m + lw / 2, h - 50 - logoH(c, lw), lw)}`
  }
  const story = size === 'story', d = story ? 600 : size === 'portrait' ? 540 : 430
  const top = story ? h * 0.2 : m, lgY = story ? Math.round(h * 0.78) - logoH(c, lw) - 6 : h - m - logoH(c, lw)
  return `<div style="${box(0, 0, w, h, `background:var(--${g})`)}"></div>
    <div style="${box(m, top, w - 2 * m, lgY - top - 40, 'display:flex;flex-direction:column;align-items:center;justify-content:space-between;text-align:center')}">
      ${text('headline', 'serif', lines(copy.headline), g, `position:relative;font-size:${story ? 74 : 66}px;line-height:1.02;color:${v(c, k.head)}`)}
      <div style="position:relative;width:${d}px;height:${d}px">${photo(c, c.spec.image, 0, 0, d, d, 'border-radius:50%')}</div>
      <div style="position:relative;display:flex;flex-direction:column;align-items:center;gap:16px">
        ${text('offer', 'serif body', esc(one(copy.offer)), g, `position:relative;font-size:${story ? 34 : 30}px;line-height:1.3;color:${v(c, k.head)}`)}
        ${pill(one(copy.code))}
        ${text('date', 'caps', esc(one(copy.date)), g, `position:relative;font-size:19px;color:${v(c, k.sub)}`)}
      </div>
    </div>${logo(c, g, w / 2, lgY, lw)}`
}

// ------------------------------------------------------------------------------------------------------- AD-9
/** Carousel cover: the reader's state as one serif question over a photo, on a ground band. */
function stateCover(c: Ctx) {
  return serifCard(c)
}
/** Carousel card: a caps question, the service that answers it in serif, the photo in a soft-cornered frame. */
function stateItem(c: Ctx) {
  const { w, h, size } = c, G = groundOf(c, c.spec.ground, 'groundAlt'), g = G.tok, k = ink(c, G.role), copy = c.spec.copy, m = Math.round(w * 0.08)
  const story = size === 'story', top = story ? h * 0.2 : m, bottom = story ? h * 0.78 : h - m
  const ph = Math.round((bottom - top) * (story ? 0.5 : 0.46))
  return `<div style="${box(0, 0, w, h, `background:var(--${g})`)}"></div>
    <div style="${box(m, top, w - 2 * m, bottom - top, 'display:flex;flex-direction:column;justify-content:space-between')}">
      ${text('label', 'caps bold', esc(one(copy.question)), g, `position:relative;font-size:30px;color:${v(c, k.head)}`)}
      <div style="position:relative;height:${ph}px;border-radius:22px;overflow:hidden">${photo(c, c.spec.image, 0, 0, w - 2 * m, ph)}</div>
      ${text('headline', 'serif', lines(copy.headline), g, `position:relative;font-size:${story ? 70 : 60}px;line-height:1.04;color:${v(c, k.head)}`)}
      <div style="position:relative;display:flex;align-items:center;justify-content:space-between;gap:30px">
        ${text('sub', 'caps', esc(one(copy.sub)), g, `position:relative;font-size:21px;color:${v(c, k.head)}`)}
        ${logoFlow(c, g, 200)}
      </div>
    </div>`
}
/** Carousel end card: the promise on the deep ground with the logo. */
function stateEnd(c: Ctx) {
  const { w, h, size } = c, G = groundOf(c, c.spec.ground, 'deep'), g = G.tok, k = ink(c, G.role), copy = c.spec.copy, m = Math.round(w * 0.08), lw = 300
  const story = size === 'story', lgY = story ? Math.round(h * 0.78) - logoH(c, lw) - 6 : h - m - logoH(c, lw)
  const top = story ? h * 0.2 : m
  return `<div style="${box(0, 0, w, h, `background:var(--${g})`)}"></div>
    <div style="${box(m, top, w - 2 * m, lgY - top - 60, 'display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;gap:30px')}">
      ${text('headline', 'serif', lines(copy.headline), g, `position:relative;font-size:${story ? 84 : 76}px;line-height:1.04;color:${v(c, k.head)}`)}
      ${text('sub', 'caps', esc(one(copy.sub)), g, `position:relative;font-size:23px;line-height:1.6;color:${v(c, k.sub)}`)}
    </div>${logo(c, g, w / 2, lgY, lw)}`
}

// ============================================================================================ the brand's own ads
// Templates rebuilt to match a brand's own ads, measured from them at 1:1, in % of the frame:
//   statement, centred   serif lines 13% tall, centred, y 28–54%; a serif sub at y 59%; logo 34% wide at y 71%.
//   statement, lower     serif 9% at y 61%; caps lines 3% at y 75–87% (the last in the highlight colour); logo 25% at y 93.5%.
//   statement, corner    serif lines 12.7% at x 4.3%, y 73–97%, dark ink on a light photo.
//   caps-photo           bold caps lines 10% at x 5.4%, y 39–77% (the widest spanning 80%); logo 34% at x 5.6%, y 92%.
//   glass-panel          frosted panel x 17–84%, y 33–67%; serif rows 5%; logo 26.9% at y 92.4%.
//   review-glass         "1,500+ ★ REVIEWS" 7% at y 8%; light glass card y 28–76%; serif quote 4.2% rows; logo 34.8% at y 89.8%.
//   offer-wave           serif headline 9–11% at y 10–30% over the photo; offer line 6% at y 84%; date caps 4.4% at y 92%.
/** A shade under type. data-shade lets the renderer deepen it, step by step, until the type reads (legibility pass). */
const shadeLayer = (w: number, h: number, css: string) => `<div data-shade style="${box(0, 0, w, h, `background:${css}`)}"></div>`
/** A light veil under dark type; invisible until the legibility pass needs it. */
const lightVeil = (w: number, h: number, css: string) => `<div data-shade data-light style="${box(0, 0, w, h, `background:${css};opacity:0`)}"></div>`
const band = (c: Ctx): [number, number] => (c.size === 'story' ? [c.h * 0.2, c.h * 0.78] : [0, c.h])

/** AD-1: one big serif line (or two) on a full-bleed photo, small lines under it, the logo. */
function statement(c: Ctx) {
  const { w, h, size } = c, copy = c.spec.copy, layout = c.spec.layout ?? 'center', inkTok = c.kit.tok(c.spec.ink ?? 'white')
  const land = size === 'landscape', story = size === 'story', dark = inkTok !== c.kit.tok('white') && inkTok !== c.kit.tok('ground')
  const subs = Array.isArray(copy.sub) ? copy.sub : copy.sub ? [copy.sub] : [], accent = one(copy.accent)
  const a = c.spec.shade ?? (dark ? 0 : 0.5), sh = (o: number) => shadeOf(c, 'dark', (o * a).toFixed(3))
  const li = (o: number) => shadeOf(c, 'light', o)
  const inkVar = `var(--${inkTok})`
  const accentVar = v(c, dark ? 'ink' : 'highlight')
  const caps = (fs: number) => subs.map((s) => text('sub', 'caps', esc(s), 'photo', `position:relative;font-size:${fs}px;line-height:1.5;letter-spacing:0.17em;color:${inkVar}`)).join('')
    + (accent ? text('sub', 'caps bold', esc(accent), 'photo', `position:relative;font-size:${fs}px;line-height:1.5;letter-spacing:0.17em;color:${accentVar}`) : '')
  const logoColourOnPhoto = dark ? c.kit.tok('ink') : c.kit.tok('white')
  if (land) {
    const m = 64, tw = w * 0.56, lw = 250
    return `${photo(c, c.spec.image, 0, 0, w, h)}${dark ? lightVeil(w, h, `linear-gradient(90deg, ${li(0.92)} 0%, ${li(0.6)} 45%, ${li(0)} 78%)`) : shadeLayer(w, h, `linear-gradient(90deg, ${sh(1.5)} 0%, ${sh(1)} 45%, ${sh(0)} 78%)`)}
      <div style="${box(m, 0, tw, h - 90, 'display:flex;flex-direction:column;justify-content:center;gap:14px')}">
        ${text('headline', 'serif', lines(copy.headline), 'photo', `position:relative;font-size:86px;line-height:1.0;color:${inkVar}`)}
        <div style="position:relative;margin-top:8px">${caps(20)}</div>
      </div>${logo(c, 'photo', m + lw / 2, h - 46 - logoH(c, lw), lw, 'logo', logoColourOnPhoto)}`
  }
  const [top, bottom] = band(c), m = Math.round(w * 0.06)
  if (layout === 'center') {
    // Centred: the sub under the headline is a serif line, the logo sits under it.
    const lw = Math.round(w * 0.32), hs = story ? 140 : 132
    return `${photo(c, c.spec.image, 0, 0, w, h)}${dark ? lightVeil(w, h, `radial-gradient(ellipse 75% 55% at 50% 48%, ${li(0.88)} 0%, ${li(0.5)} 60%, ${li(0)} 100%)`) : shadeLayer(w, h, `radial-gradient(ellipse 75% 55% at 50% ${story ? 48 : 46}%, ${sh(1.5)} 0%, ${sh(1)} 55%, ${sh(0.7)} 100%)`)}
      <div style="${box(m, top, w - 2 * m, bottom - top, 'display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;gap:18px')}">
        ${text('headline', 'serif', lines(copy.headline), 'photo', `position:relative;font-size:${hs}px;line-height:0.98;color:${inkVar}`)}
        ${subs.map((s) => text('sub', 'serif', esc(s), 'photo', `position:relative;margin-top:34px;font-size:${story ? 40 : 37}px;line-height:1.2;color:${inkVar}`)).join('')}
        ${accent ? `<div style="position:relative">${text('sub', 'caps bold', esc(accent), 'photo', `position:relative;font-size:26px;letter-spacing:0.17em;color:${accentVar}`)}</div>` : ''}
        ${logoFlowPhoto(c, lw, logoColourOnPhoto, 'margin-top:42px')}
      </div>`
  }
  if (layout === 'lower') {
    // Lower: caps lines at 30 px with 1.5 leading, under the headline; the logo at y 93.5%.
    const lw = Math.round(w * 0.25), lgY = story ? bottom - logoH(c, lw) - 4 : h * 0.935 - logoH(c, lw) / 2, textBottom = lgY - (story ? 64 : 50)
    return `${photo(c, c.spec.image, 0, 0, w, h)}${dark ? lightVeil(w, h, `linear-gradient(0deg, ${li(0.92)} 0%, ${li(0.6)} 36%, ${li(0)} 66%)`) : shadeLayer(w, h, `linear-gradient(0deg, ${sh(1.8)} 0%, ${sh(1.4)} ${story ? 30 : 36}%, ${sh(0)} ${story ? 58 : 66}%)`)}
      <div style="${box(m, top, w - 2 * m, textBottom - top, 'display:flex;flex-direction:column;justify-content:flex-end;align-items:center;text-align:center;gap:10px')}">
        ${text('headline', 'serif', lines(copy.headline), 'photo', `position:relative;font-size:${story ? 104 : 98}px;line-height:1.0;color:${inkVar}`)}
        <div style="position:relative;margin-top:40px">${caps(story ? 32 : 30)}</div>
      </div>${logo(c, 'photo', w / 2, lgY, lw, 'logo', logoColourOnPhoto)}`
  }
  // corner: big lines bottom-left, the logo bottom-right.
  const lw = Math.round(w * 0.24), mx = Math.round(w * 0.043), lgY = (story ? bottom : h - m) - logoH(c, lw)
  return `${photo(c, c.spec.image, 0, 0, w, h)}${dark ? lightVeil(w, h, `linear-gradient(20deg, ${li(0.92)} 0%, ${li(0.6)} 38%, ${li(0)} 68%)`) : shadeLayer(w, h, `linear-gradient(20deg, ${sh(1.6)} 0%, ${sh(1)} 35%, ${sh(0)} 65%)`)}
    <div style="${box(mx, top, w * 0.62, (story ? bottom : h - Math.round(h * 0.055)) - top, 'display:flex;flex-direction:column;justify-content:flex-end;gap:16px')}">
      ${text('headline', 'serif', lines(copy.headline), 'photo', `position:relative;font-size:${story ? 120 : 112}px;line-height:0.97;color:${inkVar}`)}
      ${subs.length || accent ? `<div style="position:relative;margin-top:10px">${caps(24)}</div>` : ''}
    </div>${logo(c, 'photo', w - m - lw / 2, lgY, lw, 'logo', logoColourOnPhoto)}`
}
function logoFlowPhoto(c: Ctx, lw: number, colour: string, extra = '') {
  return `<div class="logo" data-role="logo" data-bg="photo" data-ink="${colour}" style="position:relative;flex:none;width:${lw}px;height:${logoH(c, lw)}px;background:var(--${colour});${extra}"></div>`
}

/** AD-2: bold, widely tracked caps across the frame on a photo (or a field blending into the photo), logo bottom-left. */
function capsPhoto(c: Ctx) {
  const { w, h, size } = c, copy = c.spec.copy, inkTok = c.kit.tok(c.spec.ink ?? 'white'), land = size === 'landscape', story = size === 'story'
  const G = c.spec.ground ? groundOf(c, c.spec.ground, 'ground') : null
  const a = c.spec.shade ?? 0.45, sh = (o: number) => shadeOf(c, 'dark', (o * a).toFixed(3)), mx = Math.round(w * 0.054), lw = Math.round(w * (land ? 0.26 : 0.34))
  const li = (o: number) => shadeOf(c, 'light', o)
  const lightInk = inkTok === c.kit.tok('white') || inkTok === c.kit.tok('ground')
  // With a ground, the photo fills the right side and fades into the field (the half-sketch art of the original).
  const art = G
    ? `<div style="${box(0, 0, w, h, `background:var(--${G.tok})`)}"></div>${photo(c, c.spec.image, story ? 0 : w * 0.5, 0, story ? w : w * 0.5, story ? h * 0.5 : h,
      story ? '-webkit-mask-image:linear-gradient(0deg, transparent 0%, #000 35%)' : '-webkit-mask-image:linear-gradient(90deg, transparent 0%, #000 30%)')}`
    : `${photo(c, c.spec.image, 0, 0, w, h)}${lightInk ? shadeLayer(w, h, `linear-gradient(${story ? 0 : 90}deg, ${sh(1.5)} 0%, ${sh(1)} 50%, ${sh(0.3)} 100%)`) : lightVeil(w, h, `linear-gradient(${story ? 0 : 90}deg, ${li(0.9)} 0%, ${li(0.55)} 50%, ${li(0.1)} 100%)`)}`
  const ground = G?.tok ?? 'photo', [top, bottom] = band(c)
  // Caps lines 13.9% apart, tracked ~0.31em, the widest spanning 80% of the frame.
  const fs = land ? 70 : story ? 112 : 108, tTop = land ? 40 : story ? h * 0.42 : h * 0.33, tBottom = land ? h - 110 : story ? h * 0.7 : h * 0.84
  const lgY = land ? h - 46 - logoH(c, lw) : story ? bottom - logoH(c, lw) - 4 : h * 0.92
  // On a field, the type stays on the field (left of where the photo fades in).
  const tw = G && !story ? w * 0.56 - mx : w - 2 * mx
  return `${art}
    <div style="${box(mx, Math.max(tTop, top), tw, tBottom - Math.max(tTop, top), 'display:flex;flex-direction:column;justify-content:center;gap:24px')}">
      ${text('headline', 'caps bold', lines(copy.headline), ground, `position:relative;white-space:nowrap;font-size:${fs}px;line-height:1.39;letter-spacing:0.31em;color:var(--${inkTok})`)}
      ${copy.sub ? text('sub', 'serif', esc(one(copy.sub)), ground, `position:relative;font-size:${land ? 30 : 42}px;line-height:1.15;color:var(--${inkTok})`) : ''}
    </div>${logo(c, ground, mx + Math.round(w * 0.002) + lw / 2, lgY, lw, 'logo', G ? undefined : inkTok)}`
}

/** AD-3: a frosted interface panel (search, alert, focus mode) over a real photo; logo white bottom-centre. */
function glassPanel(c: Ctx) {
  const { w, h, size } = c, copy = c.spec.copy, land = size === 'landscape', story = size === 'story'
  const rows = (Array.isArray(copy.rows) ? copy.rows : copy.rows ? [copy.rows] : []) as string[]
  // Panel x 4.5–95.5%, y 33–67%; query row 46 px with the icon; rows 42 px, 81 px apart.
  const pw = land ? w * 0.6 : w * 0.91, lw = Math.round(w * (land ? 0.22 : 0.269)), [top] = band(c)
  const search = `<svg width="40" height="40" viewBox="0 0 24 24" style="flex:none"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="${v(c, 'accent')}" stroke-width="2.2"/><path d="M15.5 15.5l5 5" stroke="${v(c, 'accent')}" stroke-width="2.2" stroke-linecap="round"/></svg>`
  const lgY = land ? h - 40 - logoH(c, lw) : story ? h * 0.766 - logoH(c, lw) / 2 : h * 0.924 - logoH(c, lw) / 2
  const mid = story ? h * 0.48 : land ? h * 0.45 : h * 0.5
  const white = c.kit.tok('white')
  return `${photo(c, c.spec.image, 0, 0, w, h)}${shadeLayer(w, h, `linear-gradient(0deg, ${shadeOf(c, 'dark', 0.45)} 0%, ${shadeOf(c, 'dark', 0.08)} 30%, ${shadeOf(c, 'dark', 0)} 60%)`)}
    <div style="${box(0, Math.max(top, mid - h * 0.3), w, Math.min(h * 0.6, (lgY - 20) - Math.max(top, mid - h * 0.3)), 'display:flex;align-items:center;justify-content:center')}">
      <div data-occlude data-glass data-movable style="position:relative;width:${pw}px;padding:${land ? 20 : 26}px ${land ? 20 : 26}px ${land ? 26 : 36}px;border-radius:24px;background:rgba(${c.kit.kit.shades.glass},var(--glass,0.62));backdrop-filter:blur(16px) saturate(1.1);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.16);display:flex;flex-direction:column;gap:${land ? 16 : 30}px">
        <div style="position:relative;display:flex;align-items:center;gap:20px;padding:${land ? 12 : 18}px 22px;border-radius:16px;background:rgba(255,255,255,0.1)">${search}
          ${text('headline', 'serif', esc(one(copy.query)), 'photo', `position:relative;white-space:nowrap;font-size:${land ? 34 : 46}px;line-height:1.1;color:var(--${white})`)}</div>
        ${rows.map((r) => text('sub', 'serif', esc(r), 'photo', `position:relative;padding-left:${land ? 82 : 104}px;white-space:nowrap;font-size:${land ? 31 : 42}px;line-height:1.15;color:var(--${white})`)).join('')}
      </div>
    </div>${logo(c, 'photo', w / 2, lgY, lw, 'logo', white)}`
}

/** AD-4: "1,500+ ★ REVIEWS" over a softened real photo, a light frosted card with a verbatim review, gold stars. */
function reviewGlass(c: Ctx) {
  const { w, h, size } = c, copy = c.spec.copy, land = size === 'landscape', story = size === 'story', [top, bottom] = band(c)
  const white = c.kit.tok('white'), cardTok = c.kit.tok('ground'), avatarBg = c.kit.tok('accent')
  const star = (s: number, label = '') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" style="flex:none"><path fill="${v(c, 'star')}" d="M12 1.8l3.1 6.5 7.1.9-5.2 4.9 1.4 7.1L12 17.7l-6.4 3.5 1.4-7.1L1.8 9.2l7.1-.9z"/>${label ? `<text x="12" y="15.2" text-anchor="middle" font-size="7" font-family="${attr(cssString(family(c.kit.fonts.sans.family)))}" font-weight="700" fill="var(--${white})">${label}</text>` : ''}</svg>`
  // Header centred at y 10.4%; card x 14–86%, y 29–74%; logo 34.8% wide at y 89.8%.
  const cw = land ? w * 0.5 : w * 0.72, lw = Math.round(w * (land ? 0.24 : 0.348)), hs = land ? 40 : story ? 60 : 56
  const lgY = land ? h - 36 - logoH(c, lw) : story ? bottom - logoH(c, lw) - 4 : h * 0.898
  const headY = land ? 30 : story ? top + 10 : h * 0.104 - hs * 0.9, cardTop = land ? 100 : story ? top + 150 : h * 0.24
  return `${photo(c, c.spec.image, 0, 0, w, h)}${shadeLayer(w, h, shadeOf(c, 'dark', c.spec.shade ?? 0.42))}
    <div style="${box(land ? w * 0.42 : 0, headY, land ? w * 0.58 : w, hs * 1.8, `display:flex;align-items:center;justify-content:center;gap:${land ? 14 : 20}px`)}">
        ${text('label', 'caps bold', esc(one(copy.count)), 'photo', `position:relative;font-size:${hs}px;letter-spacing:0.12em;color:var(--${white})`)}${star(Math.round(hs * 1.6), '5')}
        ${text('label', 'caps bold', esc(one(copy.reviewsLabel ?? 'Reviews')), 'photo', `position:relative;font-size:${hs}px;letter-spacing:0.12em;color:var(--${white})`)}</div>
    <div style="${box(land ? w * 0.42 : 0, cardTop, land ? w * 0.58 : w, (land ? h - 70 : lgY - 30) - cardTop, `display:flex;flex-direction:column;align-items:center;justify-content:${land || story ? 'center' : 'flex-start'};padding-top:${land || story ? 0 : h * 0.05}px`)}">
      <div data-occlude style="position:relative;width:${cw}px;padding:${land ? 30 : 46}px ${land ? 34 : 50}px;border-radius:26px;background:${shadeOf(c, 'light', 0.78)};backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);display:flex;gap:${land ? 18 : 26}px">
        <div style="flex:none;width:${land ? 52 : 70}px;height:${land ? 52 : 70}px;border-radius:50%;background:var(--${avatarBg});display:flex;align-items:center;justify-content:center">${text('avatar', 'caps bold', esc(one(copy.initials)), avatarBg, `position:relative;font-size:${land ? 18 : 24}px;letter-spacing:0.04em;color:${v(c, 'deep')}`)}</div>
        <div style="position:relative;flex:1;display:flex;flex-direction:column;gap:${land ? 12 : 18}px">
          <div style="display:flex;gap:8px">${star(land ? 30 : 48).repeat(5)}</div>
          ${text('quote', 'serif', esc(one(copy.quote)), cardTok, `position:relative;font-size:${land ? 30 : 46}px;line-height:1.22;color:${v(c, 'ink')}`)}
          ${text('name', 'caps bold', esc(one(copy.name)), cardTok, `position:relative;margin-top:6px;font-size:${land ? 20 : 30}px;letter-spacing:0.14em;color:${v(c, 'ink')}`)}
        </div>
        <div style="position:absolute;right:${land ? 22 : 30}px;top:${land ? 12 : 18}px;font-family:${attr(cssString(family(c.kit.fonts.serif.family)))};font-size:${land ? 54 : 80}px;line-height:1;color:${v(c, 'accent')}">&rdquo;</div>
      </div>
    </div>${logo(c, 'photo', land ? w * 0.42 + w * 0.29 : w / 2, lgY, lw, 'logo', white)}`
}

/** AD-11: a dated offer. Photo above with the wave edge, white serif hook over the photo, an offer card, the plain
 *  offer and its end date on the ground below. */
function offerWave(c: Ctx) {
  const { w, h, size } = c, copy = c.spec.copy, land = size === 'landscape', story = size === 'story', g = c.kit.tok('ground')
  const split = land ? 0 : story ? 0.62 : size === 'portrait' ? 0.72 : 0.7, edge = Math.round(h * split), amp = Math.round(w * 0.08)
  const a = c.spec.shade ?? 0.55, cardTok = c.kit.tok('groundAlt')
  const card = (cw: number) => {
    const chh = cw * 0.6, lw = cw * 0.36
    return `<div data-occlude style="position:relative;flex:none;width:${cw}px;height:${chh}px;border-radius:${cw * 0.06}px;background:var(--${cardTok});box-shadow:0 26px 60px ${shadeOf(c, 'dark', 0.32)};display:flex;flex-direction:column;justify-content:space-between;padding:${cw * 0.07}px">
      <div style="display:flex;flex-direction:column;gap:${cw * 0.02}px">${text('value', 'caps bold', esc(one(copy.value)), cardTok, `position:relative;font-size:${cw * 0.2}px;line-height:1;letter-spacing:0.02em;color:${v(c, 'deep')}`)}
        ${text('label', 'caps bold', esc(one(copy.valueLabel)), cardTok, `position:relative;font-size:${cw * 0.045}px;color:${v(c, 'deep')}`)}</div>
      ${logoFlow(c, cardTok, lw, 'align-self:flex-end')}</div>`
  }
  if (land) {
    const pw = w * 0.5
    return `<div style="${box(0, 0, w, h, `background:var(--${g})`)}"></div>${photo(c, c.spec.image, 0, 0, pw, h)}${shadeLayer(pw, h, shadeOf(c, 'dark', a * 0.6))}
      <div style="${box(36, 0, pw - 72, h, 'display:flex;align-items:center;justify-content:center')}">${card(pw * 0.7)}</div>
      <div style="${box(pw + 50, 40, w - pw - 100, h - 80, 'display:flex;flex-direction:column;justify-content:center;gap:18px')}">
        ${text('headline', 'serif', lines(copy.headline), g, `position:relative;font-size:52px;line-height:1.02;color:${v(c, 'ink')}`)}
        ${text('offer', 'serif', esc(one(copy.offer)), g, `position:relative;font-size:26px;line-height:1.25;color:${v(c, 'ink')}`)}
        ${text('date', 'caps bold', esc(one(copy.date)), g, `position:relative;font-size:18px;color:${v(c, 'muted')}`)}
      </div>`
  }
  // Headline lines at y 10% and 20%, a card spanning ~70% of the width at y 37–75%, the offer at y 84%.
  const [top] = band(c), m = Math.round(w * 0.06), cw = w * (story ? 0.74 : 0.62)
  return `${photo(c, c.spec.image, 0, 0, w, edge + amp)}${shadeLayer(w, edge, `linear-gradient(180deg, ${shadeOf(c, 'dark', a)} 0%, ${shadeOf(c, 'dark', a * 0.4)} 40%, ${shadeOf(c, 'dark', 0)} 70%)`)}
    <div style="${box(0, edge, w, h - edge, `background:var(--${g})`)}"></div>${wave(c, g, edge, amp)}
    <div style="${box(m, top + (story ? 44 : Math.round(h * 0.095)), w - 2 * m, Math.round(h * (story ? 0.15 : 0.24)), 'display:flex;align-items:flex-start;justify-content:center;text-align:center')}">
      ${text('headline', 'serif', lines(copy.headline), 'photo', `position:relative;font-size:${story ? 100 : 96}px;line-height:1.0;color:${v(c, 'white')}`)}</div>
    <div style="${box(0, h * 0.37, w, cw * 0.62, 'display:flex;justify-content:center')}">${card(cw)}</div>
    <div style="${box(m, story ? edge + amp * 0.2 : h * 0.8, w - 2 * m, story ? h * 0.78 - edge - amp * 0.2 : h * 0.17, 'display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;gap:12px')}">
      ${text('offer', 'serif', esc(one(copy.offer)), g, `position:relative;font-size:${story ? 46 : 44}px;line-height:1.15;color:${v(c, 'ink')}`)}
      ${text('date', 'caps bold', esc(one(copy.date)), g, `position:relative;font-size:${story ? 30 : 28}px;color:${v(c, 'muted')}`)}
    </div>`
}

const TEMPLATES: Record<string, (c: Ctx) => string> = {
  'serif-card': serifCard, 'serif-full': serifFull, 'caps-statement': capsStatement, 'ui-calendar': uiCalendar, mosaic, review, offer,
  'state-cover': stateCover, 'state-item': stateItem, 'state-end': stateEnd,
  statement, 'caps-photo': capsPhoto, 'glass-panel': glassPanel, 'review-glass': reviewGlass, 'offer-wave': offerWave,
}
export const TEMPLATE_IDS = Object.keys(TEMPLATES)

/** The whole page for one ad in one size. */
export function renderAd(kit: AdsKit, base: AdSpec, size: SizeKey, url: (img: AdImg) => string): string {
  const spec = forSize(base, size), { w, h } = SIZES[size], t = TEMPLATES[spec.template]
  if (!t) throw new Error(`${spec.id}: unknown template ${spec.template}`)
  const body = t({ kit, spec, size, w, h, url })
  return `<!doctype html><html><head><meta charset="utf-8"><style>${kit.css}
    body{width:${w}px;height:${h}px;position:relative;background:var(--${kit.tok('ground')})}
    html.bg-only [data-role]:not([data-role=logo]){color:transparent!important}html.bg-only [data-role=logo]{visibility:hidden}
    /* Depth: only the headline may pass behind a person (data-person, z 40); everything else stays in front. */
    [data-role]:not([data-role=headline]){z-index:45}[data-role=logo]{z-index:46}
    </style></head><body>${body}
    <script>
    // Fit: shrink any text that overflows its box (never grow), so long copy can't break a layout.
    for (const el of document.querySelectorAll('[data-fit]')) { let fs = parseFloat(getComputedStyle(el).fontSize), i = 0;
      while (i++ < 40 && (el.scrollWidth > el.clientWidth + 1 || (el.style.height && el.scrollHeight > el.clientHeight + 1))) { fs *= 0.96; el.style.fontSize = fs + 'px'; } }
    // Then shrink a whole stack when its boxes don't fit. Measured from the line boxes (offsetTop/Height), not
    // scrollHeight: tight leading lets glyphs overhang their lines, which is not overflow.
    const span = p => { const kids = [...p.children].filter(e => e.offsetParent !== null); if (!kids.length) return 0;
      return Math.max(...kids.map(e => e.offsetTop + e.offsetHeight)) - Math.min(...kids.map(e => e.offsetTop)); };
    for (const p of new Set([...document.querySelectorAll('[data-fit]')].map(e => e.parentElement))) { let i = 0;
      while (i++ < 40 && p.clientHeight > 0 && span(p) > p.clientHeight + 1) for (const el of p.querySelectorAll('[data-fit]')) el.style.fontSize = parseFloat(getComputedStyle(el).fontSize) * 0.96 + 'px'; }
    </script></body></html>`
}
