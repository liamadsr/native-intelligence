import { z } from 'zod';
import { curveValue, cutPoints, normalizePoints, type AutomationPoint, type ParamInfo } from './automation';
import { ease as easeCurve, type Ease } from './particles';

/**
 * Layers: text, callouts and spotlights that sit on the timeline above the picture (project frames, not per clip),
 * each with an in and out animation and its own automation lanes. Geometry is in fractions of the output frame so the
 * same layer reads the same at any resolution; text size is a fraction of the output height.
 */
const finite = z.number().finite(), frame = z.number().int().min(0).max(10_000_000);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const color = z.string().regex(/^#[\da-fA-F]{6}(?:[\da-fA-F]{2})?$/);

export const layerKinds = ['text', 'box', 'highlight', 'arrow', 'spotlight', 'notification', 'card', 'chips', 'image', 'background', 'waveform', 'icons', 'ring', 'particles', 'code'] as const;
export type LayerKind = typeof layerKinds[number];
/** In/out animations. The modern ones (blur-in, chars, streak, scatter, zoom-blur, drop) move fast, settle softly and carry motion blur. */
export const animationPresets = ['none', 'fade', 'pop', 'slide-up', 'slide-down', 'slide-left', 'slide-right', 'zoom', 'blur', 'wipe', 'typewriter', 'words', 'draw',
  'blur-in', 'chars', 'streak', 'scatter', 'zoom-blur', 'drop', 'weight-in', 'track-in'] as const;
export type AnimationPreset = typeof animationPresets[number];
export const layerParams = ['x', 'y', 'scale', 'opacity', 'rotate', 'weight', 'tracking'] as const;
export type LayerParam = typeof layerParams[number];

const PointSchema = z.object({ frame, value: finite, curve: z.enum(['smooth', 'linear', 'hold']).optional() }).strict();
export const LayerLaneSchema = z.object({ param: z.enum(layerParams), points: z.array(PointSchema).max(2000) }).strict();
/** ease: expo (default, snappy, no overshoot), spring (overshoots a little and settles), bouncy, smooth (ease in and out). */
export const easeKinds = ['expo', 'spring', 'bouncy', 'smooth'] as const;
export const LayerAnimationSchema = z.object({ preset: z.enum(animationPresets), frames: z.number().int().min(1).max(600), ease: z.enum(easeKinds).optional() }).strict();
const springy = (kind: Ease | undefined) => kind === 'spring' || kind === 'bouncy';
/** Particles: one shape the dots travel to (see motion.ts ParticleForm). */
export const ParticleFormSchema = z.object({ at: finite.min(0).max(36_000), shape: z.enum(['scatter', 'line', 'wave', 'bars', 'points', 'ring', 'point']),
  x: finite.min(-1).max(2), y: finite.min(-1).max(2), w: finite.min(0).max(3).optional(), h: finite.min(0).max(3).optional(),
  points: z.array(z.tuple([finite.min(-1).max(2), finite.min(-1).max(2)])).max(24).optional(),
  amp: finite.min(-1).max(1).optional(), freq: finite.min(0).max(40).optional(), speed: finite.min(-20).max(20).optional(), jitter: finite.min(0).max(0.5).optional(),
  size: finite.min(0.001).max(0.3).optional(), barWidth: finite.min(0.001).max(0.2).optional(), color: color.optional(), opacity: finite.min(0).max(1).optional(), spin: finite.min(-10).max(10).optional(), comet: finite.min(0).max(1).optional(), spike: finite.min(0).max(3).optional(),
  duration: finite.min(0.05).max(10).optional(), bounce: finite.min(0).max(0.9).optional(), stagger: finite.min(0).max(10).optional(),
  order: z.enum(['index', 'reverse', 'random', 'center', 'angle']).optional() }).strict();
/** One step of a component's interaction script (kit-script.ts): exactly one action, optional timing. */
const target = z.string().min(1).max(200);
export const ScriptStepSchema = z.object({
  at: z.number().finite().min(0).max(60).optional(), duration: z.number().finite().min(0.05).max(20).optional(),
  wait: z.number().finite().min(0).max(20).optional(), move: target.optional(), hover: target.optional(), click: target.optional(),
  type: z.string().max(400).optional(), into: target.optional(), cps: z.number().finite().min(2).max(80).optional(),
  press: z.string().min(1).max(40).optional(), scroll: z.number().finite().min(-20000).max(20000).optional(), in: target.optional(),
  drag: target.optional(), to: target.optional(),
}).strict().refine(s => ['wait', 'move', 'hover', 'click', 'type', 'press', 'scroll', 'drag'].filter(k => (s as Record<string, unknown>)[k] !== undefined).length === 1,
  { message: 'Each step does exactly one thing: wait, move, hover, click, type, press, scroll or drag' })
  .refine(s => s.drag === undefined || s.to !== undefined, { message: 'A drag needs "to"' });

export const LayerStyleSchema = z.object({
  text: z.string().max(2000).optional(),
  /** sans · display · serif · mono · heavy (Inter, Satoshi, Instrument Serif, JetBrains Mono, Clash Display), or any
   *  family name from Fontshare or Google Fonts ("Cabinet Grotesk", "Fraunces"…) — downloaded on first use. */
  font: z.string().min(1).max(80).optional(),
  /** Text height as a fraction of the output height (0.06 ≈ 65 px at 1080p). */
  size: finite.min(0.01).max(0.5).optional(),
  /** A name, or any number 100–1000 (variable fonts take every value in their range). */
  weight: z.union([z.enum(['thin', 'light', 'regular', 'medium', 'semibold', 'bold', 'black']), z.number().int().min(1).max(1000)]).optional(),
  /** Letter spacing in em (−0.05 tight display, 0.1 wide caps). */
  tracking: finite.min(-0.3).max(1.5).optional(),
  /** Line height as a multiple of the size. */
  leading: finite.min(0.6).max(3).optional(),
  italic: z.boolean().optional(),
  /** Variable-font axes beyond weight: { wdth: 75, opsz: 32, slnt: -10, … }. */
  axes: z.record(z.string(), finite).refine(axes => Object.keys(axes).every(tag => /^[a-zA-Z]{4}$/.test(tag)), { message: 'Axis tags are four letters (wdth, opsz, slnt, …)' }).optional(),
  /** OpenType features: "ss01", "tnum", "case", "liga 0"… */
  features: z.array(z.string().regex(/^[a-z0-9]{4}( [01])?$/)).max(12).optional(),
  color: color.optional(),
  /** Pill/box behind text, or the fill of a highlight. */
  background: color.optional(),
  stroke: color.optional(),
  /** Outline/line thickness in px at 1080p. */
  strokeWidth: finite.min(0).max(60).optional(),
  /** Corner radius in px at 1080p. */
  radius: finite.min(0).max(500).optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  /** true/'soft' a soft lift · 'lifted' deeper · 'glow' a halo in the accent (or text) colour · 'hard' a heavy drop shadow. */
  shadow: z.union([z.boolean(), z.enum(['soft', 'lifted', 'glow', 'hard'])]).optional(),
  uppercase: z.boolean().optional(),
  /** One word per line (stacked titles). */
  stack: z.boolean().optional(),
  /** Shrink the type so the longest line fits the layer width — big words never overflow. */
  fit: z.boolean().optional(),
  /** Spotlight: how dark everything outside the hole gets. */
  dim: finite.min(0).max(1).optional(),
  /** Kinetic text: the colour of the word being spoken / the latest word in. */
  accent: color.optional(),
  /** Kinetic text: when each word appears, in frames from the layer start (else evenly over the in-animation). */
  wordFrames: z.array(frame).max(400).optional(),
  /** Arrow: where it starts (fractions of the frame); it points at the layer's x/y. */
  fromX: finite.min(-1).max(2).optional(), fromY: finite.min(-1).max(2).optional(),
  /** Arrow: bend of the shaft, −1…1. */
  curve: finite.min(-1).max(1).optional(),
  /** Second colour: text gradient, background gradient/mesh/glow. */
  color2: color.optional(),
  /** Notification/card: the bold first line; notification: app name and icon (emoji). */
  title: z.string().max(300).optional(), app: z.string().max(60).optional(), icon: z.string().max(12).optional(),
  /** Chips: the pills, popping in one after another. */
  items: z.array(z.string().min(1).max(160)).max(12).optional(),
  /** Waveform look: bars (rounded capsules) · dots · line (layered flowing curves) · radial (around a circle) · mirror (with a reflection). */
  variant: z.enum(['bars', 'dots', 'line', 'radial', 'mirror']).optional(),
  /** Waveform: space between bars (0 touching … 0.9 hairlines), bar roundness (0 square … 1 capsule), height multiplier,
   *  movement speed, glow (0 … 1), and what drives it: synthetic (a voice-like swell), voice (the voice-over), music, all. */
  gap: finite.min(0).max(0.9).optional(), roundness: finite.min(0).max(1).optional(), amp: finite.min(0).max(3).optional(), speed: finite.min(0).max(5).optional(),
  glow: finite.min(0).max(1).optional(), source: z.enum(['synthetic', 'voice', 'music', 'all']).optional(),
  /** Waveform: how many bars; spike = a playhead bar that travels across. */
  count: z.number().int().min(4).max(120).optional(), spike: z.boolean().optional(),
  /** Text: a slim blinking caret while typing (and after, when 'line'). */
  caret: z.enum(['line', 'none']).optional(),
  /** Word swap: these words take turns after the text ("Over 98% of" → Restaurants / Salons / Gyms), every `swapEvery` frames. */
  swapWords: z.array(z.string().min(1).max(80)).max(12).optional(), swapEvery: z.number().int().min(4).max(600).optional(),
  /** Counter: the number in the text counts up from this value during the in-animation. */
  countFrom: finite.optional(),
  /** Continuous drift while on screen, in frame widths per second (negative = leftward) — the slow slide under kinetic titles. */
  drift: finite.min(-2).max(2).optional(),
  /** Gentle floating bob (images, avatars), as a fraction of the frame height. */
  float: finite.min(0).max(0.1).optional(),
  /** Background: how the frame is filled. */
  fill: z.enum(['solid', 'gradient', 'mesh', 'glow', 'image']).optional(),
  /** Background image blur / card backdrop blur, px at 1080p. */
  blur: finite.min(0).max(120).optional(),
  /** Frosted-glass look for cards and notifications. */
  glass: z.boolean().optional(),
  /** Per-word/letter delay for kinetic text, frames. */
  stagger: finite.min(0).max(30).optional(),
  /** Motion blur strength (0 = off, 1 = natural, 2 = heavy). */
  motionBlur: finite.min(0).max(3).optional(),
  /** A product component this layer shows (kits): which one, with what props, rendered from which code (key). The
   *  footage (assetId) is re-rendered when the product's code changes — on refresh and on export. */
  component: z.object({ kit: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,40}$/), id: z.string().min(1).max(300), props: z.record(z.string(), z.unknown()).optional(),
    script: z.array(ScriptStepSchema).max(80).optional(), cursor: z.boolean().optional(),
    seconds: finite.min(0.5).max(60), theme: z.enum(['light', 'dark']).optional(), width: finite.min(40).max(4000).optional(), height: finite.min(40).max(4000).optional(),
    key: z.string().max(64) }).strict().optional(),
  /** A code scene (scenes.ts): the compiled scene (by content hash), its name, the props it gets and the fonts it uses. */
  scene: z.object({ id: z.string().regex(/^[a-f0-9]{16}$/), name: z.string().min(1).max(80), props: z.record(z.string(), z.unknown()).optional(), fonts: z.array(z.string().min(1).max(80)).max(16).optional() }).strict().optional(),
  /** Clip a scene to its box. */
  clip: z.boolean().optional(),
  /** Particles: the shapes the dots travel through, in time order. */
  forms: z.array(ParticleFormSchema).max(40).optional(),
}).strict();
export type LayerStyle = z.infer<typeof LayerStyleSchema>;

