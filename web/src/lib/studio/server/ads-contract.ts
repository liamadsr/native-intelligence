/**
 * Ads in the Studio: the brand kit, a batch of static ads and a motion ad's brief, as data both the app and the
 * Studio worker read. Pure (zod only), so the worker can import its types and the tests its values.
 *
 *   BrandKit      a Studio project's brand: palette tokens, the roles the templates draw with, the approved logo
 *                 colour per ground (logoOn), the two logo masks (library images), the serif and sans font roles
 *                 (the brand's own licensed files, stored in the Studio, or a free family named as a stand-in), the
 *                 rules the brand check enforces, the motion rules and the sound library motion ads mix from.
 *                 Stored as one record (studio_record, collection `brand-kit`, key = the Studio project id).
 *   StaticBatch   ads by template id with their copy and images, in the sizes asked for (square, portrait,
 *                 story, landscape). Images are library assets, named by id or by their name in the library.
 *   MotionBrief   one 9:16 motion ad: a template (cut-on-beat, pull-out), seconds, background segments, sound,
 *                 copy, formats.
 *
 * A kit can be pasted in the shape the local brand folders keep it (brand.json, fonts.json, rules.json and
 * sound.json, alone or together): normaliseKit turns any of them into this shape and merges it into the kit.
 */
import { z } from 'zod'
import type { EditorAsset } from '../engine/contracts'

// ---- small parts -----------------------------------------------------------------------------------------------

/** A palette token: a CSS custom property name (`--<token>`). */
export const TokenSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,40}$/, 'A colour token is a name like warmSand or brand-green')
export const HexSchema = z.string().regex(/^#[\da-fA-F]{6}$/, 'A colour is #RRGGBB')
const finite = z.number().finite()

// ---- what may reach a page or a filter graph ---------------------------------------------------------------------
// The ads are drawn from HTML pages and mixed with FFmpeg, and a kit or a brief is anyone's text. Every value that is
// written into CSS, an attribute, a script or a filter graph is held to a grammar here (and again in the worker,
// which also escapes it for where it goes).

/** A font family (and any other font name that reaches CSS): letters (any script), digits, space, - and _. */
export const FONT_FAMILY = /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,79}$/u
export const FontFamilySchema = z.string().regex(FONT_FAMILY, 'A font family is letters, numbers, spaces, - and _ (at most 80)')
/** A weight's name (thin, light, regular, medium, bold, …). */
const WeightNameSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,30}$/, 'A weight name is lower-case letters, numbers, - and _')
/** A gradient map's name: it names files in the worker. */
export const GRADE_NAME = /^[a-z0-9_-]{1,40}$/
export const GradeNameSchema = z.string().regex(GRADE_NAME, 'A grade name is lower-case letters, numbers, - and _')

/** The functions a paint (a veil, a shade) may call: colours and gradients, nothing that loads or reads anything. */
const PAINT_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'linear-gradient', 'radial-gradient', 'repeating-linear-gradient', 'repeating-radial-gradient'])
const PAINT_UNITS = new Set(['', '%', 'deg', 'rad', 'grad', 'turn', 'px', 'em', 'rem', 'vw', 'vh', 'vmin', 'vmax'])

/**
 * Whether `value` is a paint the ads may draw with: a preset or token name (`sand`, `brand-green`), or a CSS colour or
 * gradient made only of colour and gradient functions, hex colours, numbers with a unit (%, deg, px, …), keywords,
 * commas, spaces and balanced parentheses. A small tokenizer, so quotes, `<`, `>`, `{`, `}`, `;`, `\`, `/`, `@`, `:`,
 * `!`, `url(`, `var(`, `expression(` and anything else that could leave the value or fetch something are refused. Pure.
 */
export function isPaint(value: string): boolean {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000) return false
  if (/^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(value)) return true
  let depth = 0
  let i = 0
  let calls = 0
  while (i < value.length) {
    const rest = value.slice(i)
    let m: RegExpExecArray | null
    if ((m = /^[ \t\n]+/.exec(rest)) || (m = /^,/.exec(rest))) {
      i += m[0].length
    } else if ((m = /^#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z_-])/.exec(rest))) {
      if (![4, 5, 7, 9].includes(m[0].length)) return false
      i += m[0].length
    } else if ((m = /^[+-]?(?:\d+\.?\d*|\.\d+)([a-zA-Z%]*)/.exec(rest))) {
      if (!PAINT_UNITS.has(m[1]!.toLowerCase())) return false
      i += m[0].length
    } else if ((m = /^[A-Za-z][A-Za-z-]*/.exec(rest))) {
      const word = m[0]
      i += word.length
      if (value[i] === '(') {
        if (!PAINT_FUNCTIONS.has(word.toLowerCase())) return false
        depth++
        calls++
        i++
        if (depth > 4 || calls > 64) return false
      }
    } else if (rest[0] === ')') {
      if (--depth < 0) return false
      i++
    } else return false
  }
  return depth === 0
}
export const PaintSchema = z.string().max(1000).refine(isPaint, 'A veil or shade is a preset name, or a CSS colour or gradient (rgba(), hsl(), linear-gradient(), radial-gradient(), hex colours, %, deg, px)')

/** The pure audio filters a kit's sound may run through FFmpeg: none opens, writes or loads anything. */
export const AUDIO_FILTERS = ['volume', 'highpass', 'lowpass', 'bandpass', 'bandreject', 'equalizer', 'bass', 'treble', 'lowshelf', 'highshelf', 'afade', 'atempo', 'acompressor', 'alimiter', 'loudnorm', 'aecho', 'adelay', 'apad', 'atrim', 'dynaudnorm', 'pan', 'aresample', 'aformat', 'stereotools', 'extrastereo'] as const
const AUDIO_FILTER_SET: ReadonlySet<string> = new Set(AUDIO_FILTERS)

/**
 * A kit sound's `af` as its filters, `name` or `name=args` each (comma separated), or null when it is not allowed: a
 * filter outside AUDIO_FILTERS, arguments with anything but letters, numbers and _ . : = + - | and spaces, or an
 * argument named file, filename or path. Pure.
 */
export function parseAudioFilters(af: string): { name: string; args: string }[] | null {
  if (typeof af !== 'string' || af.length > 400) return null
  if (!af.trim()) return []
  const out: { name: string; args: string }[] = []
  for (const entry of af.split(',')) {
    const m = /^\s*([a-z][a-z0-9_]*)\s*(?:=([A-Za-z0-9_.:=+\-| ]*))?\s*$/.exec(entry)
    if (!m || !AUDIO_FILTER_SET.has(m[1]!)) return null
    const args = (m[2] ?? '').trim()
    if (args.split(':').some((part) => /^\s*(file|filename|path|f_file)\s*=/i.test(part))) return null
    out.push({ name: m[1]!, args })
  }
  return out
}
export const AudioFilterSchema = z.string().max(400).refine((af) => parseAudioFilters(af) !== null, `An audio filter is a comma-separated list of ${AUDIO_FILTERS.join(', ')} with plain arguments (letters, numbers, _ . : = + - | and spaces)`)

