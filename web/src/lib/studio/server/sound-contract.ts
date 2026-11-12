// Sound design's jobs, as data both the app and the Studio worker read (job-contract.ts names the kinds; this file
// says what each is given and gives back). Pure (the engine's types only), so the worker imports it by relative path
// like the rest of the contract.
//
// The sound work runs in the worker with earshot (an MIT-licensed outside project, pinned to a reviewed commit:
// studio-worker/README.md, "Sound"), driven through a small JSON bridge (studio-worker/python/earshot_bridge.py).
// A worker offers it only when the tool answers (the `sound` capability). The app computes the cue sheet from the
// edit (engine/sound.ts, pure), queues the job, and applies what comes back to the video itself (sound.ts): a job
// never edits a video.
//
//   sounds        render cues (the automatic pass, or chosen sounds) as audio files levelled against the music bed,
//                 each a library asset with where it sits; and the music's step-down before big moments
//   sound-import  one sound or music file (a library asset or an upload) aligned on its onset or peak, levelled,
//                 cut and faded for a music bed
//   listen        the mix rendered (audio only) and heard by earshot: transcript, scorecard, an annotated sheet image
//   sound-bank    the sound bank and the kit presets (quick; the app keeps them)
//   sound-judge   earshot's ears on any sounds (library audio, bank sounds): describe, measure, compare, rank, find,
//                 A/B, realness. Writes nothing: the answer is compact numbers and short words (judgeResultFrom)
//   sound-make    a new sound made in code (forge: a recipe searched toward a description) or a recording turned into
//                 code (fit: its resynthesis); each a library asset with its provenance, never placed on a video
import type { EditorAsset, EditorProject } from '../engine/contracts'
import type { SoundCue } from '../engine/sound'
import type { ExportFont } from './job-contract'

/** The kit presets earshot knows. */
export const SOUND_PRESETS = ['launch', 'crisp', 'calm', 'minimal'] as const
export type SoundPreset = (typeof SOUND_PRESETS)[number]

/** What listen can be asked to do. */
export const LISTEN_CHECKS = ['timeline', 'critique', 'sheet'] as const
export type ListenCheck = (typeof LISTEN_CHECKS)[number]

/** One piece of the music bed on the timeline's clock (a segment of an unmuted music track). */
export type BedPiece = { asset: EditorAsset; atSeconds: number; trimStartSeconds: number; trimEndSeconds: number; gain: number }

/** The Music track's one segment, for the step-down: the file it plays now and the take it was ducked from. */
export type MusicSegment = { segmentId: string; atSeconds: number; trimStartSeconds: number; currentAssetId: string; source: EditorAsset }

/**
 * sounds: `cues` rendered with the preset. `mode` 'pass' replaces the earlier automatic pass when applied, 'add'
 * keeps everything and drops only `replaceIds`. `bed`: the music to level against (none: each role's own level).
 */
export type SoundsInput = {
  mode: 'pass' | 'add'
  preset: SoundPreset
  cues: SoundCue[]
  bed: BedPiece[]
  music: MusicSegment | null
  replaceIds?: string[]
}

/** One rendered cue: its library asset (stored as blob `asset.file`) and where it sits so its sync point lands. */
export type RenderedSound = {
  cueId: string
  asset: EditorAsset
  startSeconds: number
  trimSeconds: number
  durationSeconds: number
  sound: string
  role: string | null
  gainDb: number
  label: string
}

/** What happens to the music bed: stepped down before big moments (a new take), or back to the take as imported. */
export type MusicChange =
  | { action: 'duck'; segmentId: string; currentAssetId: string; sourceId: string; asset: EditorAsset; moments: number[] }
  | { action: 'restore'; segmentId: string; currentAssetId: string; sourceId: string }

export type SoundsResult = { preset: SoundPreset; placed: RenderedSound[]; notes: string[]; music: MusicChange | null }

/**
 * sound-import: one file from the library (`asset`) or an upload (`uploadKey` + `name`), placed at `at` seconds.
 * track 'music': the bed from `at` to the video's end (`endSeconds` long at most), faded out over `fadeOut` seconds.
 */
export type SoundImportInput = {
  asset?: EditorAsset
  uploadKey?: string
  name: string
  at: number
  align: 'onset' | 'peak'
  offsetMs?: number
  levelDb?: number
  label?: string
  track: 'sfx' | 'music'
  fadeOut?: number
  from?: number
  endSeconds?: number
}
export type SoundImportResult = { asset: EditorAsset; startSeconds: number; trimSeconds: number; durationSeconds: number; track: 'sfx' | 'music'; name: string; label: string }

/** earshot's cue-file format (engine/sound.ts earshotCueFile): what its checks sync against. */
export type EarshotCueFile = { fps: number; total: number; events: { f: number; kind: string; id: string; weight: number; dur?: number }[] }