export const LayerSchema = z.object({
  id, kind: z.enum(layerKinds), name: z.string().min(1).max(100),
  /** Layers with the same track share one timeline track (e.g. every phrase of the captions). */
  track: id.optional(),
  /** Image/background/card avatar: an image (or video) asset of the project. */
  assetId: id.optional(),
  /** Drawn behind the isolated subject (needs a subject cut-out of the footage on screen): words behind the speaker. */
  behind: z.boolean().optional(),
  startFrame: frame, endFrame: frame,
  /** Centre of the layer (arrow: its tip), fractions of the output frame. */
  x: finite.min(-1).max(2), y: finite.min(-1).max(2),
  /** Size, fractions of the output frame (down to a hairline). Text wraps to `width`; `height` is its box for callouts. */
  width: finite.min(0.0005).max(3), height: finite.min(0.0005).max(3),
  rotate: finite.min(-360).max(360), opacity: finite.min(0).max(1),
  style: LayerStyleSchema,
  enter: LayerAnimationSchema, exit: LayerAnimationSchema,
  automation: z.array(LayerLaneSchema).max(layerParams.length),
}).strict().superRefine((layer, ctx) => {
  if (layer.endFrame <= layer.startFrame) ctx.addIssue({ code: 'custom', message: 'A layer must end after it starts' });
  if (new Set(layer.automation.map(lane => lane.param)).size !== layer.automation.length) ctx.addIssue({ code: 'custom', message: 'One automation lane per layer parameter' });
});
export type EditorLayer = z.infer<typeof LayerSchema>;
export type LayerLane = z.infer<typeof LayerLaneSchema>;

