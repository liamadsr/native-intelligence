// The desktop recorder: the Mac app's native recorder (a sidecar driven through Tauri), reached through
// `studioRecorder` in src/lib/tauri-bridge.ts. It records a real window or display with the cursor hidden, an input
// trace (cursor, clicks, keys, focus) for the editor's zooms and cursor, the camera and microphone as their own
// files, and puts each file into storage itself (the bytes never pass through the web view).
//
// Uploaded while it records: the recorder writes each file in segments and says so (`onSegment`); each track of the
// take goes to the Studio as a live take (live.ts, the browser's own protocol and the Studio's fences), its pieces byte
// ranges of the file the app sends from its disk. This page drives it because it holds the person's session (each
// piece's link is signed for it); the app plans each piece on its disk before the Studio hears of it, sends only whole
// segments, and only to the app's own storage. At Stop only the last seconds are left. A take a quit or a crash cut
// short stays on the computer, linked to its take on the Studio: the next time the Studio opens, what did not go up
// is sent (sendUnfinished), and the take is offered back. An app without these commands uploads after Stop, as before.
//
// This file is the only one that knows the bridge's names (`tauriBridge.studioRecorder`, its payloads in
// src/lib/studio/recorder-bridge-types.ts): everything is read through `bridge()` and normalized here, so a change
// in the bridge is fixed in this file alone.
import { request } from '../ui/client'
import { STUDIO_API } from '../studio-env'
import { fetchApi, LiveError, LiveTake, LiveTrack, serverRole, type FileRange, type LiveApi, type Piece } from './live'
import { provisionalDraft, type Draft, type LocalMedia } from './provisional'
import { PageLeases, settleRecording, wordsOnScreenClock } from './filing'
import { sourceOffsets } from './media'
import type {
  DesktopApp,
  DesktopDisplay,
  DesktopWindow,
  DeviceOption,
  FinishedTake,
  PermissionState,
  Recorder,
  RecorderHandlers,
  RecorderPermissionName,
  RecorderPermissions,
  RecorderTargets,
  TakeFile,
  TakeOptions,
  TakeRole,
  TakeWord,
  UploadPart,
} from './types'

type Unlisten = () => void
type AnyFn = (...args: never[]) => unknown

/** The bridge as this file uses it. Every member is checked before use: an older app may lack some. */
export type StudioRecorderBridge = {
  available: () => Promise<boolean>
  permissions: () => Promise<unknown>
  requestPermissions: (which: RecorderPermissionName[]) => Promise<unknown>
  targets: () => Promise<unknown>
  start: (options: Record<string, unknown>) => Promise<unknown>
  stop: (sessionId: string) => Promise<unknown>
  upload: (sessionId: string, role: string, parts: UploadPart[]) => Promise<unknown>
  discard: (sessionId: string) => Promise<unknown>
  cancel: (sessionId: string) => Promise<unknown>
  showControl?: (sessionId: string) => Promise<unknown>
  hideControl?: () => Promise<unknown>
  // Uploads while recording (an older app has none of these: the take uploads after Stop).
  segments?: (sessionId: string, role: string) => Promise<unknown>
  linkLive?: (sessionId: string, takeId: string) => Promise<unknown>
  planPieces?: (sessionId: string, role: string, pieces: { index: number; offset: number; length: number; seconds: number; offsetSeconds?: number | null }[]) => Promise<unknown>
  putPiece?: (sessionId: string, role: string, index: number, url: string, headers: Record<string, string>) => Promise<unknown>
  unfinishedTakes?: (holder?: string) => Promise<unknown>
  hold?: (sessionId: string, holder: string, release?: boolean) => Promise<unknown>
  /** A stopped take's files' hashes and sizes, and the microphone's waveform (the editor opens it from them). */
  takeMedia?: (sessionId: string) => Promise<unknown>
} & Record<string, unknown>

let cached: Promise<StudioRecorderBridge | null> | null = null

/** The native recorder's bridge, or null outside the desktop app (or in an app too old to have one). */
export function bridge(): Promise<StudioRecorderBridge | null> {
  if (!cached) {
    cached = (async () => {
      if (typeof window === 'undefined') return null
      try {
        const mod = (await import('@/lib/tauri-bridge')) as unknown as Record<string, unknown>
        const found = (mod.studioRecorder ?? (mod.tauriBridge as Record<string, unknown> | undefined)?.studioRecorder) as Record<string, unknown> | undefined
        if (!found || typeof found.available !== 'function' || typeof found.start !== 'function' || typeof found.stop !== 'function') return null
        return found as StudioRecorderBridge
      } catch {
        return null
      }
    })()
  }
  return cached
}

/** True inside the Native Intelligence desktop app (any version). */
export async function insideDesktopApp(): Promise<boolean> {
  if (typeof window === 'undefined') return false
  try {
    const mod = (await import('@/lib/tauri-bridge')) as unknown as { tauriBridge?: { isAvailable?: () => boolean } }
    return !!mod.tauriBridge?.isAvailable?.()
  } catch {
    return false
  }
}

/** Whether the native recorder is there and answers. */
export async function nativeRecorderAvailable(): Promise<boolean> {
  const b = await bridge()
  if (!b) return false
  try {
    return (await b.available()) === true
  } catch {
    return false
  }
}

