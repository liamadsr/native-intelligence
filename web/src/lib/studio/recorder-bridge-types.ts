/**
 * Payloads of the desktop app's Studio recorder (desktop:
 * src-tauri/src/commands/studio_recorder.rs, which drives the
 * `studio-recorder` sidecar). The bridge is `tauriBridge.studioRecorder` in
 * `@/lib/tauri-bridge`. Outside the desktop app (or on a desktop build that
 * predates the recorder) `available()` is false. Calls resolve the payloads
 * below or reject with a `StudioRecorderError` (from the bridge) whose `code`
 * is a StudioRecorderFailure code.
 *
 * Clocks: every `*Pts` / `t0` / `endedAt` is in seconds on the Mac's host
 * clock (the clock ScreenCaptureKit stamps frames with). `t0` is the screen
 * recording's first frame; `offsetMs` on a file is where that file's first
 * sample falls after t0. Trace and transcript times are milliseconds since t0.
 */

/** One privacy service as macOS reports it. */
export type StudioPermissionState = 'granted' | 'denied' | 'undetermined'

export type StudioPermissionService =
  | 'screenRecording'
  | 'accessibility'
  | 'inputMonitoring'
  | 'camera'
  | 'microphone'

/** What the input trace can record with the grants as they are. `full`:
 *  precise pointer, click, scroll and typing events (Input Monitoring or
 *  Accessibility). `pointer`: the pointer, clicks and scrolling, typing only as
 *  times; `reason` says what to turn on. A take never needs either. */
export interface StudioTraceCapability {
  level: 'full' | 'pointer'
  reason: string | null
}

export interface StudioPermissions {
  screenRecording: StudioPermissionState
  accessibility: StudioPermissionState
  inputMonitoring: StudioPermissionState
  camera: StudioPermissionState
  microphone: StudioPermissionState
  trace: StudioTraceCapability
}

/** What `requestPermissions` did for one service: `prompted` = macOS showed
 *  its prompt (the answer arrives later: poll `permissions()`); Screen
 *  Recording takes effect only after the person allows it in System Settings,
 *  which can need the app to restart. */
export type StudioPermissionRequestResult = 'granted' | 'denied' | 'prompted' | 'opened-settings' | 'unknown-service'

/** The permissions after asking, and what happened to each service asked for. */
export interface StudioPermissionRequest extends StudioPermissions {
  results: Partial<Record<StudioPermissionService, StudioPermissionRequestResult>>
}

/** A rectangle in global points, top-left origin (the main display's top-left is 0,0). */
export interface StudioRect {
  x: number
  y: number
  width: number
  height: number
}

export interface StudioDisplay {
  displayId: number
  name: string
  frame: StudioRect
  /** Pixels per point (2 on a Retina display). */
  scale: number
  pixelWidth: number
  pixelHeight: number
  isMain: boolean
}

export interface StudioWindow {
  windowId: number
  /** Empty until Screen Recording is granted. */
  title: string
  frame: StudioRect
  displayId: number | null
  scale: number
}

/** An app with on-screen windows, front-most first. */
export interface StudioApp {
  pid: number
  bundleId: string | null
  name: string
  windows: StudioWindow[]
}

export interface StudioDevice {
  id: string
  name: string
  isDefault: boolean
}

export interface StudioTargets {
  displays: StudioDisplay[]
  apps: StudioApp[]
  cameras: StudioDevice[]
  microphones: StudioDevice[]
}

/** What a take records. The app picks where files go. */
export interface StudioStartOptions {
  screen: { kind: 'display'; displayId?: number } | { kind: 'window'; windowId: number }
  /** Leave the system cursor out of the picture (the editor can redraw it from the trace). */
  hideCursor?: boolean
  /** Omit for no camera; `{}` for the default camera. */
  camera?: { deviceId?: string }
  /** Omit for no microphone; `{}` for the default microphone. */
  microphone?: { deviceId?: string }
  /** The sound the Mac plays (for a window take: that app's sound). */
  systemAudio?: boolean
  extraWindows?: { windowId: number }[]
  extraCameras?: { deviceId?: string }[]
  /** 60 (default) or 30. 30 keeps a 5K/6K display inside the encoder's real-time budget. */
  fps?: 60 | 30
}

export type StudioFileRole = 'screen' | 'camera' | 'microphone' | 'system-audio' | `window-${number}` | `camera-${number}`

export interface StudioPlannedFile {
  role: StudioFileRole
  path: string
}

export interface StudioStarted {
  sessionId: string
  t0HostTime: number
  /** ISO 8601. */
  startedAt: string
  /** The recorded surface in global points, and its pixels per point. */
  viewport: StudioRect & { scale: number }
  screen: { width: number; height: number; fps: number; codec: 'h264' | 'hevc' }
  files: StudioPlannedFile[]
  /** `local`: on-device words come back from stop(); `none`: use a server transcript. */
  transcription: 'local' | 'none'
  warnings: string[]
}

