/**
 * Sound design with earshot (../earshot.ts; the contract is
 * web/src/lib/studio/server/sound-contract.ts). Each job does the audio work
 * and answers what it made; the app applies it to the video (a job never edits
 * a video).
 *
 *   sounds        the cues (the app computed them from the edit) rendered with
 *                 the preset's sounds, levelled against the music bed (the
 *                 music segments mixed with FFmpeg on the timeline's clock),
 *                 each take a library asset with where it sits so its sync
 *                 point lands on the cue. Then the stop-down: the music steps
 *                 down ~9 dB for 0.4 s before every hit, drop, big whoosh and
 *                 swell, always made from the bed as imported (passes never
 *                 stack ducks); a pass with no big moment puts that take back.
 *   sound-import  a sound or music file (a library asset, or an upload) with
 *                 its onset and peak measured, levelled, and placed so its sync
 *                 point lands on the time; a music bed is cut to the video's end
 *                 and faded out.
 *   listen        the edit rendered as sound only (Remotion, WAV, mastered when
 *                 the edit says so), then earshot listens against the edit's own
 *                 cue sheet: the listening transcript, the launch-film
 *                 scorecard, and the annotated sheet, stored as
 *                 `listen/<job id>/sheet.png`.
 *   sound-bank    the bank and the kit presets.
 */
import { createRequire } from 'node:module'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EditorAsset } from '../../../web/src/lib/studio/engine/contracts.ts'
import type { SoundCue } from '../../../web/src/lib/studio/engine/sound.ts'
import type { BedPiece, ListenResult, MusicChange, MusicSegment, RenderedSound, SoundBankResult, SoundImportResult, SoundsResult } from '../../../web/src/lib/studio/server/sound-contract.ts'
import { fileSha256 } from '../app-client.ts'
import { buildAsset, inspectFile, publishAsset, stageAssets } from '../assets.ts'
import { bridge, BridgeError, earshotInstalled } from '../earshot.ts'
import { loudnessTarget, parseLoudnorm, secondPass } from '../master.ts'
import { mediaTimeout, probe, run } from '../media.ts'
import { COMPOSITION_ID, inputPropsFor, unstagedNeeds } from '../render.ts'
import { stageFonts } from '../fonts.ts'
import { frozenProject } from './export.ts'
import { checkAborted, JobError, stage, type JobContext, type JobHandler } from './context.ts'

const require = createRequire(import.meta.url)
const engineSound = require('../../../web/src/lib/studio/engine/sound.ts') as typeof import('../../../web/src/lib/studio/engine/sound.ts')

export const NEEDS_EARSHOT = 'Sound design needs earshot where the Studio worker runs (STUDIO_EARSHOT_DIR), and it is not installed there.'

/** The roles the music steps down before. */
export const BIG_ROLES = ['hit', 'drop', 'whoosh.long', 'swell']

/** One cue as the bridge renders it. */
export type BridgeCue = { id: string; file?: string; start_s: number; trim_s: number; dur_s: number; sound: string; role: string | null; gain_db: number; warnings?: (string | null)[]; skipped?: string }

/**
 * The containers an uploaded sound may be: the ones that hold one stream of audio and name no other file. A
 * playlist (hls), a concat list or anything else that would make FFmpeg read other files is refused before it is
 * opened (FFmpeg's own format whitelist), whatever the file's name says.
 */
export const SOUND_FORMATS = 'wav,w64,mp3,flac,ogg,mov,matroska,aac,aiff,caf'

/** The longest sound an upload may be. */
const MAX_UPLOAD_SECONDS = 2 * 60 * 60

/**
 * An uploaded sound as a 48 kHz float WAV in scratch, made with the fenced FFmpeg (only files and pipes, only the
 * containers above): measured first (it must hold audio, at most two hours), then its first audio stream decoded.
 * earshot is only ever handed this WAV, never the upload.
 */
