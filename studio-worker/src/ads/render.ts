/**
 * Render a batch of static ads (every spec × every size) in headless Chromium,
 * check each against the brand, and write PNGs, a report and a contact sheet.
 *
 * Per ad and size:
 *   1. Faces: map each photo's keep-clear zones (faces and heads, from people
 *      data) onto the frame, re-frame photos and slide movable panels until no
 *      text, logo or panel covers a face.
 *   2. Still covering someone? A statement tries its other layouts first.
 *   3. Last resort, headline only: set it behind the person (a copy of the
 *      photo masked to the person, above the type), if that hides at most 15%
 *      of its lettering.
 *   4. Legibility: deepen shades, raise light veils, darken glass, step by
 *      step, until the type on photos reads.
 *   5. The brand check (check.ts) on the final render and a text-hidden one.
 * Passes 1–3 need people data for the photo. Without it they find nothing to
 * avoid, and the ad is listed as rendered without people data.
 *
 * The pages are served from the job's own folder through the fence
 * (fence.ts): the page that `input.page` is must come from fencedPage().
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import type { AdImg, AdSpec, People, SizeKey, StaticBatch } from '../../../web/src/lib/studio/server/ads-contract.ts'
import { checkAd, checkPhoto, legibility, type Finding, type Measured } from './check.ts'
import type { AdsKit } from './kit.ts'
import { html as escHtml, attr } from './escape.ts'
import { pageUrl } from './fence.ts'
import { differingPixels, magick } from './raster.ts'
import { run } from '../media.ts'
import { SIZE_ORDER, SIZES, forSize, renderAd } from './templates.ts'

type Box = { x: number; y: number; w: number; h: number }
type Zones = Record<string, { width: number; height: number; zones: Box[] }>
type Overlap = { photo: number; kind: string; text: string; zoneFrac: number; blockFrac: number }

/** The zones text must keep clear of: each face or head, grown by a margin so type never grazes a hairline or chin. */
export const keepClear = (p: Pick<People, 'faces' | 'heads'>, grow = 0.18): Box[] =>
  [...p.faces, ...p.heads].map((b) => ({ x: b.x - b.w * grow, y: b.y - b.h * grow, w: b.w * (1 + 2 * grow), h: b.h * (1 + 2 * grow) }))

// ---- In-page passes (run inside Chromium) -------------------------------------------------------------------

/** Faces: map each photo's keep-clear zones onto the frame, re-frame a photo (search its focus) until no text, logo or
 *  panel covers a face, and report what still overlaps. */
