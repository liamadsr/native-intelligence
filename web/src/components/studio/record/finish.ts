// After Stop: every file of the take goes into storage (the browser uploads its own bytes; the Mac app uploads
// through the native side), then the Studio is told what the take is (POST /recordings) and answers once the take
// is a video, or with its progress while the worker still imports the files (then GET /recordings/<id> is polled).
// A browser take is uploaded while it records (live.ts): at Stop only its last pieces are left to send.
//
// The Studio finishes a recording on its own once its imports are done, so nobody has to wait on it: the dialog may
// stop following it (`isAlive`), and GET /recordings says later where it stands. A take whose window closed before
// it was finished is offered back (listSavedTakes) and made a video from what reached the Studio (recoverSavedTake).
import type { EditorProject } from '@/lib/studio/engine/contracts'
import { request } from '../ui/client'
import { STUDIO_API } from '../studio-env'
import type { FinishedTake, Recorder, TakeFile, TakeRole } from './types'

/** Where a take goes once it is a video: a new video, a punch-in, or storyboard beats of an open video. */
export type TakePlacement =
  | { kind: 'new' }
  | { kind: 'punch'; projectId: string; fromFrame: number; toFrame: number }
  | { kind: 'beats'; projectId: string; beatIds: string[]; marks: { ms: number; beat?: number; retake?: number }[]; extraCameraSlots?: ('B' | 'C' | 'D')[] }

/** What the server answers about a recording. */
export type RecordingView = {
  id: string
  status: 'processing' | 'done' | 'failed'
  progress: number
  step: string
  projectId?: string
  placed?: 'new' | 'punch' | 'beats'
  screenAssetId?: string
  voiceAssetId?: string
  note?: string
  error?: string
}
export type RecordingAnswer = { recording: RecordingView; project?: EditorProject; projectDigest?: string }

/**
 * One file's upload, for the "Finishing…" list. `live`: it went up while it recorded, so only its last seconds are
 * left (its fraction starts near 1). `bytes`: the file's size.
 */
export type UploadProgress = { role: TakeRole; label: string; fraction: number; done: boolean; bytes: number; live: boolean }

const LABELS: Record<TakeRole, string> = { screen: 'Screen', camera: 'Camera', microphone: 'Microphone', 'system-audio': 'System sound' }

/** Upload order: the voice first (small, and what the transcript needs), the screen, then the camera. */
const ORDER: TakeRole[] = ['microphone', 'screen', 'system-audio', 'camera']

/** The files of a take in upload order, empty ones left out. */
export function uploadOrder(files: TakeFile[]): TakeFile[] {
  return [...files].filter((file) => file.bytes > 0).sort((a, b) => ORDER.indexOf(a.role) - ORDER.indexOf(b.role))
}

/** The body of POST /recordings for a take whose files are uploaded under `keys`. */
export function recordingRequest(take: FinishedTake, keys: Partial<Record<TakeRole, string>>, placement: TakePlacement, title?: string) {
  const file = (role: TakeRole) => take.files.find((f) => f.role === role)
  const screen = file('screen')
  if (!screen || !keys.screen) throw new Error('The screen recording was not uploaded.')
  // A track uploaded while it recorded says how many pieces it is: all of them must be on the Studio before it is queued.
  const pieces = (f: TakeFile) => ({
    ...(f.uploadKey && f.pieces ? { pieces: f.pieces, ...(f.partial ? { partial: true as const } : {}) } : {}),
    // The most the track is conformed to (a screen judged by its moving frames is never made faster than this).
    ...(f.frameRate && Number.isFinite(f.frameRate) && f.frameRate > 0 && f.frameRate <= 240 ? { frameRate: f.frameRate } : {}),
  })
  const synced = (role: TakeRole) => {
    const f = file(role)
    const key = keys[role]
    return f && key ? { uploadKey: key, name: f.name, offsetSeconds: Math.round(f.offsetSeconds * 1000) / 1000, ...pieces(f) } : undefined
  }
  const camera = synced('camera')
  const microphone = synced('microphone')
  const systemAudio = synced('system-audio')
  return {
    ...(title ? { title } : {}),
    recorder: take.kind,
    screen: { uploadKey: keys.screen, name: screen.name, ...pieces(screen) },
    ...(camera ? { camera } : {}),
    ...(microphone ? { microphone } : {}),
    ...(systemAudio ? { systemAudio } : {}),
    ...(take.trace ? { trace: take.trace } : {}),
    sourceCursorHidden: take.sourceCursorHidden,
    ...(take.transcript?.words.length ? { transcript: { words: take.transcript.words.slice(0, 40_000) } } : {}),
    durationSeconds: Math.max(0, take.durationSeconds),
    ...(placement.kind === 'punch' ? { punch: { projectId: placement.projectId, fromFrame: placement.fromFrame, toFrame: placement.toFrame } } : {}),
    ...(placement.kind === 'beats'
      ? { beats: { projectId: placement.projectId, beatIds: placement.beatIds, marks: placement.marks, ...(placement.extraCameraSlots ? { extraCameraSlots: placement.extraCameraSlots } : {}) } }
      : {}),
  }
}