/** The longest brand-kit pattern: the copy rules are words and short phrases. */
export const MAX_PATTERN = 200
/**
 * Why a brand kit's pattern (a copy rule) can't be used, or null: too long, not a regular expression, or a quantified
 * group that itself repeats (`(a+)+`, `(\w*)*`, `(a|aa){2,}`): the shapes that can take forever on a few words. Pure.
 */
export function patternProblem(pattern: string): string | null {
  if (typeof pattern !== 'string' || !pattern) return 'is empty'
  if (pattern.length > MAX_PATTERN) return `is longer than ${MAX_PATTERN} characters`
  try {
    new RegExp(pattern, 'i')
  } catch {
    return 'is not a regular expression'
  }
  // Each open group: whether something inside it repeats (a quantifier, or an alternation that can overlap).
  const stack: { repeats: boolean }[] = []
  let lastClosedRepeats = false
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '\\') {
      i++
      lastClosedRepeats = false
      continue
    }
    if (c === '[') {
      // a character class: skip to its end
      i++
      if (pattern[i] === '^') i++
      if (pattern[i] === ']') i++
      while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1
      lastClosedRepeats = false
      continue
    }
    if (c === '(') {
      stack.push({ repeats: false })
      lastClosedRepeats = false
      continue
    }
    if (c === ')') {
      const g = stack.pop()
      lastClosedRepeats = !!g?.repeats
      if (g?.repeats && stack.length) stack[stack.length - 1]!.repeats = true
      continue
    }
    const quantifier = c === '+' || c === '*' || (c === '{' && /^\{\d+(,\d*)?\}/.test(pattern.slice(i)))
    if (quantifier) {
      if (lastClosedRepeats) return 'repeats a group that already repeats (like (a+)+), which can take forever'
      const unbounded = c !== '{' || /^\{\d+,\}/.test(pattern.slice(i)) || Number(/^\{\d+,(\d+)\}/.exec(pattern.slice(i))?.[1] ?? 0) > 1 || Number(/^\{(\d+)\}/.exec(pattern.slice(i))?.[1] ?? 0) > 1
      if (unbounded && stack.length) stack[stack.length - 1]!.repeats = true
    }
    // An optional part (`a?`, not `(?:` and not a lazy `+?`) and an alternation also let a repeated group match one
    // stretch of text in many ways.
    if (c === '?' && pattern[i - 1] !== '(' && !'+*}?'.includes(pattern[i - 1] ?? '') && stack.length) stack[stack.length - 1]!.repeats = true
    if (c === '|' && stack.length) stack[stack.length - 1]!.repeats = true
    lastClosedRepeats = false
  }
  return null
}
const PatternSchema = z.string().min(1).max(MAX_PATTERN).superRefine((p, ctx) => {
  const problem = patternProblem(p)
  if (problem) ctx.addIssue({ code: 'custom', message: `The pattern ${problem}` })
})

/**
 * The colours the static templates draw with, by what they do. The kit maps each to one of its palette tokens.
 *   ground     the main light ground (cards, panels, the page itself)
 *   groundAlt  a second light ground (word tiles, offer cards, carousel cards)
 *   deep       the deep ground (end cards, review cards) and dark ink on light grounds
 *   ink        the darkest text colour
 *   accent     the accent (buttons, avatars, icons)
 *   muted      quiet secondary text
 *   line       hairlines and outlines
 *   highlight  the highlighted caps line on photos
 *   star       review stars
 *   white      white type and logos on photos
 */
export const TEMPLATE_ROLES = ['ground', 'groundAlt', 'deep', 'ink', 'accent', 'muted', 'line', 'highlight', 'star', 'white'] as const
export type TemplateRole = (typeof TEMPLATE_ROLES)[number]

/** One cut of a font: a stored file (a key under brand-kits/), or, before it is uploaded, the file name a pasted kit names. */
export const FontFaceSchema = z.object({
  file: z.string().min(1).max(300),
  weight: z.union([z.number().int().min(1).max(1000), z.string().regex(/^\d{1,4}( \d{1,4})?$/)]),
  style: z.enum(['normal', 'italic']).default('normal'),
}).strict()
export type KitFontFace = z.infer<typeof FontFaceSchema>

/** A font role: the brand's family (its licensed cuts) or a free family standing in for it. */
export const FontRoleSchema = z.object({
  /** The family name the ads and the editor use. */
  family: FontFamilySchema,
  /** The licensed font's own name, for the report ("<brand> → <stand-in>"). */
  brand: z.string().max(120).optional(),
  /** A free family (Fontshare or Google Fonts) drawn instead while the brand's files are not uploaded. */
  standIn: z.union([FontFamilySchema, z.literal(false)]).optional(),
  faces: z.array(FontFaceSchema).max(24).default([]),
  /** Weights by name: the serif uses thin, light and regular; the sans medium and bold. */
  weights: z.record(WeightNameSchema, z.number().int().min(1).max(1000)).default({}),
  opsz: finite.optional(),
  /** Cuts the brand did not supply (the nearest is used), for the report. */
  missing: z.array(z.string().max(120)).max(24).optional(),
}).strict()
export type KitFontRole = z.infer<typeof FontRoleSchema>

/** A copy rule: words an ad may not say (matched case-insensitively), unless `unless` also matches. */
export const CopyBanSchema = z.object({
  pattern: PatternSchema,
  rule: z.string().min(1).max(40),
  why: z.string().min(1).max(200),
  unless: PatternSchema.optional(),
}).strict()

/** What the static brand check enforces beyond the palette and the safe band. */
export const StaticRulesSchema = z.object({
  /** TYPE-1: the serif is never set in caps; the sans always is. */
  casing: z.object({ serifCaps: z.boolean().default(false), sansCaps: z.boolean().default(true) }).strict().default({ serifCaps: false, sansCaps: true }),
  /** VOICE-*, FAIL-*, AVOID-*, ARCH-*: words the copy may not use. */
  copyBans: z.array(CopyBanSchema).max(200).default([]),
  /** LOGO-3/4/5a: the logo's minimum width (px), its clear space (one cap height = logo height / capRatio), and the contrast it needs on a photo. */
  logo: z.object({ minWidth: finite.min(1).default(80), capRatio: finite.min(0.5).default(2.07), photoContrast: finite.min(1).default(3) }).strict().default({ minWidth: 80, capRatio: 2.07, photoContrast: 3 }),
  /** VOICE-7: headlines longer than this many words are flagged. */
  headlineMaxWords: z.number().int().min(1).max(40).default(8),
}).strict()

/** The motion rules every motion ad is checked against (a brand folder's motion/rules.json). Pixels in the 1080×1920 frame. */
export const MotionRulesSchema = z.object({
  service: z.object({ minPx: finite.positive(), by: finite.min(0), minSeconds: finite.min(0) }).strict(),
  minPx: finite.positive(),
  safe: z.object({ top: finite.min(0), bottom: finite.positive(), side: finite.min(0) }).strict(),
  maxHold: finite.positive(),
  loudness: z.object({ lufs: finite, tolerance: finite.min(0), peak: finite }).strict(),
  banned: z.array(z.object({ pattern: PatternSchema, rule: z.string().min(1).max(40), why: z.string().min(1).max(200) }).strict()).max(200).default([]),
}).passthrough()
export type MotionRules = z.infer<typeof MotionRulesSchema>
export const DEFAULT_MOTION_RULES: MotionRules = {
  service: { minPx: 40, by: 1, minSeconds: 2 },
  minPx: 26,
  safe: { top: 384, bottom: 1498, side: 48 },
  maxHold: 2.5,
  loudness: { lufs: -17, tolerance: 1.5, peak: -1 },
  banned: [],
}

