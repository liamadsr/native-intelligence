/**
 * Motion ads (9:16 Reels and Stories) from a short brief, step by step:
 *
 *   1. Background: each segment (a clip or a photo from the library) graded
 *      into the palette with a gradient map and rendered full length on the
 *      piece's clock, then joined by cuts, fades or "light" transitions (the
 *      outgoing picture opens into the next through its own highlights), with grain.
 *   2. Type: the template's transparent HTML, its CSS animations seeked frame
 *      by frame in Chromium; what the page drew on every frame is read for the
 *      brand check (the service named early and last, the safe band, clipped
 *      lettering, type size, cadence, copy rules).
 *   3. Sound: music and effects from the kit's sound library, each exactly as
 *      long as the piece (use, then crossfaded loops), set to its loudness,
 *      eased in and out; tonal layers must share a key.
 *   4. Composite, then check the sound against the picture (length, dropouts,
 *      loudness, peak).
 *   5. The 4:5 feed crop (centred on the safe band), a strip of stills, a report.
 *   6. The same piece as editable parts: the background without type, each
 *      sound alone, veils and logos as images, every word as a text layer. The
 *      knock-out pull-out, which the editor can't draw as layers yet, is drawn
 *      into that background instead (`baked`).
 *
 * Every value of the kit or the brief that reaches a page or a filter graph is
 * checked again here (veils, grade names, a sound's filters, the length), the
 * pages are fenced to the job's folder (fence.ts), and the copy rules run with
 * a time limit (patterns.ts).
 */
import { existsSync } from 'node:fs'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Browser } from 'playwright-core'
import type { Finding, MotionBrief, MotionRules, SoundRef } from '../../../web/src/lib/studio/server/ads-contract.ts'
import { GRADE_NAME, parseAudioFilters } from '../engine.ts'
import { minimalEnv } from '../child.ts'
import { needSpace } from '../disk.ts'
import { findBinary, run } from '../media.ts'
import { attr } from './escape.ts'
import { fencedPage, pageUrl } from './fence.ts'
import type { AdsKit } from './kit.ts'
import { copyRuleFindings } from './patterns.ts'
import { MOTION_TEMPLATES, type Editable } from './motion-templates.ts'
import { appendSideBySide, colorizeLogo, gradientFiles, imageSize, prepareStill } from './raster.ts'

const W = 1080, H = 1920

/** Gradient maps into a palette, dark → mid → light (a kit adds or replaces them). */
export const GRADES: Record<string, [string, string, string]> = { forest: ['#121C15', '#3E5846', '#CFE3D5'], sand: ['#5E5650', '#CFC4B9', '#F7F3EF'], mint: ['#1B2A1F', '#6E907A', '#E4EFE7'] }

// ---- Pure helpers ----------------------------------------------------------------------------------------------

/** How many times the loop section repeats so `use` plus the loops (each overlapping by xfade) covers `secs`. */
export function loopCount(secs: number, use: [number, number], loop: [number, number] | null | undefined, xfade: number) {
  return loop ? Math.max(0, Math.ceil((secs - (use[1] - use[0])) / (loop[1] - loop[0] - xfade))) : 0
}

/** The "light" transition mask (0..255, per pixel, over time T): the outgoing picture's luma, stretched from its own
 *  [lo, hi], opens brightest-first as the threshold falls from 1 to -softness across [at, at + d]. */
export function lightMask(at: number, d: number, lo: number, hi: number, softness = 0.4) {
  const s = `clip((lum(X,Y)-${lo})/${Math.max(1, hi - lo)},0,1)`, p = `clip((T-${at})/${d},0,1)`
  return `clip((${s}-(1-${p}*${1 + softness}))/${softness},0,1)*255`
}

/** zoompan zoom expression for hard punch-ins: frame index `on` counted from the segment's start. */
export function punchZoom(cuts: [number, number][] | undefined, start: number, fps: number) {
  return (cuts ?? []).slice().sort((a, b) => a[0] - b[0]).reduceRight((acc, [t, z]) => `if(gte(on,${Math.round((t - start) * fps)}),${z},${acc})`, '1')
}

/** The 4:5 feed crop: centred on the 9:16 safe band, so everything the safe-band check passed is in frame. */
export function crop45(safe: MotionRules['safe']) {
  const h = Math.round((W * 5) / 4), mid = (safe.top + safe.bottom) / 2
  return { w: W, h, y: Math.max(0, Math.min(H - h, Math.round(mid - h / 2))) }
}

export function copyFindings(text: string, rules: MotionRules): Finding[] {
  return copyRuleFindings(rules.banned, text)
}

/** The longest motion ad and its highest frame rate (the contract's limits, held here too). */
export const MOTION_MAX_SECONDS = 60
export const MAX_FPS = 60