/** Upload every file of a take; answers the upload keys by role. Progress is reported per file. */
export async function uploadTake(recorder: Recorder, take: FinishedTake, onProgress: (files: UploadProgress[]) => void): Promise<Partial<Record<TakeRole, string>>> {
  const files = uploadOrder(take.files)
  const state: UploadProgress[] = files.map((file) => ({ role: file.role, label: LABELS[file.role], fraction: 0, done: false, bytes: file.bytes, live: !!file.uploadKey }))
  const report = () => onProgress(state.map((item) => ({ ...item })))
  report()
  const keys: Partial<Record<TakeRole, string>> = {}
  for (const [index, file] of files.entries()) {
    keys[file.role] = await recorder.upload(take, file, (fraction) => {
      state[index] = { ...state[index]!, fraction: Math.max(0, Math.min(1, fraction)) }
      report()
    })
    state[index] = { ...state[index]!, fraction: 1, done: true }
    report()
  }
  return keys
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Tell the Studio about an uploaded take and follow it until it is a video (or failed). */
export async function submitTake(body: ReturnType<typeof recordingRequest>, onProgress: (view: RecordingView) => void, isAlive: () => boolean = () => true): Promise<RecordingAnswer> {
  return follow(await request<RecordingAnswer>(`${STUDIO_API}/recordings?wait=1`, body), onProgress, isAlive)
}

/**
 * Make a take that stopped before it was finished into a new video, from the pieces that reached the Studio, and
 * follow it as submitTake does.
 */
export async function recoverSavedTake(id: string, onProgress: (view: RecordingView) => void, isAlive: () => boolean = () => true): Promise<RecordingAnswer> {
  return follow(await request<RecordingAnswer>(`${STUDIO_API}/live-takes/${encodeURIComponent(id)}/recover?wait=1`, {}), onProgress, isAlive)
}

/** The person's recordings of the last day, newest first; those still being prepared say how far along they are. */
export async function recentRecordings(): Promise<RecordingView[]> {
  return (await request<{ recordings: RecordingView[] }>(`${STUDIO_API}/recordings`)).recordings
}

/** Poll a recording until it is a video (or failed), or until `isAlive` says nobody is watching any more. */
async function follow(first: RecordingAnswer, onProgress: (view: RecordingView) => void, isAlive: () => boolean): Promise<RecordingAnswer> {
  let answer = first
  let failures = 0
  for (;;) {
    onProgress(answer.recording)
    if (answer.recording.status === 'done') return answer
    if (answer.recording.status === 'failed') throw new Error(answer.recording.error || 'The recording could not be put together.')
    if (!isAlive()) return answer
    await sleep(1500)
    try {
      answer = await request<RecordingAnswer>(`${STUDIO_API}/recordings/${encodeURIComponent(answer.recording.id)}`)
      failures = 0
    } catch (error) {
      // A dropped connection is not the end of the take: keep asking for a while.
      if (++failures > 20) throw error
    }
  }
}