export async function uploadAsWav(raw: string, wav: string, signal: AbortSignal): Promise<string> {
  const formats = ['-format_whitelist', SOUND_FORMATS]
  let p
  try {
    p = await probe(raw, { signal, extraArgs: formats })
  } catch (err) {
    checkAborted(signal)
    throw new JobError(`That file is not a sound the Studio can read (${(err as Error).message.slice(0, 160)})`)
  }
  if (!p.streams.some((s) => s.codec_type === 'audio')) throw new JobError('That file has no sound in it.')
  const seconds = Number(p.format.duration)
  if (Number.isFinite(seconds) && seconds > MAX_UPLOAD_SECONDS) throw new JobError('That sound is longer than two hours.')
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...formats, '-i', raw, '-map', '0:a:0', '-vn', '-sn', '-dn', '-c:a', 'pcm_f32le', '-ar', '48000', '-t', String(MAX_UPLOAD_SECONDS), wav], {
    timeout: mediaTimeout(Number.isFinite(seconds) ? seconds : MAX_UPLOAD_SECONDS, 1),
    signal,
  })
  return wav
}

/** earshot's folder, or the job's refusal. */
function earshotDir(ctx: Pick<JobContext, 'config'>): string {
  const dir = ctx.config.earshotDir
  if (!earshotInstalled(dir)) throw new JobError(NEEDS_EARSHOT)
  return dir
}

/** A bridge call whose failure is the job's sentence. */
async function ask<T>(ctx: JobContext, request: Record<string, unknown>, timeout?: number): Promise<T> {
  try {
    return await bridge<T>(earshotDir(ctx), request, { signal: ctx.signal, cwd: ctx.scratch, timeout })
  } catch (err) {
    checkAborted(ctx.signal)
    throw err instanceof BridgeError ? new JobError(err.message) : err
  }
}

const unique = (assets: EditorAsset[]) => [...new Map(assets.map((a) => [a.id, a])).values()]

/**
 * A finished local audio file as a library asset (measured, hashed, stored under its sha256). The same bytes twice
 * in one job are one asset. The file is moved into the cache.
 */
async function publishLocal(ctx: JobContext, file: string, name: string, provenance: Record<string, unknown>, published: Map<string, EditorAsset>): Promise<EditorAsset> {
  const sha256 = await fileSha256(file)
  const known = published.get(sha256)
  if (known) return known
  const { measured, waveform } = await inspectFile(file, name, ctx.signal)
  if (measured.kind !== 'audio' || !measured.hasAudio) throw new JobError(`earshot made ${name}, but it is not audio that can be read.`)
  const asset = buildAsset(measured, { sha256, bytes: (await stat(file)).size }, { name, waveform, provenance })
  await publishAsset(ctx, asset, file)
  published.set(sha256, asset)
  return asset
}

/** FFmpeg's arguments for the music bed as one WAV on the timeline's clock (each piece trimmed, gained, delayed). Pure. */
export function bedArgs(pieces: { path: string; piece: BedPiece }[], out: string): string[] {
  const inputs: string[] = []
  const chains: string[] = []
  pieces.forEach(({ path, piece }, n) => {
    inputs.push('-ss', piece.trimStartSeconds.toFixed(4), '-t', Math.max(0.001, piece.trimEndSeconds - piece.trimStartSeconds).toFixed(4), '-i', path)
    chains.push(`[${n}:a]volume=${piece.gain.toFixed(4)},adelay=${Math.round(piece.atSeconds * 1000)}:all=1[m${n}]`)
  })
  const mix = `${chains.map((_, i) => `[m${i}]`).join('')}amix=inputs=${chains.length}:normalize=0[out]`
  return ['-nostdin', '-y', '-v', 'error', ...inputs, '-filter_complex', `${chains.join(';')};${mix}`, '-map', '[out]', '-ar', '48000', out]
}

/**
 * When the music steps down: the timeline time each big moment's take starts at, on the bed's own clock (its file
 * time), rounded to the millisecond, once each, and never in the first 0.3 s. Pure.
 */
export function stopDownTimes(rendered: BridgeCue[], music: Pick<MusicSegment, 'atSeconds' | 'trimStartSeconds'>): number[] {
  const times = rendered.filter((c) => c.file && BIG_ROLES.includes(c.role ?? '')).map((c) => c.start_s - c.trim_s - music.atSeconds + music.trimStartSeconds)
  return [...new Set(times.map((t) => Math.round(t * 1000) / 1000))].filter((t) => t > 0.3).sort((a, b) => a - b)
}

