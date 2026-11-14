// A Mac take opened in the editor at Stop, before the Studio has filed it. Desktop only, and only for a take that
// becomes a new video: Windows has no native recorder, and a browser take, a punch-in or a take into beats still waits
// for the Studio ("Preparing your recording", useManualRecording.ts finish), as before.
//
//   1. At Stop the app hashes each file it wrote (studio_recorder_take_media). Each becomes a provisional asset: its
//      id and sha256 are the hash of the file as recorded, its measurements the recorder's own (frames on its grid,
//      its rate, its size). The edit is built from them by the Studio's own builder (engine/take-project.ts), under the
//      video id the recording is filed as (POST /recordings `projectId`), and the preview plays the files from the
//      computer (studio-take://<this run's key>/<take>/<role>, asset-base.ts setLocalAsset: the addresses are made when
//      a draft opens, from the key the app hands this page, and never kept).
//   2. While the Studio files it, the edit lives on this computer only: saving keeps it beside the take, through the app
//      (ProvisionalRecord in the take's folder, `draft.json`: one copy for every window, as long as the take, no browser
//      quota; a write that fails says "Not saved"), export waits. Nothing the computer says is stored on the Studio.
//   3. Once filed, the Studio has built its own edit of the take from the media it measured. adoptFiled maps each
//      provisional asset to the Studio's asset for the same track (its import records the hash of the bytes it read,
//      `provenance.rawSha256`, which is the provisional id when the bytes arrived as recorded). Not edited meanwhile:
//      the Studio's edit is taken as it is. Edited: the edit is rewritten onto the Studio's assets (swapAssets) and
//      saved over the Studio's own with its digest, so the edits land once; a video changed elsewhere meanwhile refuses
//      that save and the edit stays here, offered back. A kept file keeps playing from the computer (same frames,
//      same times); a conformed one plays from the Studio.
import { EditorAssetSchema, EditorProjectSchema, TranscriptSchema, type EditorAsset, type EditorProject, type EditorTranscript } from '@/lib/studio/engine/contracts'
import { buildTakeProject, voiceAsset, wordsOnVoiceClock, type TakeMedia } from '@/lib/studio/engine/take-project'
import type { FinishedTake, TakeFile, TakeRole, TakeWord } from './types'

/** What the app knows of a stopped take's files: their hashes and sizes, and the microphone's waveform. */
export type LocalMedia = { tracks: { role: TakeRole; sha256: string; bytes: number }[]; waveform: number[] | null }

/**
 * Where the app serves a take's file to the editor (studio_recorder.rs TAKE_SCHEME; macOS: `<scheme>://localhost`), with
 * this run's key (studio_recorder_take_token): made when a draft opens, never stored.
 */
export const localTakeHref = (key: string, sessionId: string, role: TakeRole) => `studio-take://localhost/${encodeURIComponent(key)}/${encodeURIComponent(sessionId)}/${role}`

/** The editor's role name for the Studio's (an asset's `provenance.role`). */
const takeRole = (role: unknown): TakeRole | null => (role === 'systemAudio' ? 'system-audio' : role === 'screen' || role === 'camera' || role === 'microphone' ? role : null)

/** Where each provisional asset plays from on this computer: its file name → the app's address for it, with `key`. */
export function hrefsFor(assets: EditorAsset[], sessionId: string, key: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const asset of assets) {
    const role = takeRole((asset.provenance as { role?: unknown } | undefined)?.role)
    if (role) out[asset.file] = localTakeHref(key, sessionId, role)
  }
  return out
}

/** The Studio's name for a track's role (an import's `provenance.role`). */
const studioRole = (role: TakeRole) => (role === 'system-audio' ? 'systemAudio' : role)

/** A take opened before it is filed: the edit, and its provisional assets (their role in provenance). */
export type Draft = { project: EditorProject; assets: EditorAsset[] }

const HEX64 = /^[a-f0-9]{64}$/

