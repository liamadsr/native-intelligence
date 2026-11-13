// The browser recorder: the browser's own screen-share picker (getDisplayMedia), the chosen camera and microphone
// (getUserMedia), and one MediaRecorder per source, all started together. Each recorder notes when it started on the
// page's clock (performance.now()), so the camera and the microphone can be placed on the screen file's clock.
//
// There is no input trace in a browser (no clicks, keys or cursor outside the page), so a browser take has none.
//
// Each track goes to the Studio while it records, in pieces of a few seconds (`live.ts`): a crash or a closed window
// loses only the last seconds (the rest is offered back when the person returns), and Stop has only the last piece
// to send. Where the Studio cannot take a recording while it is made, the take is kept here and uploaded after Stop.
import { uploadFile } from '../ui/client'
import { mediaErrorSentence, plainError } from './errors'
import { LiveTake, fetchApi, type LiveApi, type LiveTrack } from './live'
import { AUDIO_TYPES, VIDEO_TYPES, extensionFor, levelFrom, pickType, sourceOffsets, takeFileName, withAudio } from './media'
import type { DeviceOption, FinishedTake, Recorder, RecorderHandlers, SharedSurface, TakeFile, TakeOptions, TakeRole } from './types'

/** One running MediaRecorder. Its bytes are in the live take's track of the same role. */
type Track = {
  role: TakeRole
  recorder: MediaRecorder
  stream: MediaStream
  type: string
  /** Where its chunks go: its track of the live take. */
  sink: LiveTrack | null
  startedAt: number | null
  stoppedAt: number | null
  stopped: Promise<void>
  width?: number
  height?: number
}

/**
 * Bits per second for a picture of this size: enough for sharp text, capped at 12 Mbit/s so a take of about
 * 20 minutes stays under the Studio's 2 GB upload limit.
 */
export function videoBitrate(width: number, height: number, fps: number): number {
  return Math.round(Math.min(12_000_000, Math.max(2_500_000, width * height * fps * 0.09)))
}

/**
 * A keyframe every two seconds. Chromium's MP4 recorder hands over its bytes a keyframe at a time (a fragment each),
 * and with its own spacing a take could sit unsent for many seconds: what a crash would lose. Browsers that do not
 * know the option (WebKit) ignore it.
 */
const KEYFRAMES = { videoKeyFrameIntervalDuration: 2000 } as MediaRecorderOptions

/** The cameras and microphones the browser lists. Labels are empty until the page was allowed a device once. */
export async function listBrowserDevices(): Promise<{ cameras: DeviceOption[]; microphones: DeviceOption[] }> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return { cameras: [], microphones: [] }
  const all = await navigator.mediaDevices.enumerateDevices()
  const pick = (kind: MediaDeviceKind, noun: string) => {
    const rows = all.filter((device) => device.kind === kind && device.deviceId)
    // "default" and "communications" are Chrome's aliases of a real device: keep the real ones.
    const real = rows.filter((device) => device.deviceId !== 'default' && device.deviceId !== 'communications')
    const fallback = rows.find((device) => device.deviceId === 'default')
    return (real.length ? real : rows).map((device, index) => ({
      id: device.deviceId,
      name: device.label || `${noun} ${index + 1}`,
      isDefault: fallback ? !!fallback.groupId && fallback.groupId === device.groupId : index === 0,
    }))
  }
  return { cameras: pick('videoinput', 'Camera'), microphones: pick('audioinput', 'Microphone') }
}

/** Ask once for the camera and/or microphone so the device list gets its names; answers a sentence when refused. */
export async function unlockDeviceLabels(video: boolean, audio: boolean): Promise<string | null> {
  if (!video && !audio) return null
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video, audio })
    for (const track of stream.getTracks()) track.stop()
    return null
  } catch (error) {
    return mediaErrorSentence(error, video ? 'camera' : 'microphone')
  }
}

/** Open a camera for the dialog's live preview bubble. The caller stops it. */
export async function openCameraPreview(deviceId: string | null): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({ video: cameraConstraints(deviceId), audio: false })
  } catch (error) {
    throw new Error(mediaErrorSentence(error, 'camera') ?? 'The camera could not start.')
  }
}

function cameraConstraints(deviceId: string | null): MediaTrackConstraints {
  return { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }
}

