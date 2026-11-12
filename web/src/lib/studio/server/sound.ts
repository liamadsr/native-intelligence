// Sound design: the automatic sound pass (a sound effect on every layer entrance, transition and recorded click,
// levelled against the music), single sounds at a time, importing a sound or a music bed, the sound bank, and
// listening to the mix (a measured report of how it sounds). The work runs in the Studio worker with earshot
// (sound-contract.ts); this module queues it and files what comes back.
//
// The app computes the cue sheet from the edit (engine/sound.ts, pure) and freezes what the worker needs in the job
// (the cues, the music bed, the edit for listening). When a job finishes, what it made is applied to the video here,
// as the editor's own sound menu did on the local product's server: the automatic pass replaces the earlier
// automatic pass and keeps hand-placed sounds, the music steps down before big moments, the new audio is registered
// in the library, and the edit is saved with the digest guard as ONE step (the editor takes it as one undoable
// step), with a version kept before it. A video changed while the job ran is not a failure: sound edits only touch
// the audio tracks, so they are applied again on the fresh edit.
//
// The bank (252 sounds made in code, and the kit presets' roles) is kept as a studio_record (`sound`/`bank`) and read
// again from the worker at most once a week, so listing it rarely needs the worker.
import { randomUUID } from 'node:crypto'
import { EditorAssetSchema, type EditorAsset, type EditorProject } from '../engine/contracts'
import type { EditorJob } from '../engine/api'
import { earshotCueFile, MUSIC_TRACK, placeMusic, placeSounds, soundCues, type PlacedSound, type SoundCue } from '../engine/sound'
import { projectDuration } from '../engine/timeline'
import { getAsset, getAssets, registerAsset } from './assets'
import { checkBlobKey, deleteBlob, getBlob } from './blobs'
import { requireCapability, workerCan } from './capabilities'
import { isUuid, type StudioContext } from './context'
import { notFoundError, StudioError } from './errors'
import { serveBlob } from './files'
import { exportFonts } from './fonts'
import { jobRow, ownAsset, queueJob, toEditorJob, waitForJob, type JobRow } from './jobs'
import { checkFileName } from './media'
import { getRecord, putRecord } from './records'
import {
  LISTEN_CHECKS,
  SOUND_PRESETS,
  type BedPiece,
  type ListenCheck,
  type ListenInput,
  type ListenResult,
  type MusicChange,
  type MusicSegment,
  type RenderedSound,
  type SoundBankResult,
  type SoundImportInput,
  type SoundImportResult,
  type SoundPreset,
  type SoundsInput,
  type SoundsResult,
} from './sound-contract'
import { saveVersion } from './versions'
import { openVideo, saveVideo } from './videos'

export const SOUND_COLLECTION = 'sound'
const BANK_KEY = 'bank'

/** How long the kept bank is fresh: it only changes when the worker's earshot moves to a new pin. */
export const BANK_FRESH_MS = 7 * 24 * 60 * 60_000

/** The most sounds one request places. */
export const MAX_SOUNDS = 200

/** How many times a finished job's edit is applied again when the video changed under it. */
const SAVE_TRIES = 4

type KeptBank = SoundBankResult & { at: string }
export type SoundBankAnswer = { available: boolean; version?: string; at?: string; sounds: SoundBankResult['sounds']; presets: SoundBankResult['presets'] }

// ---- reading what the editor and the agent send ------------------------------------------------------------------

const seconds = (value: unknown, what: string, min = 0, max = 36_000): number => {
  const n = Number(value)
  if (value === undefined || value === null || value === '' || !Number.isFinite(n) || n < min || n > max) throw new StudioError(`${what} must be a number of seconds from ${min} to ${max}.`)
  return n
}
const optionalNumber = (value: unknown, what: string, min: number, max: number): number | undefined => {
  if (value === undefined || value === null) return undefined
  const n = Number(value)
  if (!Number.isFinite(n) || n < min || n > max) throw new StudioError(`${what} must be a number from ${min} to ${max}.`)
  return n
}
const shortText = (value: unknown, max = 200): string | undefined => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined)

/** A preset by name (launch when none), or a 400. Pure. */
export function checkPreset(value: unknown): SoundPreset {
  if (value === undefined || value === null || value === '') return 'launch'
  if (typeof value === 'string' && (SOUND_PRESETS as readonly string[]).includes(value)) return value as SoundPreset
  throw new StudioError(`The preset is one of ${SOUND_PRESETS.join(', ')}.`)
}