/** Rendered cues as placed sounds (with their assets) and notes for what was skipped or warned. Pure over `assetOf`. */
export function placedFrom(rendered: BridgeCue[], cues: SoundCue[], assetOf: (cue: BridgeCue) => EditorAsset | undefined): { placed: RenderedSound[]; notes: string[] } {
  const byId = new Map(cues.map((c) => [c.id, c]))
  const placed: RenderedSound[] = []
  const notes: string[] = []
  for (const item of rendered) {
    const asset = item.file ? assetOf(item) : undefined
    if (!item.file || !asset) {
      notes.push(`${item.id}: ${item.skipped ?? 'not rendered'}`)
      continue
    }
    placed.push({
      cueId: item.id,
      asset,
      startSeconds: item.start_s,
      trimSeconds: item.trim_s,
      durationSeconds: item.dur_s,
      sound: item.sound,
      role: item.role,
      gainDb: item.gain_db,
      label: byId.get(item.id)?.label ?? item.sound,
    })
    for (const warning of item.warnings ?? []) if (warning) notes.push(`${item.id}: ${warning}`)
  }
  return { placed, notes }
}

export const runSounds: JobHandler<'sounds'> = async (ctx): Promise<SoundsResult> => {
  earshotDir(ctx)
  const input = ctx.job.input
  if (!Array.isArray(input.cues) || !input.cues.length) throw new JobError('There are no moments to sound.')
  const bed = (input.bed ?? []).filter((p) => p.asset.hasAudio && p.trimEndSeconds > p.trimStartSeconds && p.gain > 0)
  const release = await stageAssets(ctx, unique([...bed.map((p) => p.asset), ...(input.music ? [input.music.source] : [])]), stage(ctx, 0, 0.1))
  try {
    let bedFile: string | null = null
    if (bed.length) {
      ctx.log('Levelling effects against the music bed')
      bedFile = join(ctx.scratch, 'bed.wav')
      await run('ffmpeg', bedArgs(bed.map((piece) => ({ path: ctx.cache.pathOf(piece.asset.file), piece })), bedFile), { timeout: 180_000, maxBuffer: 4 * 1024 * 1024, signal: ctx.signal })
    }
    const n = input.cues.length
    ctx.log(`Rendering ${n} sound${n === 1 ? '' : 's'} with earshot (${input.preset})`)
    ctx.progress(0.12)
    const render = (cues: SoundCue[], out: string) => ask<{ cues: BridgeCue[] }>(ctx, { cmd: 'render', out, preset: input.preset, music: bedFile, cues }, mediaTimeout(cues.length * 2, 1))
    let rendered = (await render(input.cues, join(ctx.scratch, 'sfx'))).cues
    // Sounds on the never-use list are rendered again as their stand-in (same cue, same timing).
    const banned = rendered.filter((c) => c.file && engineSound.bannedSounds[c.sound])
    if (banned.length) {
      const again = await render(banned.map((c) => ({ ...input.cues.find((cue) => cue.id === c.id)!, sound: engineSound.bannedSounds[c.sound]! })), join(ctx.scratch, 'sfx-swapped'))
      const swapped = new Map(again.cues.map((c) => [c.id, c]))
      rendered = rendered.map((c) => swapped.get(c.id) ?? c)
    }
    checkAborted(ctx.signal)
    ctx.progress(0.7)
    ctx.log('Storing the takes in the library')
    const published = new Map<string, EditorAsset>()
    const assets = new Map<string, EditorAsset>()
    for (const item of rendered) {
      if (!item.file) continue
      assets.set(item.id, await publishLocal(ctx, item.file, `${item.sound.replace('/', ' · ')}.wav`, { earshot: true, sound: item.sound, role: item.role, gainDb: item.gain_db }, published))
    }
    const { placed, notes } = placedFrom(rendered, input.cues, (c) => assets.get(c.id))
    ctx.progress(0.9)
    const music = input.music ? await stopDown(ctx, input.mode, input.music, rendered, published) : null
    ctx.progress(1)
    ctx.log(`Made ${placed.length} sound${placed.length === 1 ? '' : 's'}`)
    return { preset: input.preset, placed, notes, music }
  } finally {
    release()
  }
}