/** A text weight as a number (named weights, or 100–1000 for variable fonts). */
export const weightNumber = (weight?: LayerStyle['weight']) => typeof weight === 'number' ? weight : ({ thin: 200, light: 300, regular: 400, medium: 500, semibold: 600, bold: 700, black: 900 } as const)[weight ?? 'bold'];
export const layerParamInfo = (layer: Pick<EditorLayer, 'x' | 'y' | 'opacity' | 'rotate'> & { style?: LayerStyle }, param: LayerParam): ParamInfo => ({
  x: { id: 'x', label: 'Position ←→', min: -0.5, max: 1.5, neutral: layer.x, format: (v: number) => `${Math.round(v * 100)}%`, help: 'Horizontal position (0% left edge, 100% right edge)' },
  y: { id: 'y', label: 'Position ↑↓', min: -0.5, max: 1.5, neutral: layer.y, format: (v: number) => `${Math.round(v * 100)}%`, help: 'Vertical position (0% top, 100% bottom)' },
  scale: { id: 'scale', label: 'Scale', min: 0, max: 4, neutral: 1, format: (v: number) => `${v.toFixed(2)}×`, help: 'Size of the layer' },
  opacity: { id: 'opacity', label: 'Opacity', min: 0, max: 1, neutral: layer.opacity, format: (v: number) => `${Math.round(v * 100)}%`, help: 'How visible the layer is' },
  rotate: { id: 'rotate', label: 'Rotation', min: -180, max: 180, neutral: layer.rotate, format: (v: number) => `${v.toFixed(0)}°`, help: 'Turn the layer' },
  weight: { id: 'weight', label: 'Font weight', min: 1, max: 1000, neutral: weightNumber(layer.style?.weight), format: (v: number) => `${Math.round(v)}`, help: 'Text thickness (variable fonts move smoothly through every weight)' },
  tracking: { id: 'tracking', label: 'Letter spacing', min: -0.3, max: 1.5, neutral: layer.style?.tracking ?? 0, format: (v: number) => `${v.toFixed(3)} em`, help: 'Space between letters, in em (negative = tighter)' },
}[param] as ParamInfo);