/** One file of a stopped take, on this Mac until `discard()`. */
export interface StudioFile {
  role: StudioFileRole
  /** Local path (for display only: upload with `upload()`, never through the page). */
  path: string
  bytes: number
  codec: 'h264' | 'hevc' | 'aac'
  /** Host seconds of the first and last sample (the last one's end for audio). */
  firstPts: number
  lastPts: number
  /** Milliseconds from t0 to firstPts. */
  offsetMs: number
  durationSeconds?: number
  /** Pictures. */
  width?: number
  height?: number
  fps?: number
  frames?: number
  /** Screen: grid slots the encoder was too busy for (the previous frame repeats). */
  gridMisses?: number
  /** Audio. */
  sampleRate?: number
  channels?: number
  /** Extra cameras and windows. */
  kind?: 'camera' | 'window'
  sourceId?: string
  name?: string
}

/** The editor's trace (its TraceSchema): positions in points from the
 *  recorded surface's top-left, times in ms since t0. Typing is recorded only
 *  as intervals: no characters, no key codes. */
export interface StudioTraceAction {
  t: number
  end: number
  kind: 'click' | 'type' | 'scroll' | (string & {})
  label: string
  box: { x: number; y: number; w: number; h: number } | null
  button?: 'left' | 'right' | 'other'
}

export interface StudioTraceFocus {
  t: number
  pid: number
  bundleId: string | null
  app: string | null
  windowId: number
  title: string
}

export interface StudioTrace {
  version: 1
  clock: { unit: 'ms'; origin: 'screen-first-frame'; t0HostTime: number }
  viewport: StudioRect & { scale: number }
  /** [t (ms), x, y] */
  cursor: [number, number, number][]
  actions: StudioTraceAction[]
  /** The app and window in front over the take. */
  focus: StudioTraceFocus[]
  durationMs: number
  /** How it listened: `events` (precise), `events-pointer` (typing polled), `polled`. */
  mode: 'events' | 'events-pointer' | 'polled'
  warnings: string[]
}

export interface StudioTranscriptWord {
  text: string
  startMs: number
  endMs: number
  confidence: number
}

export interface StudioTranscript {
  engine: 'local'
  words: StudioTranscriptWord[]
}

export interface StudioStopped {
  sessionId: string
  t0: number
  endedAt: number
  durationMs: number
  files: StudioFile[]
  /** The trace, inlined; null if it could not be read. */
  trace: StudioTrace | null
  tracePath: string
  traceMode: StudioTrace['mode'] | null
  /** On-device words, or null: then transcribe on the server. */
  transcript: StudioTranscript | null
  /** The take was recorded with the system cursor hidden (the editor draws it from the trace). */
  sourceCursorHidden: boolean
  warnings: string[]
  cancelled?: undefined
}

export interface StudioCancelled {
  sessionId: string
  cancelled: true
}

/** `studio-recorder://stopped`: a take stopped (from the page or the control) or was cancelled. */
export type StudioStoppedEvent = StudioStopped | StudioCancelled

/** `studio-recorder://status`, twice a second while recording. Levels are 0–1. */
export interface StudioStatusEvent {
  sessionId: string
  elapsedMs: number
  bytes: number
  levels: { mic: number; system: number }
  /** The microphone's level again (levels.mic), 0 without a microphone. */
  level: number
}

/** `studio-recorder://error`. `fatal`: the screen capture stopped (a display
 *  unplugged, the recorder crashed): stop() still keeps what was recorded. */
export interface StudioErrorEvent {
  sessionId: string | null
  message: string
  fatal: boolean
}

/** `studio-recorder://upload`, as each part lands. */
export interface StudioUploadProgressEvent {
  sessionId: string
  role: StudioFileRole
  uploadedBytes: number
  totalBytes: number
  partsDone: number
  partsTotal: number
  /** uploadedBytes / totalBytes. */
  fraction: number
}

/** One signed part from /api/account/studio/uploads: bytes
 *  [index × parts[0].bytes, + bytes) of the file go to `url` with `headers`. */
export interface StudioUploadPart {
  index: number
  bytes: number
  url: string
  headers?: Record<string, string>
}

export interface StudioUploadResult {
  /** The whole file's size and SHA-256 (hex). */
  bytes: number
  sha256: string
  /** Each part's ETag (S3-style multipart completion needs them), in index order. */
  parts: { index: number; etag: string | null }[]
}

/** Why a call failed (`StudioRecorderError.code`): `unavailable` (browser,
 *  older desktop, no recorder in this build), `permission` (a service isn't
 *  granted: request it first), `busy` (a take is already recording),
 *  `not-found`, `recording` (upload before stop), `device`, `target`,
 *  `capture`, `bad-request`, `upload`, `io`, `timeout`, `failed`. */
export type StudioRecorderFailure =
  | 'unavailable'
  | 'permission'
  | 'busy'
  | 'not-found'
  | 'recording'
  | 'device'
  | 'target'
  | 'capture'
  | 'bad-request'
  | 'upload'
  | 'io'
  | 'timeout'
  | 'failed'
  | (string & {})