/** A provisional asset for one file of the take, or null when the recorder's word on it is not enough to edit with. */
function provisionalAsset(take: FinishedTake, file: TakeFile, media: LocalMedia): EditorAsset | null {
  const track = media.tracks.find((t) => t.role === file.role)
  if (!track || !HEX64.test(track.sha256) || !(track.bytes > 0)) return null
  const audio = file.role === 'microphone' || file.role === 'system-audio'
  const ext = audio ? 'm4a' : 'mp4'
  const base = {
    id: track.sha256,
    name: file.name,
    file: `assets/${track.sha256}.${ext}`,
    sha256: track.sha256,
    bytes: track.bytes,
    sourceCursorHidden: file.role === 'screen' ? take.sourceCursorHidden : false,
    provenance: { provisional: true, role: studioRole(file.role), session: take.sessionId },
  }
  let asset: Record<string, unknown>
  if (audio) {
    if (!(file.durationSeconds && file.durationSeconds > 0)) return null
    asset = { ...base, kind: 'audio', hasAudio: true, durationSeconds: file.durationSeconds, ...(file.role === 'microphone' && media.waveform?.length ? { waveform: media.waveform.slice(0, 2000) } : {}) }
  } else {
    if (!file.width || !file.height || !file.frames || !(file.fps === 30 || file.fps === 60)) return null
    asset = { ...base, kind: 'video', hasAudio: false, width: file.width, height: file.height, sourceFps: file.fps, sourceFrames: file.frames, durationSeconds: file.frames / file.fps }
    if (file.role === 'screen' && take.trace) asset.trace = take.trace
  }
  let parsed = EditorAssetSchema.safeParse(asset)
  // A trace the editor cannot read never keeps the take from opening (the Studio's import checks it again).
  if (!parsed.success && asset.trace !== undefined) {
    delete asset.trace
    parsed = EditorAssetSchema.safeParse(asset)
  }
  return parsed.success ? parsed.data : null
}

/** How far apart (start times) a word heard here and the Studio's may be and still be the same word. */
export const WORD_MATCH_MS = 120

/**
 * Each word of `ours` matched to the Studio's same word in `theirs` (the same text, ignoring case and punctuation,
 * starting within WORD_MATCH_MS; in order, each matched once). Pure.
 */
export function matchWords(ours: { id: string; text: string; startMs: number }[], theirs: { id: string; text: string; startMs: number }[]): Map<string, string> {
  const norm = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  const out = new Map<string, string>()
  let from = 0
  for (const word of ours) {
    for (let j = from; j < theirs.length; j++) {
      const other = theirs[j]!
      if (other.startMs - word.startMs > WORD_MATCH_MS) break
      if (Math.abs(other.startMs - word.startMs) <= WORD_MATCH_MS && norm(other.text) === norm(word.text)) {
        out.set(word.id, other.id)
        from = j + 1
        break
      }
    }
  }
  return out
}

/** A transcript's id for a provisional asset: distinct from the asset's own (its hash reversed). */
const transcriptIdOf = (sha256: string) => [...sha256].reverse().join('')

/**
 * The take as an edit, from the files on this computer: null when anything needed is missing (no screen, a hash or a
 * measurement the recorder did not give), and the take then waits for the Studio as before. Pure.
 */
export function provisionalDraft(input: { take: FinishedTake; media: LocalMedia; projectId: string; title: string }): Draft | null {
  const { take, media } = input
  const assets = new Map<TakeRole, EditorAsset>()
  for (const file of take.files) {
    const asset = provisionalAsset(take, file, media)
    if (asset) assets.set(file.role, asset)
    else if (file.role === 'screen') return null
  }
  const screen = assets.get('screen')
  if (!screen) return null
  const offset = (role: TakeRole) => take.files.find((f) => f.role === role)?.offsetSeconds ?? 0
  const synced = (role: TakeRole) => (assets.has(role) ? { asset: assets.get(role)!, offsetSeconds: offset(role) } : null)
  const takeMedia: TakeMedia = { screen, camera: synced('camera'), microphone: synced('microphone'), systemAudio: synced('system-audio') }
  let transcript: EditorTranscript | null = null
  const voice = voiceAsset(takeMedia)
  if (voice && take.transcript?.words.length) {
    const words = wordsOnVoiceClock(take.transcript.words, voice)
    if (words.length) {
      const id = transcriptIdOf(voice.asset.sha256)
      const parsed = TranscriptSchema.safeParse({
        id, assetId: voice.asset.id, sourceSha256: voice.asset.sha256, label: `${voice.asset.name} transcript`.slice(0, 250), origin: 'imported',
        text: words.map((w) => w.text).join(' '), alignmentSha256: id,
        words: words.map((w, index) => ({ id: `w-${id.slice(0, 20)}-${index}`, text: w.text, startMs: w.startMs, endMs: w.endMs })),
      })
      if (parsed.success) transcript = parsed.data
    }
  }
  let project: EditorProject
  try {
    project = buildTakeProject({ id: input.projectId, title: input.title, media: takeMedia, transcript })
  } catch {
    return null
  }
  return { project, assets: [...assets.values()] }
}