export const layerKindInfo: Record<LayerKind, { label: string; help: string }> = {
  text: { label: 'Text', help: 'Titles, captions, labels and kinetic word-by-word text' },
  box: { label: 'Box', help: 'An outlined box that frames an area' },
  highlight: { label: 'Highlight', help: 'A soft glowing marker over an area' },
  arrow: { label: 'Arrow', help: 'Points at something; draws itself in' },
  spotlight: { label: 'Spotlight', help: 'Dims everything except one area' },
  notification: { label: 'Notification', help: 'A macOS/iOS-style glass notification that drops in and types its message' },
  card: { label: 'Card', help: 'A floating glass card: avatar, a line that types in, placeholder lines' },
  chips: { label: 'Chips', help: 'A stack of pills that pop in one after another (features, steps, results)' },
  waveform: { label: 'Waveform', help: 'Audio bars that grow out of a line and keep moving, with a travelling playhead' },
  icons: { label: 'Icons', help: 'A row of icons that pop in one by one: notes, keys, a toggle that switches, bubbles that burst, a dash that flies off' },
  ring: { label: 'Ring', help: 'A dashed circle that draws itself and spins — a reveal around a logo' },
  code: { label: 'Scene', help: 'Graphics written as code: anything that can be drawn and animated (a custom chart, a device with the product, a logo reveal)' },
  particles: { label: 'Particles', help: 'Dots that travel from shape to shape — text bursting into dots, a line becoming a waveform, dots gathering into icons or swirling into a ring' },
  image: { label: 'Image', help: 'A picture from your project (logo, avatar, screenshot) that pops in and floats' },
  background: { label: 'Background', help: 'Fills the frame — gradient mesh, glow, colour or photo — for title beats between screens' },
};

export const textLooks = {
  title: { font: 'display', size: 0.09, weight: 'black', color: '#ffffff', shadow: true, align: 'center' },
  caption: { font: 'display', size: 0.06, weight: 'black', color: '#ffffff', stroke: '#000000', strokeWidth: 6, shadow: true, align: 'center', uppercase: true, accent: '#ffd84d' },
  label: { font: 'sans', size: 0.035, weight: 'bold', color: '#111118', background: '#ffffff', radius: 14, align: 'center' },
  pill: { font: 'sans', size: 0.04, weight: 'bold', color: '#ffffff', background: '#7c5cff', radius: 500, align: 'center', shadow: true },
  subtitle: { font: 'sans', size: 0.04, weight: 'medium', color: '#ffffff', background: '#0b0b10cc', radius: 12, align: 'center' },
  /** Clean modern statement: big, medium weight, tight — dark on light backgrounds. */
  hero: { font: 'display', size: 0.075, weight: 'medium', color: '#15161a', align: 'center' },
  /** The same in a colour gradient (set color/color2). */
  gradient: { font: 'display', size: 0.11, weight: 'medium', color: '#3f9c35', color2: '#a7d98f', align: 'center' },
  /** Huge heavy caps filling the frame — pair with behind: true for words behind the speaker. */
  impact: { font: 'heavy', size: 0.36, weight: 'black', color: '#ff5f0f', align: 'center', uppercase: true, stack: true, fit: true },
  /** White statement for dark or photo backgrounds. */
  statement: { font: 'display', size: 0.06, weight: 'medium', color: '#ffffff', align: 'center', shadow: true },
  /** A big serif in italic: the premium, magazine voice. */
  editorial: { font: 'serif', size: 0.085, weight: 'regular', italic: true, color: '#ffffff', align: 'center', tracking: -0.01, leading: 1.02, shadow: 'soft' },
  /** Glowing type for dark scenes. */
  neon: { font: 'display', size: 0.07, weight: 700, color: '#ffffff', accent: '#7c6cff', align: 'center', shadow: 'glow' },
  /** The small, wide-spaced caps line above a headline. */
  kicker: { font: 'display', size: 0.022, weight: 600, color: '#ffffff', align: 'center', uppercase: true, tracking: 0.18 },
} as const satisfies Record<string, LayerStyle>;
export type TextLook = keyof typeof textLooks;

