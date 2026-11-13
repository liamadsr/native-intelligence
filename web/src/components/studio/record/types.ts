// The Studio's recorder, whichever machine does the recording. Two backends make takes: the browser's own screen
// share and MediaRecorder (`browser.ts`), and the Mac app's native recorder (`desktop.ts`). The Record dialog and its
// hook only ever talk to a `Recorder`; they never know which one they hold, except where the two genuinely differ
// (what can be picked as the screen, which permissions there are).
//
// No UI here.

/** Which recorder makes the take. */
export type RecorderKind = 'desktop' | 'browser'

/** One permission's state, as the Mac reports it. */
export type PermissionState = 'granted' | 'denied' | 'undetermined'

/** The five permissions the desktop recorder can need. */
export type RecorderPermissions = {
  screenRecording: PermissionState
  accessibility: PermissionState
  inputMonitoring: PermissionState
  camera: PermissionState
  microphone: PermissionState
  /** Whether the input trace times clicks and typing precisely with the grants as they are (else pointer only). */
  traceFull: boolean
}
export type RecorderPermissionName = Exclude<keyof RecorderPermissions, 'traceFull'>

/** A camera or a microphone. `id` is what `start` takes back. */
export type DeviceOption = { id: string; name: string; isDefault: boolean }

/** A window the desktop recorder can record. */
export type DesktopWindow = {
  windowId: number
  pid: number
  bundleId: string
  appName: string
  title: string
  frame: { x: number; y: number; width: number; height: number }
  displayId: number
  scale: number
}

/** A whole display the desktop recorder can record. */
export type DesktopDisplay = { displayId: number; name: string; width: number; height: number; scale: number; isMain: boolean }

/** One running app and its windows. */
export type DesktopApp = { pid: number; bundleId: string; appName: string; windows: DesktopWindow[] }

/** Everything the desktop recorder can record from right now. */
export type RecorderTargets = { displays: DesktopDisplay[]; apps: DesktopApp[]; cameras: DeviceOption[]; microphones: DeviceOption[] }

/** What the screen part of a take records: a display or a window (desktop), or whatever was shared (browser). */
export type ScreenChoice = { kind: 'display'; displayId: number } | { kind: 'window'; windowId: number } | { kind: 'shared' }

/** What the browser's own picker handed back. */
export type SharedSurface = {
  /** The browser's name for it (a tab's title, a window's title, "screen:0:0"). */
  label: string
  /** What kind of surface it is, when the browser says. */
  surface: 'browser' | 'window' | 'monitor' | 'unknown'
  /** Whether the share carries the tab's or the system's sound. */
  hasAudio: boolean
  width: number | null
  height: number | null
}

/** How to record a take. */
export type TakeOptions = {
  screen: ScreenChoice
  camera: { deviceId: string | null } | null
  microphone: { deviceId: string | null } | null
  /** Record the sound the screen makes (desktop: system audio; browser: whatever the share carries). */
  systemAudio: boolean
  /** Desktop: hide the cursor in the picture (the editor draws its own from the input trace). */
  hideCursor: boolean
}

/** What a recording is doing right now. */
export type LiveStatus = {
  /** Milliseconds recorded so far. */
  elapsedMs: number
  /** The microphone's level, 0..1, when one is recorded. */
  level: number | null
  /** Each track's upload while it records (browser takes; absent for the Mac app's recorder). */
  tracks?: LiveTrackStatus[]
}

/**
 * One track of a take being uploaded while it records (`live.ts`):
 *   connecting  the server has not answered yet; the pieces wait on this device
 *   live        pieces go up as they are made
 *   retrying    the connection dropped; the pieces wait on this device and go up when it is back
 *   local       the server could not take the recording while it was made: it uploads after Stop, as before
 *   failed      the server refused the rest (no space left, the take was finished elsewhere): what reached it is kept
 *   done        every piece is on the server
 */