function solveFaces({ zones, band }: { zones: Zones; band: [number, number] }) {
  const inter = (a: any, b: any) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  const box = (r: DOMRect) => ({ x: r.left, y: r.top, w: r.width, h: r.height })
  const tight = (el: HTMLElement) => {
    if (el.dataset.role === 'logo') return box(el.getBoundingClientRect())
    const g = document.createRange()
    g.selectNodeContents(el)
    return box(g.getBoundingClientRect())
  }
  const blockers = [
    ...Array.from(document.querySelectorAll<HTMLElement>('[data-role]')).filter((el) => el.dataset.role === 'logo' || (el.innerText ?? '').trim()).map((el) => ({ el, kind: el.dataset.role!, r: tight(el) })),
    ...Array.from(document.querySelectorAll<HTMLElement>('[data-occlude]')).map((el) => ({ el, kind: 'panel', r: box(el.getBoundingClientRect()) })),
  ]
  const photos = Array.from(document.querySelectorAll<HTMLElement>('[data-photo]'))
  const zonesFor = (ph: HTMLElement, fx: number, fy: number) => {
    const p = zones[ph.dataset.img ?? '']
    if (!p) return []
    const r = ph.getBoundingClientRect(), s = Math.max(r.width / p.width, r.height / p.height), dw = p.width * s, dh = p.height * s, ox = (r.width - dw) * fx, oy = (r.height - dh) * fy
    return p.zones.map((z) => {
      const x = Math.max(r.left, r.left + ox + z.x * dw), y = Math.max(r.top, r.top + oy + z.y * dh)
      return { x, y, w: Math.min(r.right, r.left + ox + (z.x + z.w) * dw) - x, h: Math.min(r.bottom, r.top + oy + (z.y + z.h) * dh) - y }
    }).filter((z) => z.w > 4 && z.h > 4)
  }
  const cost = (zs: any[]) => blockers.reduce((s, b) => s + zs.reduce((t, z) => t + inter(b.r, z), 0), 0)
  let reframed = 0
  for (const ph of photos) {
    const fx0 = +ph.dataset.fx!, fy0 = +ph.dataset.fy!
    let best = { fx: fx0, fy: fy0, c: cost(zonesFor(ph, fx0, fy0)), d: 0 }
    if (best.c > 0) for (let fx = 0; fx <= 1.0001; fx += 0.05) for (let fy = 0; fy <= 1.0001; fy += 0.05) {
      const c = cost(zonesFor(ph, fx, fy)), d = Math.hypot(fx - fx0, fy - fy0)
      if (c < best.c - 1 || (Math.abs(c - best.c) <= 1 && d < best.d)) best = { fx, fy, c, d }
    }
    if (best.fx !== fx0 || best.fy !== fy0) {
      ph.style.backgroundPosition = `${best.fx * 100}% ${best.fy * 100}%`
      ph.dataset.fx = String(best.fx)
      ph.dataset.fy = String(best.fy)
      reframed++
    }
  }
  // Then panels (data-movable) may slide up or down within the safe band, clear of the logo, to uncover a face.
  const allZones = () => photos.flatMap((ph) => zonesFor(ph, +ph.dataset.fx!, +ph.dataset.fy!))
  const logoBox = blockers.find((b) => b.kind === 'logo')?.r, H = innerHeight
  for (const m of Array.from(document.querySelectorAll<HTMLElement>('[data-movable]'))) {
    const mr = box(m.getBoundingClientRect()), mine = blockers.filter((b) => m === b.el || m.contains(b.el)), zs = allZones()
    const at = (dy: number) => mine.reduce((s, b) => s + zs.reduce((t, z) => t + inter({ ...b.r, y: b.r.y + dy }, z), 0), 0)
    if (at(0) <= 0) continue
    let best = { dy: 0, c: at(0) }
    for (let dy = -0.45 * H; dy <= 0.45 * H; dy += 0.01 * H) {
      const top = mr.y + dy, bottom = top + mr.h
      if (top < band[0] * H + 8 || bottom > band[1] * H - 8 || (logoBox && inter({ ...mr, y: top }, logoBox) > 0)) continue
      const c = at(dy)
      if (c < best.c - 1 || (Math.abs(c - best.c) <= 1 && Math.abs(dy) < Math.abs(best.dy))) best = { dy, c }
    }
    if (best.dy) {
      m.style.transform = `translateY(${best.dy}px)`
      for (const b of mine) b.r = { ...b.r, y: b.r.y + best.dy }
      reframed++
    }
  }
  const overlaps: { photo: number; kind: string; text: string; zoneFrac: number; blockFrac: number }[] = []
  photos.forEach((ph, i) => {
    for (const z of zonesFor(ph, +ph.dataset.fx!, +ph.dataset.fy!)) for (const b of blockers) {
      const a = inter(b.r, z)
      if (a > 0.02 * z.w * z.h) overlaps.push({ photo: i, kind: b.kind, text: (b.el.innerText ?? '').slice(0, 40), zoneFrac: a / (z.w * z.h), blockFrac: a / Math.max(1, b.r.w * b.r.h) })
    }
  })
  return { overlaps, reframed }
}
/** Text behind the head: a copy of the photo, masked to the people in it (a greyscale matte), layered above the type. */
function personLayer({ idx, matte }: { idx: number; matte: string }) {
  const ph = document.querySelectorAll<HTMLElement>('[data-photo]')[idx]!, d = document.createElement('div')
  d.setAttribute('style', ph.getAttribute('style') ?? '')
  d.dataset.person = ''
  const pos = ph.style.backgroundPosition || getComputedStyle(ph).backgroundPosition
  const s = d.style as CSSStyleDeclaration & Record<string, string>
  Object.assign(s, { backgroundPosition: pos, maskImage: `url(${matte})`, maskMode: 'luminance', maskSize: 'cover', maskPosition: pos, maskRepeat: 'no-repeat', zIndex: '40' })
  document.body.appendChild(d)
}
/** One legibility step: deepen dark shades, raise light veils, darken glass panels. */
function boost(step: number) {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-shade]:not([data-light]):not([data-clone])'))) {
    const c = el.cloneNode() as HTMLElement
    c.dataset.clone = ''
    c.style.opacity = '0.4'
    el.after(c)
  }
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-shade][data-light]'))) el.style.opacity = String(Math.min(1, 0.35 * step))
  document.documentElement.style.setProperty('--glass', String(Math.min(0.9, 0.62 + 0.07 * step)))
}
function measure() {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-role]')).map((el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    const r = el.dataset.role === 'logo' ? el.getBoundingClientRect() : range.getBoundingClientRect(), cs = getComputedStyle(el)
    return { role: el.dataset.role!, text: el.innerText ?? '', bg: el.dataset.bg ?? '', ink: el.dataset.ink, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, color: cs.color, family: cs.fontFamily, transform: cs.textTransform, fontSize: parseFloat(cs.fontSize) }
  })
}