/** A layer with sensible defaults for its kind; `patch` overrides anything. */
export function createLayer(kind: LayerKind, layerId: string, startFrame: number, endFrame: number, patch: Partial<EditorLayer> = {}, fps = 30): EditorLayer {
  const anim = (preset: AnimationPreset, seconds: number) => ({ preset, frames: Math.max(1, Math.round(fps * seconds)) });
  const base: Record<LayerKind, Omit<EditorLayer, 'id' | 'kind' | 'startFrame' | 'endFrame'>> = {
    text: { name: 'Text', x: 0.5, y: 0.5, width: 0.8, height: 0.2, rotate: 0, opacity: 1, style: { text: 'Your headline', ...textLooks.title }, enter: anim('blur-in', 0.55), exit: anim('blur-in', 0.35), automation: [] },
    box: { name: 'Box', x: 0.5, y: 0.5, width: 0.3, height: 0.2, rotate: 0, opacity: 1, style: { stroke: '#ffd84d', strokeWidth: 8, radius: 18, shadow: true }, enter: anim('pop', 0.3), exit: anim('fade', 0.2), automation: [] },
    highlight: { name: 'Highlight', x: 0.5, y: 0.5, width: 0.3, height: 0.08, rotate: 0, opacity: 1, style: { background: '#ffd84d55', stroke: '#ffd84d', strokeWidth: 3, radius: 10 }, enter: anim('wipe', 0.3), exit: anim('fade', 0.2), automation: [] },
    arrow: { name: 'Arrow', x: 0.5, y: 0.5, width: 0.05, height: 0.05, rotate: 0, opacity: 1, style: { stroke: '#ffd84d', strokeWidth: 10, fromX: 0.3, fromY: 0.3, curve: 0.25, shadow: true }, enter: anim('draw', 0.4), exit: anim('fade', 0.2), automation: [] },
    spotlight: { name: 'Spotlight', x: 0.5, y: 0.5, width: 0.35, height: 0.3, rotate: 0, opacity: 1, style: { dim: 0.65, radius: 24 }, enter: anim('fade', 0.35), exit: anim('fade', 0.35), automation: [] },
    notification: { name: 'Notification', x: 0.79, y: 0.12, width: 0.36, height: 0.11, rotate: 0, opacity: 1, style: { app: 'Messages', icon: '💬', title: 'New message', text: 'This is amazing!', glass: true, size: 0.022 }, enter: anim('drop', 0.45), exit: anim('blur-in', 0.3), automation: [] },
    card: { name: 'Card', x: 0.5, y: 0.5, width: 0.46, height: 0.18, rotate: 0, opacity: 1, style: { text: 'We’re looking to hire you! 💼', glass: true, size: 0.034 }, enter: anim('zoom-blur', 0.45), exit: anim('blur-in', 0.3), automation: [] },
    chips: { name: 'Chips', x: 0.72, y: 0.4, width: 0.3, height: 0.24, rotate: 0, opacity: 1, style: { items: ['First step', 'Second step', 'Third step'], background: '#f08c2e', color: '#ffffff', size: 0.026, stagger: 9 }, enter: anim('pop', 0.3), exit: anim('fade', 0.25), automation: [] },
    code: { name: 'Scene', x: 0.5, y: 0.5, width: 1, height: 1, rotate: 0, opacity: 1, style: {}, enter: anim('none', 0.2), exit: anim('none', 0.2), automation: [] },
    waveform: { name: 'Waveform', x: 0.5, y: 0.6, width: 0.5, height: 0.12, rotate: 0, opacity: 1, style: { color: '#3355dd', count: 48, spike: true }, enter: anim('wipe', 0.8), exit: anim('fade', 0.3), automation: [] },
    icons: { name: 'Icons', x: 0.5, y: 0.45, width: 0.5, height: 0.12, rotate: 0, opacity: 1, style: { items: ['note', 'note', 'note', 'note'], color: '#111118', accent: '#3355dd', stagger: 9 }, enter: anim('pop', 0.3), exit: anim('blur-in', 0.3), automation: [] },
    ring: { name: 'Ring', x: 0.5, y: 0.5, width: 0.22, height: 0.22, rotate: 0, opacity: 1, style: { color: '#3355dd', strokeWidth: 4 }, enter: anim('draw', 0.8), exit: anim('fade', 0.3), automation: [] },
    particles: { name: 'Particles', x: 0.5, y: 0.5, width: 1, height: 1, rotate: 0, opacity: 1, style: { count: 40, forms: [{ at: 0, shape: 'scatter', x: 0.5, y: 0.5, w: 0.4, h: 0.2, opacity: 0 },
      { at: 0.1, shape: 'line', x: 0.5, y: 0.5, w: 0.5, jitter: 0.006, stagger: 0.3 }, { at: 1.2, shape: 'bars', x: 0.5, y: 0.5, w: 0.5, h: 0.16, barWidth: 0.006, stagger: 0.35 }] }, enter: anim('none', 0.1), exit: anim('fade', 0.3), automation: [] },
    image: { name: 'Image', x: 0.5, y: 0.5, width: 0.12, height: 0.18, rotate: 0, opacity: 1, style: { radius: 24, shadow: true }, enter: anim('pop', 0.35), exit: anim('blur-in', 0.3), automation: [] },
    background: { name: 'Background', x: 0.5, y: 0.5, width: 1, height: 1, rotate: 0, opacity: 1, style: { fill: 'mesh', color: '#d9f2c8', color2: '#bfe3ff' }, enter: anim('fade', 0.2), exit: anim('fade', 0.2), automation: [] },
  };
  const defaults = base[kind];
  return { id: layerId, kind, startFrame, endFrame, ...defaults, ...patch, style: { ...defaults.style, ...(patch.style ?? {}) } };
}