/** A sound in the library: a library audio asset (by id, or by its name in the library: `src`), with how it is used. */
export const SoundSchema = z.object({
  asset: z.string().max(250).optional(),
  src: z.string().max(400).optional(),
  kind: z.enum(['music', 'sfx']),
  key: z.string().max(20).optional(),
  pitched: z.boolean().optional(),
  use: z.tuple([finite.min(0), finite.min(0)]).optional(),
  loop: z.tuple([finite.min(0), finite.min(0)]).nullable().optional(),
  xfade: finite.min(0).max(5).optional(),
  af: AudioFilterSchema.optional(),
  lufs: finite.optional(),
  notes: z.string().max(1000).optional(),
}).strict().refine((s) => s.asset || s.src, 'A sound names its library asset (asset) or file (src)')
export type KitSound = z.infer<typeof SoundSchema>
export const SoundMixSchema = z.object({
  musicLufs: finite,
  sfxUnder: finite.min(0),
  musicFadeIn: finite.min(0),
  sfxFadeIn: finite.min(0),
  fadeOut: finite.min(0),
}).strict()
export const DEFAULT_MIX = { musicLufs: -18, sfxUnder: 8, musicFadeIn: 0.4, sfxFadeIn: 0.05, fadeOut: 0.6 }
export const SoundLibrarySchema = z.object({
  mix: SoundMixSchema.default(DEFAULT_MIX),
  sounds: z.record(z.string().min(1).max(80), SoundSchema).default({}),
  /** Sounds that failed and why (kept for the agent to read). */
  avoid: z.unknown().optional(),
}).strict()

/** The shades the static templates lay under type, as "r,g,b" (the brand's own ads' values unless the kit says otherwise). */
export const ShadesSchema = z.object({
  /** under light type on photos */
  dark: z.string().regex(/^\d{1,3},\d{1,3},\d{1,3}$/).default('36,30,28'),
  /** under dark type on photos */
  light: z.string().regex(/^\d{1,3},\d{1,3},\d{1,3}$/).default('240,234,228'),
  /** glass panels */
  glass: z.string().regex(/^\d{1,3},\d{1,3},\d{1,3}$/).default('52,48,45'),
  /** the warm full-photo shade and veils (older templates) */
  warm: z.string().regex(/^\d{1,3},\d{1,3},\d{1,3}$/).default('65,61,59'),
  /** the deep-ground shade and card shadows (older templates) */
  deep: z.string().regex(/^\d{1,3},\d{1,3},\d{1,3}$/).default('36,52,40'),
}).strict()
export const DEFAULT_SHADES = { dark: '36,30,28', light: '240,234,228', glass: '52,48,45', warm: '65,61,59', deep: '36,52,40' }

export const LogoRefSchema = z.object({ assetId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/) }).strict()

export const BrandKitSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1).max(120),
  palette: z.record(TokenSchema, HexSchema).refine((p) => Object.keys(p).length <= 40, 'At most 40 colours'),
  roles: z.object(Object.fromEntries(TEMPLATE_ROLES.map((r) => [r, TokenSchema.optional()])) as Record<TemplateRole, z.ZodOptional<typeof TokenSchema>>).strict().default({}),
  /** LOGO-5: the approved logo colour (a token) per ground (a token). A ground missing here may not carry the logo. */
  logoOn: z.record(TokenSchema, TokenSchema).default({}),
  /** LOGO-5a: the logo's colour on photographs. */
  logoOnPhoto: TokenSchema.optional(),
  logos: z.object({ primary: LogoRefSchema.optional(), mark: LogoRefSchema.optional() }).strict().default({}),
  fonts: z.object({ serif: FontRoleSchema, sans: FontRoleSchema }).strict(),
  rules: StaticRulesSchema.default(StaticRulesSchema.parse({})),
  motion: z.object({
    rules: MotionRulesSchema.default(DEFAULT_MOTION_RULES),
    /** Gradient maps for backgrounds, dark → mid → light (the defaults: forest, sand, mint). */
    grades: z.record(GradeNameSchema, z.tuple([HexSchema, HexSchema, HexSchema])).optional(),
    /** Veil presets (a CSS colour or gradient: PaintSchema) beside the defaults: sand, sand-low, photo, forest. */
    veils: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/, 'A veil name is letters, numbers, - and _'), PaintSchema).optional(),
  }).strict().default({ rules: DEFAULT_MOTION_RULES }),
  sounds: SoundLibrarySchema.default({ mix: DEFAULT_MIX, sounds: {} }),
  shades: ShadesSchema.default(DEFAULT_SHADES),
  /** Anything else a pasted brand.json carried (kept, not used). */
  extra: z.record(z.string(), z.unknown()).optional(),
}).strict().superRefine((kit, ctx) => {
  const has = (t: string) => t in kit.palette
  for (const [role, token] of Object.entries(kit.roles)) if (token && !has(token)) ctx.addIssue({ code: 'custom', path: ['roles', role], message: `"${token}" is not in the palette` })
  for (const [bg, logo] of Object.entries(kit.logoOn)) {
    if (!has(bg)) ctx.addIssue({ code: 'custom', path: ['logoOn', bg], message: `"${bg}" is not in the palette` })
    if (!has(logo)) ctx.addIssue({ code: 'custom', path: ['logoOn', bg], message: `"${logo}" is not in the palette` })
  }
  if (kit.logoOnPhoto && !has(kit.logoOnPhoto)) ctx.addIssue({ code: 'custom', path: ['logoOnPhoto'], message: `"${kit.logoOnPhoto}" is not in the palette` })
  for (const ban of [...kit.rules.copyBans, ...kit.motion.rules.banned]) {
    const problem = patternProblem(ban.pattern)
    if (problem) ctx.addIssue({ code: 'custom', path: ['rules'], message: `The copy rule ${ban.rule} has a pattern that ${problem}` })
  }
})
export type BrandKit = z.infer<typeof BrandKitSchema>

/** A new kit: a name and the two font roles as free families, nothing else yet. */
export function emptyKit(name = 'Brand'): BrandKit {
  return BrandKitSchema.parse({
    schemaVersion: 1,
    name,
    palette: {},
    fonts: { serif: { family: 'Instrument Serif', standIn: 'Instrument Serif' }, sans: { family: 'Inter', standIn: 'Inter' } },
  })
}

// ---- pasting a brand folder's files ----------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const baseName = (p: string) => p.split('/').pop() ?? p