/** The listening checks asked for (all three when none), or a 400. Pure. */
export function checkChecks(value: unknown): ListenCheck[] {
  if (value === undefined || value === null) return [...LISTEN_CHECKS]
  if (!Array.isArray(value) || !value.length || value.some((c) => !(LISTEN_CHECKS as readonly unknown[]).includes(c))) throw new StudioError(`checks are any of ${LISTEN_CHECKS.join(', ')}.`)
  return [...new Set(value as ListenCheck[])]
}

/**
 * Chosen sounds as cues: each {at, kind} with a kit role, or {at, sound} with a bank id, and the optional knobs
 * (pitch, dur, apex, weight, level_db, over_bed_db, label, id). Pure; a 400 says which one is wrong.
 */
export function cuesFromSounds(value: unknown, makeId: () => string): SoundCue[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_SOUNDS) throw new StudioError(`sounds must be a list of 1–${MAX_SOUNDS} {at, kind | sound}.`)
  return value.map((raw, i) => {
    const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const t = Number(s.at ?? s.t)
    if (!Number.isFinite(t) || t < 0 || t > 36_000) throw new StudioError(`sound ${i + 1}: "at" (seconds) is required.`)
    const kind = shortText(s.kind, 40)
    const sound = shortText(s.sound, 120)
    if (!kind && !sound) throw new StudioError(`sound ${i + 1}: give a kind (pop, whoosh.short, hit, …) or a bank sound id.`)
    if (kind && !/^[a-z][a-z0-9_.-]*$/.test(kind)) throw new StudioError(`sound ${i + 1}: "${kind}" is not a kind.`)
    if (sound && !/^[a-z0-9_]+(\/[a-z0-9_.-]+)*$/i.test(sound)) throw new StudioError(`sound ${i + 1}: "${sound}" is not a bank id.`)
    const pitch = shortText(s.pitch, 8)
    if (pitch && !/^[A-G][#b]?\d$/.test(pitch)) throw new StudioError(`sound ${i + 1}: pitch is a note like E5.`)
    const cue: SoundCue = { id: shortText(s.id, 120) ?? `manual:${makeId()}`, t: Math.round(t * 1000) / 1000, kind: kind ?? 'sound', label: shortText(s.label) ?? sound ?? kind! }
    if (sound) cue.sound = sound
    if (pitch) cue.pitch = pitch
    const dur = optionalNumber(s.dur, `sound ${i + 1}: dur`, 0.02, 30)
    if (dur !== undefined) cue.dur = dur
    const apex = optionalNumber(s.apex, `sound ${i + 1}: apex`, 0, 30)
    if (apex !== undefined) cue.apex = apex
    const weight = optionalNumber(s.weight, `sound ${i + 1}: weight`, 0, 2)
    if (weight !== undefined) cue.weight = weight
    const level = optionalNumber(s.level_db ?? s.levelDb, `sound ${i + 1}: level_db`, -60, 12)
    if (level !== undefined) cue.level_db = level
    const over = optionalNumber(s.over_bed_db ?? s.overBedDb, `sound ${i + 1}: over_bed_db`, -20, 30)
    if (over !== undefined) cue.over_bed_db = over
    return cue
  })
}

// ---- what the worker is given ------------------------------------------------------------------------------------

/** The music to level effects against: every segment of an unmuted music track, on the timeline's clock. Pure. */
export function bedPieces(project: EditorProject): BedPiece[] {
  const fps = project.output.fps
  const pieces: BedPiece[] = []
  for (const track of project.audioTracks) {
    if (track.role !== 'music' || track.muted) continue
    for (const segment of track.segments) {
      const asset = project.assets.find((a) => a.id === segment.assetId)
      if (!asset) continue
      pieces.push({ asset, atSeconds: segment.startFrame / fps, trimStartSeconds: segment.trimStartSeconds, trimEndSeconds: segment.trimEndSeconds, gain: track.gain * (segment.gain ?? 1) })
    }
  }
  return pieces
}

/** The asset a ducked take was made from (its provenance says), else the asset itself. Pure. */
export const duckedFrom = (asset: EditorAsset | undefined): string | undefined => (asset?.provenance as { duckedFrom?: string } | undefined)?.duckedFrom ?? asset?.id

/** The Music track's one segment and the take it was ducked from (the library's when it left the edit), or null. */
export async function musicSegment(ctx: StudioContext, project: EditorProject): Promise<MusicSegment | null> {
  const track = project.audioTracks.find((t) => t.id === MUSIC_TRACK)
  const segment = track?.segments.length === 1 ? track.segments[0]! : null
  if (!segment) return null
  const current = project.assets.find((a) => a.id === segment.assetId)
  const sourceId = duckedFrom(current)
  if (!sourceId) return null
  const source = project.assets.find((a) => a.id === sourceId) ?? (await getAssets(ctx, [sourceId])).get(sourceId)
  if (!source) return null
  return { segmentId: segment.id, atSeconds: segment.startFrame / project.output.fps, trimStartSeconds: segment.trimStartSeconds, currentAssetId: segment.assetId, source }
}

const asJob = (row: JobRow): { job: EditorJob } => ({ job: toEditorJob(row) })

async function queueSounds(ctx: StudioContext, videoId: string, project: EditorProject, mode: SoundsInput['mode'], preset: SoundPreset, cues: SoundCue[], replaceIds?: string[]) {
  const input: SoundsInput = { mode, preset, cues, bed: bedPieces(project), music: await musicSegment(ctx, project), ...(replaceIds?.length ? { replaceIds } : {}) }
  return asJob(await queueJob(ctx, 'sounds', input, videoId))
}

/** POST /projects/:id/sound-pass {preset?, from?, to?, clicks?, captions?}: the automatic pass, as a job. */
export async function startSoundPass(ctx: StudioContext, videoId: string, body: Record<string, unknown>) {
  requireCapability(ctx, 'sound')
  const preset = checkPreset(body.preset)
  const { project } = await openVideo(ctx, videoId)
  const options = {
    ...(body.from !== undefined && body.from !== null ? { from: seconds(body.from, 'from') } : {}),
    ...(body.to !== undefined && body.to !== null ? { to: seconds(body.to, 'to') } : {}),
    ...(body.clicks === false ? { clicks: false } : {}),
    ...(body.captions === false ? { captions: false } : {}),
  }
  const cues = soundCues(project, options)
  if (!cues.length) throw new StudioError('Nothing moves yet: add layers, transitions or clicks first.')
  return queueSounds(ctx, videoId, project, 'pass', preset, cues)
}

/** POST /projects/:id/sounds {sounds, preset?, replace?}: chosen sounds at times, as a job. */
export async function startAddSounds(ctx: StudioContext, videoId: string, body: Record<string, unknown>) {
  requireCapability(ctx, 'sound')
  const preset = checkPreset(body.preset)
  const cues = cuesFromSounds(body.sounds, () => randomUUID().slice(0, 8))
  const replace = body.replace === undefined || body.replace === null ? [] : body.replace
  if (!Array.isArray(replace) || replace.length > 500 || replace.some((id) => typeof id !== 'string' || id.length > 200)) throw new StudioError('replace is a list of cue ids.')
  const { project } = await openVideo(ctx, videoId)
  return queueSounds(ctx, videoId, project, 'add', preset, cues, replace as string[])
}

/**
 * POST /projects/:id/sounds/import {assetId | uploadKey + name, at, align?, offsetMs?, levelDb?, label?, track?,
 * fadeOut?, from?}: one sound or music file placed at a time, as a job.
 */
export async function startImportSound(ctx: StudioContext, videoId: string, body: Record<string, unknown>) {
  requireCapability(ctx, 'sound')
  const track = body.track === 'music' ? 'music' : body.track === undefined || body.track === null || body.track === 'sfx' ? 'sfx' : null
  if (!track) throw new StudioError('track is sfx or music.')
  const align = body.align === 'peak' ? 'peak' : body.align === undefined || body.align === null || body.align === 'onset' ? 'onset' : null
  if (!align) throw new StudioError('align is onset or peak.')
  const at = seconds(body.at, 'at')
  const { project } = await openVideo(ctx, videoId)
  const total = projectDuration(project) / project.output.fps
  if (at >= total) throw new StudioError(`The video is ${Math.round(total * 100) / 100} seconds long; ${at} is past its end.`)
  const input: SoundImportInput = { name: '', at, align: track === 'music' ? 'onset' : align, track }
  const assetId = body.assetId ?? body.asset_id
  if (assetId !== undefined && assetId !== null) {
    if (typeof assetId !== 'string' || !/^[a-f0-9]{64}$/.test(assetId)) throw new StudioError('assetId is a library asset id.')
    const asset = await getAsset(ctx, assetId)
    if (!asset.hasAudio) throw new StudioError(`${asset.name} has no sound.`)
    input.asset = asset
    input.name = asset.name
  } else if (body.uploadKey !== undefined) {
    const key = checkBlobKey(body.uploadKey)
    if (!key.startsWith('uploads/')) throw new StudioError('uploadKey is an upload (POST /uploads).')
    if (!(await getBlob(ctx, key))) throw notFoundError('That upload is not there (it may have been imported already).')
    input.uploadKey = key
    input.name = checkFileName(body.name)
  } else throw new StudioError('Name the file: assetId (from the library) or uploadKey (an upload).')
  const offsetMs = optionalNumber(body.offsetMs ?? body.offset_ms, 'offsetMs', -5000, 5000)
  if (offsetMs !== undefined) input.offsetMs = offsetMs
  const levelDb = optionalNumber(body.levelDb ?? body.level_db, 'levelDb', -60, 12)
  if (levelDb !== undefined) input.levelDb = levelDb
  const label = shortText(body.label)
  if (label) input.label = label
  const from = optionalNumber(body.from, 'from', 0, 36_000)
  if (from) input.from = from
  if (track === 'music') {
    input.fadeOut = optionalNumber(body.fadeOut ?? body.fade_out, 'fadeOut', 0, 30) ?? 1.5
    input.endSeconds = Math.round((total - at) * 1000) / 1000
  }
  return asJob(await queueJob(ctx, 'sound-import', input, videoId))
}

/** POST /projects/:id/listen {checks?}: the mix rendered and heard, as a job. */
export async function startListen(ctx: StudioContext, videoId: string, body: Record<string, unknown>) {
  requireCapability(ctx, 'sound')
  const checks = checkChecks(body.checks)
  const { project } = await openVideo(ctx, videoId)
  const fonts = await exportFonts(ctx, project).catch(() => [])
  const input: ListenInput = { project, cues: earshotCueFile(project), checks, ...(fonts.length ? { fonts } : {}) }
  return asJob(await queueJob(ctx, 'listen', input, videoId))
}

// ---- the bank ------------------------------------------------------------------------------------------------------

/**
 * GET /sounds: the bank and the kit presets. The kept copy while it is fresh (or when no worker can read it again);
 * else read through a quick worker job. `available`: a worker can make sounds right now.
 */
export async function soundBank(ctx: StudioContext, options: { refresh?: boolean; waitMs?: number; now?: number } = {}): Promise<SoundBankAnswer> {
  const now = options.now ?? Date.now()
  const available = workerCan('sound', now)
  const kept = await getRecord<KeptBank>(ctx, SOUND_COLLECTION, BANK_KEY)
  const answer = (bank: KeptBank): SoundBankAnswer => ({ available, version: bank.version, at: bank.at, sounds: bank.sounds, presets: bank.presets })
  const fresh = kept && now - Date.parse(kept.at) < BANK_FRESH_MS
  if (kept && (fresh || !available) && !options.refresh) return answer(kept)
  if (!available) return kept ? answer(kept) : { available: false, sounds: [], presets: {} }
  const job = await queueJob(ctx, 'sound-bank', {})
  const done = await waitForJob(ctx, job.id, { timeoutMs: options.waitMs ?? 30_000, everyMs: 500 })
  if (done.status === 'completed') {
    const read = await getRecord<KeptBank>(ctx, SOUND_COLLECTION, BANK_KEY)
    if (read) return answer(read)
  }
  if (kept) return answer(kept)
  if (done.status === 'failed' || done.status === 'cancelled') throw new StudioError(done.error ?? 'Reading the sound bank failed.', 502, 'SOUND')
  throw new StudioError('The Studio worker is busy; ask for the sound bank again in a moment.', 503, 'BUSY')
}

/** The bank filtered by a text (any field, case aside). Pure. */
export function filterBank(sounds: SoundBankResult['sounds'], query: string | undefined): SoundBankResult['sounds'] {
  const q = (query ?? '').trim().toLowerCase()
  return q ? sounds.filter((s) => JSON.stringify(s).toLowerCase().includes(q)) : sounds
}

/** Each preset's role → sound map (what list_sounds answered on the local product). Pure. */
export function presetRoles(presets: SoundBankResult['presets']): Record<string, Record<string, string>> {
  return Object.fromEntries(Object.entries(presets).map(([name, p]) => [name, Object.fromEntries(Object.entries(p.roles ?? {}).map(([role, v]) => [role, v.sound]))]))
}

// ---- the listening sheet ---------------------------------------------------------------------------------------------

/** The stored sheet of a listen job. */
export const sheetKey = (jobId: string) => `listen/${jobId}/sheet.png`

/** GET /listen/<job id>/sheet.png: the annotated sheet a finished listen job stored, through the file store. */
export async function listenSheet(ctx: StudioContext, jobId: string, request: Request): Promise<Response> {
  if (!isUuid(jobId)) throw notFoundError('That listening sheet is not there.')
  const row = await jobRow(ctx, jobId)
  if (row.kind !== 'listen' || row.status !== 'completed') throw notFoundError('That listening sheet is not there.')
  const blob = await getBlob(ctx, sheetKey(jobId))
  if (!blob) throw notFoundError('That listening sheet is not there.')
  return serveBlob(ctx, blob, request)
}

// ---- applying what came back (pure) ------------------------------------------------------------------------------------

/** The music change on the edit: the ducked take swapped in, or the take as imported put back. Pure. */
export function applyMusic(project: EditorProject, change: MusicChange | null, library: ReadonlyMap<string, EditorAsset> = new Map()): EditorProject {
  if (!change) return project
  const track = project.audioTracks.find((t) => t.id === MUSIC_TRACK)
  const segment = track?.segments.length === 1 ? track.segments[0]! : null
  // The bed changed while the job ran (another take, moved, removed): leave it as the person left it.
  if (!track || !segment || segment.id !== change.segmentId || segment.assetId !== change.currentAssetId) return project
  const swap = (assetId: string) => project.audioTracks.map((t) => (t.id === MUSIC_TRACK ? { ...t, segments: [{ ...segment, assetId }] } : t))
  const usedElsewhere = (id: string) =>
    project.clips.some((c) => c.assetId === id) || project.audioTracks.some((t) => t.segments.some((s) => s.assetId === id && s.id !== segment.id)) || (project.layers ?? []).some((l) => l.assetId === id)
  // The take it replaces leaves the edit when nothing else plays it (the take as imported stays in the library).
  const without = (id: string) => project.assets.filter((a) => a.id !== id || usedElsewhere(id))
  if (change.action === 'duck') {
    if (change.asset.id === segment.assetId) return project
    const assets = without(segment.assetId)
    return { ...project, assets: assets.some((a) => a.id === change.asset.id) ? assets : [...assets, change.asset], audioTracks: swap(change.asset.id) }
  }
  if (change.sourceId === segment.assetId) return project
  const source = project.assets.find((a) => a.id === change.sourceId) ?? library.get(change.sourceId)
  if (!source) return project
  const assets = without(segment.assetId)
  return { ...project, assets: assets.some((a) => a.id === source.id) ? assets : [...assets, source], audioTracks: swap(source.id) }
}

/** A finished sounds job on an edit: the sounds on the Sound effects track, then the music change. Pure. */
export function applySounds(project: EditorProject, input: Pick<SoundsInput, 'mode' | 'replaceIds'>, result: Pick<SoundsResult, 'placed' | 'music'>, library: ReadonlyMap<string, EditorAsset> = new Map()): EditorProject {
  const placed: PlacedSound[] = result.placed.map((p) => ({ cueId: p.cueId, asset: p.asset, startSeconds: p.startSeconds, trimSeconds: p.trimSeconds, durationSeconds: p.durationSeconds, sound: p.sound, label: p.label }))
  const next = placeSounds(project, placed, input.mode === 'pass' ? { replaceAuto: true } : { replaceIds: input.replaceIds ?? [] })
  return applyMusic(next, result.music, library)
}

/** A finished import on an edit: a music bed on the Music track, or one sound on the Sound effects track. Pure. */
export function applyImport(project: EditorProject, result: SoundImportResult, at: number, cueId: string): EditorProject {
  if (result.track === 'music') return placeMusic(project, result.asset, at, result.label)
  return placeSounds(project, [{ cueId, asset: result.asset, startSeconds: result.startSeconds, trimSeconds: result.trimSeconds, durationSeconds: result.durationSeconds, sound: `file:${result.name}`, label: result.label }])
}

// ---- filing a finished job ------------------------------------------------------------------------------------------

/**
 * Save an edit made from the video as it is now; when it changed meanwhile (the digest moved), read it again and
 * apply again. The version kept is the edit the change was applied to. Answers the saved digest.
 */
export async function saveSoundEdit(ctx: StudioContext, videoId: string, label: string, apply: (project: EditorProject) => EditorProject): Promise<{ projectDigest: string }> {
  for (let attempt = 1; ; attempt++) {
    const opened = await openVideo(ctx, videoId)
    let next: EditorProject
    try {
      next = apply(opened.project)
    } catch (error) {
      throw new StudioError(error instanceof Error ? error.message : String(error))
    }
    try {
      const saved = await saveVideo(ctx, next, opened.projectDigest)
      await saveVersion(ctx, videoId, 'project', label, opened.project).catch((error) => console.error('[studio] keeping the version before a sound edit failed:', error instanceof Error ? error.message : error))
      return { projectDigest: saved.projectDigest }
    } catch (error) {
      if (error instanceof StudioError && error.code === 'DIGEST_CONFLICT' && attempt < SAVE_TRIES) continue
      throw error
    }
  }
}

/** A worker's asset checked, stored, and registered (the library's copy, which the edit must carry exactly). */
async function registered(ctx: StudioContext, value: unknown, seen: Map<string, EditorAsset>): Promise<EditorAsset> {
  const asset = EditorAssetSchema.parse(value)
  const known = seen.get(asset.id)
  if (known) return known
  if (asset.kind !== 'audio' || !asset.hasAudio) throw new StudioError('A rendered sound is not an audio file.')
  // Checked against what the job stored (named by its bytes, those bytes there) before it is registered.
  const kept = await registerAsset(ctx, await ownAsset(ctx, asset, 'rendered sound'))
  seen.set(asset.id, kept)
  return kept
}

const videoOf = (row: Pick<JobRow, 'video_id'>): string => {
  if (!row.video_id) throw new StudioError('A sound job names its video.')
  return row.video_id
}

/** A finished `sounds` job: the audio registered and placed on the video. Answers what the editor reads (`placed`). */
export async function fileSounds(ctx: StudioContext, row: Pick<JobRow, 'video_id' | 'input'>, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
  const input = row.input as unknown as SoundsInput
  const out = raw as unknown as SoundsResult
  if (!Array.isArray(out.placed) || !Array.isArray(out.notes ?? [])) throw new StudioError('A sounds result lists what it placed.')
  const seen = new Map<string, EditorAsset>()
  const placed: RenderedSound[] = []
  for (const item of out.placed.slice(0, MAX_SOUNDS * 2)) {
    const startSeconds = Number(item.startSeconds), trimSeconds = Number(item.trimSeconds), durationSeconds = Number(item.durationSeconds)
    if (![startSeconds, trimSeconds, durationSeconds].every((n) => Number.isFinite(n) && n >= 0)) throw new StudioError('A rendered sound has no place.')
    placed.push({ ...item, cueId: String(item.cueId).slice(0, 200), sound: String(item.sound).slice(0, 200), label: String(item.label ?? item.sound).slice(0, 200), startSeconds, trimSeconds, durationSeconds, asset: await registered(ctx, item.asset, seen) })
  }
  let music: MusicChange | null = null
  if (out.music?.action === 'duck') music = { ...out.music, asset: await registered(ctx, out.music.asset, seen) }
  else if (out.music?.action === 'restore') music = out.music
  const library = music?.action === 'restore' ? await getAssets(ctx, [music.sourceId]) : new Map<string, EditorAsset>()
  const label = input.mode === 'pass' ? 'Before the sound pass' : 'Before adding sounds'
  const { projectDigest } = await saveSoundEdit(ctx, videoOf(row), label, (project) => applySounds(project, input, { placed, music }, library))
  return {
    preset: out.preset ?? input.preset,
    placed: placed.map((p) => ({ cue: p.cueId, sound: p.sound, at: Math.round(p.startSeconds * 1000) / 1000, label: p.label })),
    notes: (out.notes ?? []).slice(0, 200).map((n) => String(n).slice(0, 300)),
    ...(music?.action === 'duck' ? { music: `stepped down before ${music.moments.length} big moment${music.moments.length === 1 ? '' : 's'}` } : music?.action === 'restore' ? { music: 'back to the take as imported' } : {}),
    projectDigest,
  }
}

/** A finished `sound-import` job: the placed take registered and put on the video; an upload is removed. */
export async function fileSoundImport(ctx: StudioContext, row: Pick<JobRow, 'id' | 'video_id' | 'input'>, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
  const input = row.input as unknown as SoundImportInput
  const out = raw as unknown as SoundImportResult
  const asset = await registered(ctx, out.asset, new Map())
  const result: SoundImportResult = {
    asset,
    startSeconds: Math.max(0, Number(out.startSeconds) || 0),
    trimSeconds: Math.max(0, Number(out.trimSeconds) || 0),
    durationSeconds: Math.max(0, Number(out.durationSeconds) || asset.durationSeconds || 0),
    track: input.track,
    name: String(out.name || input.name).slice(0, 200),
    label: String(out.label || input.label || input.name).slice(0, 200),
  }
  const cueId = `manual:${row.id.slice(0, 8)}`
  const { projectDigest } = await saveSoundEdit(ctx, videoOf(row), input.track === 'music' ? 'Before the music bed' : 'Before importing a sound', (project) => applyImport(project, result, input.at, cueId))
  if (input.uploadKey) await deleteBlob(ctx, input.uploadKey).catch((error) => console.error('[studio] removing an upload failed:', error instanceof Error ? error.message : error))
  return input.track === 'music'
    ? { music: result.name, at: input.at, assetId: asset.id, projectDigest }
    : { placed: [{ cue: cueId, sound: result.name, at: Math.round(result.startSeconds * 1000) / 1000, label: result.label }], assetId: asset.id, projectDigest }
}

/** A finished `listen` job: the report kept as the editor reads it, the sheet's link by its job id (`folder`). */
export async function fileListen(ctx: StudioContext, row: Pick<JobRow, 'id'>, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out = raw as unknown as ListenResult
  const text = (value: unknown) => (typeof value === 'string' ? value.slice(0, 6000) : undefined)
  let sheet: Record<string, unknown> | undefined
  if (out.sheet) {
    if (out.sheet.key !== sheetKey(row.id) || !(await getBlob(ctx, out.sheet.key))) throw new StudioError('The worker did not store the listening sheet.')
    sheet = { png: out.sheet.key, ...(out.sheet.summary !== undefined ? { summary: out.sheet.summary } : {}) }
  }
  return {
    seconds: Number(out.seconds) || 0,
    ...(out.timeline ? { timeline: { ...(out.timeline.summary !== undefined ? { summary: out.timeline.summary } : {}), ...(text(out.timeline.text) ? { text: text(out.timeline.text) } : {}) } } : {}),
    ...(out.critique ? { critique: { ...(typeof out.critique.verdict === 'string' ? { verdict: out.critique.verdict.slice(0, 80) } : {}), ...(Number.isFinite(out.critique.score) ? { score: out.critique.score } : {}), ...(text(out.critique.text) ? { text: text(out.critique.text) } : {}) } } : {}),
    ...(sheet ? { sheet } : {}),
    // The editor's report reads the sheet at /listen/<folder>/sheet.png.
    folder: row.id,
  }
}

/** A finished `sound-bank` job: the bank kept for a week. */
export async function fileSoundBank(ctx: StudioContext, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out = raw as unknown as SoundBankResult
  if (!Array.isArray(out.sounds) || !out.presets || typeof out.presets !== 'object') throw new StudioError('The sound bank came back empty.')
  const sounds = out.sounds.filter((s) => s && typeof s.id === 'string').slice(0, 2000)
  await putRecord(ctx, SOUND_COLLECTION, BANK_KEY, { version: String(out.version ?? ''), sounds, presets: out.presets, at: new Date().toISOString() } satisfies KeptBank)
  return { version: String(out.version ?? ''), sounds: sounds.length, presets: Object.keys(out.presets) }
}
