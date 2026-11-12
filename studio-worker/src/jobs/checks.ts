/**
 * The measured checks (web/src/lib/studio/server/check-contract.ts). Each
 * returns its report and stores its pictures under `checks/<job id>/`; none
 * edits the video.
 *
 *   motion  the picture at half size, muted, for the range; the analysis
 *           script (python/motion_analysis.py, ../analysis.ts) watches it and
 *           compares it with the bundled reference films (python/references)
 *           and any library videos named, each measured once and kept by its
 *           sha256 in the work folder. Stores timeline.png, each move's onion
 *           skin and filmstrip, each handoff's strip, motion.json, motion.txt.
 *   review  the same render with its sound; the script cuts it into scenes and
 *           lines up the transcript, layers and clicks the app sent, reads the
 *           text on screen when this worker has tesseract (else it says so),
 *           measures motion and sound per scene and flags where a viewer gets
 *           lost. Stores scenes.png, timeline.png, review.json, review.txt.
 *           Given a library video alone (`reference`), it measures that file as
 *           it is, with no render, and keeps the measurement by its sha256 like
 *           any reference. Either way the answer carries the scene list.
 *   look    the visual check (../visual.ts): frames every `step` seconds with
 *           and without the overlays; per overlay where it lands, per text its
 *           contrast, size and overflow; a contact sheet (the problems boxed,
 *           or a few frames when there are none). Overlap with the person and
 *           their face needs the person finder (macOS Vision, ../vision/): on a
 *           worker without it the report says that part was not measured.
 */
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { EditorAsset, EditorProject } from '../../../web/src/lib/studio/engine/contracts.ts'
import type { EditorLayer } from '../../../web/src/lib/studio/engine/layers.ts'
import type { VisualIssue } from '../../../web/src/lib/studio/engine/server-types.ts'
import type { CheckReference, LookResult, MotionResult, ReviewContext, ReviewInput, ReviewReferenceInput, ReviewResult, ReviewScene, ReviewShot } from '../../../web/src/lib/studio/server/check-contract.ts'
import { analysisState, REFERENCES_DIR, runAnalysis } from '../analysis.ts'
import { stageAssets } from '../assets.ts'
import { mediaTimeout, pictureStream, probe, run, runBuffer } from '../media.ts'
import { renderPicture, withStills } from '../picture.ts'
import { visionState } from '../vision/probe.ts'
import { maskAt, subjectsOfFrames, type FrameSubject } from '../vision/subject.ts'
import { changedShare, fullFrame, lookTimes, settled, measureFrame, mergeFindings, type Finding, type Rgb, type Subject } from '../visual.ts'
import { frozenProject } from './export.ts'
import { checkAborted, JobError, stage, type JobContext, type JobHandler } from './context.ts'

/** At most this many reference videos per check (each is measured once, then kept). */
export const MAX_REFERENCES = 3
/** At most this many frames the look renders (twice each). */
export const MAX_LOOK_FRAMES = 80

// ---- pure ------------------------------------------------------------------------------------------------------

/** A `from`/`to` pair in seconds, checked: both optional, from < to. */
export function checkRange(from: unknown, to: unknown): { from?: number; to?: number } {
  const num = (v: unknown, what: string) => {
    if (v === undefined || v === null) return undefined
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new JobError(`${what} must be seconds, 0 or more`)
    return v
  }
  const a = num(from, 'from')
  const b = num(to, 'to')
  if (a !== undefined && b !== undefined && b <= a) throw new JobError('to must come after from')
  return { ...(a !== undefined ? { from: a } : {}), ...(b !== undefined ? { to: b } : {}) }
}

/** The review's context on the render's clock (the render starts `offset` seconds into the video). Pure. */
export function shiftContext(context: ReviewContext, offset: number): ReviewContext {
  const at = (t: number) => Math.round((t - offset) * 1000) / 1000
  return {
    title: context.title,
    words: context.words.map((w) => ({ ...w, t: at(w.t), end: at(w.end) })),
    layers: context.layers.map((l) => ({ ...l, start: at(l.start), end: at(l.end) })),
    clicks: context.clicks.map(at),
  }
}