/**
 * The words the Mac heard, arrived after the draft opened (Stop does not wait for them), as the voice's transcript of
 * `project`, built the way the draft builds them; the project as it is when it has a transcript of that voice already,
 * or no voice to hear. Pure.
 */
export function withWords(project: EditorProject, assets: EditorAsset[], take: { files: Pick<TakeFile, 'role' | 'offsetSeconds'>[] }, words: { text: string; startMs: number; endMs: number }[]): EditorProject {
  const byRole = (role: TakeRole) => assets.find((a) => takeRole((a.provenance as { role?: unknown } | undefined)?.role) === role && project.assets.some((p) => p.id === a.id))
  const screen = byRole('screen')
  if (!screen || !words.length) return project
  const offset = (role: TakeRole) => take.files.find((f) => f.role === role)?.offsetSeconds ?? 0
  const synced = (role: TakeRole) => { const a = byRole(role); return a ? { asset: a, offsetSeconds: offset(role) } : null }
  const voice = voiceAsset({ screen, camera: synced('camera'), microphone: synced('microphone'), systemAudio: synced('system-audio') })
  if (!voice || project.transcripts.some((t) => t.assetId === voice.asset.id)) return project
  const onVoice = wordsOnVoiceClock(words, voice)
  if (!onVoice.length) return project
  const id = transcriptIdOf(voice.asset.sha256)
  const parsed = TranscriptSchema.safeParse({
    id, assetId: voice.asset.id, sourceSha256: voice.asset.sha256, label: `${voice.asset.name} transcript`.slice(0, 250), origin: 'imported',
    text: onVoice.map((w) => w.text).join(' '), alignmentSha256: id,
    words: onVoice.map((w, index) => ({ id: `w-${id.slice(0, 20)}-${index}`, text: w.text, startMs: w.startMs, endMs: w.endMs })),
  })
  return parsed.success ? EditorProjectSchema.parse({ ...project, transcripts: [...project.transcripts, parsed.data] }) : project
}

// ---- once filed -----------------------------------------------------------------------------------------------

/** A provisional asset and the Studio's asset for the same track. */
export type Filed = { provisional: EditorAsset; final: EditorAsset }

const roleOf = (asset: EditorAsset) => (asset.provenance as { role?: unknown } | undefined)?.role

/**
 * Each provisional asset's counterpart in the Studio's edit of the take (the asset its import made for the same track),
 * and whether the Studio kept the very bytes recorded (its `rawSha256` is the provisional hash, and the file was kept,
 * not conformed): such a file keeps playing from the computer. Provisional assets with no counterpart (a track the
 * Studio could not import) are `missing`. Pure.
 */
export function filedAssets(provisional: EditorAsset[], server: EditorProject): { filed: (Filed & { kept: boolean })[]; missing: EditorAsset[] } {
  const filed: (Filed & { kept: boolean })[] = []
  const missing: EditorAsset[] = []
  for (const asset of provisional) {
    const final = server.assets.find((a) => roleOf(a) === roleOf(asset) && a.kind === asset.kind && !(a.provenance as { provisional?: unknown } | undefined)?.provisional)
    if (!final) {
      missing.push(asset)
      continue
    }
    const p = (final.provenance ?? {}) as { rawSha256?: unknown; keptAtFps?: unknown; normalizedCfrFps?: unknown }
    // An audio file is copied as it is (or rewrapped, never encoded); a picture only when the import kept it.
    const kept = p.rawSha256 === asset.sha256 && (asset.kind === 'audio' ? true : p.keptAtFps !== undefined && p.normalizedCfrFps === undefined)
    filed.push({ provisional: asset, final, kept })
  }
  return { filed, missing }
}

/** Replace every whole occurrence of `from` in `text` (ids and file names are long hashes: no accidental match). */
const replaceAll = (text: string, from: string, to: string) => text.split(from).join(to)