/** Which of a brand folder's files a pasted object is, by its shape. */
export function pastedKind(value: unknown): 'kit' | 'brand' | 'fonts' | 'rules' | 'sound' | 'bundle' | null {
  if (!isObject(value)) return null
  if (value.schemaVersion === 1 && isObject(value.fonts) && isObject(value.palette)) return 'kit'
  if (['brand.json', 'fonts.json', 'rules.json', 'sound.json', 'brand', 'rules', 'sound'].some((k) => k in value) && !('palette' in value)) return 'bundle'
  if (isObject(value.palette)) return 'brand'
  if (isObject(value.serif) && isObject(value.sans)) return 'fonts'
  if (isObject(value.service) && isObject(value.loudness)) return 'rules'
  if (isObject(value.sounds) || isObject(value.mix)) return 'sound'
  return null
}

/** A brand.json's palette ({token: {hex}} or {token: hex}) as {token: hex}. */
function paletteOf(raw: unknown): Record<string, string> {
  if (!isObject(raw)) return {}
  const out: Record<string, string> = {}
  for (const [token, value] of Object.entries(raw)) {
    const hex = typeof value === 'string' ? value : isObject(value) && typeof value.hex === 'string' ? value.hex : null
    if (hex && /^#[\da-fA-F]{6}$/.test(hex.trim())) out[token] = hex.trim().toUpperCase()
  }
  return out
}

/** A fonts.json role as a kit font role: `faces` kept (file names until uploaded), the older `files` form turned into faces. */
function fontRoleOf(raw: unknown, before?: KitFontRole): KitFontRole | undefined {
  if (!isObject(raw)) return before
  const faces: KitFontFace[] = Array.isArray(raw.faces)
    ? raw.faces.filter(isObject).map((f) => ({ file: String(f.file ?? ''), weight: (typeof f.weight === 'number' ? f.weight : String(f.weight ?? '400')) as KitFontFace['weight'], style: f.style === 'italic' ? 'italic' as const : 'normal' as const }))
    : isObject(raw.files)
      ? Object.entries(raw.files).filter(([, f]) => typeof f === 'string').map(([style, f]) => ({ file: String(f), weight: '100 900', style: style === 'italic' ? 'italic' as const : 'normal' as const }))
      : []
  // Faces already uploaded under the same file name stay uploaded.
  const uploaded = new Map((before?.faces ?? []).filter((f) => isStoredFontKey(f.file)).map((f) => [fontFileName(f.file), f]))
  const merged = faces.filter((f) => f.file).map((f) => uploaded.get(baseName(f.file)) ?? { ...f, file: baseName(f.file) })
  return FontRoleSchema.parse({
    family: String(raw.family ?? before?.family ?? 'Brand'),
    ...(typeof raw.brand === 'string' ? { brand: raw.brand } : before?.brand ? { brand: before.brand } : {}),
    ...(raw.standIn === false || typeof raw.standIn === 'string' ? { standIn: raw.standIn } : before?.standIn !== undefined ? { standIn: before.standIn } : {}),
    faces: merged.length ? merged : before?.faces ?? [],
    weights: isObject(raw.weights) ? Object.fromEntries(Object.entries(raw.weights).filter(([, w]) => typeof w === 'number')) : before?.weights ?? {},
    ...(typeof raw.opsz === 'number' ? { opsz: raw.opsz } : {}),
    ...(Array.isArray(raw.missing) ? { missing: raw.missing.map(String) } : {}),
  })
}

/** A stored font file's key: brand-kits/<project>/fonts/<name>. */
export const isStoredFontKey = (file: string) => /^brand-kits\/[a-zA-Z0-9_-]+\/fonts\/[^/]+$/.test(file)
/** The file name a stored font key ends in (`<sha8>-<name>` → `<name>`). */
export const fontFileName = (file: string) => baseName(file).replace(/^[a-f0-9]{8}-/, '')

/** A sound.json's sounds: `src` (a path in the brand's motion folder) kept as the library file it names. */
function soundsOf(raw: Record<string, unknown>, before: BrandKit['sounds']): BrandKit['sounds'] {
  const sounds: Record<string, KitSound> = { ...before.sounds }
  if (isObject(raw.sounds)) {
    for (const [name, s] of Object.entries(raw.sounds)) {
      if (!isObject(s)) continue
      const old = before.sounds[name]
      sounds[name] = SoundSchema.parse({
        ...Object.fromEntries(Object.entries(s).filter(([k]) => ['kind', 'key', 'pitched', 'use', 'loop', 'xfade', 'af', 'lufs', 'notes', 'asset'].includes(k))),
        ...(typeof s.src === 'string' ? { src: baseName(s.src) } : {}),
        ...(old?.asset && !s.asset ? { asset: old.asset } : {}),
      })
    }
  }
  return SoundLibrarySchema.parse({ mix: isObject(raw.mix) ? { ...before.mix, ...raw.mix } : before.mix, sounds, ...(raw.avoid !== undefined ? { avoid: raw.avoid } : before.avoid !== undefined ? { avoid: before.avoid } : {}) })
}

/**
 * Any pasted brand material merged into a kit: the kit's own shape, one of a brand folder's files (brand.json,
 * fonts.json, rules.json, sound.json), or several of them under their names ({ "brand.json": …, "fonts.json": … }).
 * Throws a zod error (or a plain one) saying what is wrong.
 */
export function normaliseKit(value: unknown, before?: BrandKit | null): BrandKit {
  const base = before ?? null
  const kind = pastedKind(value)
  if (kind === 'kit') {
    const parsed = BrandKitSchema.parse(value)
    // Logos and uploaded font files the person did not mention are kept.
    if (base) {
      if (!parsed.logos.primary && base.logos.primary) parsed.logos.primary = base.logos.primary
      if (!parsed.logos.mark && base.logos.mark) parsed.logos.mark = base.logos.mark
    }
    return parsed
  }
  if (!kind) throw new Error('That is not a brand kit: paste the kit, or a brand folder\'s brand.json, fonts.json, rules.json or sound.json (or several, under their file names).')
  let kit: Record<string, unknown> = structuredClone((base ?? emptyKit()) as unknown as Record<string, unknown>)
  const parts: [string, unknown][] = kind === 'bundle'
    ? Object.entries(value as Record<string, unknown>).map(([k, v]) => [k.replace(/\.json$/, ''), v])
    : [[kind, value]]
  for (const [name, part] of parts) {
    if (!isObject(part)) continue
    const what = name === 'kit' ? 'kit' : pastedKind(part) ?? name
    if (what === 'kit') kit = { ...kit, ...BrandKitSchema.parse(part) }
    else if (what === 'brand') {
      const palette = paletteOf(part.palette)
      const logo = isObject(part.logo) ? part.logo : {}
      const treatments = Array.isArray(logo.treatments) ? logo.treatments.filter(isObject) : []
      const onPhoto = isObject(logo.onPhoto) && Array.isArray(logo.onPhoto.colours) ? String(logo.onPhoto.colours[0] ?? '') : ''
      const { palette: _p, logo: _l, brand: _b, name: _n, roles, ...rest } = part
      kit = {
        ...kit,
        name: typeof part.brand === 'string' ? part.brand : typeof part.name === 'string' ? part.name : kit.name,
        palette: Object.keys(palette).length ? palette : kit.palette,
        ...(treatments.length ? { logoOn: Object.fromEntries(treatments.map((t) => [String(t.background), String(t.logo)])) } : {}),
        ...(onPhoto ? { logoOnPhoto: onPhoto } : {}),
        ...(isObject(roles) ? { roles } : {}),
        extra: { ...(isObject(kit.extra) ? kit.extra : {}), ...rest, ...(Object.keys(logo).length ? { logo } : {}) },
      }
    } else if (what === 'fonts') {
      const fonts = isObject(kit.fonts) ? (kit.fonts as BrandKit['fonts']) : emptyKit().fonts
      kit = { ...kit, fonts: { serif: fontRoleOf(part.serif, fonts.serif)!, sans: fontRoleOf(part.sans, fonts.sans)! } }
    } else if (what === 'rules') {
      const motion = isObject(kit.motion) ? kit.motion : {}
      kit = { ...kit, motion: { ...motion, rules: MotionRulesSchema.parse(part) } }
    } else if (what === 'sound') {
      kit = { ...kit, sounds: soundsOf(part, SoundLibrarySchema.parse(kit.sounds ?? {})) }
    }
  }
  return BrandKitSchema.parse(kit)
}

/** The palette token a role draws with: the kit's mapping, else a palette token of the role's own name. */
export function roleToken(kit: Pick<BrandKit, 'roles' | 'palette'>, role: string): string | null {
  const mapped = (kit.roles as Record<string, string | undefined>)[role]
  if (mapped) return mapped
  if (role in kit.palette) return role
  // White needs no token: the renderer adds #FFFFFF when the palette has none.
  if (role === 'white') return 'white'
  return null
}

/** A colour named in a batch or a brief (a role or a palette token) as a palette token, or null. */
export function colourToken(kit: Pick<BrandKit, 'roles' | 'palette'>, name: string): string | null {
  if (name in kit.palette) return name
  return roleToken(kit, name)
}

/** Roles a kit has no colour for (the static templates need all of them). */
export const missingRoles = (kit: Pick<BrandKit, 'roles' | 'palette'>): TemplateRole[] => TEMPLATE_ROLES.filter((r) => !roleToken(kit, r))

/** What the overview page's brand summary (studio_project.brand) shows of a kit. */
export function brandSummary(kit: BrandKit): { name: string; colors: { name: string; hex: string }[]; fonts: string[]; logoAssetId?: string } {
  const fonts = [...new Set([kit.fonts.serif, kit.fonts.sans].map((f) => (f.faces.some((x) => isStoredFontKey(x.file)) ? f.family : typeof f.standIn === 'string' ? f.standIn : f.family)))]
  return {
    name: kit.name.slice(0, 120),
    colors: Object.entries(kit.palette).slice(0, 24).map(([name, hex]) => ({ name: name.slice(0, 60), hex })),
    fonts,
    ...(kit.logos.primary ? { logoAssetId: kit.logos.primary.assetId } : {}),
  }
}

// ---- static ads ------------------------------------------------------------------------------------------------

export const SIZE_KEYS = ['square', 'portrait', 'story', 'landscape'] as const
export type SizeKey = (typeof SIZE_KEYS)[number]
export const SIZES: Record<SizeKey, { w: number; h: number; label: string }> = {
  square: { w: 1080, h: 1080, label: '1:1' },
  portrait: { w: 1080, h: 1350, label: '4:5' },
  story: { w: 1080, h: 1920, label: '9:16' },
  landscape: { w: 1200, h: 628, label: '1.91:1' },
}

/** What each static template draws and what it needs, for the agent and for checking a batch before it is queued. */
export const STATIC_TEMPLATES = {
  statement: { pattern: 'AD-1', image: 'one', copy: ['headline'], optional: ['sub', 'accent'], draws: 'One big serif headline on a full-bleed photo, small lines under it, the logo. layout center (headline centred, serif sub, logo under), lower (headline low, caps lines under, logo at the foot) or corner (big lines bottom-left, logo bottom-right). ink white (default), ink (dark type on a light photo) or ground; shade 0–1.' },
  'caps-photo': { pattern: 'AD-2', image: 'one', copy: ['headline'], optional: ['sub'], draws: 'Bold, widely tracked caps lines across a photo (headline as an array of short lines), an optional serif sub, logo bottom-left. With ground set, a field of that colour that the photo fades into.' },
  'glass-panel': { pattern: 'AD-3', image: 'one', copy: ['query', 'rows'], optional: [], draws: 'A frosted interface panel over a photo: a search row (query, with a search icon) and result rows (rows: array of short serif lines); white logo bottom-centre.' },
  'review-glass': { pattern: 'AD-4', image: 'one', copy: ['count', 'quote', 'name', 'initials'], optional: ['reviewsLabel'], draws: '"<count> ★ REVIEWS" over a softened photo, a light frosted card with an initials avatar, five stars, the verbatim quote (serif) and the name (caps).' },
  'offer-wave': { pattern: 'AD-11', image: 'one', copy: ['headline', 'value', 'valueLabel', 'offer', 'date'], optional: [], draws: 'A dated offer: photo above with a wave edge, white serif headline over it, an offer card (value large, valueLabel small, the logo) on the groundAlt colour, the offer line and its end date on the ground below.' },
  'serif-card': { pattern: 'AD-1/AD-8', image: 'one', copy: ['headline'], optional: ['kicker', 'sub'], draws: 'Photo above, a ground panel below with a soft wave edge: caps kicker, serif headline, caps sub, logo. ground picks the panel colour.' },
  'serif-full': { pattern: 'AD-1', image: 'one', copy: ['headline'], optional: ['sub'], draws: 'Full-bleed photo with a warm shade at the bottom, a serif headline and caps sub in the light ground colour, logo on the photo.' },
  'caps-statement': { pattern: 'AD-2', image: 'one', copy: ['headline'], optional: ['sub'], draws: 'A tracked caps statement on a ground (default deep) beside the photo (above it in 9:16), a serif sub, logo.' },
  'ui-calendar': { pattern: 'AD-3', image: 'one', copy: ['label', 'headline', 'when'], optional: ['sub', 'decline', 'cta'], draws: 'A calendar invite as the hook: a card over the photo with a label, serif headline, when, sub, and Later / Accept buttons (decline, cta), logo in the card.' },
  mosaic: { pattern: 'AD-7', image: 'many', copy: ['words'], optional: [], draws: 'Word tiles (words: three short caps words) in a checkerboard with photo tiles (images: 1–6), the logo on its own tile.' },
  review: { pattern: 'AD-4', image: 'one', copy: ['count', 'quote', 'name', 'initials'], optional: [], draws: 'A verbatim review on a deep card over a shaded photo: count with a star, avatar initials, five stars, quote, name, logo.' },
  offer: { pattern: 'AD-11', image: 'one', copy: ['headline', 'offer', 'code', 'date'], optional: [], draws: 'A dated, valued offer on the ground: serif hook, the photo in a circle, the plain offer, a code pill, the end date, logo.' },
  'state-cover': { pattern: 'AD-9', image: 'one', copy: ['headline'], optional: ['kicker', 'sub'], draws: 'Carousel cover: the reader\'s state as one serif question over a photo, on a ground band (as serif-card).' },
  'state-item': { pattern: 'AD-9', image: 'one', copy: ['question', 'headline'], optional: ['sub'], draws: 'Carousel card: a caps question, the photo in a soft-cornered frame, the answer in serif, a caps line and the logo (ground default groundAlt).' },
  'state-end': { pattern: 'AD-9', image: 'none', copy: ['headline'], optional: ['sub'], draws: 'Carousel end card: the promise in serif and a caps line on a ground (default deep) with the logo. No photo.' },
} as const satisfies Record<string, { pattern: string; image: 'one' | 'many' | 'none'; copy: readonly string[]; optional: readonly string[]; draws: string }>
export type StaticTemplate = keyof typeof STATIC_TEMPLATES
export const STATIC_TEMPLATE_IDS = Object.keys(STATIC_TEMPLATES) as StaticTemplate[]

/** An image an ad uses: a library asset (its id, or its name in the library) and where to keep in frame (0–1). */
export const ImgSchema = z.object({ src: z.string().min(1).max(250), focus: z.tuple([finite.min(0).max(1), finite.min(0).max(1)]).optional() }).strict()
export type AdImg = z.infer<typeof ImgSchema>
const CopySchema = z.record(z.string().min(1).max(40), z.union([z.string().max(600), z.array(z.string().max(300)).max(12)]))

const adFields = {
  title: z.string().max(200).optional(),
  copy: CopySchema.optional(),
  image: ImgSchema.optional(),
  images: z.array(ImgSchema).max(8).optional(),
  ground: z.string().max(41).optional(),
  logoOnPhoto: z.boolean().optional(),
  layout: z.enum(['center', 'lower', 'corner']).optional(),
  ink: z.string().max(41).optional(),
  shade: finite.min(0).max(1).optional(),
  depth: z.boolean().optional(),
  flags: z.array(z.string().max(300)).max(20).optional(),
  notes: z.string().max(2000).optional(),
}
export const AdSpecSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/, 'An ad id is letters, numbers, - and _'),
  pattern: z.string().max(40).default(''),
  template: z.enum(STATIC_TEMPLATE_IDS as [StaticTemplate, ...StaticTemplate[]]),
  ...adFields,
  copy: CopySchema.default({}),
  sizes: z.array(z.enum(SIZE_KEYS)).min(1).max(4).optional(),
  bySize: z.partialRecord(z.enum(SIZE_KEYS), z.object({ ...adFields, template: z.enum(STATIC_TEMPLATE_IDS as [StaticTemplate, ...StaticTemplate[]]).optional() }).strict()).optional(),
}).strict()
export type AdSpec = z.infer<typeof AdSpecSchema>