/** Picture paths as the script prints them, as file names. Pure. */
const names = (pictures: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries((pictures ?? {}) as Record<string, unknown>).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, basename(v as string)]))

/** The motion analysis's answer as the job's result: file names, not paths; no folder. Pure. */
export function motionResult(raw: Record<string, unknown>, name: string, offsetSeconds: number, references: string[], files: string[]): MotionResult {
  const handoffs = Array.isArray(raw.handoffs) ? (raw.handoffs as MotionResult['handoffs']) : []
  return {
    name,
    offsetSeconds,
    summary: (raw.summary ?? {}) as Record<string, unknown>,
    text: String(raw.text ?? ''),
    moves: Number(raw.moves ?? 0),
    handoffs: handoffs.map((h) => ({ ...h, ...(h.picture ? { picture: basename(h.picture) } : {}) })),
    pictures: names(raw.pictures),
    compare: (raw.compare ?? null) as MotionResult['compare'],
    references,
    files,
  }
}

/** A scene as the analysis script writes it in review.json (the fields read here). */
type RawScene = {
  index?: unknown
  start?: unknown
  end?: unknown
  seconds?: unknown
  enters_by?: unknown
  alive?: unknown
  luma?: unknown
  empty_seconds?: unknown
  said?: unknown
  words_spoken?: unknown
  on_screen?: unknown
  words_on_screen?: unknown
  largest_text?: unknown
}

const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/**
 * How a scene reads, from its measured numbers, first match wins: empty (the frame is empty for half of it or more),
 * motion (something moves for 60% of it or more: busy footage, whatever text the reader finds in it), text (two or
 * more headline-sized words on screen), talk (three or more words said in it), motion (something moves for 30% of
 * it or more), else still. Pure.
 */
export function shotOf(scene: RawScene): ReviewShot {
  const seconds = num(scene.seconds)
  if (seconds > 0 && num(scene.empty_seconds) >= seconds / 2) return 'empty'
  if (num(scene.alive) >= 0.6) return 'motion'
  if (num(scene.words_on_screen) >= 2) return 'text'
  if (num(scene.words_spoken) >= 3) return 'talk'
  if (num(scene.alive) >= 0.3) return 'motion'
  return 'still'
}

/** A line of read text worth keeping: three letters or digits at least (shorter ones are the reader guessing at texture). Pure. */
const readable = (line: string) => (line.match(/[\p{L}\p{N}]/gu) ?? []).length >= 3

/** The scene list from review.json's scenes: times, how each reads, what was said and read in it. Pure. */
export function sceneList(raw: unknown): ReviewScene[] {
  if (!Array.isArray(raw)) return []
  return (raw as RawScene[]).map((sc, i) => {
    const onScreen = Array.isArray(sc.on_screen) ? (sc.on_screen as { text?: unknown }[]).map((l) => String(l?.text ?? '').trim()).filter(readable).slice(0, 8) : []
    const said = typeof sc.said === 'string' ? sc.said.trim() : ''
    return {
      index: num(sc.index, i),
      start: num(sc.start),
      end: num(sc.end),
      seconds: num(sc.seconds, num(sc.end) - num(sc.start)),
      shot: shotOf(sc),
      entersBy: String(sc.enters_by ?? 'change'),
      alive: num(sc.alive),
      luma: num(sc.luma),
      ...(said ? { said, words: num(sc.words_spoken) } : {}),
      ...(onScreen.length ? { onScreen, wordsOnScreen: num(sc.words_on_screen), textHeight: num(sc.largest_text) } : {}),
    }
  })
}

