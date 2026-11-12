// The desktop recorder: the Mac app's native recorder (a sidecar driven through Tauri), reached through
// `studioRecorder` in src/lib/tauri-bridge.ts. It records a real window or display with the cursor hidden, an input
// trace (cursor, clicks, keys, focus) for the editor's zooms and cursor, the camera and microphone as their own
// files, and puts each file into storage itself (the bytes never pass through the web view).
//
// This file is the only one that knows the bridge's names (`tauriBridge.studioRecorder`, its payloads in
// src/lib/studio/recorder-bridge-types.ts): everything is read through `bridge()` and normalized here, so a change
// in the bridge is fixed in this file alone.
import { request } from '../ui/client'
import { STUDIO_API } from '../studio-env'
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
  const when = at.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  const out: TakeFile[] = files.map((f) => {
    const role = f.role as TakeRole
    const path = str(f.path)
    const ext = path.split('.').pop()?.toLowerCase() || 'mov'
    return {
      role,
      name: `${ROLE_LABEL[role]} ${when}.${ext}`.replace(/[\\/:*?"<>|]+/g, '.').slice(0, 240),
      contentType: contentTypeOf(path, role),
      bytes: num(f.bytes),
      offsetSeconds: offsets[role] ?? 0,
      durationSeconds: f.durationSeconds === undefined ? null : num(f.durationSeconds),
      ...(typeof f.width === 'number' ? { width: f.width } : {}),
      ...(typeof f.height === 'number' ? { height: f.height } : {}),
    }
  })
  const screenFirst = num(screen.firstPts, NaN)
  const t0 = num(s.t0, NaN)
  // Words are ms after t0; the screen file starts at its first timestamp.
  const shiftMs = Number.isFinite(screenFirst) && Number.isFinite(t0) ? (t0 - screenFirst) * 1000 : 0
  const words: TakeWord[] = arr(obj(s.transcript).words).flatMap((value) => {
    const w = obj(value)
    const text = str(w.text).trim()
    const startMs = num(w.startMs, NaN) + shiftMs
    const endMs = num(w.endMs, NaN) + shiftMs
    if (!text || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < 0) return []
    return [{ text, startMs: Math.max(0, startMs), endMs: Math.max(0, startMs, endMs) }]
  })
  return {
    kind: 'desktop',
    sessionId,
    files: out,
    trace: s.trace && typeof s.trace === 'object' ? s.trace : null,
    sourceCursorHidden: s.sourceCursorHidden === undefined ? true : s.sourceCursorHidden === true,
    transcript: words.length ? { words } : null,
    durationSeconds: num(screen.durationSeconds, 0),
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

  constructor(private readonly native: StudioRecorderBridge) {}

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
    // Listeners stay until the take is discarded (upload progress arrives after stop); stop and error only count while recording.
    const mine = (payload: unknown) => {
      const id = obj(payload).sessionId
      return id === undefined || id === null || id === sessionId
    }
    this.unlisten.push(
      subscribe(this.native, ['onStatus', 'onStudioRecorderStatus'], (payload) => {
        if (!mine(payload)) return
        const p = obj(payload)
        const elapsedMs = typeof p.elapsedMs === 'number' ? p.elapsedMs : num(p.elapsed) * 1000
        const levels = obj(p.levels)
        const raw = typeof p.level === 'number' ? p.level : typeof levels.mic === 'number' ? levels.mic : typeof levels.microphone === 'number' ? levels.microphone : null
        handlers.onStatus({ elapsedMs, level: raw === null ? null : Math.max(0, Math.min(1, raw)) })
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
    return normalizeStop(sessionId, raw, this.startedAt)
  }

  async cancel(): Promise<void> {
    const sessionId = this.sessionId
    this.sessionId = null
    this.stopping = true
    try {
      await this.native.hideControl?.()
    } catch {
      // Already gone.
    }
    this.stopListening()
    if (sessionId) await this.native.cancel(sessionId)
  }

  async upload(take: FinishedTake, file: TakeFile, onProgress: (fraction: number) => void): Promise<string> {
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
    if (this.sessionId === take.sessionId) this.sessionId = null
    this.stopListening()
  }

  dispose(): void {
    this.stopListening()
  }

  private stopListening() {
    for (const off of this.unlisten) off()
    this.unlisten = []
  }
}