// ---- normalizing what the bridge answers ------------------------------------------------------------------------

const num = (value: unknown, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
const str = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback)
const obj = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

function permission(value: unknown): PermissionState {
  if (value === true || value === 'granted' || value === 'authorized') return 'granted'
  if (value === false || value === 'denied' || value === 'restricted') return 'denied'
  return 'undetermined'
}

/** The five permissions, whatever words the bridge uses. */
export function normalizePermissions(raw: unknown): RecorderPermissions {
  const p = obj(raw)
  return {
    screenRecording: permission(p.screenRecording ?? p.screen),
    accessibility: permission(p.accessibility),
    inputMonitoring: permission(p.inputMonitoring ?? p.input),
    camera: permission(p.camera),
    microphone: permission(p.microphone),
    traceFull: obj(p.trace).level === 'full' || (obj(p.trace).level === undefined && (permission(p.accessibility) === 'granted' || permission(p.inputMonitoring) === 'granted')),
  }
}

function device(raw: unknown, index: number, noun: string): DeviceOption | null {
  const d = obj(raw)
  const id = str(d.deviceId ?? d.id ?? d.uniqueId)
  if (!id) return null
  return { id, name: str(d.name ?? d.label, `${noun} ${index + 1}`), isDefault: d.isDefault === true || d.default === true }
}

function windowOf(raw: unknown, app?: Record<string, unknown>): DesktopWindow | null {
  const w = obj(raw)
  const windowId = num(w.windowId ?? w.id, NaN)
  if (!Number.isFinite(windowId)) return null
  const frame = obj(w.frame)
  return {
    windowId,
    pid: num(w.pid ?? app?.pid),
    bundleId: str(w.bundleId ?? app?.bundleId),
    appName: str(w.appName ?? app?.appName ?? app?.name, 'App'),
    title: str(w.title),
    frame: { x: num(frame.x), y: num(frame.y), width: num(frame.width), height: num(frame.height) },
    displayId: num(w.displayId),
    scale: num(w.scale, 1),
  }
}

/** Displays, windows grouped by app, cameras and microphones, whether the bridge groups windows or lists them flat. */
export function normalizeTargets(raw: unknown): RecorderTargets {
  const t = obj(raw)
  const displays: DesktopDisplay[] = arr(t.displays).flatMap((value, index) => {
    const d = obj(value)
    const displayId = num(d.displayId ?? d.id, NaN)
    if (!Number.isFinite(displayId)) return []
    const frame = obj(d.frame)
    return [{
      displayId,
      name: str(d.name, index === 0 ? 'Main display' : `Display ${index + 1}`),
      // Pixels when the bridge gives them (pixelWidth), else points.
      width: num(d.pixelWidth ?? d.width ?? frame.width),
      height: num(d.pixelHeight ?? d.height ?? frame.height),
      scale: num(d.scale, 1),
      isMain: d.isMain === true || d.main === true || index === 0,
    }]
  })
  const byPid = new Map<number, DesktopApp>()
  const add = (window: DesktopWindow) => {
    const app = byPid.get(window.pid) ?? { pid: window.pid, bundleId: window.bundleId, appName: window.appName, windows: [] }
    app.windows.push(window)
    byPid.set(window.pid, app)
  }
  for (const value of arr(t.apps ?? t.applications)) {
    const app = obj(value)
    for (const w of arr(app.windows)) {
      const window = windowOf(w, app)
      if (window) add(window)
    }
  }
  for (const w of arr(t.windows)) {
    const window = windowOf(w)
    if (window) add(window)
  }
  return {
    displays,
    apps: [...byPid.values()].sort((a, b) => a.appName.localeCompare(b.appName)),
    cameras: arr(t.cameras).map((value, index) => device(value, index, 'Camera')).filter((d): d is DeviceOption => !!d),
    microphones: arr(t.microphones).map((value, index) => device(value, index, 'Microphone')).filter((d): d is DeviceOption => !!d),
  }
}

// The take's main files. Extra windows and cameras (`window-<n>`, `camera-<n>`) only exist when `start` is given
// extraWindows / extraCameras, which this version never asks for: the take -> video builder has no extra sources yet.
const ROLES: TakeRole[] = ['screen', 'camera', 'microphone', 'system-audio']
const ROLE_LABEL: Record<TakeRole, string> = { screen: 'Screen recording', camera: 'Camera', microphone: 'Microphone', 'system-audio': 'System audio' }
/** What the recorder writes each role as (Recorder.swift). */
const ROLE_EXT: Record<TakeRole, string> = { screen: 'mp4', camera: 'mp4', microphone: 'm4a', 'system-audio': 'm4a' }

/** A take file's name for the library: "Screen recording 14 Nov, 09:41.mp4". */
export function desktopFileName(role: TakeRole, ext: string, at: Date): string {
  const when = at.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  return `${ROLE_LABEL[role]} ${when}.${ext}`.replace(/[\\/:*?"<>|]+/g, '.').slice(0, 240)
}

/** Content type from a file path's extension. */
function contentTypeOf(path: string, role: TakeRole): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'mov') return 'video/quicktime'
  if (ext === 'mp4') return 'video/mp4'
  if (ext === 'm4a') return 'audio/mp4'
  if (ext === 'wav') return 'audio/wav'
  if (ext === 'caf') return 'audio/x-caf'
  if (ext === 'webm') return role === 'microphone' || role === 'system-audio' ? 'audio/webm' : 'video/webm'
  return role === 'microphone' || role === 'system-audio' ? 'audio/mp4' : 'video/quicktime'
}