/** What a review answer carries beyond the script's printout: its scene list and, for a reference, which file it measured. */
export type ReviewExtra = { sceneList?: ReviewScene[]; reference?: ReviewResult['reference'] }

/** The review's answer as the job's result, saying whether on-screen text was read. Pure. */
export function reviewResult(raw: Record<string, unknown>, name: string, offsetSeconds: number, read: boolean, files: string[], extra: ReviewExtra = {}): ReviewResult {
  return {
    name,
    offsetSeconds,
    profile: (raw.profile ?? {}) as Record<string, unknown>,
    issues: Array.isArray(raw.issues) ? (raw.issues as ReviewResult['issues']) : [],
    text: String(raw.text ?? ''),
    pictures: names(raw.pictures),
    ...(raw.against ? { against: raw.against as ReviewResult['against'] } : {}),
    scenes: Number(raw.scenes ?? 0),
    ...(extra.sceneList ? { sceneList: extra.sceneList } : {}),
    ...(extra.reference ? { reference: extra.reference } : {}),
    onScreenText: read ? 'read' : 'not-read',
    ...(read ? {} : { note: 'On-screen text was not read (this Studio worker has no text reader, tesseract): the reading, small text and mismatch flags and the text style rows are left out.' }),
    files,
  }
}

/** The files of a check folder worth keeping: its pictures and its report. Pure over the names. */
export const keptFiles = (entries: string[]) => entries.filter((f) => /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,79}\.(png|json|txt)$/.test(f)).sort()

// ---- shared ----------------------------------------------------------------------------------------------------

const TYPES: Record<string, string> = { png: 'image/png', json: 'application/json', txt: 'text/plain; charset=utf-8', jpg: 'image/jpeg' }

/** Store these files of `dir` under checks/<job id>/; answers their names. */
async function store(ctx: JobContext, dir: string, files: string[], onProgress: (f: number) => void): Promise<string[]> {
  for (const [i, file] of files.entries()) {
    checkAborted(ctx.signal)
    await ctx.client.writeBlob(ctx.job.id, `checks/${ctx.job.id}/${file}`, join(dir, file), TYPES[file.split('.').at(-1) ?? ''] ?? 'application/octet-stream', { signal: ctx.signal })
    onProgress((i + 1) / files.length)
  }
  return files
}

/** The references named, checked: library videos, at most MAX_REFERENCES. */
function referencesOf(value: unknown): EditorAsset[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new JobError('references must be a list')
  if (value.length > MAX_REFERENCES) throw new JobError(`At most ${MAX_REFERENCES} references`)
  return (value as CheckReference[]).map((r) => {
    if (!r?.asset || r.asset.kind !== 'video') throw new JobError('A reference must be a video from the library')
    return r.asset
  })
}

/** How long a reference's measurement is kept unused, and how much the kept ones may take. */
export const CHECK_REFS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
export const CHECK_REFS_MAX_BYTES = 2 * 1024 ** 3

/** The size of everything under `dir`. */
async function folderBytes(dir: string): Promise<number> {
  let total = 0
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name)
    total += e.isDirectory() ? await folderBytes(p) : ((await stat(p).catch(() => null))?.size ?? 0)
  }
  return total
}

/**
 * The kept reference measurements (check-refs/<mode>/<sha>/) trimmed: any not used for `maxAgeMs` removed, then the
 * least recently used until the rest fit in `maxBytes`. A folder's mtime is when it was last used. Answers how many
 * went.
 */
