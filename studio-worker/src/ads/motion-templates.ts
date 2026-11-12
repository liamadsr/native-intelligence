/**
 * Type layers for motion ads. Each template turns a brief's copy into a
 * transparent HTML page whose CSS animations the renderer seeks frame by frame.
 * The two templates are a brand's approved pieces made reusable:
 *   cut-on-beat  hook → answer → end card, hard text cuts on the beat
 *   pull-out     a hook over the texture, then a pull out of the full stop of a
 *                knocked-out word
 * Every element the brand check reads carries data-role: service (the thing
 * sold, checked for size and screen time), aside, hook, headline, line, cta,
 * logo. data-zoom marks type that is scaled through the frame on purpose.
 *
 * Colours in the copy are palette tokens or template roles (the kit resolves
 * them); veils are presets or a plain CSS colour or gradient (the contract's
 * paint grammar, checked again here). Copy is HTML-escaped; the serif's name
 * is escaped for the CSS and the script it goes into (escape.ts).
 */
import type { CutOnBeatCopy, PullOutCopy } from '../../../web/src/lib/studio/server/ads-contract.ts'
import { attr, cssString, family, html, jsString, paint } from './escape.ts'
import type { AdsKit } from './kit.ts'

/** The same piece as editable parts for the editor (px in the 1080×1920 frame, seconds). */
export type Anim = { preset: 'none' | 'fade' | 'wipe'; seconds: number }
type Token = string
export type Editable =
  | { kind: 'text'; name: string; text: string; font: 'serif' | 'sans'; px: number; weight: number; tracking: number; leading: number; color: Token; uppercase?: boolean
      align: 'left' | 'right'; left: number; top: number; width: number; start: number; end?: number; enter: Anim; exit?: Anim; settle?: number }
  | { kind: 'rule'; name: string; left: number; top: number; width: number; height: number; color: Token; opacity?: number; start: number; end?: number; enter: Anim; exit?: Anim }
  | { kind: 'logo'; name: string; left: number; top: number; width: number; color: Token; start: number; enter: Anim }
  | { kind: 'veil'; name: string; css: string; start: number; end?: number; enter: Anim; exit?: Anim }
  | { kind: 'scene'; name: string; scene: 'knockout-pullout'; props: Record<string, unknown>; start: number; end?: number }
export type Built = {
  html: string
  checkpoints: number[]
  events: number[]
  editable: Editable[]
  /** A CSS selector for what an editor can't draw as layers (drawn into its background instead). */
  scene?: string
}
export type Template = (copy: any, ctx: { secs: number; fps: number; kit: AdsKit }) => Built

const NONE: Anim = { preset: 'none', seconds: 0 }, fadeIn = (seconds: number): Anim => ({ preset: 'fade', seconds })
/** The label row, as editable parts: the service (left), the aside (right, on the service's baseline), the hairline. */
function rowParts(service: string, aside: string | undefined, ink: Token, until?: number, ruleOpacity = 1): Editable[] {
  const out = until == null ? {} : { end: until, exit: fadeIn(0.3) }
  return [
    { kind: 'text', name: 'Service', text: service, font: 'sans', px: 40, weight: 500, tracking: 0.15, leading: 1.2, color: ink, uppercase: true, align: 'left', left: 72, top: 404, width: 620, start: 0, enter: fadeIn(0.3), ...out },
    ...(aside ? [{ kind: 'text', name: 'Aside', text: aside, font: 'sans', px: 26, weight: 500, tracking: 0.2, leading: 1.2, color: ink, uppercase: true, align: 'right', left: 608, top: 414.5, width: 400, start: 0, enter: fadeIn(0.3), ...out } as Editable] : []),
    { kind: 'rule', name: 'Hairline', left: 72, top: 476, width: 936, height: 1.5, color: ink, opacity: ruleOpacity, start: 0, enter: { preset: 'wipe', seconds: 0.75 }, ...out },
  ]
}
/** The end card's call to action (a short rule, then the words) and the logo, bottom right. */
function endParts(ink: Token, cta: string, ctaAt: number, logoAt: number): Editable[] {
  return [
    { kind: 'rule', name: 'CTA dash', left: 72, top: 1420, width: 56, height: 1.5, color: ink, start: ctaAt, enter: fadeIn(0.5) },
    { kind: 'text', name: 'Call to action', text: cta, font: 'sans', px: 28, weight: 500, tracking: 0.2, leading: 1.2, color: ink, uppercase: true, align: 'left', left: 150, top: 1404, width: 700, start: ctaAt, enter: fadeIn(0.5) },
    { kind: 'logo', name: 'Logo', left: 738, top: 1398, width: 270, color: ink, start: logoAt, enter: fadeIn(0.7) },
  ]
}
const esc = html
const f = (n: number) => `${+n.toFixed(3)}s`
const COMMON = `:root { --ease: cubic-bezier(.16,.84,.24,1); }
  @keyframes fade { from { opacity:0 } to { opacity:1 } }
  @keyframes away { to { opacity:0 } }
  @keyframes gone { to { opacity:0 } }
  @keyframes show { from { opacity:0 } to { opacity:1 } }
  @keyframes settle { from { transform:scale(1.035) } to { transform:none } }
  @keyframes draw { from { transform:scaleX(0) } to { transform:scaleX(1) } }
  @keyframes land { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:none } }`