/** A kit sound's `af` as FFmpeg filters, only when every one is a pure filter with plain arguments (else throws). Pure. */
export function soundFilters(af: string | undefined, name: string): string {
  if (!af) return ''
  const parsed = parseAudioFilters(af)
  if (!parsed) throw new Error(`The sound "${name}" has an audio filter (af) the worker does not run: only plain ${['volume', 'highpass', 'lowpass', 'equalizer', 'afade', '…'].join(', ')} filters`)
  return parsed.map((f) => (f.args ? `${f.name}=${f.args}` : f.name)).join(',')
}

export type Seen = { t: number; els: { role: string; text: string; x: number; y: number; w: number; h: number; size: number; opacity: number; clipped: boolean; zoom: boolean }[] }

/** The checks that read the type layer frame by frame. */
export function typeFindings(seen: Seen[], checkpoints: number[], events: number[], secs: number, rules: MotionRules): Finding[] {
  const out: Finding[] = [], { safe } = rules, last = seen[seen.length - 1]!
  const dt = seen.length > 1 ? seen[1]!.t - seen[0]!.t : 0
  const inFrame = (e: Seen['els'][number]) => e.x >= 0 && e.y >= 0 && e.x + e.w <= W && e.y + e.h <= H
  const serviceUp = (s: Seen) => s.els.some((e) => e.role === 'service' && e.opacity >= 0.9 && e.size >= rules.service.minPx && inFrame(e))
  // The service: named in the first second, on the last frame, and on screen long enough to read.
  const shown = seen.filter(serviceUp)
  if (!seen.some((s) => s.t <= rules.service.by && serviceUp(s))) out.push({ level: 'error', rule: 'MOTION-1', message: `the service isn't named (≥${rules.service.minPx}px, fully visible) within the first ${rules.service.by}s` })
  if (!serviceUp(last)) out.push({ level: 'error', rule: 'MOTION-1', message: 'the service isn\'t named on the last frame' })
  if (shown.length * dt < rules.service.minSeconds) out.push({ level: 'error', rule: 'MOTION-1', message: `the service is on screen ${(shown.length * dt).toFixed(1)}s (needs ${rules.service.minSeconds}s)` })
  // Lettering is never cut by a mask (reveals "look cut off"), and nothing is too small to read on a phone.
  const flagged = new Set<string>()
  for (const s of seen) for (const e of s.els) {
    if (e.opacity > 0.05 && e.clipped && !e.zoom && !flagged.has(`c${e.text}`)) {
      flagged.add(`c${e.text}`)
      out.push({ level: 'error', rule: 'MOTION-2', message: `"${e.text.slice(0, 40)}" is clipped by a mask at ${s.t.toFixed(2)}s` })
    }
    if (e.opacity > 0.5 && e.role !== 'logo' && e.size < rules.minPx && !flagged.has(`s${e.text}`)) {
      flagged.add(`s${e.text}`)
      out.push({ level: 'error', rule: 'MOTION-3', message: `"${e.text.slice(0, 40)}" is ${e.size}px (min ${rules.minPx}px)` })
    }
  }
  // Settled type sits inside the safe band (clear of the platform's UI), checked at the template's checkpoints.
  for (const t of [...checkpoints, last.t]) {
    const s = seen.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a))
    // (type that zooms through the frame on purpose is only checked once it has landed, on the last frame)
    for (const e of s.els) if (e.opacity > 0.5 && (!e.zoom || s === last) && (e.y < safe.top || e.y + e.h > safe.bottom || e.x < safe.side || e.x + e.w > W - safe.side) && !flagged.has(`b${e.text}`)) {
      flagged.add(`b${e.text}`)
      out.push({ level: 'error', rule: 'MOTION-4', message: `"${e.text.slice(0, 40) || e.role}" leaves the safe band at ${s.t.toFixed(2)}s (box ${Math.round(e.x)},${Math.round(e.y)} ${Math.round(e.w)}×${Math.round(e.h)})` })
    }
  }
  // Something changes about every 1.7 s until the end card ("stylistically very slow" otherwise).
  const ev = [...new Set(events.map((e) => +e.toFixed(2)))].sort((a, b) => a - b)
  const hold = Math.max(...ev.slice(1).map((e, i) => e - ev[i]!))
  if (hold > rules.maxHold) out.push({ level: 'warn', rule: 'MOTION-5', message: `${hold.toFixed(1)}s pass with nothing new before the end card (max ${rules.maxHold}s)` })
  out.push(...copyFindings(seen.flatMap((s) => s.els.map((e) => e.text)).filter((x, i, a) => a.indexOf(x) === i).join(' \n '), rules))
  return out
}

// ---- Render --------------------------------------------------------------------------------------------------