// ---- The batch -----------------------------------------------------------------------------------------------

export type AdResult = {
  id: string; pattern: string; template: string; title?: string
  files: Partial<Record<SizeKey, string>>; findings: Partial<Record<SizeKey, Finding[]>>
  photo: Finding[]; flags: string[]; notes?: string
  /** True when every photo of the ad had people data (the face passes had something to go on). */
  people: boolean
}

export type BatchInput = {
  kit: AdsKit
  batch: StaticBatch
  /** Each image source, staged and shrunk. */
  images: Map<string, string>
  /** What each image source is called in the library (for the report). */
  names?: Map<string, string>
  /** People data per image source, the matte staged as a local file. */
  people: Map<string, People & { mattePath?: string }>
  /** The job's folder: the page may read nothing outside it (images, out and cache are in it). */
  root: string
  out: string
  cache: string
  page: Page
  log: (line: string) => void
  progress: (fraction: number) => void
  signal: AbortSignal
}

const imagesOf = (spec: AdSpec): AdImg[] =>
  [spec.image, ...(spec.images ?? []), ...Object.values(spec.bySize ?? {}).flatMap((o) => [o?.image, ...(o?.images ?? [])])].filter(Boolean) as AdImg[]

export async function renderBatch(input: BatchInput): Promise<{ results: AdResult[]; reportJson: string; reportMd: string; contactSheet: string }> {
  const { kit, batch, images, page, out, cache, log } = input
  await mkdir(out, { recursive: true })
  await mkdir(cache, { recursive: true })
  const url = (img: AdImg) => pageUrl(input.root, images.get(img.src)!)
  const zones: Zones = {}
  const peopleByUrl = new Map<string, People & { mattePath?: string }>()
  for (const [src, p] of input.people) {
    const local = images.get(src)
    if (!local) continue
    const u = pageUrl(input.root, local)
    zones[u] = { width: p.width, height: p.height, zones: keepClear(p) }
    peopleByUrl.set(u, p)
  }
  // tsx/esbuild wraps named functions in __name(); define it in the page so the in-page passes can run there.
  await page.addInitScript({ content: 'window.__name = (f) => f;' })
  const results: AdResult[] = []
  const total = batch.ads.reduce((n, a) => n + (a.sizes ?? SIZE_ORDER).length, 0) || 1
  let done = 0
  for (const spec of batch.ads) {
    if (input.signal.aborted) throw input.signal.reason
    const sizes = spec.sizes ?? SIZE_ORDER
    const used = [...new Set(imagesOf(spec).map((i) => i.src))]
    const r: AdResult = { id: spec.id, pattern: spec.pattern, template: spec.template, title: spec.title, files: {}, findings: {}, photo: [], flags: spec.flags ?? [], notes: spec.notes, people: used.every((s) => input.people.has(s)) }
    for (const src of used) r.photo.push(...(await checkPhoto(images.get(src)!)).map((f) => ({ ...f, message: `${input.names?.get(src) ?? src}: ${f.message}` })))
    for (const size of sizes) {
      const { w, h } = SIZES[size], dir = join(out, spec.id), html = join(dir, `${size}.html`), png = join(dir, `${spec.id}-${size}-${w}x${h}.png`), bg = join(cache, `bg-${spec.id}-${size}.png`)
      await mkdir(dir, { recursive: true })
      await page.setViewportSize({ width: w, height: h })
      const band: [number, number] = size === 'story' ? [0.2, 0.78] : [0.025, 0.975], sized = forSize(spec, size), notes: Finding[] = []
      const load = async (variant: AdSpec) => {
        await writeFile(html, renderAd(kit, variant, size, url))
        await page.goto(pageUrl(input.root, html), { waitUntil: 'load' })
        await page.evaluate(() => document.fonts.ready)
        await page.waitForTimeout(60)
        return (await page.evaluate(solveFaces, { zones, band })) as { overlaps: Overlap[]; reframed: number }
      }
      const withLayout = (layout: NonNullable<AdSpec['layout']>): AdSpec => ({ ...spec, bySize: { ...spec.bySize, [size]: { ...(spec.bySize?.[size] ?? {}), layout } } })
      // 1. Faces: re-frame photos and move panels so nothing covers a face.
      let faces = await load(spec)
      // 2. Still covering someone? A statement tries its other layouts first.
      if (faces.overlaps.length && sized.template === 'statement') {
        const asked = sized.layout ?? 'center'
        let found = false
        for (const layout of (['lower', 'center', 'corner'] as const).filter((l) => l !== asked)) {
          const f = await load(withLayout(layout))
          if (!f.overlaps.length) {
            faces = f
            found = true
            notes.push({ level: 'info', rule: 'FACE', message: `Switched to the ${layout} layout to keep faces clear (asked: ${asked})` })
            break
          }
        }
        if (!found) faces = await load(spec)
      }
      if (faces.reframed) notes.push({ level: 'info', rule: 'FACE', message: `Re-framed or moved ${faces.reframed} element(s) to keep faces clear of the type` })
      // 3. Last resort, headline only: set it behind the person, if that hides at most 15% of its lettering.
      if (sized.depth !== false && faces.overlaps.length && faces.overlaps.every((o) => o.kind === 'headline')) {
        const clip = await page.evaluate(() => {
          const rs = Array.from(document.querySelectorAll('[data-role=headline]')).map((el) => { const g = document.createRange(); g.selectNodeContents(el); return g.getBoundingClientRect() })
          const x = Math.max(0, Math.min(...rs.map((q) => q.left))), y = Math.max(0, Math.min(...rs.map((q) => q.top)))
          return { x, y, width: Math.min(innerWidth, Math.max(...rs.map((q) => q.right))) - x, height: Math.min(innerHeight, Math.max(...rs.map((q) => q.bottom))) - y }
        })
        const shot = async (name: string, bgOnly: boolean) => {
          const f = join(cache, `depth-${name}.png`)
          if (bgOnly) await page.evaluate(() => document.documentElement.classList.add('bg-only'))
          await page.screenshot({ path: f, clip })
          await page.evaluate(() => document.documentElement.classList.remove('bg-only'))
          return f
        }
        const before = await differingPixels(await shot('a', false), await shot('a-bg', true))
        let layered = false
        for (const idx of new Set(faces.overlaps.map((o) => o.photo))) {
          const img = await page.evaluate((i) => document.querySelectorAll('[data-photo]')[i]!.getAttribute('data-img'), idx), p = img ? peopleByUrl.get(img) : undefined
          if (p?.mattePath) {
            await page.evaluate(personLayer, { idx, matte: `data:image/png;base64,${(await readFile(p.mattePath)).toString('base64')}` })
            layered = true
          }
        }
        if (layered) {
          const after = await differingPixels(await shot('b', false), await shot('b-bg', true)), hidden = before ? 1 - after / before : 1
          if (hidden <= 0.15) {
            notes.push({ level: 'info', rule: 'FACE', message: `Headline set behind the person (depth layer, ${Math.round(hidden * 100)}% of its lettering hidden)` })
            faces = { ...faces, overlaps: [] }
          } else {
            await page.evaluate(() => document.querySelectorAll('[data-person]').forEach((e) => e.remove()))
            notes.push({ level: 'info', rule: 'FACE', message: `Depth layer rejected: it would hide ${Math.round(hidden * 100)}% of the headline` })
          }
        }
      }
      for (const o of faces.overlaps) notes.push({ level: 'error', rule: 'FACE-1', message: `${o.kind === 'panel' ? 'A panel' : `"${o.text}"`} covers ${Math.round(o.zoneFrac * 100)}% of a face; change the photo, its crop or the copy` })
      // 4. Legibility: deepen shades or glass, step by step, until the type reads.
      let measured: Measured[] = []
      for (let step = 0; ; step++) {
        await page.screenshot({ path: png })
        measured = (await page.evaluate(measure)) as Measured[]
        await page.evaluate(() => document.documentElement.classList.add('bg-only'))
        await page.screenshot({ path: bg })
        await page.evaluate(() => document.documentElement.classList.remove('bg-only'))
        const weak = await legibility(kit, measured, bg)
        if (!weak.length || step >= 4) {
          if (step) notes.push({ level: 'info', rule: 'COLOR-2', message: `Shade deepened ${step}× for legibility${weak.length ? `; still weak: ${weak.map((x) => `"${x.text.slice(0, 24)}" ${x.worst.toFixed(1)}:1`).join(', ')}` : ''}` })
          break
        }
        await page.evaluate(boost, step + 1)
      }
      r.files[size] = png
      r.findings[size] = [...notes, ...(await checkAd(kit, spec, size, w, h, measured, bg, png))]
      const n = r.findings[size]!.filter((f) => f.level === 'error').length
      log(`${spec.id} ${size}: ${n ? `${n} brand-check error(s)` : 'ok'}`)
      input.progress(++done / total)
    }
    results.push(r)
  }
  const reportJson = join(out, 'report.json'), reportMd = join(out, 'report.md'), contactSheetFile = join(out, 'contact-sheet.jpg')
  await writeFile(reportJson, JSON.stringify({ batch: batch.id, title: batch.title, kit: kit.name, fonts: { serif: kit.fonts.serif, sans: kit.fonts.sans }, results: results.map((x) => ({ ...x, files: Object.fromEntries(Object.entries(x.files).map(([k, f]) => [k, f!.split('/').pop()])) })) }, null, 2))
  await writeFile(reportMd, reportText(batch, kit, results))
  await contactSheet(results, contactSheetFile, page, cache, input.root)
  return { results, reportJson, reportMd, contactSheet: contactSheetFile }
}