function microphoneConstraints(deviceId: string | null): MediaTrackConstraints {
  // Narration: keep the voice as it is (no gating), but take echo out in case the speakers play the screen's sound.
  return { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: true, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 1 } }
}

const surfaceOf = (track: MediaStreamTrack): SharedSurface['surface'] => {
  const value = (track.getSettings() as { displaySurface?: string }).displaySurface
  return value === 'browser' || value === 'window' || value === 'monitor' ? value : 'unknown'
}

/** Every recorder of a take said it started (or a moment passed). */
function started(tracks: Track[]): Promise<void> {
  const waits = tracks.map((track) => (track.startedAt !== null ? Promise.resolve() : new Promise<void>((resolve) => track.recorder.addEventListener('start', () => resolve(), { once: true }))))
  return Promise.race([Promise.all(waits).then(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, 1500))])
}

/** Seconds after the screen a role started, once both have started. */
function offsetOf(tracks: Track[], role: TakeRole): number | null {
  return sourceOffsets(Object.fromEntries(tracks.map((track) => [track.role, track.startedAt])))[role] ?? null
}

const stopAll = (stream: MediaStream | null | undefined) => {
  for (const track of stream?.getTracks() ?? []) track.stop()
}

export class BrowserRecorder implements Recorder {
  readonly kind = 'browser' as const
  private display: MediaStream | null = null
  private surface: SharedSurface | null = null
  private shareListeners = new Set<(share: SharedSurface | null) => void>()
  private options: TakeOptions | null = null
  private camera: MediaStream | null = null
  private microphone: MediaStream | null = null
  private tracks: Track[] = []
  private handlers: RecorderHandlers | null = null
  private ticker: ReturnType<typeof setInterval> | null = null
  private audio: { context: AudioContext; analyser: AnalyserNode; samples: Uint8Array<ArrayBuffer> } | null = null
  private createdAt = new Date()
  private ending = false
  /** The take on its way to the Studio while it records. */
  private live: LiveTake | null = null
  /** Stopped takes whose last pieces may still be going up, by their session id. */
  private stopped = new Map<string, LiveTake>()

  constructor(private readonly api: LiveApi = fetchApi) {}

  /** What is being shared, if anything. */
  get share(): SharedSurface | null {
    return this.surface
  }

  /** Told when the share changes (chosen, or ended from the browser's own bar). Answers the unsubscribe. */
  onShareChange(listener: (share: SharedSurface | null) => void): () => void {
    this.shareListeners.add(listener)
    return () => this.shareListeners.delete(listener)
  }