/**
 * The bridge's stop answer as a finished take: each file's offset on the screen file's clock (from their first
 * presentation timestamps), and the transcript's words moved onto that clock too (they arrive in ms after `t0`).
 */
export function normalizeStop(sessionId: string, raw: unknown, at: Date): FinishedTake {
  const s = obj(raw)
  const files = arr(s.files).map(obj).filter((f) => ROLES.includes(f.role as TakeRole))
  const screen = files.find((f) => f.role === 'screen')
  if (!screen) throw new Error('The recorder finished without a screen recording. Try again.')
  const firsts = Object.fromEntries(files.map((f) => [f.role, num(f.firstPts, NaN)])) as Partial<Record<TakeRole, number>>
  const offsets = sourceOffsets(firsts, 's')
  const out: TakeFile[] = files.map((f) => {
    const role = f.role as TakeRole
    const path = str(f.path)
    const ext = path.split('.').pop()?.toLowerCase() || 'mov'
    return {
      role,
      name: desktopFileName(role, ext, at),
      contentType: contentTypeOf(path, role),
      bytes: num(f.bytes),
      offsetSeconds: offsets[role] ?? 0,
      durationSeconds: f.durationSeconds === undefined ? null : num(f.durationSeconds),
      ...(typeof f.width === 'number' ? { width: f.width } : {}),
      ...(typeof f.height === 'number' ? { height: f.height } : {}),
      ...(typeof f.frames === 'number' && Number.isInteger(f.frames) && f.frames > 0 ? { frames: f.frames } : {}),
      ...(typeof f.fps === 'number' && Number.isFinite(f.fps) && f.fps > 0 ? { fps: f.fps } : {}),
      ...(typeof f.sha256 === 'string' && /^[a-f0-9]{64}$/.test(f.sha256) ? { sha256: f.sha256 } : {}),
    }
  })
  const screenFirst = num(screen.firstPts, NaN)
  const t0 = num(s.t0, NaN)
  // Words are ms after t0; the screen file starts at its first timestamp.
  const shiftMs = Number.isFinite(screenFirst) && Number.isFinite(t0) ? (t0 - screenFirst) * 1000 : 0
  const words = wordsOnScreenClock(s.transcript, shiftMs)
  // A track the recorder ended early (its input changed format mid-take): said plainly, the take is still whole up to there.
  const notes = arr(s.notes).filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
  return {
    kind: 'desktop',
    sessionId,
    files: out,
    trace: s.trace && typeof s.trace === 'object' ? s.trace : null,
    sourceCursorHidden: s.sourceCursorHidden === undefined ? true : s.sourceCursorHidden === true,
    transcript: words.length ? { words } : null,
    durationSeconds: num(screen.durationSeconds, 0),
    wordsShiftMs: shiftMs,
    ...(s.wordsPending === true ? { wordsPending: true } : {}),
    ...(notes.length ? { note: notes.join(' ') } : {}),
  }
}


/** Subscribe to one of the bridge's events under whichever name it has. Answers the unsubscribe. */
function subscribe(b: StudioRecorderBridge, names: string[], handler: (payload: unknown) => void): Unlisten {
  for (const name of names) {
    const fn = b[name]
    if (typeof fn !== 'function') continue
    let unlisten: Unlisten | null = null
    let dropped = false
    try {
      const result = (fn as AnyFn).call(b, handler as never)
      if (typeof result === 'function') return result as Unlisten
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        void (result as Promise<unknown>).then((value) => {
          if (typeof value !== 'function') return
          if (dropped) (value as Unlisten)()
          else unlisten = value as Unlisten
        }).catch(() => {})
        return () => {
          dropped = true
          unlisten?.()
        }
      }
    } catch {
      // Try the next name.
    }
  }
  return () => {}
}

// ---- uploading while it records -------------------------------------------------------------------------------

/** The app's word on a piece it could not send, as a live track reads it: trouble on the way is worth another try. */
function pieceError(error: unknown): LiveError {
  const code = (error as { code?: unknown } | null)?.code
  const message = error instanceof Error ? error.message : 'The recording could not be sent.'
  return new LiveError(message, code === 'upload' || code === 'io' || code === 'timeout' ? 503 : 400, typeof code === 'string' ? `APP_${code.toUpperCase()}` : undefined)
}

type Uploads = Required<Pick<StudioRecorderBridge, 'segments' | 'linkLive' | 'planPieces' | 'putPiece'>> & StudioRecorderBridge

/** The bridge, when the app can upload while it records. */
function uploads(native: StudioRecorderBridge): Uploads | null {
  return typeof native.segments === 'function' && typeof native.linkLive === 'function' && typeof native.planPieces === 'function'
    && typeof native.putPiece === 'function' && typeof native.onSegment === 'function'
    ? (native as Uploads)
    : null
}

