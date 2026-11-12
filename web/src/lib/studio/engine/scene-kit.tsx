// @studio/kit — the motion toolkit for code scenes (scenes.ts). A scene is a React component the agent writes; it draws
// on a 1920-wide stage, its frame 0 is the layer's start, and everything is driven by time — never by timers or state.
// Everything here is pure and deterministic, so the preview, stills and the export draw the same frame.
import React, { createContext, useContext } from 'react';
import { Img, useCurrentFrame, useVideoConfig } from 'remotion';
import { spring as springCurve } from './particles';
import { fontStack } from './font-faces';
import { MediaVideo } from './media-video';

// -------------------------------------------------------------------------------------------------------- the scene
type Asset = { url: string; kind: 'image' | 'video' | 'audio'; width?: number; height?: number };
export type SceneInfo = { width: number; height: number; seconds: number; asset: (idOrName: string) => Asset | null };
export const SceneContext = createContext<SceneInfo>({ width: 1920, height: 1080, seconds: 5, asset: () => null });
/** Time in the scene: frame (0 at the layer's start), t in seconds, the stage size (1920 wide) and the scene's length. */
export function useTime() {
  const frame = useCurrentFrame(), { fps } = useVideoConfig(), info = useContext(SceneContext);
  return { frame, t: frame / fps, fps, width: info.width, height: info.height, seconds: info.seconds };
}
export const useScene = () => useContext(SceneContext);

// ------------------------------------------------------------------------------------------------------------- motion
export const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
export const mix = (a: number, b: number, p: number) => a + (b - a) * p;
/** 0 → 1 as t goes from start to start + duration (clamped). */
export const progress = (t: number, start: number, duration: number) => clamp((t - start) / Math.max(1e-6, duration));
export const ease = {
  linear: (p: number) => clamp(p),
  out: (p: number) => 1 - Math.pow(1 - clamp(p), 3),
  in: (p: number) => Math.pow(clamp(p), 3),
  inOut: (p: number) => { p = clamp(p); return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; },
  /** Fast arrival, long soft landing: the default for anything entering. */
  expo: (p: number) => { p = clamp(p); return p >= 1 ? 1 : 1 - Math.pow(2, -10 * p); },
  /** A small overshoot. */
  back: (p: number) => { p = clamp(p); const c = 1.7; return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2); },
  /** Apple-like: quick start, very gentle settle. */
  smooth: (p: number) => { p = clamp(p); return 1 - Math.pow(1 - p, 4); },
};
export type Easing = (p: number) => number;
/** A spring from 0 to 1 starting at `start` (s): `duration` to settle, `bounce` 0 (none) … 0.6 (playful). Overshoots past 1. */
export function spring(t: number, start = 0, { duration = 0.8, bounce = 0.15 }: { duration?: number; bounce?: number } = {}) {
  return t <= start ? 0 : springCurve(t - start, duration, bounce);
}
/** Value between `from` and `to` while t moves through [start, end]. */
export function tween(t: number, [start, end]: [number, number], [from, to]: [number, number], easing: Easing = ease.expo) {
  return mix(from, to, easing(progress(t, start, end - start)));
}
/** Keyframes: [[time, value], …] with an easing per segment (default smooth in-out). */
export function keys(t: number, frames: [number, number][], easing: Easing = ease.inOut) {
  if (t <= frames[0]![0]) return frames[0]![1];
  for (let i = 1; i < frames.length; i++) { const [t1, v1] = frames[i]!, [t0, v0] = frames[i - 1]!; if (t <= t1) return mix(v0, v1, easing(progress(t, t0, t1 - t0))); }
  return frames[frames.length - 1]![1];
}
/** Smooth value noise in 0…1 (organic motion: drift, flicker, waveforms). */
export function noise(x: number, seed = 0) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f), h = (n: number) => { const v = Math.sin((n + seed * 57.31) * 127.1) * 43758.5453; return v - Math.floor(v); };
  return h(i) * (1 - u) + h(i + 1) * u;
}
/** A deterministic random number in 0…1 for an index. */
export const rand = (i: number, seed = 0) => { const v = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453; return v - Math.floor(v); };
/** Gentle floating offset in px. */
export const float = (t: number, amount = 6, speed = 0.35, seed = 0) => ({ x: (noise(t * speed, seed) - 0.5) * 2 * amount, y: (noise(t * speed, seed + 9) - 0.5) * 2 * amount });

