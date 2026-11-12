/**
 * Reels (9:16 video) from a brand's own footage: real shots cut together,
 * animated type in the same calibrated styles as the static ads, and an end
 * card. The type layer is drawn by Chromium frame by frame (CSS animations,
 * seeked) as a transparent overlay and composited onto the footage with FFmpeg.
 *
 * Two of its inputs would take macOS helpers a server doesn't have, so they are
 * data the spec may carry:
 *   - faces per shot (`people[src].faces`, a few samples a second): each beat's
 *     type goes in the first band no face passes through. Without them the
 *     beat takes its first band, and the notes say so.
 *   - a person matte per shot (`people[src].matte`, a greyscale library video,
 *     white = person): a beat with `depth` sets its headline behind the people.
 *     Without one the headline stays in front, and the notes say so.
 * Silent: add music or voice in the editor. At most REEL_MAX_SECONDS long at
 * up to 60 fps, and only begun with room on the disk for its frames; the type
 * layer's page is fenced to the job's folder (fence.ts).
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser } from 'playwright-core'
import type { ReelBand, ReelBeat, ReelEnd, ReelSpec, ReelSplit } from '../../../web/src/lib/studio/server/ads-contract.ts'
import { needSpace } from '../disk.ts'
import { REEL_MAX_SECONDS, reelSeconds } from '../engine.ts'
import { run } from '../media.ts'
import { fencedPage, pageUrl } from './fence.ts'
import { html } from './escape.ts'
import type { AdsKit } from './kit.ts'
import { appendSideBySide } from './raster.ts'

const W = 1080, H = 1920
type GroundRole = 'ground' | 'groundAlt' | 'deep' | 'ink'
const INK: Record<GroundRole, { head: string; sub: string }> = { ground: { head: 'ink', sub: 'muted' }, groundAlt: { head: 'deep', sub: 'deep' }, deep: { head: 'groundAlt', sub: 'accent' }, ink: { head: 'ground', sub: 'accent' } }
/** y range of each band, as fractions of the frame (all inside the Stories safe band, y 20–78%). */
export const BAND: Record<ReelBand, [number, number]> = { upper: [0.2, 0.44], center: [0.36, 0.62], lower: [0.5, 0.76] }

const esc = html
const arr = (x?: string | string[]) => (Array.isArray(x) ? x : x ? [x] : [])

/** A ground named by role or token, as its role (the ink table) and token. */
function groundOf(kit: AdsKit, name: string | undefined, fallback: GroundRole): { role: GroundRole; tok: string } {
  const asked = name ?? fallback
  if (asked in INK) return { role: asked as GroundRole, tok: kit.tok(asked) }
  const tok = kit.tok(asked)
  const role = (Object.keys(INK) as GroundRole[]).find((r) => { try { return kit.tok(r) === tok } catch { return false } })
  if (!role) throw new Error(`"${asked}" is not one of the kit's grounds (ground, groundAlt, deep, ink)`)
  return { role, tok }
}