/** How a live track sends a piece and writes pieces down, through the app (the bytes never come here). */
function appSending(native: Uploads, sessionId: string, offset: (role: TakeRole) => number | null) {
  return {
    send: async (role: TakeRole, piece: Piece, link: { url: string; headers: Record<string, string> }) => {
      try {
        await native.putPiece(sessionId, role, piece.index, link.url, link.headers)
      } catch (error) {
        throw pieceError(error)
      }
    },
    plan: async (role: TakeRole, pieces: Piece[]) => {
      const at = offset(role)
      await native.planPieces(sessionId, role, pieces.map((piece) => {
        const range = piece.body as FileRange
        return { index: piece.index, offset: range.offset, length: range.size, seconds: piece.seconds, offsetSeconds: at !== null && Number.isFinite(at) ? at : null }
      }))
    },
  }
}

/**
 * A take's segments into its live tracks, in order and each once: from the app's events as they come, and from the
 * take's index whenever one was missed (an event lost, or the first ones sent before this page listened) and at Stop
 * (the last ones may still be on their way). Also where each file's time 0 sits on the take's clock.
 */
export class SegmentFeed {
  private next = new Map<TakeRole, number>()
  private chains = new Map<TakeRole, Promise<void>>()
  private lastEvent = Number.NEGATIVE_INFINITY
  /** Host seconds of each file's time 0, as the recorder said. */
  readonly starts = new Map<TakeRole, number>()

  constructor(private readonly native: Uploads, private readonly sessionId: string, private readonly live: LiveTake) {}

  /** Seconds after the screen's first frame this track's file starts (0 for the screen; null until both are known). */
  offset(role: TakeRole): number | null {
    const screen = this.starts.get('screen')
    const own = this.starts.get(role)
    return screen === undefined || own === undefined ? null : Math.round((own - screen) * 1000) / 1000
  }

  /** No event for a while (`now`, ms): read the index of every track, so the take still goes up while it records. */
  poll(now: number): void {
    if (now - this.lastEvent < 3000) return
    this.lastEvent = now
    for (const role of this.live.tracks.keys()) void this.catchUp(role)
  }

  event(raw: unknown, now = performance.now()): void {
    this.lastEvent = now
    const e = obj(raw)
    const role = e.role as TakeRole
    if (!ROLES.includes(role) || !this.live.tracks.has(role)) return
    if (typeof e.startPts === 'number' && Number.isFinite(e.startPts)) this.starts.set(role, e.startPts)
    const index = num(e.index, -1)
    const next = this.next.get(role) ?? 0
    if (index === next) this.push(role, { index, offset: num(e.offset, -1), length: num(e.length, 0), endSeconds: e.endSeconds })
    else if (index > next) void this.catchUp(role)
  }

  /** Read the take's index and push every segment not pushed yet. Never throws. */
  catchUp(role: TakeRole): Promise<void> {
    const chain = (this.chains.get(role) ?? Promise.resolve()).then(async () => {
      try {
        const answer = obj(await this.native.segments(this.sessionId, role))
        // Where the file starts on the take's clock, as the recorder kept it: known even when every event was missed.
        if (typeof answer.startPts === 'number' && Number.isFinite(answer.startPts) && !this.starts.has(role)) this.starts.set(role, answer.startPts)
        for (const value of arr(answer.segments)) {
          const seg = obj(value)
          if (num(seg.index, -1) === (this.next.get(role) ?? 0)) this.push(role, { index: num(seg.index), offset: num(seg.offset, -1), length: num(seg.length, 0), endSeconds: seg.endSeconds })
        }
      } catch {
        // The next event (or Stop) tries again.
      }
    })
    this.chains.set(role, chain)
    return chain
  }

  private push(role: TakeRole, seg: { index: number; offset: number; length: number; endSeconds: unknown }): void {
    if (seg.offset < 0 || seg.length <= 0) return
    this.next.set(role, seg.index + 1)
    this.live.tracks.get(role)?.push({ offset: seg.offset, size: seg.length }, num(seg.endSeconds, 0))
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A take on the Studio as GET /live-takes/:id answers (src/lib/studio/server/live-takes.ts LiveTakeState). */
type LiveTakeState = { id: string; status: string; recordingId?: string; whole?: string[]; tracks: { role: string; declared: number; stored: number; bytes?: number; sealed: boolean; stopped: boolean }[] }

const WHOLE = 'ni-studio-whole:'
/**
 * Tracks of a take the Studio stopped taking pieces of, uploaded whole from the computer afterwards: the Studio's role
 * → the upload's key. Bringing the take back names them (POST /live-takes/:id/recover `whole`), so its full sound and
 * picture are used, not the start that came in pieces. Kept in this browser until the take is made a video.
 */
export function wholeTracks(takeId: string): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(WHOLE + takeId) ?? '{}') as unknown
    return value && typeof value === 'object' ? (Object.fromEntries(Object.entries(value).filter(([, key]) => typeof key === 'string')) as Record<string, string>) : {}
  } catch {
    return {}
  }
}
function keepWhole(takeId: string, role: string, key: string) {
  try {
    localStorage.setItem(WHOLE + takeId, JSON.stringify({ ...wholeTracks(takeId), [role]: key }))
  } catch {
    // Not kept: the folder stays on the computer, and the next launch uploads it again.
  }
}
function forgetWhole(takeId: string) {
  try {
    localStorage.removeItem(WHOLE + takeId)
  } catch {
    // Gone already.
  }
}