  /**
   * Open the browser's picker (call it straight from a click: the browser only opens it for one). Answers what was
   * shared, or null when the person closed the picker. Throws a sentence when the browser refused.
   */
  async chooseShare(withSound: boolean): Promise<SharedSurface | null> {
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('This browser cannot share the screen.')
    // Nothing is awaited before getDisplayMedia: the click that called this must still count as the person's.
    const asked = navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 60, max: 60 }, width: { max: 3840 }, height: { max: 2160 }, cursor: 'always' } as MediaTrackConstraints,
      audio: withSound,
      // Chrome's options: offer other tabs, windows and screens but not this tab; let the person switch tabs mid-take.
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      systemAudio: withSound ? 'include' : 'exclude',
      monitorTypeSurfaces: 'include',
    } as DisplayMediaStreamOptions)
    let stream: MediaStream
    try {
      stream = await asked
    } catch (error) {
      const sentence = mediaErrorSentence(error, 'screen')
      if (sentence === null) return null
      throw new Error(sentence)
    }
    this.releaseShare()
    const video = stream.getVideoTracks()[0]
    if (!video) {
      stopAll(stream)
      throw new Error('The browser shared no picture. Choose a tab, window or screen.')
    }
    try {
      video.contentHint = 'detail'
    } catch {
      // Older browsers lack contentHint: fine.
    }
    const settings = video.getSettings()
    this.display = stream
    this.surface = {
      label: video.label,
      surface: surfaceOf(video),
      hasAudio: stream.getAudioTracks().length > 0,
      width: settings.width ?? null,
      height: settings.height ?? null,
    }
    video.addEventListener('ended', this.onShareEnded)
    this.emitShare()
    return this.surface
  }

  /** Stop sharing (the person chose again, or closed the dialog before recording). */
  clearShare(): void {
    if (this.tracks.length) return
    this.releaseShare()
    this.emitShare()
  }

  private releaseShare() {
    const video = this.display?.getVideoTracks()[0]
    video?.removeEventListener('ended', this.onShareEnded)
    stopAll(this.display)
    this.display = null
    this.surface = null
  }

  private emitShare() {
    for (const listener of this.shareListeners) listener(this.surface)
  }

  private onShareEnded = () => {
    if (this.tracks.length) {
      // Ending the share from the browser's own bar is the person's Stop.
      if (!this.ending) this.handlers?.onEnded({ kind: 'share-ended' })
      return
    }
    this.releaseShare()
    this.emitShare()
  }

  async prepare(options: TakeOptions): Promise<void> {
    if (typeof MediaRecorder === 'undefined') throw new Error(mediaErrorSentence({ name: 'NotSupportedError' }, 'recording')!)
    if (!this.display || !this.display.getVideoTracks()[0] || this.display.getVideoTracks()[0]!.readyState !== 'live')
      throw new Error('Choose what to share first.')
    this.closeDevices()
    this.options = options
    try {
      if (options.microphone) this.microphone = await navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints(options.microphone.deviceId), video: false })
    } catch (error) {
      throw new Error(mediaErrorSentence(error, 'microphone') ?? 'The microphone could not start.')
    }
    try {
      if (options.camera) this.camera = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints(options.camera.deviceId), audio: false })
    } catch (error) {
      this.closeDevices()
      throw new Error(mediaErrorSentence(error, 'camera') ?? 'The camera could not start.')
    }
  }

  async start(handlers: RecorderHandlers): Promise<void> {
    const options = this.options
    const display = this.display
    if (!options || !display) throw new Error('Choose what to share first.')
    const screenVideo = display.getVideoTracks()[0]
    if (!screenVideo || screenVideo.readyState !== 'live') throw new Error('The screen share ended. Choose what to share again.')
    this.handlers = handlers
    this.ending = false
    this.createdAt = new Date()
    const supported = (type: string) => MediaRecorder.isTypeSupported(type)
    const videoType = pickType(VIDEO_TYPES, supported)
    const screenSound = options.systemAudio ? display.getAudioTracks() : []
    const screenStream = new MediaStream([screenVideo, ...screenSound])
    const screenSettings = screenVideo.getSettings()
    const width = screenSettings.width ?? 1920
    const height = screenSettings.height ?? 1080
    try {
      this.tracks.push(this.track('screen', screenStream, screenSound.length ? withAudio(videoType, supported) : videoType, {
        videoBitsPerSecond: videoBitrate(width, height, Math.min(60, screenSettings.frameRate ?? 30)),
        ...KEYFRAMES,
        ...(screenSound.length ? { audioBitsPerSecond: 160_000 } : {}),
      }, width, height))
      const cameraVideo = this.camera?.getVideoTracks()[0]
      if (cameraVideo) {
        const cam = cameraVideo.getSettings()
        this.tracks.push(this.track('camera', new MediaStream([cameraVideo]), videoType, {
          videoBitsPerSecond: videoBitrate(cam.width ?? 1280, cam.height ?? 720, cam.frameRate ?? 30),
          ...KEYFRAMES,
        }, cam.width, cam.height))
      }
      const micAudio = this.microphone?.getAudioTracks()[0]
      if (micAudio) {
        this.tracks.push(this.track('microphone', new MediaStream([micAudio]), pickType(AUDIO_TYPES, supported), { audioBitsPerSecond: 160_000 }))
        this.meter(this.microphone!)
      }
    } catch (error) {
      this.abort()
      throw new Error(mediaErrorSentence(error, 'recording') ?? plainError(error))
    }
    // This take's recorders: kept here, as the pieces may still go up after the recorder has moved on.
    const tracks = this.tracks
    const live = new LiveTake(tracks.map((track) => track.role), {
      api: this.api,
      now: () => performance.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      offset: (role) => offsetOf(tracks, role),
      // The Studio refused the rest (no space left, the take finished elsewhere): what reached it is kept, and the take stops.
      onFailed: (message) => {
        if (!this.ending) this.handlers?.onEnded({ kind: 'error', message: `The recording stopped: ${message.replace(/\.$/, '')}. What was saved before that is kept.` })
      },
      onChange: () => undefined,
    })
    this.live = live
    for (const track of this.tracks) track.sink = live.tracks.get(track.role) ?? null
    // All together, in one tick, chunked every second.
    for (const track of this.tracks) track.recorder.start(1000)
    this.ticker = setInterval(() => this.tick(), 250)
    // The take is made on the Studio once the recorders say what they record into (their file names); pieces wait here meanwhile.
    const createdAt = this.createdAt
    void started(tracks).then(() => live.open('browser', Object.fromEntries(tracks.map((track) => [track.role, takeFileName(track.role, extensionFor(track.type), createdAt)]))))
  }

  /** One MediaRecorder for one source, noting when it really started. */
  private track(role: TakeRole, stream: MediaStream, type: string | null, options: MediaRecorderOptions, width?: number, height?: number): Track {
    const recorder = new MediaRecorder(stream, { ...options, ...(type ? { mimeType: type } : {}) })
    const track: Track = { role, recorder, stream, type: recorder.mimeType || type || (role === 'microphone' ? 'audio/webm' : 'video/webm'), sink: null, startedAt: null, stoppedAt: null, stopped: Promise.resolve(), width, height }
    track.stopped = new Promise<void>((resolve) => {
      recorder.addEventListener('stop', () => {
        track.stoppedAt = performance.now()
        resolve()
      })
    })
    recorder.addEventListener('start', () => {
      track.startedAt = performance.now()
      if (recorder.mimeType) track.type = recorder.mimeType
    })
    recorder.addEventListener('dataavailable', (event) => {
      if (!event.data.size) return
      const started = track.startedAt ?? performance.now()
      track.sink?.push(event.data, Math.max(0, (performance.now() - started) / 1000))
    })
    recorder.addEventListener('error', (event) => {
      const cause = (event as Event & { error?: unknown }).error
      if (!this.ending) this.handlers?.onEnded({ kind: 'error', message: mediaErrorSentence(cause, 'recording') ?? 'The recording stopped unexpectedly.' })
    })
    return track
  }

  /** A level meter on the microphone. */
  private meter(stream: MediaStream) {
    try {
      const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Context) return
      const context = new Context()
      const analyser = context.createAnalyser()
      analyser.fftSize = 1024
      context.createMediaStreamSource(stream).connect(analyser)
      this.audio = { context, analyser, samples: new Uint8Array(new ArrayBuffer(analyser.fftSize)) }
    } catch {
      this.audio = null
    }
  }

  private tick() {
    const screen = this.tracks.find((track) => track.role === 'screen')
    const startedAt = screen?.startedAt
    let level: number | null = null
    if (this.audio) {
      this.audio.analyser.getByteTimeDomainData(this.audio.samples)
      level = levelFrom(this.audio.samples)
    }
    this.handlers?.onStatus({ elapsedMs: startedAt === null || startedAt === undefined ? 0 : performance.now() - startedAt, level, ...(this.live ? { tracks: this.live.status() } : {}) })
  }

  async stop(): Promise<FinishedTake> {
    if (!this.tracks.length) throw new Error('Nothing is recording.')
    this.ending = true
    this.stopTicker()
    for (const track of this.tracks) {
      if (track.recorder.state !== 'inactive') {
        try {
          track.recorder.stop()
        } catch {
          // Already stopping.
        }
      }
    }
    // A recorder whose stream died may never say it stopped: wait a few seconds at most.
    await Promise.race([Promise.all(this.tracks.map((track) => track.stopped)), new Promise((resolve) => setTimeout(resolve, 5000))])
    // The last chunk arrives with the stop: give it a moment to reach its track.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const tracks = this.tracks
    const live = this.live!
    this.tracks = []
    this.live = null
    this.releaseAll()
    const screen = tracks.find((track) => track.role === 'screen')
    if (!screen || !live.tracks.get('screen')?.recordedBytes) {
      void live.discard()
      throw new Error('The screen recording came out empty. Try again.')
    }
    // Whether the Studio took the take while it recorded (it says within seconds of the start).
    const onServer = await live.ready
    const offsets = sourceOffsets(Object.fromEntries(tracks.map((track) => [track.role, track.startedAt])))
    const files: TakeFile[] = []
    for (const track of tracks) {
      const pieces = live.tracks.get(track.role)
      if (!pieces?.recordedBytes) continue
      const type = track.type.split(';')[0]!.trim() || 'video/webm'
      const started = track.startedAt ?? screen.startedAt ?? 0
      const ended = track.stoppedAt ?? performance.now()
      const kept = pieces.state === 'local' ? pieces.localBlob(type) : null
      files.push({
        role: track.role,
        name: takeFileName(track.role, extensionFor(track.type), this.createdAt),
        contentType: type,
        bytes: kept?.size ?? pieces.recordedBytes,
        offsetSeconds: offsets[track.role] ?? 0,
        durationSeconds: Math.max(0, (ended - started) / 1000),
        ...(track.width ? { width: track.width } : {}),
        ...(track.height ? { height: track.height } : {}),
        ...(kept ? { blob: kept } : pieces.key ? { uploadKey: pieces.key } : {}),
      })
    }
    const screenFile = files.find((file) => file.role === 'screen')!
    const sessionId = onServer && live.id ? live.id : crypto.randomUUID()
    this.stopped.set(sessionId, live)
    return {
      kind: 'browser',
      sessionId,
      files,
      trace: null,
      sourceCursorHidden: false,
      transcript: null,
      durationSeconds: screenFile.durationSeconds ?? 0,
      ...(onServer && live.id ? { liveTakeId: live.id } : {}),
    }
  }

  async cancel(): Promise<void> {
    this.ending = true
    // Thrown away: the pieces already on the Studio go too.
    const live = this.live
    this.abort()
    if (live) await live.discard()
  }

  private abort() {
    this.stopTicker()
    for (const track of this.tracks) {
      try {
        if (track.recorder.state !== 'inactive') track.recorder.stop()
      } catch {
        // Already stopped.
      }
    }
    // Stopped without Stop (the dialog closed mid-take): once the recorders hand over their last chunks, what each
    // track gathered goes up too, while the page lives. The take is offered back from the Studio later.
    const live = this.live
    const stopped = this.tracks.map((track) => track.stopped)
    if (live) void Promise.race([Promise.all(stopped), new Promise((resolve) => setTimeout(resolve, 5000))]).then(() => live.flush())
    this.tracks = []
    this.live = null
    this.releaseAll()
  }

  /**
   * A track uploaded while it recorded: wait for its last pieces (the fraction is of its bytes on the Studio) and
   * answer its key, noting on the file how many pieces make it. Otherwise the old way: the whole file, after Stop.
   */
  async upload(take: FinishedTake, file: TakeFile, onProgress: (fraction: number) => void): Promise<string> {
    const track = file.uploadKey ? this.stopped.get(take.sessionId)?.tracks.get(file.role) : undefined
    if (file.uploadKey && track) {
      const done = await track.finish(onProgress)
      file.pieces = done.pieces
      if (!done.complete) file.partial = true
      if (!done.complete) take.note = `The end of the ${track.label.toLowerCase()} recording could not be saved: ${track.error ?? 'the Studio refused it'}`.slice(0, 300)
      return done.key
    }
    if (file.uploadKey) throw new Error(`The ${file.role} recording is no longer here to upload.`)
    if (!file.blob) throw new Error(`The ${file.role} recording is no longer here to upload.`)
    return uploadFile(file.blob, file.name, onProgress)
  }

  async discard(take: FinishedTake): Promise<void> {
    for (const file of take.files) delete file.blob
    const live = this.stopped.get(take.sessionId)
    this.stopped.delete(take.sessionId)
    // A take that became a recording is the Studio's to clean up (it answers that it is busy); one thrown away goes now.
    if (live) await live.discard()
  }

  /** Let go of the devices. A take still recording is not thrown away: what reached the Studio is offered back later. */
  dispose(): void {
    this.ending = true
    this.abort()
    this.shareListeners.clear()
  }

  private stopTicker() {
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
  }

  /** Stop the camera, the microphone, the meter and the share (after a take, or on cancel). */
  private releaseAll() {
    this.closeDevices()
    this.handlers = null
    this.releaseShare()
    this.emitShare()
  }

  private closeDevices() {
    stopAll(this.camera)
    stopAll(this.microphone)
    this.camera = null
    this.microphone = null
    if (this.audio) void this.audio.context.close().catch(() => {})
    this.audio = null
  }
}