/** listen: the edit frozen in the job, rendered as sound only, heard against its own cue sheet. */
export type ListenInput = { project: EditorProject; cues: EarshotCueFile; checks: ListenCheck[]; fonts?: ExportFont[] }
export type ListenResult = {
  seconds: number
  timeline?: { summary?: unknown; text?: string }
  critique?: { verdict?: string; score?: number; text?: string }
  /** The annotated sheet, stored as blob `key` ("listen/<job id>/sheet.png"). */
  sheet?: { key: string; summary?: unknown }
}

export type SoundBankInput = Record<string, never>
/** One sound of the bank as earshot lists it (id, category, kinds, knobs, notes…). */
export type BankSound = { id: string; category?: string; kinds?: string[]; notes?: string; [field: string]: unknown }
export type SoundBankResult = { version: string; sounds: BankSound[]; presets: Record<string, { note?: string | null; roles: Record<string, { sound: string; [field: string]: unknown }> }> }

// ---- judging sounds ---------------------------------------------------------------------------------------------------

/**
 * What the judge can be asked. The sounds are heard in the order given:
 *   describe  the first sound: tags, character, measurements; with a description, how well it matches it
 *   measure   the first sound: meters only (loudness, peaks, envelope, spectrum), no models
 *   compare   the first sound against the others (two or more) as references: nearest, typicality, what differs
 *   rank      the sounds (two or more) by a description, or by closeness to a target sound
 *   find      with a sound: its best moments for a description; with none: the bank sounds that match it best
 *   ab        the first two: which is closer to a description (or to the rest as references), and how B differs
 *   realness  each sound: a real recording or simple code-made sound (p_real, a verdict, why)
 */
export const JUDGE_ACTIONS = ['describe', 'measure', 'compare', 'rank', 'find', 'ab', 'realness'] as const
export type JudgeAction = (typeof JUDGE_ACTIONS)[number]

/** One sound to hear: a library audio asset, or a bank sound (its id) rendered at its own settings. */
export type JudgeSource = { asset: EditorAsset; sound?: never } | { sound: string; asset?: never }

/** The most sounds one judgement hears, and the longest one (seconds). */
export const MAX_JUDGED = 12
export const MAX_JUDGED_SECONDS = 600

export type SoundJudgeInput = {
  action: JudgeAction
  sounds: JudgeSource[]
  description?: string
  /** Realistic confusions the description must beat (describe with a description). */
  alts?: string[]
  /** rank: closeness to this sound instead of a description. */
  target?: JudgeSource
  /** The part of the first sound judged (seconds into it): describe, measure, realness. */
  start?: number
  end?: number
  /** find in the bank: only this category (whoosh_fast, pop, …). */
  category?: string
  /** How many rows a rank or a find answers. */
  top?: number
}

/** Which sound a row is about: a library asset or a bank sound, and its name. */
export type JudgedRef = { name: string; assetId?: string; sound?: string }

/** Meter readings, all numbers (seconds, dB, LUFS, Hz, ms). */
export type SoundMeasures = {
  seconds?: number
  lufs?: number
  truePeakDb?: number
  peakDb?: number
  rmsDb?: number
  lraLu?: number
  noiseFloorDb?: number
  brightnessHz?: number
  bandwidthHz?: number
  attackMs?: number
  decayMs?: number
  onsets?: number
  f0Hz?: number
  clippedSamples?: number
}

export type SoundJudgeResult = {
  action: JudgeAction
  /** earshot's own plain words, with names in place of files. */
  summary: string
  measures?: SoundMeasures
  tags?: { term: string; category?: string; z: number }[]
  character?: string[]
  labels?: { label: string; p: number }[]
  match?: { description: string; z: number; verdict: string; percentile?: number; pVsAlts?: number; soundsLike?: string[] }
  ranked?: (JudgedRef & { z?: number; cosine?: number; verdict?: string; soundsLike?: string })[]
  segments?: { start: number; end: number; z: number; verdict: string; cut?: string }[]
  nearest?: (JudgedRef & { cosine: number })[]
  typicality?: { z: number; verdict: string }
  differences?: string[]
  ab?: { a: string; b: string; closer: 'a' | 'b' | null; zA?: number; zB?: number; cosine?: number }
  realness?: (JudgedRef & { pReal: number | null; verdict: string; why?: string })[]
}

// ---- making sounds -----------------------------------------------------------------------------------------------------