function beatHtml(kit: AdsKit, b: ReelBeat, band: ReelBand, i: number, split?: ReelSplit) {
  const v = (name: string) => `var(--${kit.tok(name)})`
  const dark = (a: number) => `rgba(${kit.kit.shades.dark},${a})`
  const sg = split ? groundOf(kit, split.ground, 'deep') : null
  const [y0, y1] = split ? ([split.at + 0.05, 0.72] as [number, number]) : BAND[band], t0 = b.from, t1 = b.to, out = Math.max(t0 + 0.6, t1 - 0.35)
  const head = sg ? INK[sg.role].head : 'white', sub = sg ? INK[sg.role].sub : 'white'
  const enter = (d: number, extra = '') => `animation:rise 0.7s cubic-bezier(.2,.7,.2,1) ${(t0 + d).toFixed(3)}s both, leave 0.35s ease-in ${out.toFixed(3)}s forwards;${extra}`
  const shadeAt = band === 'lower'
    ? `linear-gradient(0deg, ${dark(0)} 0%, ${dark(0.62)} 38%, ${dark(0.62)} 62%, ${dark(0)} 100%)`
    : `radial-gradient(ellipse 80% 50% at 50% 50%, ${dark(0.6)} 0%, ${dark(0.35)} 55%, ${dark(0)} 100%)`
  const shade = split ? '' : `<div style="position:absolute;left:0;top:${(y0 - 0.1) * H}px;width:${W}px;height:${(y1 - y0 + 0.2) * H}px;background:${shadeAt};animation:fade 0.6s ease ${t0.toFixed(3)}s both, leave 0.35s ease-in ${out.toFixed(3)}s forwards"></div>`
  const box = `position:absolute;left:${W * 0.07}px;top:${y0 * H}px;width:${W * 0.86}px;height:${(y1 - y0) * H}px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:14px`
  if (b.kind === 'statement') {
    const hs = split ? 104 : 118
    const heads = arr(b.copy.headline).map((l, j) => `<div class="serif" data-beat="${i}" data-role="headline" style="font-size:${hs}px;line-height:1.0;white-space:nowrap;color:${v(head)};${enter(0.12 * j)}">${esc(l)}</div>`).join('')
    const subs = arr(b.copy.sub).map((s, j) => `<div class="caps" style="font-size:30px;line-height:1.5;letter-spacing:0.17em;color:${v(sub === 'muted' ? 'ink' : sub)};${enter(0.45 + 0.08 * j)}">${esc(s)}</div>`).join('')
    const acc = b.copy.accent ? `<div class="caps bold" style="font-size:30px;letter-spacing:0.17em;color:${v(sg ? (sg.role === 'deep' ? 'highlight' : 'muted') : 'highlight')};${enter(0.6)}">${esc(b.copy.accent)}</div>` : ''
    return `${shade}<div style="${box}">${heads}<div style="height:22px"></div>${subs}${acc}</div>`
  }
  if (b.kind === 'caps') {
    const heads = arr(b.copy.headline).map((l, j) => `<div class="caps bold" data-beat="${i}" data-role="headline" style="font-size:${split ? 68 : 96}px;line-height:${split ? 1.3 : 1.38};color:${v(head)};white-space:nowrap;animation:track 1.1s cubic-bezier(.2,.7,.2,1) ${(t0 + 0.14 * j).toFixed(3)}s both, leave 0.35s ease-in ${out.toFixed(3)}s forwards">${esc(l)}</div>`).join('')
    return `${shade}<div style="${box};align-items:flex-start;text-align:left">${heads}</div>`
  }
  // glass: the panel rises, the query types itself, the rows follow.
  const q = b.copy.query ?? '', chars = [...q].map((ch, j) => `<span style="opacity:0;animation:show 0.01s linear ${(t0 + 0.55 + j * 0.035).toFixed(3)}s both">${esc(ch)}</span>`).join('')
  const typed = t0 + 0.55 + q.length * 0.035
  const ink = sg ? head : 'white'
  const rows = (b.copy.rows ?? []).map((r, j) => `<div class="serif" style="padding-left:104px;white-space:nowrap;font-size:42px;line-height:1.15;color:${v(ink)};${enter(typed - t0 + 0.2 + 0.18 * j)}">${esc(r)}</div>`).join('')
  const search = `<svg width="40" height="40" viewBox="0 0 24 24" style="flex:none"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="${v('accent')}" stroke-width="2.2"/><path d="M15.5 15.5l5 5" stroke="${v('accent')}" stroke-width="2.2" stroke-linecap="round"/></svg>`
  const card = sg ? (sg.role === 'deep' || sg.role === 'ink' ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.55)') : `rgba(${kit.kit.shades.glass},0.74)`
  return `<div style="position:absolute;left:${W * 0.045}px;top:${((y0 + y1) / 2) * H - 230}px;width:${W * 0.91}px;padding:26px 26px 36px;border-radius:24px;background:${card};backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.16);display:flex;flex-direction:column;gap:30px;${enter(0)}">
      <div style="display:flex;align-items:center;gap:20px;padding:18px 22px;border-radius:16px;background:rgba(255,255,255,0.1)">${search}<div class="serif" data-beat="${i}" data-role="headline" style="white-space:nowrap;font-size:46px;line-height:1.1;color:${v(ink)}">${chars}</div></div>${rows}</div>`
}

