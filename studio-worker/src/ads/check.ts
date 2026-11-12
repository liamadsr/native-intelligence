/**
 * The brand check for a rendered static ad. It reads what the page actually
 * drew (element boxes, computed colours, fonts) and what sits behind each text
 * (a second render with the text hidden), and returns findings that cite the
 * brand's rule ids. Errors break a rule; warnings are judgement calls for a person.
 *
 * The copy bans, the casing rule and the logo's limits come from the brand kit
 * (rules) instead of being written into the check; the copy bans run with a
 * time limit (patterns.ts).
 */
import type { AdSpec, Finding, SizeKey } from '../../../web/src/lib/studio/server/ads-contract.ts'
import type { AdsKit } from './kit.ts'
import { copyRuleFindings } from './patterns.ts'
import { hexRgb, region, thumbnailPixels } from './raster.ts'
import { SAFE } from './templates.ts'

export type { Finding }
export type Measured = { role: string; text: string; bg: string; ink?: string; rect: { x: number; y: number; w: number; h: number }; color: string; family: string; transform: string; fontSize: number }

const lin = (c: number) => {
  c /= 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
export const lum = ([r, g, b]: number[]) => 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!)
export const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
const rgb = (css: string) => (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
export const oklab = ([r, g, b]: number[]) => {
  const R = lin(r!), G = lin(g!), B = lin(b!)
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B), m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B), s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}

/** True when a computed font family is the kit's sans. */
const isSansFamily = (kit: AdsKit, family: string) => family.includes(kit.fonts.sans.family)

/** Copy rules matched against all of an ad's words (case-insensitive); a rule with `unless` is lifted when that also matches. */
export function copyFindings(kit: AdsKit, all: string): Finding[] {
  return copyRuleFindings(kit.kit.rules.copyBans, all)
}

export async function checkAd(kit: AdsKit, spec: AdSpec, size: SizeKey, w: number, h: number, measured: Measured[], bgPng: string, finalPng: string): Promise<Finding[]> {
  void spec
  const out: Finding[] = [], palette = Object.entries(kit.palette).map(([k, hex]) => ({ k, hex, lab: oklab(hexRgb(hex)) }))
  const rules = kit.kit.rules
  const [safeTop, safeBottom] = SAFE[size]
  const texts = measured.filter((m) => m.role !== 'logo' && m.text.trim())
  for (const m of texts) {
    // TYPE-1: the serif is never caps, the sans always is.
    const isSans = isSansFamily(kit, m.family), letters = m.text.replace(/[^A-Za-z]/g, '')
    if (rules.casing.sansCaps && isSans && m.transform !== 'uppercase' && letters !== letters.toUpperCase()) out.push({ level: 'error', rule: 'TYPE-1', message: `Sans text not in caps: "${m.text}"` })
    if (!rules.casing.serifCaps && !isSans && (m.transform === 'uppercase' || (letters.length > 3 && letters === letters.toUpperCase()))) out.push({ level: 'error', rule: 'TYPE-1', message: `Serif text in caps: "${m.text}"` })
    // Text colour must be a palette colour.
    const c = rgb(m.color), lab = oklab(c), near = palette.map((p) => ({ ...p, d: Math.hypot(lab[0]! - p.lab[0]!, lab[1]! - p.lab[1]!, lab[2]! - p.lab[2]!) })).sort((a, b) => a.d - b.d)[0]
    if (!near || near.d > 0.02) out.push({ level: 'error', rule: 'COLOR-1', message: `Text colour ${m.color} is not a palette colour ("${m.text.slice(0, 30)}")` })
    // Contrast against what is really behind the words (text hidden), worst 10% of the background.
    const bgPx = await region(bgPng, m.rect), tl = lum(c), ratios = bgPx.map((p) => contrast(tl, lum(p))).sort((a, b) => a - b)
    const worst = ratios[Math.floor(ratios.length * 0.1)] ?? 0, large = m.fontSize >= 36, need = large ? 3 : 4.5
    if (worst < need) out.push({ level: m.bg === 'photo' ? 'warn' : 'error', rule: 'COLOR-2', message: `Contrast ${worst.toFixed(1)}:1 (needs ${need}:1) for "${m.text.slice(0, 40)}"${m.bg === 'photo' ? ' on the photo' : ''}` })
    // Safe band (CHANNEL-2): 9:16 keeps everything within y 20–78%; other sizes keep a margin.
    if (m.rect.y < h * safeTop - 1 || m.rect.y + m.rect.h > h * safeBottom + 1 || m.rect.x < w * 0.03 || m.rect.x + m.rect.w > w * 0.97 + 1)
      out.push({ level: 'error', rule: 'CHANNEL-2', message: `Outside the safe area: "${m.text.slice(0, 40)}"` })
  }
  // Logo (LOGO-3/4/5): one logo, wide enough, an approved treatment, clear space of one cap height.
  const logos = measured.filter((m) => m.role === 'logo')
  if (!logos.length) out.push({ level: 'error', rule: 'LOGO', message: 'No logo on this ad' })
  for (const l of logos) {
    // The logo must actually have been drawn: compare the final render with the logo hidden.
    const [withLogo, without] = await Promise.all([region(finalPng, l.rect, 32), region(bgPng, l.rect, 32)])
    const drawn = withLogo.filter((p, i) => Math.abs(p[0]! - without[i]![0]!) + Math.abs(p[1]! - without[i]![1]!) + Math.abs(p[2]! - without[i]![2]!) > 60).length / withLogo.length
    if (drawn < 0.08) out.push({ level: 'error', rule: 'LOGO', message: `Logo did not render (${Math.round(drawn * 100)}% of its box changed)` })
    if (l.rect.w < rules.logo.minWidth) out.push({ level: 'error', rule: 'LOGO-4', message: `Logo is ${Math.round(l.rect.w)} px wide (minimum ${rules.logo.minWidth})` })
    if (l.bg === 'photo') {
      // LOGO-5a: allowed on photos, if it reads.
      const ink = lum(hexRgb(kit.palette[l.ink ?? 'white'] ?? '#FFFFFF')), ratios = (await region(bgPng, l.rect, 16)).map((p) => contrast(ink, lum(p))).sort((a, b) => a - b)
      const worst = ratios[Math.floor(ratios.length * 0.1)] ?? 0
      if (worst < rules.logo.photoContrast) out.push({ level: 'warn', rule: 'LOGO-5a', message: `Logo on the photo reads at ${worst.toFixed(1)}:1 (aim for ${rules.logo.photoContrast}:1); shade the photo or move it` })
    } else if (kit.logoOn[l.bg] !== l.ink) out.push({ level: 'error', rule: 'LOGO-5', message: `Logo ${l.ink} on ${l.bg} is not an approved treatment` })
    else {
      // The ground under the logo must really be that colour.
      const px = await region(bgPng, l.rect, 12), want = oklab(hexRgb(kit.palette[l.bg]!)), off = px.filter((p) => { const q = oklab(p); return Math.hypot(q[0]! - want[0]!, q[1]! - want[1]!, q[2]! - want[2]!) > 0.03 }).length / px.length
      if (off > 0.1) out.push({ level: 'error', rule: 'LOGO-5', message: `Ground under the logo is not ${l.bg} (${Math.round(off * 100)}% off)` })
    }
    const C = l.rect.h / rules.logo.capRatio, r = { x: l.rect.x - C, y: l.rect.y - C, w: l.rect.w + 2 * C, h: l.rect.h + 2 * C }
    for (const m of texts) {
      const a = m.rect
      if (a.x < r.x + r.w && a.x + a.w > r.x && a.y < r.y + r.h && a.y + a.h > r.y) out.push({ level: 'error', rule: 'LOGO-3', message: `"${m.text.slice(0, 30)}" is inside the logo's clear space` })
    }
    if (l.rect.y < h * safeTop - 1 || l.rect.y + l.rect.h > h * safeBottom + 1) out.push({ level: 'error', rule: 'CHANNEL-2', message: 'Logo outside the safe area' })
  }
  // Copy rules.
  out.push(...copyFindings(kit, texts.map((m) => m.text).join(' ')))
  const head = texts.filter((m) => m.role === 'headline').map((m) => m.text).join(' ').trim()
  const words = head.split(/\s+/).filter(Boolean)
  if (words.length > rules.headlineMaxWords) out.push({ level: 'warn', rule: 'VOICE-7', message: `Headline has ${words.length} words (proven: 2–6)` })
  const serifHeads = texts.filter((m) => m.role === 'headline' && !isSansFamily(kit, m.family)).map((m) => m.text).join(' ').split(/\s+/).filter((x) => /^[A-Za-z]{4,}/.test(x))
  if (serifHeads.length >= 3 && serifHeads.filter((x) => /^[A-Z]/.test(x)).length / serifHeads.length > 0.75) out.push({ level: 'warn', rule: 'TYPE-4', message: 'Serif headline looks like Title Case (use sentence case)' })
  return out
}