export async function trimCheckRefs(root: string, opts: { maxAgeMs?: number; maxBytes?: number; now?: number } = {}): Promise<number> {
  const maxAge = opts.maxAgeMs ?? CHECK_REFS_MAX_AGE_MS, maxBytes = opts.maxBytes ?? CHECK_REFS_MAX_BYTES, now = opts.now ?? Date.now()
  const kept: { dir: string; used: number; bytes: number }[] = []
  for (const mode of await readdir(root).catch(() => [] as string[])) {
    for (const sha of await readdir(join(root, mode)).catch(() => [] as string[])) {
      const dir = join(root, mode, sha)
      const st = await stat(dir).catch(() => null)
      if (st?.isDirectory()) kept.push({ dir, used: st.mtimeMs, bytes: await folderBytes(dir) })
    }
  }
  kept.sort((a, b) => a.used - b.used)
  let total = kept.reduce((n, k) => n + k.bytes, 0)
  let removed = 0
  for (const k of kept) {
    if (now - k.used <= maxAge && total <= maxBytes) continue
    await rm(k.dir, { recursive: true, force: true })
    total -= k.bytes
    removed++
  }
  return removed
}

/**
 * A library video measured by the script once (`watch` or `review`), kept in
 * the work folder by its sha256: answers the measurement's JSON file. The
 * video is measured with the fenced ffprobe (it must be a video) before the
 * script's OpenCV opens it; the kept measurements are trimmed by age and size.
 */
async function measuredReference(ctx: JobContext, asset: EditorAsset, mode: 'watch' | 'review', extra: string[]): Promise<string> {
  const refs = resolve(ctx.config.workDir, 'check-refs')
  if (!/^[a-f0-9]{32,64}$/.test(asset.sha256)) throw new JobError('A reference must be a video from the library')
  const folder = join(refs, mode, asset.sha256.slice(0, 32))
  const done = join(folder, mode === 'watch' ? 'motion.json' : 'review.json')
  if (await stat(done).catch(() => null)) {
    const now = new Date()
    await utimes(folder, now, now).catch(() => undefined)
    return done
  }
  await trimCheckRefs(refs).catch(() => undefined)
  ctx.log(`Measuring the reference "${asset.name}" (once)`)
  const release = await stageAssets(ctx, [asset], () => undefined)
  try {
    const file = ctx.cache.pathOf(asset.file)
    const measured = await probe(file, { signal: ctx.signal }).catch(() => null)
    if (!measured || !pictureStream(measured)) throw new JobError(`The reference "${asset.name}" is not a video that can be read`)
    await mkdir(folder, { recursive: true })
    await runAnalysis([mode, file, '--out', folder, ...extra], { signal: ctx.signal, timeoutMs: mediaTimeout(asset.durationSeconds ?? 600, 30) })
  } finally {
    release()
  }
  return done
}

/** The bundled reference films' measurements. */
async function bundledReferences(): Promise<string[]> {
  return (await readdir(REFERENCES_DIR).catch(() => [] as string[])).filter((f) => f.endsWith('.json')).sort().map((f) => join(REFERENCES_DIR, f))
}

// ---- motion ----------------------------------------------------------------------------------------------------

export const runMotion: JobHandler<'motion'> = async (ctx) => {
  const input = ctx.job.input
  const project = frozenProject(input.project)
  const range = checkRange(input.from, input.to)
  const scale = typeof input.scale === 'number' && input.scale >= 0.2 && input.scale <= 1 ? input.scale : 0.5
  const refs = referencesOf(input.references)
  ctx.log('Rendering the picture for the motion check (no sound, scaled down)')
  const pic = await renderPicture(ctx, project, join(ctx.scratch, 'picture.mp4'), { scale, ...range, muted: true, fonts: input.fonts }, stage(ctx, 0, 0.6))
  checkAborted(ctx.signal)
  const references = await bundledReferences()
  const labels = references.map((r) => basename(r).replace(/\.json$/, ''))
  for (const asset of refs) {
    references.push(await measuredReference(ctx, asset, 'watch', []))
    labels.push(asset.name)
  }
  ctx.progress(0.65)
  ctx.log('Watching the motion frame by frame')
  const out = join(ctx.scratch, 'watch')
  const seconds = (pic.to - pic.from + 1) / pic.fps
  const raw = await runAnalysis(['watch', pic.file, '--out', out, ...(references.length ? ['--refs', ...references] : [])], { signal: ctx.signal, timeoutMs: mediaTimeout(seconds, 30) })
  ctx.progress(0.85)
  const files = await store(ctx, out, keptFiles(await readdir(out)), stage(ctx, 0.85, 1))
  ctx.log(`Watched: ${String(raw.moves ?? 0)} moves, ${Array.isArray(raw.handoffs) ? raw.handoffs.length : 0} handoffs`)
  return motionResult(raw, ctx.job.id, pic.from / pic.fps, labels, files)
}