let sending: Promise<number> | null = null
/** The take sendAll is working on now (its folder must not be discarded under it). */
const beingSent = new Set<string>()
/** The takes on this computer being sent on now (sendUnfinishedTakes): the Record dialog never offers them. */
export const takesBeingSent = (): ReadonlySet<string> => beingSent

/**
 * What a quit or a crash kept from going up: each take on this computer linked to a take on the Studio still being
 * recorded there gets its missing pieces, from the plan written before any was declared (so the Studio sees the same
 * pieces), then the rest of its segments. A take the Studio made into a video or threw away is removed from the
 * computer. `skip`: takes this page is sending itself. Answers how many takes it went on with; never throws. One run
 * at a time.
 */
export function sendUnfinishedTakes(native: StudioRecorderBridge, api: LiveApi = fetchApi, skip: ReadonlySet<string> = new Set(), holder?: string, wait: (ms: number) => Promise<void> = sleep): Promise<number> {
  sending ??= sendAll(native, api, skip, holder, wait).finally(() => {
    sending = null
    beingSent.clear()
  })
  return sending
}

async function sendAll(native: StudioRecorderBridge, api: LiveApi, skip: ReadonlySet<string>, holder: string | undefined, wait: (ms: number) => Promise<void>): Promise<number> {
  const app = uploads(native)
  if (!app || typeof native.unfinishedTakes !== 'function') return 0
  let listed: unknown
  try {
    // The takes this page holds (a draft it reopened) are listed for it; those another live page holds are not.
    listed = await native.unfinishedTakes(holder)
  } catch {
    return 0
  }
  let sent = 0
  for (const value of arr(obj(listed).takes)) {
    const local = obj(value)
    const sessionId = str(local.sessionId)
    const takeId = str(local.takeId)
    // Another account's take, or one with no screen to make a video of, is listed for its size only: never sent.
    if (!sessionId || !takeId || skip.has(sessionId) || local.otherAccount === true || local.screenMissing === true) continue
    // One take at a time (one run at a time): this one until the next, or the run's end.
    beingSent.clear()
    beingSent.add(sessionId)
    let state: LiveTakeState
    try {
      state = (await api.get<{ take: LiveTakeState }>(`${STUDIO_API}/live-takes/${encodeURIComponent(takeId)}`)).take
    } catch {
      // Not here (another person's, on this computer), or no answer now: tried again next time.
      continue
    }
    if (state.status !== 'recording') {
      // A take opened in the editor before it was filed is its filing's (filing.ts): it lets go of the files itself.
      if (local.hasDraft === true) continue
      if (state.recordingId) {
        // Made into a recording: the files go only once the Studio holds every track as recorded. A track it lost
        // (its import failed, its bytes differed, it stopped taking its pieces) is sent again whole first.
        // One look (a lost track is sent again now; the files go at a later launch, once it is in).
        const settled = await settleRecording({ api, native, sleep: wait }, state.recordingId, sessionId, { rounds: 1 })
        if (settled.safe) {
          await native.discard(sessionId).catch(() => undefined)
          forgetWhole(takeId)
        }
        continue
      }
      // Thrown away on the Studio (never made into a recording): nothing of it is wanted.
      if (state.status === 'dropped') {
        await native.discard(sessionId).catch(() => undefined)
        forgetWhole(takeId)
      }
      continue
    }
    const screenStart = arr(local.tracks).map(obj).find((t) => t.role === 'screen')?.startPts
    let went = false
    for (const trackValue of arr(local.tracks)) {
      const t = obj(trackValue)
      const role = t.role as TakeRole
      if (!ROLES.includes(role)) continue
      const server = state.tracks.find((x) => x.role === serverRole(role))
      if (!server || server.sealed) continue
      if (server.stopped) {
        // The Studio stopped taking this track's pieces (it said why when it was recorded): the whole file goes up as an
        // ordinary upload, named when the take is brought back. Until then the folder is never thrown away.
        // Skipped only once the Studio says it is bound: a bind that failed is tried again at the next launch.
        if (state.whole?.includes(server.role)) continue
        try {
          const audio = role === 'microphone' || role === 'system-audio'
          const ticket = await api.post<{ uploadKey: string; parts: unknown[] }>(`${STUDIO_API}/uploads`, {
            name: desktopFileName(role, ROLE_EXT[role], new Date()), bytes: num(t.bytes), contentType: audio ? 'audio/mp4' : 'video/mp4',
          })
          await native.upload(sessionId, role, ticket.parts as UploadPart[])
          // Bound to the take on the Studio first (whoever brings it back gets the whole track); noted here only then.
          await api.post(`${STUDIO_API}/live-takes/${encodeURIComponent(takeId)}/whole`, { role: server.role, uploadKey: ticket.uploadKey })
          keepWhole(takeId, server.role, ticket.uploadKey)
          went = true
        } catch {
          // Tried again the next time the Studio opens.
        }
        continue
      }
      const plan = arr(t.plan).map(obj).map((p) => ({ index: num(p.index), offset: num(p.offset), length: num(p.length), seconds: num(p.seconds), offsetSeconds: typeof p.offsetSeconds === 'number' ? p.offsetSeconds : null }))
      if (server.stored > plan.length) continue
      // Where this track sits on the screen's clock: from the starts the recorder kept beside the files (also when the
      // page that recorded it missed every event), else as the plan said.
      const ownStart = t.startPts
      const offsetSeconds = typeof ownStart === 'number' && typeof screenStart === 'number' ? (role === 'screen' ? 0 : Math.round((ownStart - screenStart) * 1000) / 1000) : (plan.at(-1)?.offsetSeconds ?? null)
      const via = appSending(app, sessionId, () => offsetSeconds)
      const track = new LiveTrack(role, {
        api,
        now: () => performance.now(),
        sleep,
        offset: () => offsetSeconds,
        pieceSeconds: 0,
        onFailed: () => undefined,
        onChange: () => undefined,
        send: (piece, link) => via.send(role, piece, link),
        plan: (pieces) => via.plan(role, pieces),
      })
      track.connect(state.id, `live/${state.id}/${serverRole(role)}`)
      track.resume(plan.map((p) => ({ index: p.index, body: { offset: p.offset, size: p.length }, seconds: p.seconds })), server.stored)
      const end = plan.length ? plan.at(-1)!.offset + plan.at(-1)!.length : 0
      const written = num(t.bytes)
      if (written > end) track.push({ offset: end, size: written - end }, Math.max(num(t.seconds), plan.at(-1)?.seconds ?? 0))
      if (server.stored === plan.length && written <= end) continue
      try {
        await track.finish()
        went = true
      } catch {
        // No answer for a while: tried again the next time the Studio opens.
      }
    }
    if (went) sent++
  }
  return sent
}

