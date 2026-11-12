// Particles and springs — motion that feels physical: springs (fast start, a little overshoot, a soft settle) and a particle system whose dots
// travel from one shape to the next — text bursting into dots, a dotted line becoming a waveform, dots gathering into
// icons, swirling into a ring and collapsing into a logo. One population of dots carries the eye through the whole film,
// so beats hand off instead of cutting. Everything is a pure function of the frame (Remotion renders frames in any order).

/** A damped spring from 0 to 1. `t` and `duration` in seconds; bounce 0 = no overshoot (critically damped), 0.3 = lively,
 *  0.6 = bouncy. Settles within about `duration`. */
export function spring(t: number, duration = 0.6, bounce = 0.2): number {
  if (t <= 0) return 0;
  const w0 = (2 * Math.PI) / Math.max(0.02, duration), zeta = 1 - Math.min(0.9, Math.max(0, bounce));
  if (zeta >= 1) return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  const wd = w0 * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + (zeta * w0 / wd) * Math.sin(wd * t));
}
/** The eases an in/out animation can use. expo = the original snappy curve (no overshoot); spring and bouncy overshoot. */
export type Ease = 'expo' | 'spring' | 'bouncy' | 'smooth';
export function ease(kind: Ease | undefined, t: number, seconds: number): number {
  if (t <= 0) return 0;
  if (t >= 1 && kind !== 'spring' && kind !== 'bouncy') return 1;
  switch (kind) {
    case 'spring': return t >= 1.6 ? 1 : spring(t * seconds, seconds, 0.22);
    case 'bouncy': return t >= 1.8 ? 1 : spring(t * seconds, seconds, 0.45);
    case 'smooth': return t * t * (3 - 2 * t);
    default: return 1 - Math.pow(2, -10 * t);
  }
}

// ------------------------------------------------------------------------------------------------------------ particles
export type ParticleShape = 'scatter' | 'line' | 'wave' | 'bars' | 'points' | 'ring' | 'point';
export type ParticleForm = {
  /** When the dots start travelling to this shape, seconds from the layer start. */
  at: number; shape: ParticleShape;
  /** Centre and box of the shape, fractions of the frame (ring: h = diameter as a fraction of the frame height). */
  x: number; y: number; w?: number; h?: number;
  /** points: where the dots gather (fractions of the frame), round robin. */
  points?: [number, number][];
  /** line / wave: wave height (fraction of frame height), cycles across, cycles per second (travelling). */
  amp?: number; freq?: number; speed?: number;
  /** Random wander, fraction of frame height (a hand-drawn, alive line). */
  jitter?: number;
  /** Dot diameter, fraction of frame height; bars: barWidth (fraction of height). */
  size?: number; barWidth?: number;
  color?: string; opacity?: number;
  /** bars: a taller bar travelling across like a playhead (0–2 = how much taller). */
  spike?: number;
  /** ring: turns per second; comet 0–1 = a bright head sweeping round with a tail. */
  spin?: number; comet?: number;
  /** The trip to this shape: spring settle time (s), bounce, and the spread of start times across the dots (s). */
  duration?: number; bounce?: number; stagger?: number; order?: 'index' | 'reverse' | 'random' | 'center' | 'angle';
};
export type Dot = { x: number; y: number; w: number; h: number; color: string; opacity: number };

const rnd = (i: number, k: number) => { const v = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return v - Math.floor(v); };
/** Smooth wander in −1…1 (sum of incommensurate sines; deterministic per dot). */
const wander = (i: number, k: number, t: number) => (Math.sin(t * (1.3 + rnd(i, k) * 1.7) + rnd(i, k + 1) * 6.28) + 0.6 * Math.sin(t * (2.9 + rnd(i, k + 2) * 2.3) + rnd(i, k + 3) * 6.28)) / 1.6;