/** earshot's forge recipes and what each aims for by default (earshot forge --list at the pinned commit). */
export const FORGE_RECIPES: Readonly<Record<string, string>> = {
  brightswish: 'a bright quick swish',
  burstglitch: 'a short digital glitch burst',
  click: 'a clean bright user interface click',
  cuthit: 'a short deep sub bass hit with a kick drum',
  darkriser: 'a short dark riser building into a hit',
  downlifter: 'a downlifter sound effect: a sinking filtered sweep',
  drip: 'a water drop falling into water, a drip',
  glitch: 'a short digital glitch stutter with bit-crushed noise bursts that speed up and cut off',
  hover: 'a tiny high soft tick when the cursor hovers over a button',
  impact: 'a deep cinematic boom impact',
  keypress: 'a single mechanical keyboard key press with a crisp click and a short thock',
  knock: 'a knock on a wooden block',
  mallet: 'a short glockenspiel note',
  notify: 'a short bright notification ding',
  pluck: 'a kalimba note, a thumb piano pluck',
  pop: 'a small bubble pop',
  popin: 'a soft round low pop as an icon appears on screen',
  revcymbal: 'a reverse cymbal swell',
  riser: 'a cinematic riser building tension into a hit',
  shimmer: 'a sparkling magical shimmer',
  shutter: 'a camera shutter click',
  sting: 'a bright logo sting: a chime chord ringing out',
  subdrop: 'a deep sub bass drop',
  swipe: 'a soft cloth swipe',
  swish: 'a thin quick swish of a cane through the air',
  thump: 'a deep low whoosh that lands with a thump',
  toggle: 'a small switch flipped on with two quick clicks',
  typing: 'a short crisp high-passed digital typing tick for a motion graphics title',
  ui_pop: 'a soft rounded pop, a small bubble popping in a user interface',
  whoosh: 'a fast crisp air whoosh',
  zip: 'a quick tonal zip, a fast synth pitch sweep',
}

/** The most candidates one forge keeps, and the longest recording a fit takes (seconds). */
export const MAX_FORGED = 4
export const MAX_FIT_SECONDS = 30

/**
 * sound-make. forge: `recipe` searched toward `description` (with `alts` as confusions it must sound less like),
 * `count` diverse candidates kept. fit: the recording `asset` turned into code and rendered again.
 */
export type SoundMakeInput =
  | { mode: 'forge'; recipe: string; description: string; alts?: string[]; count: number }
  | { mode: 'fit'; asset: EditorAsset; description?: string }

/** The critic's scores of one forged candidate (numbers), and its words. */
export type ForgeScore = { total?: number; passes?: boolean; matchZ?: number; pReal?: number; soundsLike?: string[]; words?: string }
/** How close a fit's resynthesis is to the recording (lower dB and error is closer; envCorr near 1 is closer). */
export type FitQuality = { melDb?: number; envCorr?: number; toneDb?: number; levelDb?: number; onsetErr?: number; seconds?: [number, number]; fitKind?: string }

/** One made sound: its library asset (stored as blob `asset.file`), and what the critic or the fit measured. */
export type MadeSound = { asset: EditorAsset; name: string; score?: ForgeScore; quality?: FitQuality }
export type SoundMakeResult = { mode: 'forge' | 'fit'; recipe?: string; description?: string; made: MadeSound[]; summary: string }

// ---- compact answers (pure; the worker shapes with them and the app checks with them) --------------------------------

const num = (v: unknown, digits = 3): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? Math.round(n * 10 ** digits) / 10 ** digits : undefined
}
const text = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)
const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : [])
const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
/** An object without its undefined fields. */
const defined = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

/** A sound's reference as given: its name, and the asset or bank id it was (ids as plain text only). Pure. */
export function judgedRef(v: unknown): JudgedRef {
  const r = record(v)
  const assetId = typeof r.assetId === 'string' && /^[a-f0-9]{64}$/.test(r.assetId) ? r.assetId : undefined
  const sound = typeof r.sound === 'string' && /^[a-z0-9_]+(\/[a-z0-9_.-]+)*$/i.test(r.sound) ? r.sound.slice(0, 120) : undefined
  return defined({ name: text(r.name, 120) ?? sound ?? 'sound', assetId, sound })
}

/** Meter readings as numbers, unknown fields dropped. Pure. */
export function soundMeasuresFrom(v: unknown): SoundMeasures {
  const m = record(v)
  return defined({
    seconds: num(m.seconds), lufs: num(m.lufs, 1), truePeakDb: num(m.truePeakDb, 1), peakDb: num(m.peakDb, 1), rmsDb: num(m.rmsDb, 1),
    lraLu: num(m.lraLu, 1), noiseFloorDb: num(m.noiseFloorDb, 1), brightnessHz: num(m.brightnessHz, 0), bandwidthHz: num(m.bandwidthHz, 0),
    attackMs: num(m.attackMs, 1), decayMs: num(m.decayMs, 1), onsets: num(m.onsets, 0), f0Hz: num(m.f0Hz, 1), clippedSamples: num(m.clippedSamples, 0),
  })
}