/** Veils sit between the picture and the type so the type always reads. A preset name or any CSS background. */
export const VEILS: Record<string, string> = {
  // light sand at the top and bottom, clear through the middle
  sand: 'linear-gradient(180deg, rgba(247,243,239,0.6) 0%, rgba(247,243,239,0.2) 38%, rgba(247,243,239,0.12) 58%, rgba(247,243,239,0.62) 100%)',
  // a sand ground rising from the bottom half, for type over a busy photo
  'sand-low': 'linear-gradient(180deg, rgba(247,243,239,0) 44%, rgba(247,243,239,0.8) 58%, rgba(247,243,239,0.93) 100%)',
  // over a photo: a light lift behind the label row, clear through the subject, a sand ground for the type below
  photo: 'linear-gradient(180deg, rgba(247,243,239,0.5) 0%, rgba(247,243,239,0) 30%, rgba(247,243,239,0) 47%, rgba(247,243,239,0.6) 61%, rgba(247,243,239,0.78) 100%)',
  // deep forest shade over a dark texture
  forest: 'linear-gradient(180deg, rgba(14,22,17,0.5) 0%, rgba(14,22,17,0.12) 30%, rgba(14,22,17,0.2) 45%, rgba(14,22,17,0.62) 75%, rgba(14,22,17,0.72) 100%)',
}
/** A veil by preset name (the kit's, then the defaults) or as written, checked against the paint grammar either way. */
export const veilOf = (kit: AdsKit, v: string) => {
  const own = (o: Record<string, string> | undefined) => (o && Object.hasOwn(o, v) ? o[v] : undefined)
  return paint(own(kit.kit.motion.veils) ?? own(VEILS) ?? v)
}

/** The label row: the service, large (≥40px), and an aside, over a hairline. */
function row(service: string, aside: string | undefined, ink: Token, anim: string, ruleAnim: string, ruleOpacity = 1) {
  return {
    css: `.row { position:absolute; left:72px; right:72px; top:404px; display:flex; justify-content:space-between; align-items:baseline; animation: ${anim}; }
  .label { font-size:26px; letter-spacing:0.2em; color:var(--${ink}); }
  .label.what { font-size:40px; font-weight:500; letter-spacing:0.15em; }
  .rule { position:absolute; left:72px; top:476px; width:936px; height:1.5px; background:var(--${ink}); opacity:${ruleOpacity}; transform-origin:left; animation: ${ruleAnim}; }`,
    html: `<div class="row"><div class="caps label what" data-role="service">${esc(service)}</div>${aside ? `<div class="caps label" data-role="aside">${esc(aside)}</div>` : ''}</div>
<div class="rule"></div>`,
  }
}

function endCard(ink: Token, cta: string, ctaAt: number, logoAt: number) {
  return {
    css: `.cta { position:absolute; left:72px; top:1404px; display:flex; align-items:center; gap:22px; animation: fade .5s ease ${f(ctaAt)} both; }
  .cta i { display:block; width:56px; height:1.5px; background:var(--${ink}); }
  .cta span { font-size:28px; letter-spacing:0.2em; color:var(--${ink}); }
  .lg { position:absolute; right:72px; top:1398px; width:270px; height:calc(270px / var(--ratio)); background:var(--${ink}); animation: land .7s var(--ease) ${f(logoAt)} both; }`,
    html: `<div class="cta"><i></i><span class="caps" data-role="cta">${esc(cta)}</span></div>
<div class="logo lg" data-role="logo"></div>`,
  }
}

// ---- cut-on-beat --------------------------------------------------------------------------------------------