/** The readable report: per ad, its sizes, errors first, then warnings, flags and what the renderer adjusted. */
export function reportText(batch: Pick<StaticBatch, 'id' | 'title'>, kit: Pick<AdsKit, 'fonts'>, results: AdResult[]): string {
  const roles = [kit.fonts.serif, kit.fonts.sans]
  const standIn = roles.filter((f) => typeof f.standIn === 'string' && !f.faces.some((x) => x.file.startsWith('brand-kits/'))).map((f) => `${f.brand ?? f.family} → ${f.standIn}`)
    .concat(roles.flatMap((f) => (f.missing ?? []).map((m) => `${m} not supplied, nearest cut used`)))
  const rows = results.map((r) => {
    const all = Object.values(r.findings).flat() as Finding[], errors = all.filter((f) => f.level === 'error'), warns = [...all.filter((f) => f.level === 'warn'), ...r.photo], infos = all.filter((f) => f.level === 'info')
    const uniq = (fs: Finding[]) => [...new Set(fs.map((f) => `${f.rule}: ${f.message}`))]
    return `### ${r.id} · ${r.pattern} · ${r.title ?? r.template}\n${r.notes ? `${r.notes}\n` : ''}` +
      `- Sizes: ${Object.keys(r.files).join(', ')}\n- Brand check: ${errors.length ? `**${errors.length} error(s)**` : 'passes'}${warns.length ? `, ${uniq(warns).length} warning(s)` : ''}\n` +
      (r.people ? '' : '- Faces: no people data for its photos, so the face-avoid and text-behind-the-head passes were skipped\n') +
      uniq(errors).map((s) => `  - ✗ ${s}`).join('\n') + (errors.length ? '\n' : '') + uniq(warns).map((s) => `  - △ ${s}`).join('\n') + (warns.length ? '\n' : '') +
      (r.flags.length ? r.flags.map((f) => `  - ⚑ ${f}`).join('\n') + '\n' : '') + uniq(infos).map((x) => `  - · ${x}`).join('\n') + (infos.length ? '\n' : '')
  })
  return `# ${batch.title ?? `Batch ${batch.id}`}\n\n${results.length} ads × their sizes. ✗ breaks a brand rule · △ needs a person's judgement · ⚑ needs your confirmation before running · · what the renderer adjusted.\n` +
    (standIn.length ? `\nFonts: ${standIn.join('; ')}.\n` : '') + `\n${rows.join('\n')}`
}