// ------------------------------------------------------------------------------------------------------------- reveal
type From = 'up' | 'down' | 'left' | 'right' | 'scale' | 'blur' | 'none';
function enter(t: number, at: number, duration: number, from: From, distance: number, bounce: number, blur: number) {
  const p = bounce > 0 ? spring(t, at, { duration, bounce }) : ease.expo(progress(t, at, duration)), q = clamp(p);
  const d = (1 - p) * distance;
  const translate = from === 'up' ? `translateY(${d}px)` : from === 'down' ? `translateY(${-d}px)` : from === 'left' ? `translateX(${d}px)` : from === 'right' ? `translateX(${-d}px)` : '';
  const scale = from === 'scale' ? ` scale(${0.86 + 0.14 * p})` : '';
  return { opacity: clamp(q * 1.6), transform: `${translate}${scale}` || undefined, filter: blur > 0 && q < 0.995 ? `blur(${(1 - q) * blur}px)` : undefined };
}
/** Children arrive at `at` (s): from below by default, out of a slight blur. `out` (s) makes them leave. */
export function Reveal({ at = 0, duration = 0.7, from = 'up', distance = 28, bounce = 0, blur = 10, out, outDuration = 0.4, style, children, inline }:
  { at?: number; duration?: number; from?: From; distance?: number; bounce?: number; blur?: number; out?: number; outDuration?: number; style?: React.CSSProperties; children?: React.ReactNode; inline?: boolean }) {
  const { t } = useTime(), e = enter(t, at, duration, from, distance, bounce, blur);
  const leave = out !== undefined ? ease.in(progress(t, out, outDuration)) : 0;
  return <div style={{ display: inline ? 'inline-block' : undefined, ...style, opacity: e.opacity * (1 - leave), transform: [e.transform, leave ? `translateY(${-leave * distance * 0.5}px)` : ''].filter(Boolean).join(' ') || undefined,
    filter: [e.filter, leave ? `blur(${leave * blur}px)` : ''].filter(Boolean).join(' ') || undefined, willChange: 'transform, opacity' }}>{children}</div>;
}
/** Text that arrives word by word (or letter by letter). Wrap words in *stars* to colour them with `accent`. */
export function SplitText({ text, at = 0, stagger = 0.06, by = 'word', duration = 0.7, from = 'up', distance = 0.35, blur = 8, bounce = 0, accent, style }:
  { text: string; at?: number; stagger?: number; by?: 'word' | 'char'; duration?: number; from?: From; distance?: number; blur?: number; bounce?: number; accent?: string; style?: React.CSSProperties }) {
  const { t } = useTime(), size = typeof style?.fontSize === 'number' ? style.fontSize : 64;
  let marked = false; const parts: { text: string; accent: boolean }[] = [];
  for (const piece of (by === 'word' ? text.split(/(\s+)/) : Array.from(text))) { let s = piece; const on = marked; if (s.includes('*')) { const flips = (s.match(/\*/g) ?? []).length; s = s.replace(/\*/g, ''); marked = flips % 2 ? !marked : marked; parts.push({ text: s, accent: on || marked }); } else parts.push({ text: s, accent: marked }); }
  let n = 0;
  return <span style={{ ...style, display: 'inline' }}>{parts.map((p, i) => { if (!p.text.trim()) return by === 'word' ? ' ' : <span key={i} style={{ whiteSpace: 'pre' }}>{p.text}</span>;
    const e = enter(t, at + n++ * stagger, duration, from, distance * size, bounce, blur);
    return <span key={i} style={{ display: 'inline-block', whiteSpace: 'pre', color: p.accent && accent ? accent : undefined, ...e }}>{p.text}</span>; })}</span>;
}
/** A number that counts from `from` to `value` between at and at + duration, formatted like "12.5", "1,204", "$9.9". */
export function Counter({ value, from = 0, at = 0, duration = 1.2, decimals, prefix = '', suffix = '', easing = ease.expo, style }:
  { value: number; from?: number; at?: number; duration?: number; decimals?: number; prefix?: string; suffix?: React.ReactNode; easing?: Easing; style?: React.CSSProperties }) {
  const { t } = useTime(), v = mix(from, value, easing(progress(t, at, duration))), d = decimals ?? (String(value).split('.')[1]?.length ?? 0);
  return <span style={{ fontVariantNumeric: 'tabular-nums', ...style }}>{prefix}{v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}{suffix}</span>;
}