/**
 * A judge's answer made compact and typed: numbers and short words only, every list capped, nothing else kept
 * (no paths, no raw arrays). The worker shapes the bridge's answer with it; the app checks the worker's with it. Pure.
 */
export function judgeResultFrom(raw: unknown, action: JudgeAction): SoundJudgeResult {
  const r = record(raw)
  const z = (v: unknown) => num(v, 2)
  const out: SoundJudgeResult = { action, summary: text(r.summary, 1500) ?? '' }
  if (r.measures) out.measures = soundMeasuresFrom(r.measures)
  const tags = list(r.tags, 8).map(record).filter((t) => text(t.term) && z(t.z) !== undefined).map((t) => defined({ term: text(t.term, 80)!, category: text(t.category, 40), z: z(t.z)! }))
  if (tags.length) out.tags = tags
  const character = list(r.character, 4).map((c) => text(c, 60)).filter((c): c is string => !!c)
  if (character.length) out.character = character
  const labels = list(r.labels, 5).map(record).filter((l) => text(l.label) && num(l.p) !== undefined).map((l) => ({ label: text(l.label, 80)!, p: num(l.p)! }))
  if (labels.length) out.labels = labels
  const match = record(r.match)
  if (text(match.description) && z(match.z) !== undefined)
    out.match = defined({ description: text(match.description, 300)!, z: z(match.z)!, verdict: text(match.verdict, 40) ?? '', percentile: num(match.percentile, 1), pVsAlts: num(match.pVsAlts), soundsLike: list(match.soundsLike, 4).map((s) => text(s, 80)).filter((s): s is string => !!s) })
  if (out.match?.soundsLike && !out.match.soundsLike.length) delete out.match.soundsLike
  const ranked = list(r.ranked, 25).map(record).map((row) => defined({ ...judgedRef(row), z: z(row.z), cosine: num(row.cosine), verdict: text(row.verdict, 40), soundsLike: text(row.soundsLike, 120) }))
  if (ranked.length) out.ranked = ranked
  const segments = list(r.segments, 10).map(record).filter((s) => num(s.start) !== undefined && num(s.end) !== undefined).map((s) => defined({ start: num(s.start)!, end: num(s.end)!, z: z(s.z) ?? 0, verdict: text(s.verdict, 40) ?? '', cut: text(s.cut, 40) }))
  if (segments.length) out.segments = segments
  const nearest = list(r.nearest, 10).map(record).filter((n) => num(n.cosine) !== undefined).map((n) => ({ ...judgedRef(n), cosine: num(n.cosine)! }))
  if (nearest.length) out.nearest = nearest
  const typ = record(r.typicality)
  if (z(typ.z) !== undefined) out.typicality = { z: z(typ.z)!, verdict: text(typ.verdict, 80) ?? '' }
  const differences = list(r.differences, 8).map((d) => text(d, 160)).filter((d): d is string => !!d)
  if (differences.length) out.differences = differences
  const ab = record(r.ab)
  const closer: 'a' | 'b' | null = ab.closer === 'a' || ab.closer === 'b' ? ab.closer : null
  if (text(ab.a) && text(ab.b)) out.ab = defined({ a: text(ab.a, 120)!, b: text(ab.b, 120)!, closer, zA: z(ab.zA), zB: z(ab.zB), cosine: num(ab.cosine) })
  const realness = list(r.realness, MAX_JUDGED).map(record).map((row) => defined({ ...judgedRef(row), pReal: num(row.pReal) ?? null, verdict: text(row.verdict, 40) ?? '', why: text(row.why, 240) }))
  if (realness.length) out.realness = realness
  return out
}

/** The critic's scores of a forged sound, compact. Pure. */
export function forgeScoreFrom(v: unknown): ForgeScore {
  const s = record(v)
  const like = list(s.soundsLike, 3).map((x) => text(x, 80)).filter((x): x is string => !!x)
  return defined({ total: num(s.total), passes: typeof s.passes === 'boolean' ? s.passes : undefined, matchZ: num(s.matchZ, 2), pReal: num(s.pReal), soundsLike: like.length ? like : undefined, words: text(s.words, 400) })
}

/** How close a fit came, compact. Pure. */
export function fitQualityFrom(v: unknown): FitQuality {
  const q = record(v)
  const pair = Array.isArray(q.seconds) && q.seconds.length === 2 && q.seconds.every((n) => num(n) !== undefined) ? ([num(q.seconds[0])!, num(q.seconds[1])!] as [number, number]) : undefined
  return defined({ melDb: num(q.melDb, 2), envCorr: num(q.envCorr), toneDb: num(q.toneDb, 2), levelDb: num(q.levelDb, 2), onsetErr: num(q.onsetErr), seconds: pair, fitKind: text(q.fitKind, 40) })
}