export const cutOnBeat: Template = (copy: CutOnBeatCopy, { secs, kit }) => {
  const c = { ...copy, ink: kit.tok(copy.ink) }
  const r = row(c.service, c.aside, c.ink, 'fade .3s ease 0s both', 'draw .7s var(--ease) 0s both', 0.75)
  const e = { size: 50, top: 1176, ctaAt: c.end.at + 0.65, logoAt: c.end.at + 0.9, lines: [] as string[], ...c.end }
  const end = endCard(c.ink, e.cta, e.ctaAt, e.logoAt)
  const veils = (c.veils ?? [{ css: 'sand' }]).map((v, i) => {
    const anim = [v.at ? `fade .4s ease ${f(v.at)} both` : '', v.until != null ? `gone .3s ease ${f(v.until)} forwards` : ''].filter(Boolean).join(', ')
    return `<div class="veil" style="${attr(`background:${veilOf(kit, v.css)};${anim ? `animation:${anim}` : ''}`)}" data-i="${i}"></div>`
  })
  const beats = c.beats.map((b, i) => {
    const enter = b.enter ?? (i === 0 ? 'rise' : 'cut'), next = c.beats[i + 1]?.at, until = b.until ?? next
    const leave = until == null ? '' : (b.out ?? (b.until != null ? 'fade' : 'cut')) === 'fade' ? `gone .3s ease ${f(until)} forwards` : `gone .01s linear ${f(until)} forwards`
    const box = `position:absolute; left:62px; top:${b.top}px; font-size:${b.size}px; line-height:${b.leading ?? 1}; letter-spacing:-0.025em; color:var(--${c.ink});`
    if (enter === 'rise') {
      const lines = b.lines.map((l, k) => `<div style="animation: rise .5s var(--ease) ${f(b.at + k * 0.17)} both">${esc(l)}</div>`).join('')
      return `<div class="serif beat" data-role="headline" style="${box}${leave ? ` animation:${leave};` : ''}">${lines}</div>`
    }
    const anim = [`show .01s linear ${f(b.at)} both`, `settle .6s var(--ease) ${f(b.at)} both`, leave].filter(Boolean).join(', ')
    return `<div class="serif beat" data-role="headline" style="${box} transform-origin:0 0; animation:${anim};">${b.lines.map((l) => `<div>${esc(l)}</div>`).join('')}</div>`
  })
  const lines = e.lines.length ? `<div class="serif line" data-role="line">${e.lines.map((l, k) => `<div style="animation: rise .5s var(--ease) ${f(e.at + k * 0.16)} both">${esc(l)}</div>`).join('')}</div>` : ''
  const html = `<style>
  ${COMMON}
  @keyframes rise { from { opacity:0; transform:translateY(30px) } to { opacity:1; transform:none } }
  .veil { position:absolute; inset:0; }
  ${r.css}
  .line { position:absolute; left:72px; top:${e.top}px; width:880px; font-size:${e.size}px; line-height:1.18; color:var(--${c.ink}); }
  ${end.css}
</style>
${veils.join('\n')}
${r.html}
${beats.join('\n')}
${lines}
${end.html}`
  const editable: Editable[] = [
    ...(c.veils ?? [{ css: 'sand' }]).map((v, i): Editable => ({ kind: 'veil', name: i ? `Veil ${i + 1}` : 'Veil', css: veilOf(kit, v.css), start: v.at ?? 0, enter: v.at ? fadeIn(0.4) : NONE,
      ...(v.until != null ? { end: v.until, exit: fadeIn(0.3) } : {}) })),
    ...rowParts(c.service, c.aside, c.ink, undefined, 0.75),
    ...c.beats.flatMap((b, i) => {
      const enter = b.enter ?? (i === 0 ? 'rise' : 'cut'), until = b.until ?? c.beats[i + 1]?.at, leading = b.leading ?? 1
      const exit = until == null ? {} : { end: until, exit: (b.out ?? (b.until != null ? 'fade' : 'cut')) === 'fade' ? fadeIn(0.3) : NONE }
      return b.lines.map((line, k): Editable => ({ kind: 'text', name: `${i === 0 ? 'Hook' : `Beat ${i + 1}`} · line ${k + 1}`, text: line, font: 'serif', px: b.size, weight: 400, tracking: -0.025, leading,
        color: c.ink, align: 'left', left: 62, top: b.top + k * b.size * leading, width: 1000, start: enter === 'rise' ? b.at + k * 0.17 : b.at,
        enter: enter === 'rise' ? fadeIn(0.5) : NONE, ...(enter === 'cut' ? { settle: 1.035 } : {}), ...exit }))
    }),
    ...e.lines.map((line, k): Editable => ({ kind: 'text', name: `End line ${k + 1}`, text: line, font: 'serif', px: e.size, weight: 400, tracking: 0, leading: 1.18, color: c.ink,
      align: 'left', left: 72, top: e.top + k * e.size * 1.18, width: 880, start: e.at + k * 0.16, enter: fadeIn(0.5) })),
    ...endParts(c.ink, e.cta, e.ctaAt, e.logoAt),
  ]
  // Check each beat once it has settled, and the end card once the logo has landed.
  const settled = c.beats.map((b, i) => b.at + 0.7 + ((b.enter ?? (i === 0 ? 'rise' : 'cut')) === 'rise' ? 0.17 * (b.lines.length - 1) : 0))
  return {
    html,
    checkpoints: [...settled, e.logoAt + 0.8].filter((t) => t < secs),
    events: [0, ...c.beats.flatMap((b) => (b.until != null ? [b.at, b.until] : [b.at])), e.at],
    editable,
  }
}