/** People in a photo (faces, heads, a matte image), as fractions of the photo: keeps type off faces when given. */
export const PeopleSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  faces: z.array(z.object({ x: finite, y: finite, w: finite, h: finite }).strict()).max(40).default([]),
  heads: z.array(z.object({ x: finite, y: finite, w: finite, h: finite }).strict()).max(40).default([]),
  /** A greyscale (or alpha) person matte, a library image the size of the photo. */
  matte: z.string().max(250).optional(),
}).strict()
export type People = z.infer<typeof PeopleSchema>

export const StaticBatchSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/, 'A batch id is letters, numbers, - and _'),
  title: z.string().max(200).optional(),
  /** Ignored (a local batch's image folder); images are library assets here. */
  root: z.string().optional(),
  ads: z.array(AdSpecSchema).min(1).max(40),
  /** People data per image (keyed by the image's src): keeps faces clear of type. Without it that pass is skipped. */
  people: z.record(z.string(), PeopleSchema).optional(),
}).strict().superRefine((batch, ctx) => {
  const ids = new Set<string>()
  batch.ads.forEach((ad, i) => {
    if (ids.has(ad.id)) ctx.addIssue({ code: 'custom', path: ['ads', i, 'id'], message: `Two ads are called ${ad.id}` })
    ids.add(ad.id)
    const t = STATIC_TEMPLATES[ad.template]
    for (const size of ad.sizes ?? SIZE_KEYS) {
      const s = forSize(ad, size)
      const tt = STATIC_TEMPLATES[s.template]
      if (tt.image === 'one' && !s.image) ctx.addIssue({ code: 'custom', path: ['ads', i, 'image'], message: `${ad.id}: ${s.template} needs an image` })
      if (tt.image === 'many' && !(s.images ?? []).length) ctx.addIssue({ code: 'custom', path: ['ads', i, 'images'], message: `${ad.id}: ${s.template} needs images` })
      for (const field of tt.copy) if (s.copy[field] === undefined || s.copy[field] === '') ctx.addIssue({ code: 'custom', path: ['ads', i, 'copy', field], message: `${ad.id}: ${s.template} needs copy.${field}` })
    }
    void t
  })
})
export type StaticBatch = z.infer<typeof StaticBatchSchema>