/** Where dot i of n sits in a form at time τ (seconds from the layer start). x in frame widths, y and sizes in frame heights. */
export function formDot(f: ParticleForm, i: number, n: number, tau: number, aspect: number): Dot {
  const size = f.size ?? 0.008, color = f.color ?? '#3355dd', opacity = f.opacity ?? 1, w = f.w ?? 0.5, h = f.h ?? 0.2, jit = f.jitter ?? 0;
  const u = n > 1 ? i / (n - 1) : 0.5;
  let x = f.x, y = f.y, dw = size, dh = size;
  switch (f.shape) {
    case 'scatter': x += (rnd(i, 11) - 0.5) * w; y += (rnd(i, 12) - 0.5) * h; break;
    case 'line': case 'wave': case 'bars': {
      x += (u - 0.5) * w;
      const amp = f.amp ?? (f.shape === 'wave' ? 0.035 : 0), freq = f.freq ?? 2.5, speed = f.speed ?? (f.shape === 'wave' ? 0.6 : 0);
      y += amp * Math.sin(2 * Math.PI * (freq * u - speed * tau));
      if (f.shape === 'bars') {
        const bell = Math.exp(-Math.pow((u - 0.5) / 0.26, 2)), breathe = 0.3 + 0.7 * Math.abs(Math.sin(i * 1.73 + tau * 8.3) * Math.cos(i * 0.61 - tau * 5.9));   // lively: a voice, not a slow swell
        dw = f.barWidth ?? size; dh = Math.max(dw, (0.12 + 0.88 * bell * breathe) * h);
        if (f.spike) { const at = ((tau * 0.35) % 1), d = Math.abs(u - at) * n; if (d < 1.5) dh *= 1 + f.spike * (1 - d / 1.5); }   // a playhead peak travelling across
      }
      break;
    }
    case 'points': {
      const pts = f.points?.length ? f.points : [[f.x, f.y] as [number, number]], k = pts.length, c = i % k, j = Math.floor(i / k), per = Math.ceil(n / k);
      const p = pts[c]!, r = (f.h ?? size * 1.2), a = (2 * Math.PI * j) / Math.max(1, per) + tau * 0.7 + c;
      x = p[0] + (Math.cos(a) * r * (j ? 1 : 0)) / aspect; y = p[1] + Math.sin(a) * r * (j ? 1 : 0);
      break;
    }
    case 'ring': {
      const r = (f.h ?? 0.3) / 2, a = (2 * Math.PI * i) / n + 2 * Math.PI * (f.spin ?? 0) * tau - Math.PI / 2;
      x += (Math.cos(a) * r) / aspect; y += Math.sin(a) * r;
      if (f.comet) {   // a bright head sweeping round faster than the ring turns, with a fading tail: the spin you can see
        const head = 2 * Math.PI * ((f.spin ?? 0.3) * 2.6 * tau) - Math.PI / 2, behind = (((head - a) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / (2 * Math.PI);
        const k = Math.exp(-behind * 7) * f.comet; dw = dh = size * (1 + 2.6 * k);
      }
      break;
    }
    case 'point': x += (rnd(i, 13) - 0.5) * size / aspect; y += (rnd(i, 14) - 0.5) * size; break;
  }
  if (jit) { x += (jit * wander(i, 21, tau)) / aspect; y += jit * wander(i, 31, tau); }
  return { x, y, w: dw, h: dh, color, opacity };
}

function orderFrac(f: ParticleForm, i: number, n: number, aspect: number, from: Dot | null): number {
  switch (f.order ?? 'index') {
    case 'reverse': return n > 1 ? 1 - i / (n - 1) : 0;
    case 'random': return rnd(i, 41);
    case 'center': return n > 1 ? Math.abs(i / (n - 1) - 0.5) * 2 : 0;
    case 'angle': { if (!from) return 0; const a = Math.atan2(from.y - f.y, (from.x - f.x) * aspect); return (a + Math.PI) / (2 * Math.PI); }
    default: return n > 1 ? i / (n - 1) : 0;
  }
}

const hex = (c: string) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
export function mixColor(a: string, b: string, t: number) {
  if (a === b || t <= 0) return t <= 0 ? a : b; if (t >= 1) return b;
  const x = hex(a), y = hex(b); return `rgb(${x.map((v, k) => Math.round(v + (y[k]! - v) * t)).join(',')})`;
}

/** How far dot i is through its trip to form k at time τ (spring; may pass 1 and come back). */
export function tripProgress(forms: ParticleForm[], k: number, i: number, n: number, tau: number, aspect: number, from: Dot | null) {
  const f = forms[k]!, delay = (f.stagger ?? 0.2) * orderFrac(f, i, n, aspect, from);
  return spring(tau - f.at - delay, f.duration ?? 0.7, f.bounce ?? 0.2);
}

/** Dot i at time τ: each form pulls the dots from wherever the previous trip had them (so trips can overlap). */
export function particleDot(forms: ParticleForm[], i: number, n: number, tau: number, aspect: number): Dot {
  if (!forms.length) return { x: 0.5, y: 0.5, w: 0.01, h: 0.01, color: '#3355dd', opacity: 0 };
  // The latest form the dot has fully arrived at (settled), then blend forward through every form started since.
  let k = 0;
  for (let j = forms.length - 1; j > 0; j--) {
    const f = forms[j]!; if (tau >= f.at + (f.stagger ?? 0.2) + (f.duration ?? 0.7) * 1.6) { k = j; break; }
  }
  let dot = formDot(forms[k]!, i, n, tau, aspect);
  for (let j = k + 1; j < forms.length && forms[j]!.at <= tau; j++) {
    const target = formDot(forms[j]!, i, n, tau, aspect), p = tripProgress(forms, j, i, n, tau, aspect, dot), q = Math.max(0, Math.min(1, p));
    dot = { x: dot.x + (target.x - dot.x) * p, y: dot.y + (target.y - dot.y) * p, w: Math.max(0, dot.w + (target.w - dot.w) * p), h: Math.max(0, dot.h + (target.h - dot.h) * p),
      color: mixColor(dot.color, target.color, q), opacity: dot.opacity + (target.opacity - dot.opacity) * q };
  }
  return dot;
}

/** Every dot at time τ with its velocity (frame units per second), for drawing motion-stretched dots. */
export function particleFrame(forms: ParticleForm[], n: number, tau: number, fps: number, aspect: number) {
  const dt = 1 / fps;
  return Array.from({ length: n }, (_, i) => { const now = particleDot(forms, i, n, tau, aspect), before = particleDot(forms, i, n, tau - dt, aspect);
    return { ...now, vx: (now.x - before.x) / dt, vy: (now.y - before.y) / dt }; });
}

/** The moments a sound belongs to: each trip's busiest instant (when most dots are moving fastest). */
export function particleTrips(forms: ParticleForm[]) {
  return forms.slice(1).map((f, k) => ({ index: k + 1, shape: f.shape, from: forms[k]!.shape, at: f.at, peak: f.at + (f.stagger ?? 0.2) * 0.35 + (f.duration ?? 0.7) * 0.12,
    settle: f.at + (f.stagger ?? 0.2) + (f.duration ?? 0.7) * 0.5, duration: f.duration ?? 0.7 }));
}