// ---- the recorder --------------------------------------------------------------------------------------------

export class DesktopRecorder implements Recorder {
  readonly kind = 'desktop' as const
  private options: TakeOptions | null = null
  private sessionId: string | null = null
  private unlisten: Unlisten[] = []
  private progress = new Map<string, (fraction: number) => void>()
  private startedAt = new Date()
  /** Set once stop or cancel is asked: the recorder's own "stopped" that follows is not the person's Stop. */
  private stopping = false
  /** The take going to the Studio while it records, and its segments' feed. */
  private live: { take: LiveTake; feed: SegmentFeed } | null = null
  /** Stopped takes whose last pieces may still be going up, by their session id. */
  private stopped = new Map<string, LiveTake>()
  /** This page's hold on the takes it records and sends (another page never sends on them meanwhile). */
  readonly leases: PageLeases

  constructor(
    private readonly native: StudioRecorderBridge,
    private readonly api: LiveApi = fetchApi,
    private readonly time: { now: () => number; sleep: (ms: number) => Promise<void> } = { now: () => performance.now(), sleep },
    leases?: PageLeases,
  ) {
    this.leases = leases ?? new PageLeases(native)
  }

  /** The takes this recorder is recording now (never listed as kept on this computer). */
  liveSessions(): string[] {
    return this.live && this.sessionId ? [this.sessionId] : []
  }

  /** The takes this recorder still has: recording, or stopped and not yet let go of (being uploaded, made into a video). */
  ownedSessions(): string[] {
    return [...this.stopped.keys(), ...(this.sessionId ? [this.sessionId] : [])]
  }

  /** The ids on the Studio of the takes this recorder holds (never offered back as stopped: they are being sent). */
  liveTakeIds(): string[] {
    const ids = [...this.stopped.values()].map((live) => live.id ?? live.requestedId)
    if (this.live) ids.push(this.live.take.id ?? this.live.take.requestedId)
    return ids
  }

  /**
   * Send what a quit or a crash kept on this computer from going up (sendUnfinishedTakes). `keep`: takes whose files
   * stay on the computer even once the Studio has them (an edit opened before they were filed plays them). Answers
   * how many takes went on.
   */
  sendUnfinished(): Promise<number> {
    const mine = new Set([...this.stopped.keys(), ...(this.sessionId ? [this.sessionId] : [])])
    return sendUnfinishedTakes(this.native, this.api, mine, this.leases.holder, this.time.sleep)
  }

  /** The app's bridge (filing.ts files a take through it). */
  get app(): StudioRecorderBridge {
    return this.native
  }

  /** Let go of a stopped take without touching its files (kept: the Studio does not hold every byte of it yet). */
  async forget(take: FinishedTake): Promise<void> {
    this.stopped.delete(take.sessionId)
    await this.leases.release(take.sessionId)
    if (this.sessionId === take.sessionId) this.sessionId = null
    this.stopListening()
  }