/** The spec as it applies to one size (bySize merged over it, copy merged key by key). */
export function forSize(spec: AdSpec, size: SizeKey): AdSpec {
  const o = spec.bySize?.[size]
  return o ? ({ ...spec, ...o, copy: { ...spec.copy, ...(o.copy ?? {}) } } as AdSpec) : spec
}

/** Every image source a batch names. */
export function batchImages(batch: StaticBatch): string[] {
  const out = new Set<string>()
  for (const ad of batch.ads) {
    for (const img of [ad.image, ...(ad.images ?? []), ...Object.values(ad.bySize ?? {}).flatMap((o) => [o?.image, ...(o?.images ?? [])])]) if (img) out.add(img.src)
  }
  for (const p of Object.values(batch.people ?? {})) if (p.matte) out.add(p.matte)
  return [...out]
}

export type Finding = { level: 'error' | 'warn' | 'info'; rule: string; message: string }

// ---- motion ads ------------------------------------------------------------------------------------------------

export const MOTION_TEMPLATES = {
  'cut-on-beat': 'A label row (the service large, an aside, over a hairline), beats of large serif type that cut on the beat, then an end card (lines, a call to action, the logo).',
  'pull-out': 'A hook over the texture, then a pull out of the full stop of a word knocked out of a colour panel, landing on a line plus the word; the end card repeats the service.',
} as const
export type MotionTemplate = keyof typeof MOTION_TEMPLATES

const TransitionSchema = z.object({ kind: z.enum(['cut', 'fade', 'light']), at: finite.min(0), duration: finite.positive().max(10).optional(), softness: finite.min(0.01).max(1).optional() }).strict()
export const SegmentSchema = z.object({
  /** A library video (its id or name). */
  clip: z.string().max(250).optional(),
  /** A library image (its id or name). */
  still: z.string().max(250).optional(),
  in: TransitionSchema.optional(),
  grade: GradeNameSchema.optional(),
  strength: finite.min(0).max(1).optional(),
  saturation: finite.min(0).max(3).optional(),
  contrast: finite.min(0).max(20).optional(),
  levels: z.tuple([finite.min(0).max(255), finite.min(0).max(255)]).optional(),
  speed: finite.min(0.25).max(4).optional(),
  seek: finite.min(0).optional(),
  push: z.tuple([finite.min(0.2).max(5), finite.min(0.2).max(5)]).optional(),
  focus: z.tuple([finite.min(0).max(1), finite.min(0).max(1)]).optional(),
  cuts: z.array(z.tuple([finite.min(0), finite.min(0.2).max(5)])).max(40).optional(),
}).strict().refine((s) => !!s.clip !== !!s.still, 'A background segment is a clip or a still')
export type Segment = z.infer<typeof SegmentSchema>