export type MotionMedia = { path: string; kind: 'video' | 'image' }
export type LocalPart = Editable | (Extract<Editable, { kind: 'logo' }> & { file: string; height: number; hex: string }) | (Extract<Editable, { kind: 'veil' }> & { file: string })
export type LocalParts = {
  background: string
  audio: { name: string; role: 'music' | 'sfx'; file: string }[]
  layers: (Record<string, unknown> & { kind: string; name: string })[]
  baked: string[]
}
export type MotionInput = {
  kit: AdsKit
  brief: MotionBrief
  /** Each background source, staged. */
  media: Map<string, MotionMedia>
  /** Each sound the brief names, staged. */
  sounds: Map<string, string>
  /** The families the editor's text layers use. */
  editorFamilies: { serif: string; sans: string }
  /** The job's folder: the pages may read nothing outside it (work and out are in it). */
  root: string
  work: string
  out: string
  browser: Browser
  log: (line: string) => void
  progress: (fraction: number) => void
  signal: AbortSignal
}
export type MotionOutput = { files: { '9x16': string; '4x5'?: string }; strip: string; findings: Finding[]; errors: number; report: string; parts: LocalParts; notes: string[] }

const probe = async (file: string, what = 'format=duration', signal?: AbortSignal) =>
  parseFloat((await run('ffprobe', ['-v', 'error', '-show_entries', what, '-of', 'csv=p=0', file], { signal })).stdout.trim().split('\n')[0]!)
const loudness = (stderr: string) => {
  const I = parseFloat(stderr.match(/I:\s+(-?[\d.]+) LUFS/g)!.pop()!.split(/\s+/)[1]!), pk = parseFloat(stderr.match(/Peak:\s+(-?[\d.]+) dBFS/g)!.pop()!.split(/\s+/)[1]!)
  return { I, pk }
}

/** Python with fontTools, for drawing a word from its outlines (null when this machine has neither). */
export async function outlinePython(): Promise<string | null> {
  const py = findBinary('python3')
  if (!py) return null
  try {
    await run(py, ['-I', '-c', 'import fontTools'], { timeout: 20_000, env: minimalEnv() })
    return py
  } catch {
    return null
  }
}