/**
 * An edit made on provisional assets, rewritten onto the Studio's: every reference to each asset (clips, the camera,
 * audio pieces and their sync labels, transcripts, layers) now names the Studio's asset, and where the Studio's file
 * differs from the recording (conformed: another frame count or rate, a length a little different) clip trims are
 * moved by time and kept inside the file, camera and audio pieces inside its length. A transcript the Studio
 * registered for the same voice replaces the one made here, its words' ids (and the corrections on them) carried over
 * when the words line up; tracks the Studio did not import are taken out. Pure; throws when the result is not a valid
 * edit (the edit then stays on the computer).
 */
export function swapAssets(project: EditorProject, filed: Filed[], options: { transcripts?: EditorTranscript[]; missing?: EditorAsset[] } = {}): EditorProject {
  let text = JSON.stringify(project)
  for (const { provisional, final } of filed) {
    text = replaceAll(text, provisional.file, final.file)
    text = replaceAll(text, provisional.id, final.id)
  }
  const next = JSON.parse(text) as EditorProject
  const byFinal = new Map(filed.map((f) => [f.final.id, f]))
  const missing = new Set((options.missing ?? []).map((a) => a.id))
  next.assets = next.assets.filter((a) => !missing.has(a.id)).map((a) => byFinal.get(a.id)?.final ?? a)
  // A transcript made here becomes the one the Studio registered for the same voice. Its words are matched by text and
  // time (within WORD_MATCH_MS), not by position: the two can differ by a word at either end (the recorder's and the
  // Studio's lengths of the file clip the words a little differently), and a correction stays on its word.
  // The Studio has no transcript of that voice yet (its words are still on their way): the one made here stays, on the
  // Studio's voice (`kept`: the Studio refuses to save it until it registered the words, adoptFiled says so).
  const wordMap = new Map<string, string>()
  next.transcripts = next.transcripts.flatMap((t) => {
    const made = filed.find((f) => f.final.id === t.assetId && t.id === transcriptIdOf(f.provisional.sha256))
    if (!made) return missing.has(t.assetId) ? [] : [t]
    const studio = options.transcripts?.find((x) => x.assetId === t.assetId)
    if (!studio) return [t]
    for (const [from, to] of matchWords(t.words, studio.words)) wordMap.set(from, to)
    return [studio]
  })
  // A transcript the Studio has of a track the draft has none for (the draft opened before the words came): kept too.
  for (const studio of options.transcripts ?? []) {
    if (filed.some((f) => f.final.id === studio.assetId) && !next.transcripts.some((t) => t.assetId === studio.assetId)) next.transcripts.push(studio)
  }
  const words = new Set(next.transcripts.flatMap((t) => t.words.map((w) => w.id)))
  next.captionCorrections = Object.fromEntries(Object.entries(next.captionCorrections).flatMap(([word, text]) => {
    const to = wordMap.get(word) ?? word
    return words.has(to) ? [[to, text]] : []
  }))
  const fps = next.output.fps
  next.clips = next.clips.flatMap((clip) => {
    if (missing.has(clip.assetId)) return []
    const f = byFinal.get(clip.assetId)
    const from = f?.provisional, to = f?.final
    if (!from || !to || to.kind !== 'video' || !from.sourceFps || !to.sourceFps || !to.sourceFrames) return [clip]
    if (from.sourceFps === to.sourceFps && from.sourceFrames === to.sourceFrames) return [clip]
    const at = (frame: number) => Math.round((frame / from.sourceFps!) * to.sourceFps!)
    const start = Math.min(at(clip.trimStartSourceFrame), to.sourceFrames - 1)
    const end = Math.max(start + 1, Math.min(at(clip.trimEndSourceFrame), to.sourceFrames))
    return [{ ...clip, trimStartSourceFrame: start, trimEndSourceFrame: end }]
  })
  if (!next.clips.length) throw new Error('The recording the Studio filed has no picture to edit.')
  if (next.presenterTrack) {
    const track = next.presenterTrack
    const camera = next.assets.find((a) => a.id === track.assetId)
    if (!camera || missing.has(track.assetId)) next.presenterTrack = null
    else if (camera.durationSeconds) {
      const most = Math.floor(camera.durationSeconds * fps)
      next.presenterTrack = { ...track, segments: track.segments.flatMap((s) => {
        const end = Math.min(s.endFrame, s.startFrame + most - s.sourceStartFrame)
        return end > s.startFrame ? [{ ...s, endFrame: end }] : []
      }) }
      if (!next.presenterTrack.segments.length) next.presenterTrack = null
    }
  }
  next.audioTracks = next.audioTracks.map((track) => ({ ...track, segments: track.segments.flatMap((s) => {
    if (missing.has(s.assetId)) return []
    const audio = next.assets.find((a) => a.id === s.assetId)
    const length = audio?.durationSeconds
    if (!length || s.trimEndSeconds <= length) return [s]
    const end = Math.round(length * 1e6) / 1e6
    return end - s.trimStartSeconds >= 1 / fps ? [{ ...s, trimEndSeconds: end }] : []
  }) })).filter((track) => track.segments.length)
  return EditorProjectSchema.parse(next)
}