export const SoundRefSchema = z.union([
  z.string().min(1).max(80),
  z.object({ name: z.string().min(1).max(80), use: z.tuple([finite.min(0), finite.min(0)]).optional(), loop: z.tuple([finite.min(0), finite.min(0)]).nullable().optional(), until: finite.min(0).optional(), lufs: finite.optional(), fadeIn: finite.min(0).optional(), fadeOut: finite.min(0).optional() }).strict(),
])
export type SoundRef = z.infer<typeof SoundRefSchema>

const BeatSchema = z.object({
  at: finite.min(0), lines: z.array(z.string().max(120)).min(1).max(6), size: finite.min(10).max(600), top: finite.min(0).max(1920),
  leading: finite.min(0.5).max(3).optional(), enter: z.enum(['rise', 'cut']).optional(), until: finite.min(0).optional(), out: z.enum(['cut', 'fade']).optional(),
}).strict()
export const CutOnBeatSchema = z.object({
  service: z.string().min(1).max(80), aside: z.string().max(80).optional(), ink: z.string().min(1).max(41),
  veils: z.array(z.object({ css: PaintSchema, at: finite.min(0).optional(), until: finite.min(0).optional() }).strict()).max(6).optional(),
  beats: z.array(BeatSchema).min(1).max(12),
  end: z.object({ at: finite.min(0), lines: z.array(z.string().max(120)).max(6).optional(), size: finite.min(10).max(400).optional(), top: finite.min(0).max(1920).optional(), cta: z.string().min(1).max(120), ctaAt: finite.min(0).optional(), logoAt: finite.min(0).optional() }).strict(),
}).strict()
export const PullOutSchema = z.object({
  service: z.string().min(1).max(80), aside: z.string().max(80).optional(),
  panel: z.string().min(1).max(41), ink: z.string().min(1).max(41), hookInk: z.string().min(1).max(41), shade: PaintSchema.optional(),
  hook: z.object({ lines: z.array(z.string().max(120)).min(1).max(6), at: z.array(finite.min(0)).min(1).max(6), size: finite.min(10).max(400).optional(), top: finite.min(0).max(1920).optional() }).strict(),
  line: z.string().min(1).max(80), word: z.string().min(1).max(40),
  zoom: z.object({ at: finite.min(0).optional(), duration: finite.positive().optional(), from: finite.min(1.1).max(400).optional() }).strict().optional(),
  layout: z.object({ line: z.object({ x: finite, y: finite, size: finite.positive() }).strict().optional(), word: z.object({ x: finite, y: finite, size: finite.positive(), track: finite }).strict().optional() }).strict().optional(),
  end: z.object({ at: finite.min(0), cta: z.string().min(1).max(120) }).strict(),
}).strict()
export type CutOnBeatCopy = z.infer<typeof CutOnBeatSchema>
export type PullOutCopy = z.infer<typeof PullOutSchema>

export const MotionBriefSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/, 'A brief id is letters, numbers, - and _'),
  template: z.enum(Object.keys(MOTION_TEMPLATES) as [MotionTemplate, ...MotionTemplate[]]),
  seconds: finite.min(2).max(60),
  fps: z.number().int().min(12).max(60).optional(),
  title: z.string().max(200).optional(),
  background: z.array(SegmentSchema).min(1).max(12),
  sound: z.object({ music: SoundRefSchema.optional(), sfx: z.array(SoundRefSchema).max(8).optional() }).strict().optional(),
  copy: z.unknown(),
  formats: z.array(z.enum(['9x16', '4x5'])).min(1).max(2).optional(),
  notes: z.string().max(4000).optional(),
}).strict().superRefine((brief, ctx) => {
  const schema = brief.template === 'pull-out' ? PullOutSchema : CutOnBeatSchema
  const parsed = schema.safeParse(brief.copy)
  if (!parsed.success) for (const issue of parsed.error.issues.slice(0, 5)) ctx.addIssue({ code: 'custom', path: ['copy', ...issue.path.map(String)], message: issue.message })
  brief.background.forEach((s, i) => {
    if (i > 0 && !s.in) ctx.addIssue({ code: 'custom', path: ['background', i, 'in'], message: 'Every segment after the first says how it comes in (in: {kind, at})' })
    if (s.in && s.in.at >= brief.seconds) ctx.addIssue({ code: 'custom', path: ['background', i, 'in', 'at'], message: 'A segment comes in before the end of the piece' })
  })
})
export type MotionBrief = z.infer<typeof MotionBriefSchema>

/** Every library source a brief's background names. */
export const briefMedia = (brief: MotionBrief): string[] => [...new Set(brief.background.map((s) => (s.clip ?? s.still)!))]
/** Every sound a brief names. */
export const briefSounds = (brief: MotionBrief): string[] => [...(brief.sound?.music ? [brief.sound.music] : []), ...(brief.sound?.sfx ?? [])].map((r) => (typeof r === 'string' ? r : r.name))

// ---- reels ---------------------------------------------------------------------------------------------------