function endCardHtml(kit: AdsKit, e: ReelEnd, at: number) {
  const g = groundOf(kit, e.ground, 'deep'), ink = INK[g.role].head
  const logoInk = kit.logoOn[g.tok] ?? kit.tok(ink), lw = 380, lh = lw / kit.logo.primaryRatio
  const v = (name: string) => `var(--${kit.tok(name)})`
  const rise = (d: number) => `animation:rise 0.8s cubic-bezier(.2,.7,.2,1) ${(at + d).toFixed(3)}s both`
  return `<div style="position:absolute;inset:0;background:var(--${g.tok});animation:wipe 0.7s cubic-bezier(.7,0,.2,1) ${at.toFixed(3)}s both"></div>
    <div style="position:absolute;left:${W * 0.08}px;top:${H * 0.2}px;width:${W * 0.84}px;height:${H * 0.58}px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:34px">
      ${arr(e.headline).length ? `<div class="serif" style="font-size:96px;line-height:1.02;color:${v(ink)};${rise(0.45)}">${arr(e.headline).map(esc).join('<br>')}</div>` : ''}
      ${e.sub ? `<div class="caps" style="font-size:28px;line-height:1.6;letter-spacing:0.17em;text-wrap:balance;color:${v(ink)};${rise(0.6)}">${esc(e.sub)}</div>` : ''}
      ${e.cta ? `<div style="margin-top:10px;padding:22px 46px;border-radius:999px;background:${v('accent')};${rise(0.75)}"><div class="caps bold" style="font-size:28px;letter-spacing:0.17em;color:${v('deep')}">${esc(e.cta)}</div></div>` : ''}
      <div class="logo" style="margin-top:60px;width:${lw}px;height:${lh}px;background:var(--${logoInk});animation:land 0.9s cubic-bezier(.2,.7,.2,1) ${(at + 0.9).toFixed(3)}s both"></div>
    </div>`
}

/** The ground panel under the footage: the wave edge, and the logo at the foot of the safe band. */
function splitPanel(kit: AdsKit, sp: ReelSplit, endAt: number) {
  const g = groundOf(kit, sp.ground, 'deep')
  const y = sp.at * H, amp = 90, lw = 300, lh = lw / kit.logo.primaryRatio, logoInk = kit.logoOn[g.tok] ?? kit.tok(INK[g.role].head)
  return `<svg style="position:absolute;left:0;top:${y - amp}px;width:${W}px;height:${H - y + amp}px" viewBox="0 0 ${W} ${H - y + amp}" preserveAspectRatio="none"><path d="M0 ${amp * 0.55} C ${W * 0.28} ${-amp * 0.35}, ${W * 0.62} ${amp * 1.25}, ${W} ${amp * 0.2} L ${W} ${H - y + amp} L 0 ${H - y + amp} Z" fill="var(--${g.tok})"/></svg>
    <div class="logo" style="position:absolute;left:${(W - lw) / 2}px;top:${0.76 * H - lh}px;width:${lw}px;height:${lh}px;background:var(--${logoInk});animation:fade 0.6s ease 0.2s both, leave 0.3s ease-in ${Math.max(0.5, endAt - 0.3).toFixed(3)}s forwards"></div>`
}