export function layerLanePoints(layer: EditorLayer, param: LayerParam): AutomationPoint[] { return layer.automation.find(lane => lane.param === param)?.points ?? []; }
export function setLayerLane(layer: EditorLayer, param: LayerParam, points: AutomationPoint[]): EditorLayer {
  const info = layerParamInfo(layer, param), sorted = normalizePoints(points, info.min, info.max);
  const lanes = layer.automation.filter(lane => lane.param !== param);
  if (sorted.length) lanes.push({ param, points: sorted });
  lanes.sort((a, b) => layerParams.indexOf(a.param) - layerParams.indexOf(b.param));
  return { ...layer, automation: lanes };
}
export function layerValue(layer: EditorLayer, param: LayerParam, frame: number) {
  const info = layerParamInfo(layer, param); return curveValue(layerLanePoints(layer, param), frame, info.neutral, info.min, info.max);
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
/** Fast arrival, soft landing — the curve that makes motion feel snappy rather than floaty. */
/** Text with *highlighted* words: the plain text and which characters are highlighted (shown in the accent colour). */
export function markup(text: string) {
  let plain = '', on = false; const marked = new Set<number>();
  for (const ch of text) { if (ch === '*') { on = !on; continue; } if (on) marked.add(plain.length); plain += ch; }
  return { plain, marked };
}
export const expoOut = (t: number) => t >= 1 ? 1 : 1 - Math.pow(2, -10 * Math.max(0, t));
/** How many characters of a notification / card message are typed at a frame (shared by the picture and its sound). */
export const typedLength = (length: number, layer: EditorLayer, frame: number, fps: number) =>
  Math.floor(length * Math.max(0, Math.min(1, (frame - layer.startFrame - layer.enter.frames * 0.5) / Math.max(1, fps * Math.min(1.2, 0.025 * length + 0.25)))));
/** How far (0–1) a counting number (style.countFrom) has counted at a frame: fast, then settling. */
export const countProgress = (layer: EditorLayer, frame: number) => expoOut(Math.max(0, Math.min(1, (frame - layer.startFrame + 1) / Math.max(1, layer.enter.frames * 2.2))));
const backOut = (t: number) => { const c = 1.9; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };

/** Everything the renderer needs for one layer at one output frame. */
export type LayerState = { visible: boolean; x: number; y: number; scale: number; opacity: number; rotate: number;
  dx: number; dy: number; blur: number; reveal: number; wordsShown: number; charsShown: number; activeWord: number; draw: number; wipe: number };

function applyAnimation(state: LayerState, preset: AnimationPreset, t: number, entering: boolean, layer: EditorLayer, curve?: Ease, seconds = 0.4) {
  if (preset === 'none' || t >= (springy(curve) ? 1.8 : 1)) return;
  // With a spring the value passes 1 and comes back (overshoot); visibility (opacity, chars, wipe) stays clamped.
  const e = curve ? easeCurve(curve, t, seconds) : easeOut(clamp01(t)), ex = curve ? e : expoOut(clamp01(t));
  if (t >= 1 && !['pop', 'zoom', 'zoom-blur', 'drop', 'slide-up', 'slide-down', 'slide-left', 'slide-right', 'blur-in', 'chars', 'streak', 'scatter'].includes(preset)) return;
  switch (preset) {
    case 'fade': state.opacity *= e; break;
    case 'pop': state.scale *= entering ? Math.max(0, curve ? e : backOut(clamp01(t))) : 0.6 + 0.4 * e; state.opacity *= clamp01(t * 3); break;
    case 'slide-up': state.dy += (1 - e) * 0.08; state.opacity *= clamp01(e); break;
    case 'slide-down': state.dy -= (1 - e) * 0.08; state.opacity *= clamp01(e); break;
    case 'slide-left': state.dx += (1 - e) * 0.12; state.opacity *= clamp01(e); break;
    case 'slide-right': state.dx -= (1 - e) * 0.12; state.opacity *= clamp01(e); break;
    case 'zoom': state.scale *= 1.6 - 0.6 * e; state.opacity *= clamp01(e); break;
    case 'blur': state.blur += Math.max(0, 1 - e) * 24; state.opacity *= clamp01(e); break;
    case 'wipe': state.wipe = Math.min(state.wipe, clamp01(e)); break;
    case 'draw': state.draw = Math.min(state.draw, clamp01(e)); break;
    case 'typewriter': state.charsShown = Math.min(state.charsShown, Math.floor(markup(layer.style.text ?? '').plain.length * clamp01(t))); break;
    // Kinetic text animates word by word / letter by letter in the renderer; other layers get the whole-layer version.
    case 'blur-in': case 'chars': if (layer.kind !== 'text') { const x = ex; state.opacity *= clamp01(x * 1.4); state.blur += Math.max(0, 1 - x) * 26; state.dy += (entering ? 1 : -1) * (1 - x) * 0.04; } break;
    case 'streak': if (layer.kind !== 'text') { const x = ex; state.dx += (entering ? 1 : -1) * (1 - x) * 0.35; state.opacity *= clamp01(x * 2); } break;
    case 'scatter': if (layer.kind !== 'text') { state.scale *= Math.max(0, curve ? e : backOut(clamp01(t))); state.opacity *= clamp01(t * 3); } break;
    case 'zoom-blur': { const x = ex; state.scale *= 1 + (1 - x) * (entering ? 0.7 : 0.35); state.blur += Math.max(0, 1 - x) * 34; state.opacity *= clamp01(x * 1.6); break; }
    case 'drop': { const x = ex; state.dy -= (1 - x) * 0.14; state.blur += Math.max(0, 1 - x) * 18; state.opacity *= clamp01(x * 1.6); break; }
    case 'words': break;
    // Variable-font entrances: the renderer moves weight / letter spacing; the layer only fades in quickly.
    case 'weight-in': case 'track-in': state.opacity *= clamp01(e * 2.5); break;
  }
}

/** Evaluate a layer at an output frame: base values → automation → in/out animation. */
/** Kinetic text splits into words or letters for these presets. */
export const kineticUnit = (preset: AnimationPreset): 'words' | 'chars' | null => preset === 'blur-in' ? 'words' : preset === 'chars' || preset === 'streak' || preset === 'scatter' ? 'chars' : null;
export type UnitMotion = { x: number; y: number; opacity: number; blur: number; blurX: number; scale: number; rotate: number };
const rand = (i: number, k: number) => { const v = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return v - Math.floor(v); };
/** One word/letter of kinetic text at progress t (0 → just starting, 1 → settled). Offsets and blur are in em. */
export function unitMotion(preset: AnimationPreset, t: number, index: number, entering: boolean, curve?: Ease, seconds = 0.4): UnitMotion {
  const m: UnitMotion = { x: 0, y: 0, opacity: 1, blur: 0, blurX: 0, scale: 1, rotate: 0 };
  if (t >= (entering && springy(curve) ? 1.8 : 1)) return m;
  const e = curve ? easeCurve(curve, t, seconds) : expoOut(clamp01(t)), r = 1 - e, rp = Math.max(0, r), dir = entering ? 1 : -1;
  if (preset === 'blur-in' || preset === 'chars') { m.opacity = clamp01(e * 1.3); m.y = dir * r * 0.45; m.blur = rp * 0.32; m.scale = 1 - r * 0.05; }
  else if (preset === 'streak') { m.x = dir * r * 2.4; m.blurX = rp * 0.95; m.opacity = clamp01(e * 2.2); }
  else if (preset === 'scatter') { m.x = (rand(index, 1) - 0.5) * 7 * r; m.y = (rand(index, 2) - 0.5) * 4.5 * r; m.rotate = (rand(index, 3) - 0.5) * 100 * r;
    m.scale = 1 + (rand(index, 4) - 0.35) * 1.5 * r; m.blur = rp * 0.22; m.opacity = clamp01(e * 1.8); }
  else { m.opacity = clamp01(e); }
  return m;
}
/** Where unit `index` of `count` is in its own in- or out-animation at `frame`. */
export function unitProgress(layer: EditorLayer, frame: number, index: number, count: number, units: 'words' | 'chars') {
  const stagger = layer.style.stagger ?? (units === 'chars' ? 1.3 : 3.2), local = frame - layer.startFrame, remaining = layer.endFrame - frame - 1;
  const enter = kineticUnit(layer.enter.preset) ? Math.max(0, Math.min(springy(layer.enter.ease) ? 1.8 : 1, (local + 1 - index * stagger) / layer.enter.frames)) : 1;
  const exit = kineticUnit(layer.exit.preset) ? clamp01((remaining - (count - 1 - index) * stagger) / layer.exit.frames) : 1;
  return { enter, exit };
}

export function evaluateLayer(layer: EditorLayer, frame: number, fps = 30): LayerState {
  const state: LayerState = { visible: frame >= layer.startFrame && frame < layer.endFrame,
    x: layerValue(layer, 'x', frame), y: layerValue(layer, 'y', frame), scale: layerValue(layer, 'scale', frame), opacity: layerValue(layer, 'opacity', frame), rotate: layerValue(layer, 'rotate', frame),
    dx: 0, dy: 0, blur: 0, reveal: 1, wordsShown: Infinity, charsShown: Infinity, activeWord: -1, draw: 1, wipe: 1 };
  if (!state.visible) return state;
  const local = frame - layer.startFrame, remaining = layer.endFrame - frame - 1;
  const words = (layer.style.text ?? '').trim().split(/\s+/).filter(Boolean);
  if (layer.enter.preset === 'words' || layer.exit.preset === 'words') {
    // Kinetic text: words land one after another (on their spoken frames when known), the newest one accented.
    const times = layer.style.wordFrames?.length === words.length ? layer.style.wordFrames : words.map((_, i) => Math.round(i * layer.enter.frames / Math.max(1, words.length)));
    if (layer.enter.preset === 'words') { state.wordsShown = times.filter(t => t <= local).length; state.activeWord = state.wordsShown - 1; }
  }
  // Kinetic text presets animate word by word / letter by letter in the renderer, so the layer itself stays put.
  const perUnit = (preset: AnimationPreset) => layer.kind === 'text' && kineticUnit(preset) !== null;
  if (!perUnit(layer.enter.preset)) applyAnimation(state, layer.enter.preset, layer.enter.preset === 'words' ? 1 : (local + 1) / layer.enter.frames, true, layer, layer.enter.ease, layer.enter.frames / fps);
  if (remaining < layer.exit.frames && !perUnit(layer.exit.preset)) applyAnimation(state, layer.exit.preset === 'words' ? 'fade' : layer.exit.preset, remaining / layer.exit.frames, false, layer, layer.exit.ease, layer.exit.frames / fps);
  if (layer.style.drift) state.dx += layer.style.drift * local / fps;
  if (layer.style.float) state.dy += layer.style.float * Math.sin((local / fps) * Math.PI * 2 / 3.2 + rand(layer.id.length, 7) * 6);
  return state;
}

/** Word-level timing for kinetic text: how far (0–1) word `index` is through its own pop-in at `frame`. */
export function wordProgress(layer: EditorLayer, index: number, frame: number, fps: number) {
  const words = (layer.style.text ?? '').trim().split(/\s+/).filter(Boolean);
  const times = layer.style.wordFrames?.length === words.length ? layer.style.wordFrames : words.map((_, i) => Math.round(i * layer.enter.frames / Math.max(1, words.length)));
  return clamp01((frame - layer.startFrame - (times[index] ?? 0) + 1) / Math.max(2, Math.round(fps * 0.12)));
}

/** After cutting ranges out of the timeline: layers move and shrink with the footage; ones entirely inside a cut go. */
export function cutLayers(layers: EditorLayer[] | undefined, cuts: { startFrame: number; endFrame: number }[], mapFrame: (frame: number) => number): EditorLayer[] | undefined {
  if (!layers) return layers;
  return layers.flatMap(layer => {
    const startFrame = mapFrame(layer.startFrame), endFrame = mapFrame(layer.endFrame);
    if (endFrame <= startFrame) return [];
    const wordFrames = layer.style.wordFrames?.map(t => Math.max(0, mapFrame(layer.startFrame + t) - startFrame));
    return [{ ...layer, startFrame, endFrame, style: wordFrames ? { ...layer.style, wordFrames } : layer.style,
      automation: layer.automation.map(lane => ({ ...lane, points: cutPoints(lane.points, cuts, mapFrame) })).filter(lane => lane.points.length) }];
  });
}
/** After inserting `length` frames at `at`: layers after it move right; a layer spanning it grows. */
export function insertLayers(layers: EditorLayer[] | undefined, at: number, length: number): EditorLayer[] | undefined {
  if (!layers || !length) return layers;
  const shift = (f: number) => f >= at ? f + length : f;
  return layers.map(layer => ({ ...layer, startFrame: shift(layer.startFrame), endFrame: layer.endFrame > at ? layer.endFrame + length : layer.endFrame,
    automation: layer.automation.map(lane => ({ ...lane, points: lane.points.map(point => ({ ...point, frame: shift(point.frame) })) })) }));
}

/** Move / trim a layer on the timeline; its automation moves with it. */
export function moveLayer(layer: EditorLayer, mode: 'move' | 'start' | 'end', delta: number, total: number): EditorLayer {
  let start = layer.startFrame, end = layer.endFrame;
  if (mode === 'move') { const d = Math.max(-start, Math.min(total - end, Math.round(delta))); start += d; end += d;
    return { ...layer, startFrame: start, endFrame: end, automation: layer.automation.map(lane => ({ ...lane, points: lane.points.map(point => ({ ...point, frame: Math.max(0, point.frame + d) })) })) }; }
  if (mode === 'start') start = Math.max(0, Math.min(end - 1, start + Math.round(delta)));
  else end = Math.max(start + 1, Math.min(total, end + Math.round(delta)));
  return { ...layer, startFrame: start, endFrame: end };
}

/** Icons row: when icon `index` pops in, and when it acts (a toggle switches, bubbles burst, a dash flies) — 0.6 s later. */
export function iconTimes(layer: EditorLayer, index: number, fps: number) {
  const appear = layer.startFrame + index * (layer.style.stagger ?? 9);
  return { appear, act: appear + Math.round(0.6 * fps) };
}