/** Every ad on one sheet: a row per ad, its sizes side by side at 560 px tall, labelled. */
async function contactSheet(results: AdResult[], file: string, page: Page, cache: string, root: string): Promise<void> {
  const label = (r: AdResult) => {
    const errors = (Object.values(r.findings).flat() as Finding[]).filter((f) => f.level === 'error').length
    return `${r.id}  ·  ${r.pattern}  ·  ${r.title ?? r.template}${errors ? `  ·  ${errors} check error(s)` : ''}`
  }
  const filesOf = (r: AdResult) => SIZE_ORDER.map((s) => r.files[s]).filter(Boolean) as string[]
  const m = magick()
  if (m) {
    const rows: string[] = []
    for (const r of results) {
      const row = join(cache, `sheet-${r.id}.png`)
      await run(m, [...filesOf(r).flatMap((f) => ['(', f, '-resize', 'x560', ')']), '-background', '#F0EAE4', '-splice', '24x0', '+append',
        '-gravity', 'northwest', '-splice', '0x64', '-font', 'Helvetica', '-pointsize', '26', '-fill', '#413D3B', '-annotate', '+24+18', label(r), row], { timeout: 120_000 })
      rows.push(row)
    }
    await run(m, [...rows, '-background', '#F0EAE4', '-gravity', 'northwest', '-append', '-resize', '2400x>', '-quality', '88', file], { timeout: 120_000 })
    await Promise.all(rows.map((r) => rm(r, { force: true })))
    return
  }
  // Without ImageMagick: the same sheet laid out in the page and screenshotted.
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0}body{background:#F0EAE4;display:inline-block}
    .row{display:block;white-space:nowrap}.row h3{font:26px Helvetica,Arial,sans-serif;color:#413D3B;height:64px;line-height:64px;padding-left:24px;font-weight:400}
    .row img{height:560px;margin-left:24px;vertical-align:top}</style></head><body>${results.map((r) => `<div class="row"><h3>${escHtml(label(r))}</h3>${filesOf(r).map((f) => `<img src="${attr(pageUrl(root, f))}">`).join('')}</div>`).join('')}</body></html>`
  const sheet = join(cache, 'contact-sheet.html')
  await writeFile(sheet, html)
  await page.setViewportSize({ width: 800, height: 600 })
  await page.goto(pageUrl(root, sheet), { waitUntil: 'load' })
  const size = await page.evaluate(() => ({ w: Math.ceil(document.body.getBoundingClientRect().width), h: Math.ceil(document.body.getBoundingClientRect().height) }))
  await page.setViewportSize({ width: Math.max(1, size.w), height: Math.max(1, size.h) })
  const big = join(cache, 'contact-sheet-full.png')
  await page.screenshot({ path: big, fullPage: true })
  await run('ffmpeg', ['-v', 'error', '-y', '-i', big, '-vf', "scale='min(2400,iw)':-2", '-q:v', '3', file], { timeout: 120_000 })
}