export function overlayPage(kit: AdsKit, spec: ReelSpec, bands: ReelBand[], endAt: number) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${kit.css}
    html,body{background:transparent!important;width:${W}px;height:${H}px}
    *{animation-play-state:paused!important}
    @keyframes rise{from{opacity:0;transform:translateY(34px);filter:blur(6px)}to{opacity:1;transform:none;filter:none}}
    @keyframes fade{from{opacity:0}to{opacity:1}}
    @keyframes leave{to{opacity:0;transform:translateY(-12px)}}
    @keyframes show{to{opacity:1}}
    @keyframes track{from{opacity:0;letter-spacing:0.6em;transform:translateX(-24px)}to{opacity:1;letter-spacing:0.31em;transform:none}}
    @keyframes wipe{from{clip-path:inset(100% 0 0 0)}to{clip-path:inset(0 0 0 0)}}
    @keyframes land{from{opacity:0;transform:scale(1.06)}to{opacity:1;transform:none}}
    </style></head><body>${spec.split ? splitPanel(kit, spec.split, endAt) : ''}${spec.beats.map((b, i) => beatHtml(kit, b, bands[i]!, i, spec.split)).join('')}${spec.end ? endCardHtml(kit, spec.end, endAt) : ''}</body></html>`
}

/** Each beat's band: the first it allows that no face passes through during it (faces as fractions of the frame). */
export function chooseBands(beats: ReelBeat[], faces: { t: number; faces: { x: number; y: number; w: number; h: number }[] }[] | null, split: boolean, notes: string[]): ReelBand[] {
  if (split) return beats.map(() => 'lower')
  return beats.map((b, i) => {
    const wanted = b.bands ?? ['lower', 'center', 'upper']
    if (!faces) return wanted[0]!
    const inBeat = faces.filter((s) => s.t >= b.from - 0.1 && s.t <= b.to + 0.1).flatMap((s) => s.faces)
    const clear = (band: ReelBand) => !inBeat.some((f) => { const [y0, y1] = BAND[band], g = 0.25; return f.y - f.h * g < y1 && f.y + f.h * (1 + g) > y0 })
    const pick = b.depth ? wanted[0]! : wanted.find(clear) ?? wanted[0]!
    if (!b.depth && !clear(pick)) notes.push(`beat ${i + 1}: a face passes through every allowed band; ${pick} used — check it`)
    else if (pick !== wanted[0]) notes.push(`beat ${i + 1}: moved to the ${pick} band to keep faces clear`)
    return pick
  })
}

export type ReelInput = {
  kit: AdsKit
  spec: ReelSpec
  /** Each shot's source and each matte, staged. */
  media: Map<string, string>
  /** The job's folder: the type layer's page may read nothing outside it (work and out are in it). */
  root: string
  work: string
  out: string
  browser: Browser
  log: (line: string) => void
  progress: (fraction: number) => void
  signal: AbortSignal
}

export async function renderReel(input: ReelInput): Promise<{ file: string; strip: string; notes: string[]; seconds: number }> {
  const { kit, spec, work, out, log, signal } = input, fps = spec.fps ?? 30
  const planned = reelSeconds(spec)
  if (!(planned > 0 && planned <= REEL_MAX_SECONDS)) throw new Error(`A reel runs at most ${REEL_MAX_SECONDS} s with its end card (this one: ${Number.isFinite(planned) ? planned.toFixed(1) : 'endless'} s)`)
  if (!(Number.isInteger(fps) && fps >= 1 && fps <= 60)) throw new Error('A reel runs at up to 60 fps')
  await rm(work, { recursive: true, force: true })
  await mkdir(join(work, 'frames'), { recursive: true })
  await mkdir(out, { recursive: true })
  await needSpace(work)
  const notes: string[] = []
  const src = (s: string) => {
    const p = input.media.get(s)
    if (!p) throw new Error(`missing footage "${s}"`)
    return p
  }

  // 1. Shots: trim, conform to 1080x1920 at fps, with a slow push-in.
  const clips: { file: string; start: number; dur: number; src: string }[] = []
  let t = 0
  for (const [i, s] of spec.shots.entries()) {
    const len = s.out - s.in, slow = s.slow ?? 1, dur = len * slow, file = join(work, `shot-${i}.mp4`), push = s.push ?? 0.04, n = Math.round(dur * fps)
    const top = spec.split ? Math.round((spec.split.at * H + 110) / 2) * 2 : H, [b0, b1] = s.band ?? [0, 1]
    const pre = `crop=iw:ih*${(b1 - b0).toFixed(4)}:0:ih*${b0.toFixed(4)},`
    const pad = spec.split ? kit.palette[groundOf(kit, spec.split.ground, 'deep').tok] : ''
    const vf = `${slow !== 1 ? `setpts=${slow}*PTS,` : ''}${pre}scale=${W}:${top}:force_original_aspect_ratio=increase,crop=${W}:${top},fps=${fps},scale=${W * 2}:${top * 2},zoompan=z='1+${push}*on/${n}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${top}:fps=${fps},setsar=1`
      + (top < H ? `,pad=${W}:${H}:0:0:color=${pad}` : '')
    await run('ffmpeg', ['-v', 'error', '-y', '-ss', String(s.in), '-t', len.toFixed(3), '-i', src(s.src), '-an', '-vf', vf, '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', file], { timeout: 600_000, signal })
    clips.push({ file, start: t, dur, src: s.src })
    t += dur
    input.progress(0.3 * ((i + 1) / spec.shots.length))
  }
  const endAt = t, total = t + (spec.end?.seconds ?? 0)
  if (spec.end) {
    const file = join(work, 'end.mp4')
    await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${fps}:d=${spec.end.seconds}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], { signal })
    clips.push({ file, start: t, dur: spec.end.seconds, src: '' })
  }
  await writeFile(join(work, 'concat.txt'), clips.map((c) => `file '${c.file}'`).join('\n') + '\n')
  const base = join(work, 'base.mp4')
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(work, 'concat.txt'), '-c', 'copy', base], { signal })

  // 2. Faces: each beat's type goes in the first band no face passes through (faces from the spec, by shot).
  const people = spec.people ?? {}
  const shotsWithFaces = spec.shots.filter((s) => people[s.src]?.faces)
  const faces = spec.split || !shotsWithFaces.length
    ? null
    : clips.flatMap((c, i) => (i < spec.shots.length ? (people[c.src]?.faces ?? []).map((f) => ({ ...f, t: f.t * (spec.shots[i]!.slow ?? 1) + c.start })) : []))
  if (!spec.split && !shotsWithFaces.length && spec.beats.length) notes.push('No face data for the shots: each beat took its first band (the face-avoid pass was skipped)')
  const bands = chooseBands(spec.beats, faces, !!spec.split, notes)

  // 3. The type layer, frame by frame, transparent.
  const overlay = join(work, 'overlay.html')
  await writeFile(overlay, overlayPage(kit, spec, bands, endAt))
  const page = await fencedPage(input.browser, input.root, { viewport: { width: W, height: H }, deviceScaleFactor: 1 })
  try {
    await page.addInitScript({ content: 'window.__name = (f) => f;' })
    await page.goto(pageUrl(input.root, overlay))
    await page.evaluate(() => document.fonts.ready)
    const frames = Math.round(total * fps)
    for (let f = 0; f < frames; f++) {
      if (signal.aborted) throw signal.reason
      await page.evaluate((ms) => { for (const a of document.getAnimations()) a.currentTime = ms }, (f / fps) * 1000)
      await page.screenshot({ path: join(work, 'frames', `${String(f).padStart(5, '0')}.png`), omitBackground: true })
      if (f % 60 === 0) log(`${spec.id}: type layer ${f}/${frames}`)
      input.progress(0.3 + 0.5 * ((f + 1) / frames))
    }
  } finally {
    await page.close().catch(() => undefined)
  }

  // 4. Depth: for beats that ask for it, the people in the shot go back over the type (a matte from the spec).
  const inputs = ['-i', base, '-framerate', String(fps), '-i', join(work, 'frames', '%05d.png')]
  let graph = '[0:v][1:v]overlay=0:0:format=auto[v0]', last = 'v0', k = 2
  for (const [i, b] of spec.beats.entries()) {
    if (!b.depth) continue
    const ci = clips.findIndex((c, j) => j < spec.shots.length && b.from >= c.start - 0.01 && b.from < c.start + c.dur)
    if (ci < 0) continue
    const c = clips[ci]!, matteSrc = people[c.src]?.matte
    if (!matteSrc) {
      notes.push(`beat ${i + 1}: asked to sit behind the people, but its shot has no person matte; the headline stays in front`)
      continue
    }
    // The matte follows the shot's trim and timing, conformed like the shot.
    const shot = spec.shots[ci]!, matte = join(work, `matte-${ci}.mp4`)
    await run('ffmpeg', ['-v', 'error', '-y', '-ss', String(shot.in), '-t', (shot.out - shot.in).toFixed(3), '-i', src(matteSrc), '-an', '-vf',
      `${(shot.slow ?? 1) !== 1 ? `setpts=${shot.slow}*PTS,` : ''}scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${fps},format=gray`, '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', matte], { timeout: 600_000, signal })
    inputs.push('-itsoffset', c.start.toFixed(3), '-i', c.file, '-itsoffset', c.start.toFixed(3), '-i', matte)
    graph += `;[${k + 1}:v]scale=${W}:${H},format=gray[m${i}];[${k}:v][m${i}]alphamerge[p${i}];[${last}][p${i}]overlay=0:0:enable='between(t,${b.from.toFixed(3)},${b.to.toFixed(3)})'[v${i + 1}]`
    last = `v${i + 1}`
    k += 2
    notes.push(`beat ${i + 1}: headline set behind the people (matte)`)
  }
  const file = join(out, `${spec.id}.mp4`)
  await run('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', graph, '-map', `[${last}]`, '-t', total.toFixed(3), '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file], { timeout: 1_800_000, maxBuffer: 16 << 20, signal })
  input.progress(0.9)

  // 5. A strip of stills to review it at a glance.
  const strip = join(out, `${spec.id}-strip.jpg`), times = Array.from({ length: 8 }, (_, i) => ((i + 0.5) * total) / 8)
  const stills: string[] = []
  for (const [i, s] of times.entries()) {
    const f = join(work, `still-${i}.jpg`)
    await run('ffmpeg', ['-v', 'error', '-y', '-ss', s.toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=360:-2', f], { signal })
    stills.push(f)
  }
  await appendSideBySide(stills, strip, signal)
  await rm(join(work, 'frames'), { recursive: true, force: true })
  await writeFile(join(out, 'notes.md'), `# ${spec.title ?? spec.id}\n\n${total.toFixed(1)} s, ${spec.shots.length} shots, ${spec.beats.length} type beats${spec.end ? ', end card' : ''}. Silent: add music or voice in the editor.\n\n${notes.map((n) => `- ${n}`).join('\n')}\n`)
  log(`${spec.id}: ${total.toFixed(1)} s reel`)
  return { file, strip, notes, seconds: total }
}