export type LiveTrackState = 'connecting' | 'live' | 'retrying' | 'local' | 'failed' | 'done'
export type LiveTrackStatus = {
  role: TakeRole
  /** "Screen", "Camera", "Microphone". */
  label: string
  state: LiveTrackState
  /** Bytes the recorder has made so far, and how many of them are on the server. */
  recordedBytes: number
  uploadedBytes: number
  /** Seconds of this track recorded but not yet on the server: what a crash right now would lose. */
  unsavedSeconds: number
  /** Why it is retrying or failed, as a sentence. */
  error?: string
}

/** Why a take stopped on its own. */
export type EndReason =
  | { kind: 'share-ended' }
  | { kind: 'stopped-elsewhere' }
  /** Cancelled from the Mac's floating control: the take is thrown away. */
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string }

/** Told what happens while a take records. */
export type RecorderHandlers = {
  onStatus: (status: LiveStatus) => void
  /** The take stopped without `stop` being called (the share ended from the browser's bar, the Mac's Stop bar). */
  onEnded: (reason: EndReason) => void
}

/** The role a file plays in a take. */
export type TakeRole = 'screen' | 'camera' | 'microphone' | 'system-audio'

/** One recorded file of a finished take. */
export type TakeFile = {
  role: TakeRole
  /** A file name for the library ("Screen recording.webm"). */
  name: string
  contentType: string
  bytes: number
  /** When this file's first frame was taken, in seconds after the screen file's first frame (0 for the screen). */
  offsetSeconds: number
  durationSeconds: number | null
  width?: number
  height?: number
  /** Browser takes hold their bytes here when they could not upload while recording; desktop takes leave them on the Mac until `upload`. */
  blob?: Blob
  /**
   * A track uploaded while it recorded: its key on the server (`live/<take>/<role>`) and how many pieces make it. Its
   * bytes are on the server (or still going up: `upload` waits for the last ones), not here.
   */
  uploadKey?: string
  pieces?: number
  /** True when the Studio refused the end of this track: it holds only the start of the recording. */
  partial?: boolean
}

/** A word heard in the take, in milliseconds on the screen file's clock. */
export type TakeWord = { text: string; startMs: number; endMs: number }

/** A finished take, before it is uploaded. */
export type FinishedTake = {
  kind: RecorderKind
  sessionId: string
  files: TakeFile[]
  /** The input trace (cursor, clicks, keys, focus), matching the engine's TraceSchema; desktop only. */
  trace: unknown | null
  /** True when the cursor was left out of the picture. */
  sourceCursorHidden: boolean
  /** The words the Mac's local speech model heard, when it gave any. */
  transcript: { words: TakeWord[] } | null
  durationSeconds: number
  /** The take on the server when it was uploaded while it recorded (see TakeFile.uploadKey). */
  liveTakeId?: string
  /** A sentence about something that went wrong but left a usable take (the server refused the end of it). */
  note?: string
}

/** A part of an upload, as POST /uploads hands them out. */
export type UploadPart = { index: number; bytes: number; url: string; headers: Record<string, string> }

/** The recorder, whichever backend. */
export interface Recorder {
  readonly kind: RecorderKind
  /**
   * Get everything ready before the countdown: open the camera and microphone (the browser may ask for them here),
   * check the Mac's permissions. Throws a sentence the dialog can show.
   */
  prepare(options: TakeOptions): Promise<void>
  /** Start recording now (the countdown has already run). */
  start(handlers: RecorderHandlers): Promise<void>
  /** Stop and hand back the take's files. */
  stop(): Promise<FinishedTake>
  /** Stop and throw the take away. */
  cancel(): Promise<void>
  /** Put one file's bytes into storage under a fresh upload; answers its upload key. */
  upload(take: FinishedTake, file: TakeFile, onProgress: (fraction: number) => void): Promise<string>
  /** Forget a finished take's local files (after it is safely uploaded, or when it is thrown away). */
  discard(take: FinishedTake): Promise<void>
  /** Let go of anything held (streams, listeners). Safe to call more than once. */
  dispose(): void
}