// ---- review ----------------------------------------------------------------------------------------------------

/** The scenes of a review.json the script wrote, as the scene list (none when it can't be read). */
async function scenesOf(file: string): Promise<ReviewScene[]> {
  const raw = JSON.parse(await readFile(file, 'utf8').catch(() => '{}')) as { scenes?: unknown }
  return sceneList(raw.scenes)
}

/** Whether a review job was given a library video alone (a reference) rather than a saved video. Pure. */
export const isReferenceReview = (input: ReviewInput): input is ReviewReferenceInput => !!(input as Partial<ReviewReferenceInput>).reference && !(input as { project?: unknown }).project

/**
 * A library video reviewed by itself: measured as it is (no render), once per file (kept by its sha256 with the
 * other references' measurements), its pictures and report stored under the job's folder.
 */
async function reviewReference(ctx: JobContext, input: ReviewReferenceInput): Promise<ReviewResult> {
  const [asset] = referencesOf([input.reference])
  const ocr = analysisState().tesseract
  ctx.log(ocr ? `Watching "${asset!.name}" and reading its text` : `Watching "${asset!.name}" (no text reader here: on-screen text is left out)`)
  const report = await measuredReference(ctx, asset!, 'review', ocr ? ['--ocr', ocr] : [])
  ctx.progress(0.85)
  const folder = dirname(report)
  const raw = JSON.parse(await readFile(report, 'utf8')) as Record<string, unknown>
  const scenes = sceneList(raw.scenes)
  const files = await store(ctx, folder, keptFiles(await readdir(folder)), stage(ctx, 0.85, 1))
  ctx.log(`Reviewed the reference: ${scenes.length} scenes`)
  return reviewResult({ ...raw, scenes: scenes.length }, ctx.job.id, 0, !!ocr, files, { sceneList: scenes, reference: { assetId: asset!.id, sha256: asset!.sha256 } })
}

export const runReview: JobHandler<'review'> = async (ctx) => {
  if (isReferenceReview(ctx.job.input)) return reviewReference(ctx, ctx.job.input)
  const input = ctx.job.input
  const project = frozenProject(input.project)
  const range = checkRange(input.from, input.to)
  const refs = referencesOf(input.references)
  const ocr = analysisState().tesseract
  ctx.log('Rendering the picture and its sound for the review')
  const pic = await renderPicture(ctx, project, join(ctx.scratch, 'picture.mp4'), { scale: 0.5, ...range, muted: false, fonts: input.fonts }, stage(ctx, 0, 0.55))
  checkAborted(ctx.signal)
  const offset = pic.from / pic.fps
  const contextFile = join(ctx.scratch, 'context.json')
  await writeFile(contextFile, JSON.stringify(shiftContext(input.context ?? { title: project.title, words: [], layers: [], clicks: [] }, offset)))
  const ocrArgs = ocr ? ['--ocr', ocr] : []
  const references: string[] = []
  for (const asset of refs) references.push(await measuredReference(ctx, asset, 'review', ocrArgs))
  ctx.progress(0.6)
  ctx.log(ocr ? 'Watching the whole video and reading its text' : 'Watching the whole video (no text reader here: on-screen text is left out)')
  const out = join(ctx.scratch, 'review')
  const seconds = (pic.to - pic.from + 1) / pic.fps
  const raw = await runAnalysis(['review', pic.file, '--out', out, '--context', contextFile, ...ocrArgs, ...(references.length ? ['--refs', ...references] : [])], {
    signal: ctx.signal,
    timeoutMs: mediaTimeout(seconds, 40),
  })
  ctx.progress(0.85)
  const files = await store(ctx, out, keptFiles(await readdir(out)), stage(ctx, 0.85, 1))
  ctx.log(`Reviewed: ${String(raw.scenes ?? 0)} scenes, ${Array.isArray(raw.issues) ? raw.issues.length : 0} flags`)
  return reviewResult(raw, ctx.job.id, offset, !!ocr, files, { sceneList: await scenesOf(join(out, 'review.json')) })
}