  /** The take as an edit from the files on this computer (provisional.ts), or null when it must wait for the Studio. */
  async provisional(take: FinishedTake, projectId: string, title: string): Promise<Draft | null> {
    if (typeof this.native.takeMedia !== 'function') return null
    try {
      const raw = obj(await this.native.takeMedia(take.sessionId))
      const media: LocalMedia = {
        tracks: arr(raw.tracks).map(obj).flatMap((t) => (ROLES.includes(t.role as TakeRole) && typeof t.sha256 === 'string' ? [{ role: t.role as TakeRole, sha256: t.sha256, bytes: num(t.bytes) }] : [])),
        waveform: Array.isArray(raw.waveform) ? raw.waveform.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)) : null,
      }
      return provisionalDraft({ take, media, projectId, title })
    } catch {
      return null
    }
  }

  /** A filed take's files on this computer are no longer played: they go. */
  async releaseTake(sessionId: string): Promise<void> {
    this.stopped.delete(sessionId)
    await this.native.discard(sessionId)
    await this.leases.release(sessionId)
  }

  /** The take on the Studio, uploaded while it records, when the app can (else null: it uploads after Stop). */
  private openLive(sessionId: string, started: Record<string, unknown>): { take: LiveTake; feed: SegmentFeed } | null {
    const app = uploads(this.native)
    if (!app) return null
    const roles = arr(started.files).map((f) => obj(f).role).filter((role): role is TakeRole => ROLES.includes(role as TakeRole))
    if (!roles.includes('screen')) return null
    let feed: SegmentFeed | null = null
    const offset = (role: TakeRole) => (role === 'screen' ? 0 : (feed?.offset(role) ?? null))
    const take = new LiveTake(roles, {
      api: this.api,
      now: this.time.now,
      sleep: this.time.sleep,
      offset,
      // Each segment its own piece: about two seconds, so Stop leaves only the last one or two.
      pieceSeconds: 0,
      // The Studio refused the rest of a track: it keeps recording here, and uploads whole after Stop (upload()).
      onFailed: () => undefined,
      onChange: () => undefined,
      ...appSending(app, sessionId, offset),
    })
    feed = new SegmentFeed(app, sessionId, take)
    const names = Object.fromEntries(roles.map((role) => [role, desktopFileName(role, ROLE_EXT[role], this.startedAt)]))
    void take.open('desktop', names).then(async (onServer) => {
      if (onServer && take.id) await app.linkLive(sessionId, take.id)
    }).catch(() => undefined)
    return { take, feed }
  }

  async permissions(): Promise<RecorderPermissions> {
    return normalizePermissions(await this.native.permissions())
  }

  async requestPermissions(which: RecorderPermissionName[]): Promise<RecorderPermissions> {
    const answer = await this.native.requestPermissions(which)
    return answer && typeof answer === 'object' ? normalizePermissions(answer) : this.permissions()
  }

  async targets(): Promise<RecorderTargets> {
    return normalizeTargets(await this.native.targets())
  }

  async prepare(options: TakeOptions): Promise<void> {
    if (options.screen.kind === 'shared') throw new Error('Choose a window or a display to record.')
    const state = await this.permissions().catch(() => null)
    if (state) {
      const missing = [
        state.screenRecording !== 'granted' ? 'Screen Recording' : '',
        options.microphone && state.microphone !== 'granted' ? 'Microphone' : '',
        options.camera && state.camera !== 'granted' ? 'Camera' : '',
      ].filter(Boolean)
      if (missing.length) throw new Error(`Native Intelligence needs ${missing.join(' and ')} access first. Use Grant above, then try again.`)
    }
    this.options = options
  }

  async start(handlers: RecorderHandlers): Promise<void> {
    const options = this.options
    if (!options || options.screen.kind === 'shared') throw new Error('Choose a window or a display to record.')
    this.stopListening()
    this.stopping = false
    this.startedAt = new Date()
    const screen = options.screen.kind === 'display' ? { kind: 'display', displayId: options.screen.displayId } : { kind: 'window', windowId: options.screen.windowId }
    const answer = obj(await this.native.start({
      screen,
      hideCursor: options.hideCursor,
      ...(options.camera ? { camera: options.camera.deviceId ? { deviceId: options.camera.deviceId } : {} } : {}),
      ...(options.microphone ? { microphone: options.microphone.deviceId ? { deviceId: options.microphone.deviceId } : {} } : {}),
      systemAudio: options.systemAudio,
      fps: 60,
    }))
    const sessionId = str(answer.sessionId)
    if (!sessionId) throw new Error('The recorder did not start. Try again.')
    this.sessionId = sessionId
    void this.leases.hold(sessionId)
    const live = this.openLive(sessionId, answer)
    this.live = live
    // Listeners stay until the take is discarded (upload progress arrives after stop); stop and error only count while recording.
    const mine = (payload: unknown) => {
      const id = obj(payload).sessionId
      return id === undefined || id === null || id === sessionId
    }
    this.unlisten.push(
      subscribe(this.native, ['onStatus', 'onStudioRecorderStatus'], (payload) => {
        if (!mine(payload)) return
        live?.feed.poll(this.time.now())
        const p = obj(payload)
        const elapsedMs = typeof p.elapsedMs === 'number' ? p.elapsedMs : num(p.elapsed) * 1000
        const levels = obj(p.levels)
        const raw = typeof p.level === 'number' ? p.level : typeof levels.mic === 'number' ? levels.mic : typeof levels.microphone === 'number' ? levels.microphone : null
        handlers.onStatus({ elapsedMs, level: raw === null ? null : Math.max(0, Math.min(1, raw)), ...(this.live ? { tracks: this.live.take.status() } : {}) })
      }),
      // Each segment the recorder finished goes to its track's next piece.
      subscribe(this.native, ['onSegment'], (payload) => {
        if (mine(payload)) live?.feed.event(payload, this.time.now())
      }),
      // Stopped from the floating control (Stop, or Cancel: `cancelled: true`), or from another window.
      subscribe(this.native, ['onStopped', 'onStudioRecorderStopped'], (payload) => {
        if (!mine(payload) || this.stopping) return
        handlers.onEnded(obj(payload).cancelled === true ? { kind: 'cancelled' } : { kind: 'stopped-elsewhere' })
      }),
      // Only a fatal error ends the take (the screen capture stopped); what was recorded is still kept by stop().
      subscribe(this.native, ['onError', 'onStudioRecorderError'], (payload) => {
        const p = obj(payload)
        if (mine(payload) && !this.stopping && p.fatal !== false) handlers.onEnded({ kind: 'error', message: str(p.message ?? p.error, 'The recorder stopped with an error.') })
      }),
      subscribe(this.native, ['onUpload', 'onUploadProgress', 'onStudioRecorderUploadProgress'], (payload) => {
        if (!mine(payload)) return
        const p = obj(payload)
        const role = str(p.role)
        const fraction = typeof p.fraction === 'number' ? p.fraction : num(p.bytes) / Math.max(1, num(p.total ?? p.totalBytes, 1))
        this.progress.get(role)?.(Math.max(0, Math.min(1, fraction)))
      }),
    )
    try {
      await this.native.showControl?.(sessionId)
    } catch {
      // The floating Stop bar is a convenience: the live bar in the app still stops the take.
    }
  }

  async stop(): Promise<FinishedTake> {
    const sessionId = this.sessionId
    if (!sessionId) throw new Error('Nothing is recording.')
    try {
      await this.native.hideControl?.()
    } catch {
      // Already gone.
    }
    this.stopping = true
    const raw = await this.native.stop(sessionId)
    const take = normalizeStop(sessionId, raw, this.startedAt)
    const live = this.live
    this.live = null
    if (!live) return take
    // Every segment of the finished files (the last ones' events may still be on their way: read from the take's index
    // on this computer, never the network). Stop waits for nothing more: whether each track goes on as it went up, or
    // whole, is decided when it is uploaded (upload()), behind the editor.
    await Promise.all(take.files.map((file) => live.feed.catchUp(file.role)))
    if (live.take.id) take.liveTakeId = live.take.id
    this.stopped.set(sessionId, live.take)
    return take
  }

  /** The take's id on the Studio, once the Studio has answered its start (null: it never took it). */
  async liveTakeIdOf(sessionId: string): Promise<string | null> {
    const live = this.stopped.get(sessionId)
    if (!live) return null
    return (await live.ready) && live.id ? live.id : null
  }

  async cancel(): Promise<void> {
    const sessionId = this.sessionId
    this.sessionId = null
    this.stopping = true
    // Thrown away: the pieces already on the Studio go too.
    const live = this.live
    this.live = null
    if (live) void live.take.discard()
    try {
      await this.native.hideControl?.()
    } catch {
      // Already gone.
    }
    this.stopListening()
    if (sessionId) {
      await this.native.cancel(sessionId)
      await this.leases.release(sessionId)
    }
  }

  async upload(take: FinishedTake, file: TakeFile, onProgress: (fraction: number) => void): Promise<string> {
    // A track that went up while it recorded is finished from there: only its last seconds are left. One the Studio did
    // not take, or whose bytes do not add up to the file, uploads whole as before.
    const live = file.whole ? undefined : this.stopped.get(take.sessionId)
    if (live && !file.uploadKey) {
      const onServer = await live.ready
      const sent = live.tracks.get(file.role)
      if (onServer && sent?.key && (sent.state === 'live' || sent.state === 'retrying') && sent.recordedBytes === file.bytes) file.uploadKey = sent.key
      if (onServer && live.id) take.liveTakeId = live.id
    }
    const track = file.uploadKey ? live?.tracks.get(file.role) : undefined
    if (file.uploadKey && track) {
      try {
        const done = await track.finish(onProgress)
        if (done.complete) {
          file.pieces = done.pieces
          return done.key
        }
      } catch (error) {
        // No answer for a while: the pieces stay on this computer, and the person tries again.
        if (track.state !== 'failed') throw error
      }
    }
    // Not uploaded while it recorded, or the Studio refused the rest of it: the whole file, from the computer.
    delete file.uploadKey
    delete file.pieces
    const ticket = await request<{ uploadKey: string; partBytes: number; parts: UploadPart[] }>(`${STUDIO_API}/uploads`, {
      name: file.name,
      bytes: file.bytes,
      contentType: file.contentType,
    })
    this.progress.set(file.role, onProgress)
    try {
      await this.native.upload(take.sessionId, file.role, ticket.parts)
    } finally {
      this.progress.delete(file.role)
    }
    onProgress(1)
    return ticket.uploadKey
  }

  async discard(take: FinishedTake): Promise<void> {
    try {
      await this.native.discard(take.sessionId)
    } catch {
      // The Mac cleans its recordings folder on its own as well.
    }
    // A take that became a recording is the Studio's to clean up (it answers that it is busy); one thrown away goes now.
    const live = this.stopped.get(take.sessionId)
    this.stopped.delete(take.sessionId)
    if (live) await live.discard().catch(() => undefined)
    await this.leases.release(take.sessionId)
    if (this.sessionId === take.sessionId) this.sessionId = null
    this.stopListening()
  }

  dispose(): void {
    this.stopListening()
    this.leases.releaseAll()
  }

  private stopListening() {
    for (const off of this.unlisten) off()
    this.unlisten = []
  }
}