// ---- pull-out -----------------------------------------------------------------------------------------------

/** Pull-out keyframes: from `from`× to 1×, even in log-scale with an ease in and out, so every frame reads as motion. */
export function pulloutKeyframes(from: number, stops = 24) {
  const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2)
  return Array.from({ length: stops + 1 }, (_, i) => {
    const x = i / stops
    return `${(x * 100).toFixed(2)}% { transform:scale(${Math.pow(from, 1 - ease(x)).toFixed(4)}) }`
  }).join(' ')
}

export const pullOut: Template = (copy: PullOutCopy, { secs, kit }) => {
  const c = { ...copy, panel: kit.tok(copy.panel), ink: kit.tok(copy.ink), hookInk: kit.tok(copy.hookInk) }
  const z = { at: 2.55, duration: 1.95, from: 72, ...c.zoom }, out = z.at - 0.1
  const L = { line: { x: 66, y: 836, size: 146 }, word: { x: 60, y: 1124, size: 330, track: -8 }, ...c.layout }
  const hook = { size: 112, top: 1000, ...c.hook }
  const r = row(c.service, c.aside, c.hookInk, `fade .3s ease 0s both, away .3s ease ${f(out)} forwards`, `draw .8s var(--ease) 0s both, away .3s ease ${f(out)} forwards`)
  const end = endCard(c.ink, c.end.cta, c.end.at + 0.75, c.end.at + 1.05)
  const serif = cssString(family(kit.fonts.serif.family))
  const html = `<style>
  ${COMMON}
  @keyframes rise { from { opacity:0; transform:translateY(28px) } to { opacity:1; transform:none } }
  @keyframes pullout { ${pulloutKeyframes(z.from)} }
  svg.panel { position:absolute; inset:0; width:1080px; height:1920px; }
  .z { transform-box:view-box; animation: pullout ${f(z.duration)} linear ${f(z.at)} both; }
  #word { font-family:${serif}; font-size:${L.word.size}px; letter-spacing:${L.word.track}px; }
  .solid { font-family:${serif}; font-size:${L.line.size}px; letter-spacing:-3px; fill:var(--${c.ink}); }
  .shade { position:absolute; inset:0; background:${veilOf(kit, c.shade ?? 'forest')}; animation: away .35s ease ${f(out)} both; }
  ${r.css}
  .hook { position:absolute; left:72px; top:${hook.top}px; font-size:${hook.size}px; line-height:1.06; letter-spacing:-0.02em; color:var(--${c.hookInk}); }
  .hook > div { animation: rise .55s var(--ease) both, away .3s ease ${f(out)} forwards; }
  .rule2 { position:absolute; left:72px; top:1200px; width:936px; height:1.5px; background:var(--${c.ink}); transform-origin:left; animation: draw .9s var(--ease) ${f(c.end.at)} both; }
  .what2 { position:absolute; left:72px; top:1232px; font-size:40px; font-weight:500; letter-spacing:0.15em; color:var(--${c.ink}); animation: rise .6s var(--ease) ${f(c.end.at + 0.15)} both; }
  ${end.css}
</style>
<svg class="panel" viewBox="0 0 1080 1920">
  <defs><mask id="cut" maskUnits="userSpaceOnUse" x="0" y="0" width="1080" height="1920">
    <rect width="1080" height="1920" fill="white"/>
    <text id="word" class="z" x="${L.word.x}" y="${L.word.y}" fill="black">${esc(c.word)}</text>
  </mask></defs>
  <rect width="1080" height="1920" fill="var(--${c.panel})" mask="url(#cut)"/>
  <text class="z solid" x="${L.line.x}" y="${L.line.y}" data-role="headline" data-zoom>${esc(c.line)}</text>
</svg>
<div class="shade"></div>
${r.html}
<div class="serif hook" data-role="hook">${hook.lines.map((l, k) => `<div style="animation-delay:${f(hook.at[k] ?? 0)}, ${f(out)}">${esc(l)}</div>`).join('')}</div>
<div class="rule2"></div>
<div class="caps what2" data-role="service">${esc(c.service)}</div>
${end.html}
<script>
  // Zoom about the ink centre of the word's last character (its full stop): the glyph's pen position from the SVG
  // layout (kerning and tracking included) plus the ink box the font reports for that character. A few pixels off
  // shows as an arc of panel colour at ${z.from}x, so this is measured, not guessed.
  window.__motionReady = async () => {
    await document.fonts.ready;
    const word = document.getElementById('word'), n = word.getNumberOfChars() - 1, p = word.getStartPositionOfChar(n);
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = getComputedStyle(word).fontWeight + ' ${+L.word.size}px ' + ${jsString(serif)};
    const m = ctx.measureText(word.textContent.slice(-1));
    const x = p.x + (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2, y = p.y + (m.actualBoundingBoxDescent - m.actualBoundingBoxAscent) / 2;
    for (const el of document.querySelectorAll('.z')) el.style.transformOrigin = x.toFixed(1) + 'px ' + y.toFixed(1) + 'px';
    // Where each character of the word sits (pen position on the baseline), so it can be drawn as outlines.
    const chars = Array.from(word.textContent, (c, i) => { const q = word.getStartPositionOfChar(i); return { c, x: q.x, y: q.y }; });
    return { origin: [x, y], chars };
  };
  // The word as outlines from the font (a path scales without limit; browsers stop drawing text tens of thousands
  // of px tall): swapped in for the text when the renderer has them.
  window.__useOutline = (d) => {
    const word = document.getElementById('word'), path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d); path.setAttribute('fill', 'black'); path.setAttribute('class', 'z'); path.id = 'word';
    path.style.transformOrigin = word.style.transformOrigin; word.replaceWith(path);
  };
</script>`
  const settled = Math.max(...hook.at) + 0.6
  const editable: Editable[] = [
    { kind: 'scene', name: 'Knock-out pull-out', scene: 'knockout-pullout', start: 0,
      props: { line: c.line, word: c.word, panel: c.panel, ink: c.ink, lineX: L.line.x, lineY: L.line.y, lineSize: L.line.size, lineTrack: -3,
        wordX: L.word.x, wordY: L.word.y, wordSize: L.word.size, wordTrack: L.word.track, zoomAt: z.at, zoomSeconds: z.duration, from: z.from } },
    { kind: 'veil', name: 'Shade', css: veilOf(kit, c.shade ?? 'forest'), start: 0, enter: NONE, end: out, exit: fadeIn(0.35) },
    ...rowParts(c.service, c.aside, c.hookInk, out),
    ...hook.lines.map((line, k): Editable => ({ kind: 'text', name: `Hook · line ${k + 1}`, text: line, font: 'serif', px: hook.size, weight: 400, tracking: -0.02, leading: 1.06,
      color: c.hookInk, align: 'left', left: 72, top: hook.top + k * hook.size * 1.06, width: 1000, start: hook.at[k] ?? 0, enter: fadeIn(0.55), end: out, exit: fadeIn(0.3) })),
    { kind: 'rule', name: 'End hairline', left: 72, top: 1200, width: 936, height: 1.5, color: c.ink, start: c.end.at, enter: { preset: 'wipe', seconds: 0.9 } },
    { kind: 'text', name: 'Service (end)', text: c.service, font: 'sans', px: 40, weight: 500, tracking: 0.15, leading: 1.2, color: c.ink, uppercase: true, align: 'left',
      left: 72, top: 1232, width: 900, start: c.end.at + 0.15, enter: fadeIn(0.6) },
    ...endParts(c.ink, c.end.cta, c.end.at + 0.75, c.end.at + 1.05),
  ]
  return {
    html,
    checkpoints: [settled, secs - 0.05].filter((t) => t < secs),
    events: [0, ...hook.at, out, z.at, z.at + z.duration, c.end.at],
    editable,
    scene: 'svg.panel',
  }
}

export const MOTION_TEMPLATES: Record<string, Template> = { 'cut-on-beat': cutOnBeat, 'pull-out': pullOut }