/** Type on photos (and in glass panels) that doesn't read yet. Targets are stricter than WCAG for a serif whose
 *  hairlines vanish on busy or bright backgrounds: small serif text needs 7:1, mid sizes 6:1, everything else 4.5:1. */
export async function legibility(kit: AdsKit, measured: Measured[], bgPng: string) {
  const weak: { text: string; worst: number; target: number }[] = []
  for (const m of measured) {
    if (m.bg !== 'photo') continue
    const ink = m.role === 'logo' ? hexRgb(kit.palette[m.ink ?? 'white'] ?? '#FFFFFF') : rgb(m.color)
    if (m.role !== 'logo' && !m.text.trim()) continue
    const ratios = (await region(bgPng, m.rect)).map((p) => contrast(lum(ink), lum(p))).sort((a, b) => a - b)
    const worst = ratios[Math.floor(ratios.length * 0.1)] ?? 0, serif = !isSansFamily(kit, m.family)
    const target = m.role === 'logo' ? 3.5 : m.fontSize < 36 ? (serif ? 7 : 4.5) : m.fontSize < 60 ? (serif ? 6 : 4.5) : 4.5
    if (worst < target) weak.push({ text: m.role === 'logo' ? 'logo' : m.text, worst, target })
  }
  return weak
}

/** Photo checks on the source image (PHOTO-2, PHOTO-DONT-3): oversaturation and cold blue. */
export async function checkPhoto(path: string): Promise<Finding[]> {
  const px = await thumbnailPixels(path, 48)
  let chroma = 0, cold = 0, n = 0
  for (const p of px) {
    const [, a, b] = oklab(p)
    const C = Math.hypot(a!, b!), hue = ((Math.atan2(b!, a!) * 180) / Math.PI + 360) % 360
    chroma += C
    if (C > 0.05 && hue > 200 && hue < 280) cold++
    n++
  }
  const out: Finding[] = []
  if (!n) return out
  if (cold / n > 0.2) out.push({ level: 'warn', rule: 'PHOTO-DONT-3', message: `${Math.round((100 * cold) / n)}% cold-blue pixels` })
  if (chroma / n > 0.09) out.push({ level: 'warn', rule: 'PHOTO-2', message: `Mean chroma ${(chroma / n).toFixed(3)} reads oversaturated` })
  return out
}