export async function renderMotion(input: MotionInput): Promise<MotionOutput> {
  const { kit, brief, work, out, log, signal } = input
  const rules = kit.kit.motion.rules
  const template = MOTION_TEMPLATES[brief.template]
  if (!template) throw new Error(`unknown template "${brief.template}" (have: ${Object.keys(MOTION_TEMPLATES).join(', ')})`)
  const secs = brief.seconds, fps = brief.fps ?? 24, frames = Math.round(secs * fps)
  if (!(secs > 0 && secs <= MOTION_MAX_SECONDS) || !(Number.isInteger(fps) && fps >= 1 && fps <= MAX_FPS)) throw new Error(`A motion ad runs at most ${MOTION_MAX_SECONDS} s at up to ${MAX_FPS} fps`)
  const grades: Record<string, [string, string, string]> = Object.assign(Object.create(null), GRADES, kit.kit.motion.grades ?? {})
  await rm(work, { recursive: true, force: true })
  await mkdir(join(work, 'frames'), { recursive: true })
  await mkdir(out, { recursive: true })
  await needSpace(work)
  const findings: Finding[] = [], notes: string[] = []
  const at = (src: string) => {
    const m = input.media.get(src)
    if (!m) throw new Error(`missing background "${src}"`)
    return m.path
  }
  const step = (from: number, to: number) => (f: number) => input.progress(from + (to - from) * Math.max(0, Math.min(1, f)))

  // 1. Background: each segment rendered full length on the piece's clock, then joined by its transition.
  const grads: Record<string, { grad: string; hald: string }> = {}
  const gradeFiles = async (g: string) => {
    // A grade's name becomes a file name: it is the contract's grammar or nothing.
    if (!GRADE_NAME.test(g)) throw new Error(`"${g.slice(0, 40)}" is not a grade name (lower-case letters, numbers, - and _)`)
    if (grads[g]) return grads[g]!
    const stops = grades[g]
    if (!Array.isArray(stops) || stops.length !== 3 || !stops.every((h) => /^#[\da-fA-F]{6}$/.test(h))) throw new Error(`unknown grade "${g}" (have: ${Object.keys(grades).join(', ')})`)
    const grad = join(work, `grad-${g}.png`), hald = join(work, `hald-${g}.png`)
    await gradientFiles(stops, grad, hald, signal)
    return (grads[g] = { grad, hald })
  }
  const segs: string[] = []
  const bgStep = step(0, 0.35)
  for (const [i, seg] of brief.background.entries()) {
    const file = join(work, `seg${i}.mp4`), start = seg.in?.at ?? 0, span = secs - start, enc = ['-an', '-c:v', 'libx264', '-crf', '12', '-preset', 'medium', '-pix_fmt', 'yuv420p', file]
    const hold = `tpad=start_duration=${start}:start_mode=clone,tpad=stop_mode=clone:stop_duration=${secs},trim=duration=${secs},setpts=PTS-STARTPTS,format=yuv420p`
    const g = seg.grade ? await gradeFiles(seg.grade) : null, strength = seg.strength ?? 1
    if (seg.clip) {
      const src = at(seg.clip), d = (await probe(src, undefined, signal)) - (seg.seek ?? 0)
      const speed = seg.speed ?? Math.max(1, Math.min(1.8, span / d))
      const slow = speed > 1.01 ? `setpts=${speed.toFixed(3)}*PTS,minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:vsbmc=1,` : `fps=${fps},`
      const cuts = seg.cuts?.length ? `,zoompan=z='${punchZoom(seg.cuts, start, fps)}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${fps}` : ''
      const levels = seg.levels ? `,lutyuv=y='clip((val-${seg.levels[0]})*255/${seg.levels[1] - seg.levels[0]},0,255)':u=128:v=128` : ''
      const grade = !g ? '' : strength >= 1 ? ',format=rgb24[pre];[pre][1:v]haldclut' : `,format=rgb24,split[o][pre];[pre][1:v]haldclut[gr];[gr][o]blend=all_mode=normal:all_opacity=${strength}`
      if (speed > 1.01) log(`background ${i}: slowing the clip ${speed.toFixed(2)}× (motion-interpolated)`)
      await run('ffmpeg', ['-v', 'error', '-y', ...(seg.seek ? ['-ss', String(seg.seek)] : []), '-i', src, ...(g ? ['-i', g.hald] : []), '-filter_complex',
        `[0:v]${slow}scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}${cuts}${levels}${grade}${seg.saturation != null ? `,eq=saturation=${seg.saturation}` : ''},${hold}`,
        ...enc], { timeout: 1_800_000, signal })
    } else if (seg.still) {
      // Photos: graded at double size once (the gradient map blended over the photo at `strength`, less colour if
      // asked, an S-curve), then pushed with zoompan from the double-size frame so the move stays sharp.
      const src = at(seg.still), prep = join(work, `still${i}.png`), [fx, fy] = seg.focus ?? [0.5, 0.5]
      const { width: iw, height: ih } = await imageSize(src, signal)
      const k = Math.max((2 * W) / iw, (2 * H) / ih), sw = Math.ceil(iw * k), sh = Math.ceil(ih * k)
      const ox = Math.round(Math.max(0, Math.min(sw - 2 * W, fx * sw - W))), oy = Math.round(Math.max(0, Math.min(sh - 2 * H, fy * sh - H)))
      await prepareStill(src, prep, { sw, sh, cw: 2 * W, ch: 2 * H, ox, oy, grad: g?.grad, hald: g?.hald, strength, saturation: seg.saturation ?? 1, contrast: seg.contrast ?? 2 }, signal)
      const n = Math.round(span * fps), [p0, p1] = seg.push ?? [1, 1]
      const z = `(${p0}+(${p1 - p0})*on/${n})*${punchZoom(seg.cuts, start, fps)}`
      await run('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-framerate', String(fps), '-t', String(span), '-i', prep, '-vf',
        `zoompan=z='${z}':x='max(0,min(iw-iw/zoom,${fx}*iw-iw/zoom/2))':y='max(0,min(ih-ih/zoom,${fy}*ih-ih/zoom/2))':d=1:s=${W}x${H}:fps=${fps},${hold}`,
        ...enc], { timeout: 900_000, signal })
    } else throw new Error(`background ${i}: needs a clip or a still`)
    segs.push(file)
    bgStep((i + 1) / (brief.background.length + 1))
  }
  const base = join(work, 'base.mp4')
  {
    let graph = '[0:v]format=yuv444p[a0]'
    for (let i = 1; i < segs.length; i++) {
      const t = brief.background[i]!.in ?? { kind: 'cut' as const, at: 0 }, d = t.duration ?? 0.8
      graph += `;[${i}:v]format=yuv444p[b${i}]`
      if (t.kind === 'cut') graph += `;[a${i - 1}][b${i}]overlay=format=yuv444:enable='gte(t,${t.at})'[a${i}]`
      else if (t.kind === 'fade') graph += `;[a${i - 1}][b${i}]blend=all_expr='A+(B-A)*clip((T-${t.at})/${d},0,1)'[a${i}]`
      else {
        // Stretch the mask to the outgoing picture's own luma range over the transition (10th to 90th percentile).
        const { stdout } = await run('ffmpeg', ['-v', 'error', '-ss', String(t.at), '-t', String(d), '-i', segs[i - 1]!, '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-'], { signal, maxBuffer: 64 << 20 })
        const avg = (key: string) => { const v = [...stdout.matchAll(new RegExp(`${key}=([\\d.]+)`, 'g'))].map((m) => parseFloat(m[1]!)); return v.reduce((a, b) => a + b, 0) / v.length }
        const lo = Math.round(avg('lavfi.signalstats.YLOW')), hi = Math.round(avg('lavfi.signalstats.YHIGH')), m = lightMask(t.at, d, lo, hi, t.softness)
        graph += `;[a${i - 1}]split[ax${i}][am${i}];[am${i}]geq=lum='${m}':cb='${m}':cr='${m}',gblur=sigma=4[m${i}];[ax${i}][b${i}][m${i}]maskedmerge[a${i}]`
        log(`light transition at ${t.at}s over ${d}s (outgoing luma ${lo}–${hi})`)
      }
    }
    graph += `;[a${segs.length - 1}]noise=alls=5:allf=t+u,format=yuv420p[v]`
    await run('ffmpeg', ['-v', 'error', '-y', ...segs.flatMap((s) => ['-i', s]), '-filter_complex', graph, '-map', '[v]', '-t', String(secs),
      '-an', '-c:v', 'libx264', '-crf', '14', '-preset', 'slow', '-pix_fmt', 'yuv420p', base], { timeout: 1_800_000, signal })
  }
  bgStep(1)

  // 2. Type layer, transparent, frame by frame; the brand check reads what the page drew on every frame.
  const built = template(brief.copy, { secs, fps, kit })
  const page = join(work, 'type.html')
  await writeFile(page, `<!doctype html><html><head><meta charset="utf-8"><style>${kit.css}
  html,body{background:transparent!important;width:${W}px;height:${H}px;--ratio:${kit.logo.primaryRatio}}*{animation-play-state:paused!important}
  .serif,.caps{font-kerning:normal;font-feature-settings:"kern","liga"}
  ${built.scene ? `html.scene-only body > :not(${built.scene}){visibility:hidden!important}html.no-scene ${built.scene}{visibility:hidden!important}` : ''}</style></head><body>${built.html}</body></html>`)
  const seen: Seen[] = []
  const parts = join(out, 'editor')
  await rm(parts, { recursive: true, force: true })
  await mkdir(parts, { recursive: true })
  if (built.scene) await mkdir(join(work, 'scene'), { recursive: true })
  let ready: { origin?: [number, number]; chars?: { c: string; x: number; y: number }[] } | undefined
  let wordPath = ''
  const typeStep = step(0.35, 0.75)
  const p = await fencedPage(input.browser, input.root, { viewport: { width: W, height: H }, deviceScaleFactor: 1 })
  try {
    await p.addInitScript({ content: 'window.__name = (f) => f;' })
    await p.goto(pageUrl(input.root, page))
    await p.evaluate(() => document.fonts.ready)
    ready = await p.evaluate(() => (window as any).__motionReady?.())
    if (ready) log(`template ready: zoom centre ${ready.origin?.map((v) => Math.round(v)).join(', ')}`)
    // The knocked-out word from the font's own outlines, when Python with fontTools is here: a path scales without
    // limit, where text stops being drawn at the sizes the pull-out reaches.
    if (ready?.chars?.length) {
      const py = await outlinePython(), face = kit.faces.serif[0]
      const props = (built.editable.find((e) => e.kind === 'scene') as Extract<Editable, { kind: 'scene' }> | undefined)?.props
      if (py && face && props) {
        try {
          wordPath = (await run(py, ['-I', resolve(import.meta.dirname, 'glyph-outline.py'), face.path, String(props.wordSize), JSON.stringify(ready.chars)], { maxBuffer: 8 << 20, timeout: 60_000, signal, env: minimalEnv() })).stdout.trim()
        } catch (e) {
          notes.push(`The knocked-out word could not be drawn from its outlines (${(e as Error).message.slice(0, 200)}); it is drawn as text`)
        }
      } else notes.push('No Python with fontTools here: the knocked-out word is drawn as text, which the browser may stop drawing at the deepest zoom')
      if (wordPath) {
        await p.evaluate((d) => (window as any).__useOutline(d), wordPath)
        log('knocked-out word drawn from its outlines')
      }
    }
    await p.waitForTimeout(150)
    for (let fr = 0; fr < frames; fr++) {
      if (signal.aborted) throw signal.reason
      const els = await p.evaluate((ms) => {
        for (const a of document.getAnimations()) a.currentTime = ms
        return Array.from(document.querySelectorAll('[data-role]')).map((el) => {
          const r = el.getBoundingClientRect()
          let op = 1, clipped = false
          for (let e: Element | null = el; e; e = e.parentElement) {
            const cs = getComputedStyle(e)
            op *= parseFloat(cs.opacity)
            if (cs.visibility === 'hidden' || cs.display === 'none') op = 0
            if (e !== el && e !== document.body && e !== document.documentElement && /hidden|clip/.test(cs.overflowX + cs.overflowY)) {
              const a = e.getBoundingClientRect()
              if (r.left < a.left - 1 || r.right > a.right + 1 || r.top < a.top - 1 || r.bottom > a.bottom + 1) clipped = true
            }
          }
          return { role: el.getAttribute('data-role')!, text: (el.textContent ?? '').trim().replace(/\s+/g, ' '), x: r.left, y: r.top, w: r.width, h: r.height,
            size: parseFloat(getComputedStyle(el).fontSize), opacity: op, clipped, zoom: el.hasAttribute('data-zoom') }
        })
      }, (fr / fps) * 1000)
      seen.push({ t: fr / fps, els })
      const name = `${String(fr).padStart(5, '0')}.png`
      await p.screenshot({ path: join(work, 'frames', name), omitBackground: true })
      if (built.scene) {
        // The move the editor can't draw, alone, for its background.
        await p.evaluate(() => document.documentElement.classList.add('scene-only'))
        await p.screenshot({ path: join(work, 'scene', name), omitBackground: true })
        await p.evaluate(() => document.documentElement.classList.remove('scene-only'))
      }
      typeStep((fr + 1) / frames)
    }
    // Veils for the editor: each one drawn alone, full frame, with its transparency.
    for (const [i, v] of built.editable.entries()) if (v.kind === 'veil') {
      await p.setContent(`<!doctype html><html><body style="margin:0;background:transparent"><div style="${attr(`position:fixed;inset:0;background:${v.css}`)}"></div></body></html>`)
      await p.screenshot({ path: join(parts, `veil-${i}.png`), omitBackground: true })
    }
  } finally {
    await p.close().catch(() => undefined)
  }
  const events = [...built.events, ...brief.background.flatMap((s) => [...(s.in ? [s.in.at] : []), ...(s.cuts ?? []).map((c) => c[0])])]
  findings.push(...typeFindings(seen, built.checkpoints, events, secs, rules))

  // 3. Sound: each layer exactly as long as the piece. A layer plays `use`, then repeats its steady `loop` section
  // with crossfades until the piece is covered; it is set to its loudness with one fixed gain, EQ'd by `af` so it
  // keeps out of the other layer's way, and eased in and out on an S-curve (or out early at `until`, so a sound
  // effect leaves with its picture). Tonal layers must share a key.
  const library = kit.kit.sounds
  const refs = [...(brief.sound?.music ? [brief.sound.music] : []), ...(brief.sound?.sfx ?? [])].map((r) => (typeof r === 'string' ? { name: r } : r) as Exclude<SoundRef, string>)
  const layers = refs.map((r) => {
    const s = library.sounds[r.name]
    if (!s) throw new Error(`no sound "${r.name}" in the brand kit's sound library`)
    const src = input.sounds.get(r.name)
    if (!src) throw new Error(`the sound "${r.name}" was not staged`)
    return { ...s, ...r, src, af: soundFilters(s.af, r.name) }
  })
  const keys = new Set(layers.filter((l) => l.pitched !== false).map((l) => l.key ?? '?'))
  if (keys.size > 1) findings.push({ level: 'error', rule: 'SOUND-2', message: `tonal layers in different keys: ${[...keys].join(' / ')}` })
  const { mix } = library
  const audioIn: string[] = []
  let audioF = '', next = 2
  const labels: string[] = []
  const stems: { name: string; role: 'music' | 'sfx'; inputs: string[]; graph: string; label: string }[] = []
  for (const [k, a] of layers.entries()) {
    const ad = await probe(a.src, 'stream=duration', signal)
    const use = (a.use ?? [0, Math.min(ad, secs)]) as [number, number], x = a.xfade ?? 0.5, n = loopCount(secs, use, a.loop, x)
    const music = a.kind === 'music', lufs = a.lufs ?? (music ? mix.musicLufs : mix.musicLufs - mix.sfxUnder)
    const fi = a.fadeIn ?? (music ? mix.musicFadeIn : mix.sfxFadeIn), fo = a.fadeOut ?? mix.fadeOut
    const { stderr: m } = await run('ffmpeg', ['-v', 'info', '-ss', String(use[0]), '-t', String(use[1] - use[0]), '-i', a.src, '-af', `${a.af ? `${a.af},` : ''}ebur128=peak=true`, '-f', 'null', '-'], { signal, maxBuffer: 64 << 20 })
    const { I, pk } = loudness(m)
    const db = Math.min(lufs - I, -1 - pk), gain = Math.pow(10, db / 20)
    log(`sound ${a.name}: ${I} LUFS, peak ${pk} dBFS -> ${db >= 0 ? '+' : ''}${db.toFixed(1)} dB (${lufs} LUFS)${n ? `, ${n} loop(s)` : ''}`)
    // Each section is its own input: splitting one input and trimming the branches drops audio in ffmpeg 7.1.
    const inputs = ['-ss', String(use[0]), '-t', String(use[1] - use[0]), '-i', a.src]
    for (let i = 0; i < n; i++) inputs.push('-ss', String(a.loop![0]), '-t', String(a.loop![1] - a.loop![0]), '-i', a.src)
    const outAt = Math.min(secs - fo, a.until ?? Infinity)
    const chain = (first: number) => Array.from({ length: n }, (_, i) => `;[${i === 0 ? `${first}:a` : `x${k}_${i}`}][${first + 1 + i}:a]acrossfade=d=${x}:c1=qsin:c2=qsin[x${k}_${i + 1}]`).join('') +
      `;[${n ? `x${k}_${n}` : `${first}:a`}]aresample=48000,aformat=channel_layouts=stereo,${a.af ? `${a.af},` : ''}atrim=0:${secs},apad=whole_dur=${secs},volume=${gain.toFixed(4)}` +
      `${fi > 0 ? `,afade=t=in:d=${fi}:curve=hsin` : ''},afade=t=out:st=${outAt.toFixed(3)}:d=${fo}:curve=hsin[L${k}]`
    audioIn.push(...inputs)
    audioF += chain(next)
    next += 1 + n
    stems.push({ name: a.name, role: music ? 'music' : 'sfx', inputs, graph: chain(0).slice(1), label: `[L${k}]` })
    labels.push(`[L${k}]`)
  }
  const audioMap = labels.length ? ['-map', '[aout]', '-c:a', 'aac', '-b:a', '192k'] : ['-an']
  if (labels.length) audioF += `;${labels.join('')}${labels.length > 1 ? `amix=inputs=${labels.length}:normalize=0:duration=longest,` : ''}alimiter=limit=0.891:level=0:latency=1,atrim=0:${secs},apad=whole_dur=${secs}[aout]`
  else findings.push({ level: 'error', rule: 'SOUND-1', message: 'no sound: every piece has music and sound effects' })

  // 4. Composite, then check the picture and the sound end together and the sound plays (and sits at the target) throughout.
  const file = join(out, `${brief.id}.mp4`)
  await run('ffmpeg', ['-v', 'error', '-y', '-i', base, '-framerate', String(fps), '-i', join(work, 'frames', '%05d.png'), ...audioIn,
    '-filter_complex', `[0:v][1:v]overlay=0:0:format=auto,format=yuv420p[v]${audioF}`, '-map', '[v]', ...audioMap, '-t', String(secs),
    '-c:v', 'libx264', '-crf', '16', '-preset', 'slow', '-movflags', '+faststart', file], { timeout: 900_000, signal })
  input.progress(0.85)
  if (labels.length) {
    const dur = (s: string) => run('ffprobe', ['-v', 'error', '-select_streams', s, '-show_entries', 'stream=duration', '-of', 'csv=p=0', file], { signal }).then((r) => parseFloat(r.stdout))
    const v = await dur('v:0'), a = await dur('a:0')
    if (Math.abs(a - v) > 0.05) findings.push({ level: 'error', rule: 'SOUND-1', message: `sound ${a.toFixed(2)}s and picture ${v.toFixed(2)}s end apart` })
    const { stdout: so } = await run('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-af', 'asetnsamples=n=24000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-', '-f', 'null', '-'], { signal, maxBuffer: 64 << 20 })
    const rms = so.split('\n').filter((l) => l.includes('RMS_level')).map((l) => parseFloat(l.split('=')[1]!))
    const quiet = rms.findIndex((x, i) => i < rms.length - 1 && !(x > -70))
    if (quiet >= 0) findings.push({ level: 'error', rule: 'SOUND-1', message: `the sound drops out at ${quiet * 0.5}s` })
    const { stderr: m } = await run('ffmpeg', ['-v', 'info', '-i', file, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'], { signal, maxBuffer: 64 << 20 })
    const { I, pk } = loudness(m)
    const L = rules.loudness
    if (Math.abs(I - L.lufs) > L.tolerance) findings.push({ level: 'warn', rule: 'SOUND-3', message: `loudness ${I} LUFS (target ${L.lufs} ±${L.tolerance})` })
    if (pk > L.peak) findings.push({ level: 'error', rule: 'SOUND-3', message: `peak ${pk} dBFS (max ${L.peak})` })
    findings.push({ level: 'info', rule: 'SOUND', message: `${I} LUFS, peak ${pk} dBFS; per 0.5 s (dB): ${rms.map((x) => x.toFixed(0)).join(' ')}` })
  }

  // 5. Formats, contact strip, report.
  const files: MotionOutput['files'] = { '9x16': file }
  if ((brief.formats ?? ['9x16', '4x5']).includes('4x5')) {
    const c = crop45(rules.safe)
    files['4x5'] = join(out, `${brief.id}-4x5.mp4`)
    await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf', `crop=${c.w}:${c.h}:0:${c.y}`, '-c:v', 'libx264', '-crf', '16', '-preset', 'slow', '-c:a', 'copy', '-movflags', '+faststart', files['4x5']], { timeout: 900_000, signal })
  }
  const strip = join(out, `${brief.id}-strip.jpg`), stills: string[] = []
  for (const [i, t] of [0.4, ...built.checkpoints, secs - 0.05].entries()) {
    const s = join(work, `s${i}.jpg`)
    await run('ffmpeg', ['-v', 'error', '-y', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=360:-2', s], { signal })
    stills.push(s)
  }
  await appendSideBySide(stills, strip, signal)
  input.progress(0.9)

  // 6. The same piece as parts the editor opens as a video: the background without type (with any move it can't
  // draw as layers drawn into it), each sound as its own track (they sum to the mix; the limiter never engages
  // below -1 dBFS), the veils and the logo as images, and every word as a text layer in the brand's fonts.
  const pal = (token: string) => kit.palette[token] ?? token
  const background = join(parts, 'background.mp4')
  const baked: string[] = []
  if (built.scene) {
    await run('ffmpeg', ['-v', 'error', '-y', '-i', base, '-framerate', String(fps), '-i', join(work, 'scene', '%05d.png'),
      '-filter_complex', '[0:v][1:v]overlay=0:0:format=auto,format=yuv420p[v]', '-map', '[v]', '-t', String(secs), '-an',
      '-c:v', 'libx264', '-crf', '14', '-preset', 'slow', '-movflags', '+faststart', background], { timeout: 900_000, signal })
    for (const e of built.editable) if (e.kind === 'scene') baked.push(e.name)
  } else await copyFile(base, background)
  const audio: LocalParts['audio'] = []
  for (const [k, st] of stems.entries()) {
    const stem = join(parts, `${k}-${st.role}-${st.name.replace(/[^a-zA-Z0-9_-]+/g, '-')}.m4a`)
    await run('ffmpeg', ['-v', 'error', '-y', ...st.inputs, '-filter_complex', st.graph, '-map', st.label, '-c:a', 'aac', '-b:a', '192k', '-t', String(secs), stem], { timeout: 300_000, signal })
    audio.push({ name: st.role === 'music' ? `Music · ${st.name}` : `Sound effect · ${st.name}`, role: st.role, file: stem })
  }
  const logos = new Map<string, string>()
  const logoFile = async (hex: string) => {
    if (!logos.has(hex)) {
      const f = join(parts, `logo-${hex.slice(1)}.png`)
      await colorizeLogo(kit.logo.primary, hex, f, signal)
      logos.set(hex, f)
    }
    return logos.get(hex)!
  }
  const layersOut: LocalParts['layers'] = []
  for (const [i, e] of built.editable.entries()) {
    if (e.kind === 'text') layersOut.push({ ...e, color: pal(e.color), family: input.editorFamilies[e.font] })
    else if (e.kind === 'rule') layersOut.push({ ...e, color: pal(e.color) })
    else if (e.kind === 'logo') layersOut.push({ ...e, color: pal(e.color), height: e.width / kit.logo.primaryRatio, file: await logoFile(pal(e.color)) })
    else if (e.kind === 'veil') {
      // A veil the background already carries (the pull-out's shade sits under the panel) stays a layer all the same.
      if (existsSync(join(parts, `veil-${i}.png`))) layersOut.push({ ...e, file: join(parts, `veil-${i}.png`) })
    } else if (!built.scene) {
      const pr = e.props, originFor = [pr.word, kit.fonts.serif.family, pr.wordSize, pr.wordX, pr.wordY, pr.wordTrack].join('|')
      layersOut.push({ ...e, props: { ...e.props, panel: pal(String(pr.panel)), ink: pal(String(pr.ink)), font: input.editorFamilies.serif,
        ...(ready?.origin ? { origin: ready.origin, originFor } : {}), ...(wordPath ? { wordPath, wordPathFor: originFor } : {}) } })
    }
  }
  if (baked.length) notes.push(`${baked.join(', ')}: drawn into the editable video's background (the editor can't play code scenes yet); every other word is an editable text layer`)
  const errors = findings.filter((x) => x.level === 'error').length
  const report = [`# ${brief.id}`, '', `${brief.template}, ${secs}s at ${fps} fps. ${errors ? `**${errors} error(s)**` : 'Brand check: no errors.'}`, '',
    ...findings.map((x) => `- ${x.level.toUpperCase()} ${x.rule}: ${x.message}`), ...(notes.length ? ['', ...notes.map((n) => `- NOTE: ${n}`)] : [])].join('\n')
  await writeFile(join(out, 'report.md'), report + '\n')
  await writeFile(join(out, 'brief.json'), JSON.stringify(brief, null, 2) + '\n')
  await rm(join(work, 'frames'), { recursive: true, force: true })
  await rm(join(work, 'scene'), { recursive: true, force: true })
  return { files, strip, findings, errors, report, parts: { background, audio, layers: layersOut, baked }, notes }
}