// -------------------------------------------------------------------------------------------------------------- paths
/** A path that draws itself from at to at + duration. Use inside an <svg>. */
export function DrawPath({ d, at = 0, duration = 1.2, easing = ease.inOut, stroke = '#fff', width = 3, glow = 0, fill = 'none', opacity = 1, dash, from = 0 }:
  { d: string; at?: number; duration?: number; easing?: Easing; stroke?: string; width?: number; glow?: number; fill?: string; opacity?: number; dash?: string; from?: number }) {
  const { t } = useTime(), p = from + (1 - from) * easing(progress(t, at, duration));
  if (p <= 0) return null;
  return <path d={d} fill={fill} stroke={stroke} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray={dash ?? '1 1'} strokeDashoffset={dash ? undefined : 1 - p}
    opacity={opacity} style={glow ? { filter: `drop-shadow(0 0 ${glow}px ${stroke})` } : undefined} />;
}
/** A smooth curve through points (Catmull-Rom). */
export function smoothPath(points: [number, number][], tension = 0.5) {
  if (points.length < 2) return '';
  let d = `M${points[0]![0]} ${points[0]![1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]!, p1 = points[i]!, p2 = points[i + 1]!, p3 = points[i + 2] ?? p2, k = tension / 3;
    d += ` C${p1[0] + (p2[0] - p0[0]) * k} ${p1[1] + (p2[1] - p0[1]) * k} ${p2[0] - (p3[0] - p1[0]) * k} ${p2[1] - (p3[1] - p1[1]) * k} ${p2[0]} ${p2[1]}`;
  }
  return d;
}
/** Signal shapes for charts and "it listens" moments, as smooth paths across `width`, centred on `height`/2.
 *  kind: voice (a talking envelope), pulse (heartbeat spikes), wave (a calm sine), steps (activity bars), noise.
 *  `t` scrolls them (a live signal); `seed` varies them. */
export type SignalOptions = { kind?: 'voice' | 'pulse' | 'wave' | 'steps' | 'noise'; width: number; height: number; t?: number; seed?: number; cycles?: number; amp?: number; samples?: number; speed?: number };
export function signalPath(options: SignalOptions) {
  const pts = signalPoints(options), kind = options.kind ?? 'voice';
  return kind === 'pulse' || kind === 'steps' ? 'M' + pts.map(p => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' L') : smoothPath(pts);
}
/** The y of a signal (or any point list sorted by x) at x — e.g. to put a glowing dot on the head of a line as it draws. */
export function pointAt(points: [number, number][], x: number): [number, number] {
  if (!points.length) return [x, 0];
  let i = 1; while (i < points.length - 1 && points[i]![0] < x) i++;
  const a = points[i - 1]!, b = points[i]!, p = clamp((x - a[0]) / Math.max(1e-6, b[0] - a[0]));
  return [x, a[1] + (b[1] - a[1]) * p];
}
/** The points signalPath draws through (same options). */
export function signalPoints({ kind = 'voice', width, height, t = 0, seed = 0, cycles = 6, amp = 1, samples = 160, speed = 1 }: SignalOptions): [number, number][] {
  const mid = height / 2, half = (height / 2) * amp, pts: [number, number][] = [];
  for (let j = 0; j <= samples; j++) {
    const x = j / samples, phase = x * cycles + t * speed;
    let y = 0;
    if (kind === 'wave') y = Math.sin(phase * Math.PI * 2) * 0.55;
    else if (kind === 'voice') { const env = 0.25 + 0.75 * noise(phase * 0.6, seed); y = Math.sin(phase * Math.PI * 2 * 3.1) * env * (0.5 + 0.5 * noise(phase * 2.3, seed + 4)); }
    else if (kind === 'noise') y = (noise(phase * 3, seed) - 0.5) * 1.6;
    else if (kind === 'steps') y = (Math.round(noise(phase * 1.4, seed) * 4) / 4 - 0.5) * 1.2;
    else { const f = phase - Math.floor(phase); y = f < 0.42 ? Math.sin(f * 12) * 0.05 : f < 0.47 ? -(f - 0.42) * 6 : f < 0.52 ? -0.3 + (f - 0.47) * 26 : f < 0.58 ? 1 - (f - 0.52) * 22 : f < 0.66 ? -0.32 + (f - 0.58) * 4 : Math.sin(f * 9) * 0.04; }
    pts.push([x * width, mid - y * half]);
  }
  return pts;
}

// ------------------------------------------------------------------------------------------------------------ surfaces
/** The font stack for a family (any Fontshare / Google family, or sans · display · serif · mono · heavy). List the families
 *  a scene uses in `export const fonts = [...]` so they are downloaded before rendering. */
export const font = (family: string) => fontStack(family);
/** Frosted glass: for cards over photos or colour. */
export function Glass({ children, radius = 22, tint = 'rgba(255,255,255,0.72)', blur = 24, border = 'rgba(255,255,255,0.6)', shadow = true, style }:
  { children?: React.ReactNode; radius?: number; tint?: string; blur?: number; border?: string; shadow?: boolean; style?: React.CSSProperties }) {
  return <div style={{ borderRadius: radius, background: tint, backdropFilter: `blur(${blur}px) saturate(1.4)`, WebkitBackdropFilter: `blur(${blur}px) saturate(1.4)`, border: `1px solid ${border}`,
    boxShadow: shadow ? '0 1px 1px rgba(0,0,0,.04), 0 8px 24px rgba(0,0,0,.10), 0 30px 60px -20px rgba(0,0,0,.25)' : undefined, ...style }}>{children}</div>;
}
/** A soft, layered shadow (CSS box-shadow) at a depth 0…1. */
export const shadow = (depth = 0.5, color = '0,0,0') => `0 ${1 + depth * 2}px ${2 + depth * 4}px rgba(${color},${0.04 + depth * 0.06}), 0 ${8 + depth * 24}px ${24 + depth * 60}px -${depth * 12}px rgba(${color},${0.12 + depth * 0.22})`;
/** A glow (CSS box-shadow / drop-shadow colour) for dark scenes. */
export const glow = (color: string, size = 30) => `0 0 ${size * 0.3}px ${color}, 0 0 ${size}px ${color}88, 0 0 ${size * 2.5}px ${color}44`;
/** Film grain over everything below it (subtle by default): makes flat gradients look photographed. */
export function Grain({ opacity = 0.06, scale = 1 }: { opacity?: number; scale?: number }) {
  const { frame } = useTime(), id = `grain${frame % 8}`;
  return <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', mixBlendMode: 'overlay', opacity }}>
    <filter id={id}><feTurbulence type="fractalNoise" baseFrequency={0.9 / scale} numOctaves={2} seed={frame % 8} stitchTiles="stitch" /><feColorMatrix type="saturate" values="0" /></filter>
    <rect width="100%" height="100%" filter={`url(#${id})`} /></svg>;
}
/** A full-stage backdrop: paper (warm light, soft vignette), studio (cool light), night (deep dark with a faint glow), or any CSS background. */
export function Backdrop({ kind = 'paper', glowColor, style }: { kind?: 'paper' | 'studio' | 'night' | string; glowColor?: string; style?: React.CSSProperties }) {
  const bg = kind === 'paper' ? 'radial-gradient(120% 90% at 30% 20%, #fbfaf6 0%, #f1efe9 55%, #e4e1d9 100%)'
    : kind === 'studio' ? 'radial-gradient(110% 90% at 50% 10%, #ffffff 0%, #eef0f4 60%, #dfe3ea 100%)'
    : kind === 'night' ? `radial-gradient(60% 50% at 50% 40%, ${glowColor ?? '#2a2550'}55 0%, transparent 70%), linear-gradient(180deg, #0e0f13, #08090c)` : kind;
  return <div style={{ position: 'absolute', inset: 0, background: bg, ...style }} />;
}

// --------------------------------------------------------------------------------------------------------- media
/** An image or video from the project (by asset id or name): screenshots, photos, captured product UI. Videos play from the scene's start (or `from` s). */
export function Media({ src, fit = 'cover', style, from = 0 }: { src: string; fit?: 'cover' | 'contain'; style?: React.CSSProperties; from?: number }) {
  const asset = useScene().asset(src), { fps } = useVideoConfig();
  if (!asset) return <div style={{ ...style, background: 'repeating-linear-gradient(45deg,#ddd 0 10px,#eee 10px 20px)', display: 'flex', alignItems: 'center', justifyContent: 'center', font: '600 18px Inter', color: '#999' }}>missing: {src}</div>;
  const css: React.CSSProperties = { width: '100%', height: '100%', objectFit: fit, display: 'block', ...style };
  return asset.kind === 'video' ? <MediaVideo src={asset.url} muted style={css} trimBefore={Math.round(from * fps)} /> : <Img src={asset.url} style={css} />;
}

// --------------------------------------------------------------------------------------------------------- devices
/** An iPhone (titanium frame, Dynamic Island) at `width` px; children fill its screen (393×852 logical points scaled). */
export function Phone({ width = 420, children, frame = '#1b1c1f', screen = '#000', island = true, style }: { width?: number; children?: React.ReactNode; frame?: string; screen?: string; island?: boolean; style?: React.CSSProperties }) {
  const h = width * 2.06, bezel = width * 0.035, r = width * 0.17;
  return <div style={{ position: 'relative', width, height: h, borderRadius: r, background: `linear-gradient(145deg, ${frame}, #3a3b40 45%, ${frame})`, padding: bezel * 0.35,
    boxShadow: `inset 0 0 0 ${width * 0.004}px rgba(255,255,255,.18), ${shadow(0.9)}`, boxSizing: 'border-box', ...style }}>
    <div style={{ position: 'absolute', inset: bezel * 0.35, borderRadius: r - bezel * 0.35, background: '#050505', padding: bezel * 0.65, boxSizing: 'border-box' }}>
      <div style={{ position: 'relative', width: '100%', height: '100%', borderRadius: r - bezel, overflow: 'hidden', background: screen }}>
        {children}
        {island ? <div style={{ position: 'absolute', top: width * 0.028, left: '50%', transform: 'translateX(-50%)', width: width * 0.3, height: width * 0.085, borderRadius: width, background: '#000' }} /> : null}
      </div>
    </div>
    {[[0.22, 0.07], [0.31, 0.12], [0.45, 0.12]].map(([top, len], i) => <div key={i} style={{ position: 'absolute', left: -width * 0.012, top: h * top!, width: width * 0.012, height: h * len!, borderRadius: 3, background: frame }} />)}
    <div style={{ position: 'absolute', right: -width * 0.012, top: h * 0.33, width: width * 0.012, height: h * 0.16, borderRadius: 3, background: frame }} />
  </div>;
}
/** An Apple Watch (case, band, crown) at `width` px of case; children fill the screen. */
export function Watch({ width = 360, children, band = '#1f2023', caseColor = '#2a2b2f', style }: { width?: number; children?: React.ReactNode; band?: string; caseColor?: string; style?: React.CSSProperties }) {
  const h = width * 1.2, r = width * 0.24;
  const strap = (top: boolean) => <div style={{ position: 'absolute', left: width * 0.12, width: width * 0.76, height: width * 0.62, [top ? 'top' : 'bottom']: -width * 0.5, background: `linear-gradient(${top ? 180 : 0}deg, ${band}00, ${band} 30%)`, borderRadius: width * 0.18 }} />;
  return <div style={{ position: 'relative', width, height: h, ...style }}>
    {strap(true)}{strap(false)}
    <div style={{ position: 'absolute', inset: 0, borderRadius: r, background: `linear-gradient(150deg, #4a4b50, ${caseColor} 40%, #121214)`, boxShadow: `inset 0 0 0 ${width * 0.006}px rgba(255,255,255,.15), ${shadow(1)}` }} />
    <div style={{ position: 'absolute', right: -width * 0.035, top: h * 0.26, width: width * 0.06, height: h * 0.15, borderRadius: width * 0.02, background: 'linear-gradient(90deg,#5a5b60,#1c1c1e)' }} />
    <div style={{ position: 'absolute', inset: width * 0.045, borderRadius: r * 0.82, background: '#000', padding: width * 0.05, boxSizing: 'border-box' }}>
      <div style={{ position: 'relative', width: '100%', height: '100%', borderRadius: r * 0.6, overflow: 'hidden', background: '#000' }}>{children}</div>
    </div>
  </div>;
}
/** A macOS-style window with traffic lights and an address pill; children are the page. */
export function Browser({ width = 1100, height = 680, url = '', dark = false, children, style }: { width?: number; height?: number; url?: string; dark?: boolean; children?: React.ReactNode; style?: React.CSSProperties }) {
  const bar = 44;
  return <div style={{ width, height, borderRadius: 14, overflow: 'hidden', background: dark ? '#17181c' : '#fff', boxShadow: shadow(0.8), border: `1px solid ${dark ? '#2a2b31' : 'rgba(0,0,0,.08)'}`, ...style }}>
    <div style={{ height: bar, display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', background: dark ? '#1f2025' : '#f4f4f6', borderBottom: `1px solid ${dark ? '#2a2b31' : 'rgba(0,0,0,.06)'}` }}>
      {['#ff5f57', '#febc2e', '#28c840'].map(c => <span key={c} style={{ width: 12, height: 12, borderRadius: 6, background: c }} />)}
      {url ? <div style={{ margin: '0 auto', padding: '5px 14px', borderRadius: 8, background: dark ? '#2a2b31' : '#e9e9ee', font: '500 13px Inter', color: dark ? '#aaa' : '#666' }}>{url}</div> : null}
    </div>
    <div style={{ position: 'relative', height: height - bar }}>{children}</div>
  </div>;
}
/** A pointer you can place (pressed = the click squash). */
export function Cursor({ x, y, pressed = false, scale = 1 }: { x: number; y: number; pressed?: boolean; scale?: number }) {
  return <svg width={28 * scale} height={28 * scale} viewBox="0 0 26 26" style={{ position: 'absolute', left: x - 5 * scale, top: y - 3 * scale, transform: `scale(${pressed ? 0.86 : 1})`, transformOrigin: '5px 3px', filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.3))', overflow: 'visible' }}>
    <path d="M5 3.2v17.6l4.4-4.1 2.7 6.1 3.1-1.4-2.7-6h6.2L5 3.2z" fill="#111" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" /></svg>;
}