/**
 * The edit to carry on with once the take is filed: the Studio's own when the draft was not edited (nothing to save),
 * else the draft on the Studio's assets (to save over the Studio's edit). With the files that keep playing from the
 * computer (`local`: the Studio's file name → the computer's href) and the provisional names to forget. Pure; throws
 * as swapAssets.
 */
export function adoptFiled(record: Pick<ProvisionalRecord, 'assets' | 'base'>, draft: EditorProject, server: EditorProject, hrefs: Record<string, string> = {}): { project: EditorProject; edited: boolean; local: Record<string, string>; forget: string[]; missing: EditorAsset[]; unregistered: string[] } {
  const { filed, missing } = filedAssets(record.assets, server)
  const edited = JSON.stringify(draft) !== JSON.stringify(record.base)
  // Under the Studio's id: the take may have been made into another video than the draft's (brought back elsewhere).
  const project = edited ? { ...swapAssets(draft, filed, { transcripts: server.transcripts, missing }), id: server.id } : server
  // Transcripts made here that the Studio has not registered (its words still on their way): saving waits for them.
  const unregistered = project.transcripts.filter((t) => !server.transcripts.some((x) => x.id === t.id)).map((t) => t.id)
  const local: Record<string, string> = {}
  for (const f of filed) if (f.kept && hrefs[f.provisional.file]) local[f.final.file] = hrefs[f.provisional.file]!
  return { project, edited, local, forget: record.assets.map((a) => a.file), missing, unregistered }
}

/** `project` without the transcripts `ids` (and the corrections on their words): what the Studio takes as it is. */
export function withoutTranscripts(project: EditorProject, ids: string[]): EditorProject {
  if (!ids.length) return project
  const gone = new Set(project.transcripts.filter((t) => ids.includes(t.id)).flatMap((t) => t.words.map((w) => w.id)))
  return EditorProjectSchema.parse({ ...project, transcripts: project.transcripts.filter((t) => !ids.includes(t.id)), captionCorrections: Object.fromEntries(Object.entries(project.captionCorrections).filter(([word]) => !gone.has(word))) })
}

// ---- kept on this computer until filed ------------------------------------------------------------------------------

/**
 * A take opened before it was filed, as this computer keeps it beside the take (`draft.json`): what maps its
 * provisional assets to the Studio's, the edit as built and as last kept, and where it stands. Survives a restart of the
 * app; goes with the take's folder.
 */
export type ProvisionalRecord = {
  v: 2
  projectId: string
  /** The take on this computer (its folder) and on the Studio. */
  sessionId: string
  takeId: string | null
  /** Set once the Studio took the recording (POST /recordings answered). */
  recordingId: string | null
  title: string
  createdAt: string
  assets: EditorAsset[]
  /** What the take's files are on the screen's clock (for words that arrive after it opened). */
  files: Pick<TakeFile, 'role' | 'offsetSeconds'>[]
  /** The edit as it was built (with the words once they came): an edit equal to it was not changed by the person. */
  base: EditorProject
  /** The edit as last kept here. */
  draft: EditorProject
  /**
   * filing: on its way; failed: could not be filed (`failed` says why, with a way to try again); filed: made, the edit
   * still to carry on from the Studio's copies; adopted: the edit is on the Studio (only the files are left to let go).
   */
  state: 'filing' | 'failed' | 'filed' | 'adopted'
  failed?: string
  /** The words the Mac heard, when they arrived after the draft opened (Stop does not wait for them). */
  heard?: TakeWord[]
  /** The words the Mac heard reached the Studio. */
  wordsSent?: boolean
  /** The video the Studio made the take into, when not the draft's own (it was brought back elsewhere first). */
  filedAs?: string
  /** The Studio's edit as first read once filed (its digest): the draft is saved over that one only. */
  studioDigest?: string
  /** The take as the recorder handed it over (what files it whole when it never reached the Studio). */
  take?: FinishedTake
}