// ---- look ------------------------------------------------------------------------------------------------------

/**
 * Where the person is in each frame, with the vision helper (macOS Vision, ../vision/subject.ts) when this worker
 * has it; null when it doesn't or it fails (then nothing is said about covering anyone).
 */
async function findSubjects(ctx: JobContext, frames: string[]): Promise<FrameSubject[] | null> {
  if (!visionState().on.has('faces') || !frames.length) return null
  try {
    ctx.log('Finding the person in every frame')
    return await subjectsOfFrames(frames, { workDir: ctx.config.workDir, signal: ctx.signal })
  } catch (err) {
    checkAborted(ctx.signal)
    ctx.log(`The person could not be found in the frames (${(err as Error).message}): overlap is not measured`)
    return null
  }
}

/** A PNG as raw RGB at w×h (FFmpeg scales it). */
async function decode(file: string, w: number, h: number, signal: AbortSignal): Promise<Rgb> {
  const data = await runBuffer('ffmpeg', ['-nostdin', '-v', 'error', '-i', file, '-vf', `scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: w * h * 3 + 1024, signal })
  if (data.length < w * h * 3) throw new JobError('A rendered frame could not be read')
  return { w, h, data: new Uint8Array(data.buffer, data.byteOffset, w * h * 3) }
}

/** A font FFmpeg's drawtext can use for the sheet's labels, or null (then the sheet has boxes and no words). */
async function labelFont(): Promise<string | null> {
  for (const f of ['/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf', '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf', '/Library/Fonts/Arial.ttf']) {
    if (await stat(f).catch(() => null)) return f
  }
  return null
}

/** Whether this FFmpeg has drawtext (it needs libfreetype). */
let drawtext: Promise<boolean> | null = null
const hasDrawtext = () =>
  (drawtext ??= run('ffmpeg', ['-hide_banner', '-filters'], { timeout: 20_000 }).then(
    ({ stdout }) => /\bdrawtext\b/.test(stdout),
    () => false,
  ))

/** A contact sheet label's words: the time and the label, on one line, at most 90 characters. Pure. */
export function labelText(seconds: number, label: string): string {
  return `${Number.isFinite(seconds) ? seconds.toFixed(1) : '0.0'}s ${String(label)}`.replace(/[\r\n\t]+/g, ' ').slice(0, 90)
}

/**
 * The filters that draw a label: a dark band, and the words from `labelFile` (a plain name in the folder FFmpeg runs
 * in), never as text in the graph. The font is one of labelFont()'s fixed paths. Pure.
 */
export function labelFilters(font: string, labelFile: string, W: number, H: number): string[] {
  if (!/^[A-Za-z0-9._-]+$/.test(labelFile) || !/^[A-Za-z0-9/._ -]+$/.test(font)) throw new Error('A label file or font path the filter graph cannot take')
  return [`drawbox=x=0:y=${H - 34}:w=${W}:h=34:color=black@0.7:t=fill`, `drawtext=fontfile=${font}:fontsize=16:fontcolor=white:x=8:y=${H - 26}:expansion=none:textfile=${labelFile}`]
}

/**
 * The contact sheet: each problem's worst frame with its box in red and a label
 * (up to 16, worst first, 4 across), or, with no problems, up to 8 frames
 * across the video with their times. Answers the file name, or null.
 */
async function contactSheet(ctx: JobContext, dir: string, issues: VisualIssue[], times: number[], files: string[], W: number, H: number): Promise<string | null> {
  if (!times.length) return null
  const font = (await hasDrawtext()) ? await labelFont() : null
  const marked = join(dir, 'marked')
  await mkdir(marked, { recursive: true })
  const nearest = (t: number) => times.reduce((best, x, k) => (Math.abs(x - t) < Math.abs(times[best]! - t) ? k : best), 0)
  const tiles = issues.length
    ? issues.slice(0, 16).map((issue) => ({ i: nearest(issue.from + (issue.to - issue.from) / 2), box: issue.box, label: `${issue.name} - ${issue.detail}` }))
    : Array.from({ length: Math.min(8, times.length) }, (_, k) => ({ i: Math.round((k * (times.length - 1)) / Math.max(1, Math.min(8, times.length) - 1)), box: null, label: 'nothing flagged' }))
  for (const [n, tile] of tiles.entries()) {
    const b = tile.box
    // The label (layer names and details: the person's words) never enters the filter graph: it is a file of its own,
    // read with textfile= from the folder FFmpeg runs in.
    const labelFile = `label-${String(n).padStart(3, '0')}.txt`
    if (font) await writeFile(join(marked, labelFile), labelText(times[tile.i]!, tile.label))
    const filters = [
      ...(b ? [`drawbox=x=${Math.round(b.x * W)}:y=${Math.round(b.y * H)}:w=${Math.max(2, Math.round(b.width * W))}:h=${Math.max(2, Math.round(b.height * H))}:color=red@0.9:t=4`] : []),
      ...(font ? labelFilters(font, labelFile, W, H) : []),
    ]
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', files[tile.i]!, ...(filters.length ? ['-vf', filters.join(',')] : []), `m-${String(n).padStart(3, '0')}.png`], { timeout: 60_000, signal: ctx.signal, cwd: marked })
  }
  const cols = Math.min(4, tiles.length)
  const rows = Math.ceil(tiles.length / cols)
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-framerate', '1', '-i', join(marked, 'm-%03d.png'), '-vf', `scale=${Math.round(W * 0.6)}:-2,tile=${cols}x${rows}:padding=6:color=white`, '-frames:v', '1', join(dir, 'sheet.png')], {
    timeout: 120_000,
    signal: ctx.signal,
  })
  return 'sheet.png'
}

export const runLook: JobHandler<'look'> = async (ctx) => {
  const input = ctx.job.input
  const project: EditorProject = frozenProject(input.project)
  const step = typeof input.step === 'number' && input.step >= 0.1 && input.step <= 5 ? input.step : 0.5
  const scale = typeof input.scale === 'number' && input.scale >= 0.2 && input.scale <= 1 ? input.scale : 0.5
  const dir = join(ctx.scratch, 'look')
  await mkdir(dir, { recursive: true })
  const layers = (project.layers ?? []) as EditorLayer[]
  const result = await withStills(ctx, project, input.fonts, stage(ctx, 0, 0.1), async (render) => {
    const c = await render.composition(project)
    const fps = c.fps
    const total = c.durationInFrames / fps
    const W = Math.round(c.width * scale)
    const H = Math.round(c.height * scale)
    // Which full-frame layers are the picture (opaque scenes, backdrops) rather than something drawn over it.
    const picture = new Set(layers.filter((l) => l.kind === 'background').map((l) => l.id))
    const candidates = layers.filter((l) => fullFrame(l) && l.kind !== 'background')
    if (candidates.length) {
      ctx.log(`Telling scenes from overlays (${candidates.length})`)
      const bare = { ...project, layers: [] }
      for (const [i, l] of candidates.entries()) {
        const frame = Math.round(Math.min(total - 0.05, (l.startFrame + l.endFrame) / 2 / fps) * fps)
        const a = join(dir, `probe-${i}-alone.png`)
        const b = join(dir, `probe-${i}-bare.png`)
        await render.still({ ...project, layers: [l] }, frame, a, 0.25)
        await render.still(bare, frame, b, 0.25)
        const w = Math.round(c.width * 0.25)
        const h = Math.round(c.height * 0.25)
        if (changedShare(await decode(a, w, h, ctx.signal), await decode(b, w, h, ctx.signal)) > 0.8) picture.add(l.id)
      }
    }
    const overlays = layers.filter((l) => !picture.has(l.id))
    let times = lookTimes(overlays, total, fps, step)
    if (times.length > MAX_LOOK_FRAMES) {
      const every = times.length / MAX_LOOK_FRAMES
      times = Array.from({ length: MAX_LOOK_FRAMES }, (_, k) => times[Math.floor(k * every)]!)
      ctx.log(`Looking at ${MAX_LOOK_FRAMES} frames spread over the video (a smaller step would need more)`)
    }
    if (!times.length) return { times, issues: [] as VisualIssue[], full: [] as string[], W, H, overlap: false }
    ctx.log(`Rendering ${times.length} frames with and without the overlays`)
    const base = { ...project, layers: layers.filter((l) => picture.has(l.id)) }
    const full: string[] = []
    const bare: string[] = []
    const progress = stage(ctx, 0.1, 0.75)
    for (const [i, t] of times.entries()) {
      const frame = Math.round(t * fps)
      full.push(join(dir, `full-${String(i).padStart(3, '0')}.png`))
      bare.push(join(dir, `base-${String(i).padStart(3, '0')}.png`))
      await render.still(project, frame, full[i]!, scale)
      await render.still(base, frame, bare[i]!, scale)
      progress((i + 1) / times.length)
    }
    // Where the person is, in the frames without the overlays (macOS Vision, when this worker has it).
    const subjects = await findSubjects(ctx, bare)
    const findings: Finding[] = []
    for (const [i, t] of times.entries()) {
      const frame = Math.round(t * fps)
      const active = overlays.filter((l) => settled(l, frame))
      const s = subjects?.[i]
      const subject: Subject | null = subjects ? { mask: s?.mask ? maskAt(s.mask, W, H) : null, faces: (s?.faces ?? []).filter((f) => f.confidence > 0.5) } : null
      findings.push(...measureFrame(t, await decode(full[i]!, W, H, ctx.signal), await decode(bare[i]!, W, H, ctx.signal), active, subject))
      ctx.progress(0.75 + (0.15 * (i + 1)) / times.length)
    }
    const issues = mergeFindings(findings, step)
    return { times, issues, full, W, H, overlap: subjects !== null }
  })
  checkAborted(ctx.signal)
  const sheet = await contactSheet(ctx, dir, result.issues, result.times, result.full, result.W, result.H)
  const report: LookResult = {
    projectId: project.id,
    digest: String(input.digest ?? ''),
    checkedAt: new Date().toISOString(),
    times: result.times,
    issues: result.issues,
    ...(sheet ? { sheet } : {}),
    folder: `checks/${ctx.job.id}`,
    ...(result.overlap
      ? { overlap: 'measured' as const }
      : { overlap: 'not-measured' as const, note: 'Overlays on the person and their face were not measured: this Studio worker has no person finder (macOS Vision). Contrast, size and overflow of text were.' }),
    files: [],
  }
  await writeFile(join(dir, 'report.json'), JSON.stringify(report))
  report.files = await store(ctx, dir, keptFiles(await readdir(dir)).filter((f) => f === 'sheet.png' || f === 'report.json'), stage(ctx, 0.92, 1))
  ctx.log(`Looked at ${result.times.length} frames: ${result.issues.length} problem${result.issues.length === 1 ? '' : 's'}`)
  return report
}