export const REEL_BANDS = ['upper', 'center', 'lower'] as const
export type ReelBand = (typeof REEL_BANDS)[number]
const ReelShotSchema = z.object({
  /** A library video (its id or name). */
  src: z.string().min(1).max(250),
  in: finite.min(0), out: finite.positive(),
  /** Push-in across the shot (0.04 = 4 %). */
  push: finite.min(0).max(0.5).optional(),
  /** Play slower (1.5 = 1.5× longer on screen), for short establishing shots. */
  slow: finite.min(1).max(4).optional(),
  /** The clean vertical band of the source (fractions, top-left origin), e.g. above burned-in captions. */
  band: z.tuple([finite.min(0).max(1), finite.min(0).max(1)]).optional(),
}).strict().refine((s) => s.out > s.in, 'A shot ends after it starts')
const ReelBeatSchema = z.object({
  from: finite.min(0), to: finite.positive(),
  kind: z.enum(['statement', 'glass', 'caps']),
  copy: z.object({ headline: z.union([z.string().max(200), z.array(z.string().max(200)).max(6)]).optional(), sub: z.union([z.string().max(300), z.array(z.string().max(300)).max(6)]).optional(), accent: z.string().max(120).optional(), query: z.string().max(120).optional(), rows: z.array(z.string().max(120)).max(6).optional() }).strict(),
  /** Where the type sits; with several, the first no face passes through is used. Default: lower, center, upper. */
  bands: z.array(z.enum(REEL_BANDS)).min(1).max(3).optional(),
  /** Set the headline behind the people in the shot (needs a person matte for the shot in people). */
  depth: z.boolean().optional(),
}).strict()
const ReelEndSchema = z.object({ seconds: finite.min(0.5).max(10), ground: z.string().max(41).optional(), headline: z.union([z.string().max(200), z.array(z.string().max(200)).max(4)]).optional(), sub: z.string().max(300).optional(), cta: z.string().max(80).optional() }).strict()
const ReelSplitSchema = z.object({ at: finite.min(0.3).max(0.8), ground: z.string().min(1).max(41) }).strict()
export const ReelSpecSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/, 'A reel id is letters, numbers, - and _'),
  title: z.string().max(200).optional(),
  root: z.string().optional(),
  fps: z.number().int().min(12).max(60).optional(),
  shots: z.array(ReelShotSchema).min(1).max(30),
  beats: z.array(ReelBeatSchema).max(20).default([]),
  end: ReelEndSchema.optional(),
  /** Footage fills the top (to `at` of the height) and flows through the wave edge into a ground panel carrying the type and logo. */
  split: ReelSplitSchema.optional(),
  notes: z.string().max(4000).optional(),
  /** Per shot source: faces a few times a second (t in seconds into the shot, on the source's clock; boxes as fractions of the 9:16 frame), and a person matte (a greyscale library video, white = person) for depth beats. */
  people: z.record(z.string(), z.object({
    faces: z.array(z.object({ t: finite.min(0), faces: z.array(z.object({ x: finite, y: finite, w: finite, h: finite }).strict()).max(20) }).strict()).max(20_000).optional(),
    matte: z.string().max(250).optional(),
  }).strict()).optional(),
}).strict().superRefine((spec, ctx) => {
  const seconds = reelSeconds(spec)
  if (!(seconds <= REEL_MAX_SECONDS)) ctx.addIssue({ code: 'custom', path: ['shots'], message: `A reel runs at most ${REEL_MAX_SECONDS} s (this one: ${Number.isFinite(seconds) ? seconds.toFixed(1) : 'endless'} s with its end card)` })
})
/** The longest reel, in seconds (shots as they play, slowed, plus the end card). */
export const REEL_MAX_SECONDS = 90
/** How long a reel runs: its shots as they play (slowed) and its end card. Pure. */
export function reelSeconds(spec: { shots: { in: number; out: number; slow?: number }[]; end?: { seconds: number } }): number {
  return spec.shots.reduce((t, s) => t + (s.out - s.in) * (s.slow ?? 1), 0) + (spec.end?.seconds ?? 0)
}
export type ReelSpec = z.infer<typeof ReelSpecSchema>
export type ReelBeat = ReelSpec['beats'][number]
export type ReelEnd = NonNullable<ReelSpec['end']>
export type ReelSplit = NonNullable<ReelSpec['split']>
/** Every library video a reel names (shots and mattes). */
export const reelMedia = (spec: ReelSpec): string[] => [...new Set([...spec.shots.map((s) => s.src), ...Object.values(spec.people ?? {}).flatMap((p) => (p.matte ? [p.matte] : []))])]

// ---- the motion ad's editable parts (what the app turns into a video) ----------------------------------------

type Anim = { preset: 'none' | 'fade' | 'wipe'; seconds: number }
type Timed = { name: string; start: number; end?: number; enter?: Anim; exit?: Anim }
export type MotionPart = Timed & (
  | { kind: 'text'; text: string; family: string; px: number; weight: number; tracking: number; leading: number; color: string; uppercase?: boolean; align: 'left' | 'right'; left: number; top: number; width: number; settle?: number }
  | { kind: 'rule'; left: number; top: number; width: number; height: number; color: string; opacity?: number }
  | { kind: 'logo'; left: number; top: number; width: number; height: number; assetId: string }
  | { kind: 'veil'; assetId: string }
  | { kind: 'scene'; scene: string; props: Record<string, unknown> })
export type MotionParts = {
  schemaVersion: 1
  id: string
  title: string
  width: number
  height: number
  fps: number
  seconds: number
  /** The background clip (a library video): without type, with any move the editor can't draw (baked) in it. */
  background: string
  audio: { name: string; role: 'music' | 'sfx'; assetId: string }[]
  fonts: string[]
  layers: MotionPart[]
  /** Moves drawn into the background instead of as layers (the knock-out pull-out). */
  baked: string[]
  brand?: { name: string; colors: { name: string; hex: string }[] }
}

// ---- the jobs --------------------------------------------------------------------------------------------------

/** A font face the worker downloads: a stored file and its CSS descriptors. */
export type JobFontFace = { file: string; weight: string; style: 'normal' | 'italic' }
/** The kit as a job carries it: the kit, its logo images and the font files each role draws with. */
export type JobKit = {
  kit: BrandKit
  logos: { primary: EditorAsset; mark: EditorAsset }
  fonts: { serif: JobFontFace[]; sans: JobFontFace[] }
  /** The families the editor uses for each role (a stand-in's own name when that is what is drawn). */
  editorFamilies: { serif: string; sans: string }
  /** Sentences for the report: stand-ins in use, missing cuts. */
  fontNotes: string[]
}

/** ads-static: render a batch, every ad in every size, and check each against the brand. */
export type AdsStaticInput = {
  projectId: string
  batch: StaticBatch
  kit: JobKit
  /** The library media the batch names, by the source it names them by. */
  media: Record<string, EditorAsset>
}
export type AdImage = { size: SizeKey; asset: EditorAsset; findings: Finding[] }
export type AdsStaticResult = {
  batchId: string
  title?: string
  ads: { id: string; pattern: string; template: string; title?: string; notes?: string; flags: string[]; photo: Finding[]; images: AdImage[]; people: boolean }[]
  /** report.json, report.md and the contact sheet, stored under ads/<job id>/. */
  files: { reportJson: string; reportMd: string; contactSheet: string }
  /** Ads rendered without people data (the face-avoid and text-behind-the-head passes had nothing to go on). */
  withoutPeople: string[]
  notes: string[]
  /** Set by the app when it files the batch. */
  recordKey?: string
}

/** ads-motion: render a motion ad (9:16, the 4:5 crop, a strip, a report) and its editable parts. */
export type AdsMotionInput = {
  projectId: string
  brief: MotionBrief
  kit: JobKit
  media: Record<string, EditorAsset>
  /** The sounds the brief names, as the library has them. */
  sounds: Record<string, EditorAsset>
}
export type AdsMotionResult = {
  briefId: string
  title: string
  errors: number
  findings: Finding[]
  report: string
  files: { report: string; brief: string }
  renders: { '9x16': EditorAsset; '4x5'?: EditorAsset; strip: EditorAsset }
  parts: MotionParts
  /** Every library asset the job made (renders, background, sounds, veils, logos). */
  assets: EditorAsset[]
  notes: string[]
  /** Set by the app: the editable video it made. */
  videoId?: string
}

/** ads-reel: a reel from the brand's own footage, with type beats and an end card. */
export type AdsReelInput = { projectId: string; spec: ReelSpec; kit: JobKit; media: Record<string, EditorAsset> }
export type AdsReelResult = { reelId: string; title: string; seconds: number; render: EditorAsset; strip: EditorAsset; notes: string[]; files: { notes: string } }

/** Where a job stores its non-media files. */
export const adsFileKey = (jobId: string, name: string) => `ads/${jobId}/${name}`