/** The launch-film stop-down on the music bed, made from the take as imported. */
async function stopDown(ctx: JobContext, mode: 'pass' | 'add', music: MusicSegment, rendered: BridgeCue[], published: Map<string, EditorAsset>): Promise<MusicChange | null> {
  const times = stopDownTimes(rendered, music)
  const base = { segmentId: music.segmentId, currentAssetId: music.currentAssetId, sourceId: music.source.id }
  if (!times.length) {
    // A new pass with no big moment brings the take as imported back; added sounds leave the bed as it is.
    return mode === 'pass' && music.source.id !== music.currentAssetId ? { action: 'restore', ...base } : null
  }
  ctx.log(`Stepping the music down before ${times.length} big moment${times.length === 1 ? '' : 's'}`)
  const ducked = await ask<{ file: string }>(ctx, { cmd: 'duck', file: ctx.cache.pathOf(music.source.file), out: join(ctx.scratch, 'duck'), at_s: times, depth_db: 9, length_s: 0.4 })
  const name = `${music.source.name.replace(/\.[a-z0-9]+$/i, '')} · ducked.wav`
  const asset = await publishLocal(ctx, ducked.file, name, { earshot: true, duckedFrom: music.source.id }, published)
  return { action: 'duck', ...base, asset, moments: times }
}

export const runSoundImport: JobHandler<'sound-import'> = async (ctx): Promise<SoundImportResult> => {
  earshotDir(ctx)
  const input = ctx.job.input
  const music = input.track === 'music'
  const base = (input.name || 'Sound').replace(/\.[a-z0-9]+$/i, '').slice(0, 120) || 'Sound'
  let file: string
  let release = () => {}
  if (input.asset) {
    release = await stageAssets(ctx, [input.asset], stage(ctx, 0, 0.3))
    file = ctx.cache.pathOf(input.asset.file)
  } else if (input.uploadKey) {
    // The upload keeps no name of its own (its extension could pick a demuxer): it is measured and decoded to a WAV.
    const raw = join(ctx.scratch, 'upload.bin')
    ctx.log(`Reading ${input.name}`)
    await ctx.client.readBlob(ctx.job.id, input.uploadKey, raw, { signal: ctx.signal })
    file = await uploadAsWav(raw, join(ctx.scratch, 'upload.wav'), ctx.signal)
    ctx.progress(0.3)
  } else throw new JobError('The import names no file.')
  try {
    ctx.log(music ? `Placing ${base} as the music bed from ${input.at} s` : `Placing ${base} on its ${input.align} at ${input.at} s`)
    const placed = await ask<{ file: string; start_s: number; trim_s: number; dur_s: number }>(ctx, {
      cmd: 'place_file',
      file,
      out: join(ctx.scratch, 'placed'),
      t: input.at,
      align: music ? 'onset' : input.align,
      ...(input.offsetMs !== undefined ? { offset_ms: input.offsetMs } : {}),
      ...(input.levelDb !== undefined ? { level_db: input.levelDb } : {}),
      ...(input.from ? { source_start: input.from } : {}),
      ...(music ? { raw_start: true, end_s: input.endSeconds, fade_out_s: input.fadeOut ?? 1.5 } : {}),
    })
    ctx.progress(0.8)
    const asset = await publishLocal(ctx, placed.file, `${base}.wav`, { earshot: true, sound: `file:${base}`, ...(music ? { music: true } : {}) }, new Map())
    ctx.progress(1)
    return { asset, startSeconds: placed.start_s, trimSeconds: placed.trim_s, durationSeconds: placed.dur_s, track: input.track, name: base, label: input.label ?? base }
  } finally {
    release()
  }
}

/** Master a WAV to a loudness target (two-pass loudnorm, linear where it fits), as the export masters its sound. */
async function masterWav(input: string, output: string, master: { lufs: number; truePeak: number }, signal: AbortSignal): Promise<boolean> {
  const target = loudnessTarget(master)
  const probe = await run('ffmpeg', ['-nostdin', '-hide_banner', '-i', input, '-af', `loudnorm=${target}:print_format=json`, '-f', 'null', '-'], { timeout: 600_000, maxBuffer: 16 * 1024 * 1024, signal })
  const m = parseLoudnorm(probe.stderr)
  if (!Number.isFinite(Number(m.input_i)) || Number(m.input_i) < -70) return false
  const filter = secondPass(target, m)
  await run('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-i', input, '-af', filter, '-c:a', 'pcm_s24le', output], { timeout: 600_000, maxBuffer: 4 * 1024 * 1024, signal })
  return true
}

/** What earshot's listen answers (paths are the worker's own and are dropped). */
type Heard = {
  timeline?: { summary?: unknown; text?: string; json?: string }
  critique?: { verdict?: string; score?: number; text?: string; json?: string }
  sheet?: { summary?: unknown; png?: string }
}