/** Where provisional records are kept: beside their takes, through the app (nativeDraftStore); a write that fails rejects. */
export type DraftStore = {
  get(projectId: string): Promise<ProvisionalRecord | null>
  list(): Promise<ProvisionalRecord[]>
  put(record: ProvisionalRecord): Promise<void>
}

/** Parse a kept record, or null when it is not one. */
function parseRecord(raw: string): ProvisionalRecord | null {
  try {
    const value = JSON.parse(raw) as ProvisionalRecord
    return value && value.v === 2 && typeof value.projectId === 'string' && typeof value.sessionId === 'string' ? value : null
  } catch {
    return null
  }
}

/** The app's half of the store: studio_recorder_draft_get / draft_put / drafts. */
export type DraftBridge = {
  draftGet: (sessionId: string) => Promise<unknown>
  draftPut: (sessionId: string, draft: string) => Promise<unknown>
  drafts: () => Promise<unknown>
}

/** Records kept beside their takes, through the app (one copy for every window, no browser quota). */
export function nativeDraftStore(app: DraftBridge): DraftStore {
  const sessions = new Map<string, string>()
  const all = async () => {
    const answer = (await app.drafts()) as { drafts?: { sessionId: string; draft: string }[] }
    const records = (answer.drafts ?? []).flatMap((d) => { const r = parseRecord(d.draft); return r && r.sessionId === d.sessionId ? [r] : [] })
    for (const r of records) sessions.set(r.projectId, r.sessionId)
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  return {
    async get(projectId) {
      const session = sessions.get(projectId)
      if (session) {
        const answer = (await app.draftGet(session)) as { draft?: string | null }
        const r = answer.draft ? parseRecord(answer.draft) : null
        if (r?.projectId === projectId) return r
      }
      return (await all()).find((r) => r.projectId === projectId) ?? null
    },
    list: all,
    async put(record) {
      await app.draftPut(record.sessionId, JSON.stringify(record))
      sessions.set(record.projectId, record.sessionId)
    },
  }
}

/** Records in memory (tests; a page with no app). `failing` makes every write fail. */
export function memoryDraftStore(): DraftStore & { failing: boolean } {
  const records = new Map<string, string>()
  return {
    failing: false,
    async get(projectId) { const raw = records.get(projectId); return raw ? parseRecord(raw) : null },
    async list() { return [...records.values()].flatMap((raw) => { const r = parseRecord(raw); return r ? [r] : [] }) },
    async put(record) {
      if (this.failing) throw new Error('The disk is full.')
      records.set(record.projectId, JSON.stringify(record))
    },
  }
}

/** A new provisional record for a draft. */
export function provisionalRecord(draft: Draft, info: { sessionId: string; takeId: string | null; title: string; files: Pick<TakeFile, 'role' | 'offsetSeconds'>[]; take?: FinishedTake; at?: Date }): ProvisionalRecord {
  return {
    v: 2, projectId: draft.project.id, sessionId: info.sessionId, takeId: info.takeId, recordingId: null, title: info.title,
    createdAt: (info.at ?? new Date()).toISOString(), assets: draft.assets, files: info.files.map((f) => ({ role: f.role, offsetSeconds: f.offsetSeconds })),
    base: draft.project, draft: draft.project, state: 'filing',
    // Its files as handed over, without what is kept elsewhere (the trace is in the screen's asset; the words in the edit).
    ...(info.take ? { take: { ...info.take, trace: null, transcript: null, files: info.take.files.map((f) => { const { pieces: _p, uploadKey: _k, ...rest } = f; void _p; void _k; return rest }) } } : {}),
  }
}

/** How far the filing is, for the editor's notices: 0 to 1, and a sentence. */
export type FilingState = { projectId: string; fraction: number; step: string; failed?: string }