export const runListen: JobHandler<'listen'> = async (ctx): Promise<ListenResult> => {
  earshotDir(ctx)
  const input = ctx.job.input
  const project = frozenProject(input.project)
  for (const line of unstagedNeeds(project)) if (!(input.fonts?.length && line.startsWith('Fonts '))) ctx.log(line)
  const releaseAssets = await stageAssets(ctx, project.assets, stage(ctx, 0, 0.08))
  let mix = join(ctx.scratch, 'mix.raw.wav')
  let seconds = 0
  try {
    checkAborted(ctx.signal)
    const { serveUrl, release } = await ctx.renderer.bundle(ctx.log)
    const fonts = await stageFonts(ctx, input.fonts, serveUrl).catch(() => ({ faces: [], release: async () => {} }))
    try {
      const { selectComposition, renderMedia, makeCancelSignal } = await import('@remotion/renderer')
      const common = await ctx.renderer.common(ctx.log)
      const inputProps = { ...inputPropsFor(project), fonts: fonts.faces }
      const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps, ...common })
      seconds = composition.durationInFrames / composition.fps
      ctx.log(`Rendering the mix (sound only, ${seconds.toFixed(1)} s)`)
      const { cancel, cancelSignal } = makeCancelSignal()
      const onAbort = () => cancel()
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      try {
        const progress = stage(ctx, 0.1, 0.35)
        await renderMedia({ serveUrl, composition, inputProps, ...common, codec: 'wav', outputLocation: mix, concurrency: ctx.config.renderConcurrency, cancelSignal, onProgress: ({ progress: p }) => progress(p) })
      } catch (err) {
        checkAborted(ctx.signal)
        throw err
      } finally {
        ctx.signal.removeEventListener('abort', onAbort)
      }
    } finally {
      await fonts.release()
      release()
    }
  } finally {
    releaseAssets()
  }
  checkAborted(ctx.signal)
  if (project.master) {
    ctx.log(`Mastering the mix to ${project.master.lufs} LUFS, as the export will`)
    const mastered = join(ctx.scratch, 'mix.wav')
    if (await masterWav(mix, mastered, project.master, ctx.signal)) mix = mastered
  }
  const cues = join(ctx.scratch, 'cues.json')
  await writeFile(cues, JSON.stringify(input.cues))
  ctx.log('earshot is listening (the first time loads its models, about 30 s)')
  ctx.progress(0.4)
  const heard = await ask<Heard>(ctx, { cmd: 'listen', audio: mix, cues, out: join(ctx.scratch, 'heard'), checks: input.checks }, 20 * 60_000)
  checkAborted(ctx.signal)
  ctx.progress(0.95)
  const result: ListenResult = { seconds: Math.round(seconds * 1000) / 1000 }
  if (heard.timeline) result.timeline = { summary: heard.timeline.summary, ...(heard.timeline.text ? { text: heard.timeline.text } : {}) }
  if (heard.critique) result.critique = { ...(heard.critique.verdict ? { verdict: heard.critique.verdict } : {}), ...(typeof heard.critique.score === 'number' ? { score: heard.critique.score } : {}), ...(heard.critique.text ? { text: heard.critique.text } : {}) }
  if (heard.sheet?.png) {
    const png = await readFile(heard.sheet.png).catch(() => null)
    if (png?.length) {
      const key = `listen/${ctx.job.id}/sheet.png`
      await ctx.client.writeBlob(ctx.job.id, key, heard.sheet.png, 'image/png', { signal: ctx.signal })
      result.sheet = { key, ...(heard.sheet.summary !== undefined && heard.sheet.summary !== null ? { summary: heard.sheet.summary } : {}) }
    } else ctx.log('earshot drew no sheet')
  }
  ctx.progress(1)
  ctx.log(result.critique?.verdict ? `Listened: ${result.critique.verdict}${typeof result.critique.score === 'number' ? ` (${result.critique.score})` : ''}` : 'Listened')
  return result
}

export const runSoundBank: JobHandler<'sound-bank'> = async (ctx): Promise<SoundBankResult> => {
  earshotDir(ctx)
  await mkdir(ctx.scratch, { recursive: true })
  ctx.log('Reading the sound bank')
  const list = await ask<{ version: string; sounds: SoundBankResult['sounds'] }>(ctx, { cmd: 'list' }, 120_000)
  const presets = await ask<{ presets: SoundBankResult['presets'] }>(ctx, { cmd: 'presets' }, 120_000)
  return { version: String(list.version ?? ''), sounds: list.sounds ?? [], presets: presets.presets ?? {} }
}
