// The browser recorder: the browser's own screen-share picker (getDisplayMedia), the chosen camera and microphone
// (getUserMedia), and one MediaRecorder per source, all started together. Each recorder notes when it started on the
// page's clock (performance.now()), so the camera and the microphone can be placed on the screen file's clock.
//
// There is no input trace in a browser (no clicks, keys or cursor outside the page), so a browser take has none.
import { uploadFile } from '../ui/client'
import { mediaErrorSentence, plainError } from './errors'
import { AUDIO_TYPES, VIDEO_TYPES, extensionFor, levelFrom, pickType, sourceOffsets, takeFileName, withAudio } from './media'
import type { DeviceOption, FinishedTake, Recorder, RecorderHandlers, SharedSurface, TakeFile, TakeOptions, TakeRole } from './types'

/** One running MediaRecorder and what it has recorded. */
type Track = {
  role: TakeRole
  recorder: MediaRecorder
  stream: MediaStream
  chunks: Blob[]
  type: string
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
        ...(screenSound.length ? { audioBitsPerSecond: 160_000 } : {}),
      }, width, height))
      const cameraVideo = this.camera?.getVideoTracks()[0]
      if (cameraVideo) {
        const cam = cameraVideo.getSettings()
        this.tracks.push(this.track('camera', new MediaStream([cameraVideo]), videoType, {
          videoBitsPerSecond: videoBitrate(cam.width ?? 1280, cam.height ?? 720, cam.frameRate ?? 30),
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
    // All together, in one tick, chunked every second.
    for (const track of this.tracks) track.recorder.start(1000)
    this.ticker = setInterval(() => this.tick(), 250)
  }

  /** One MediaRecorder for one source, noting when it really started. */
  private track(role: TakeRole, stream: MediaStream, type: string | null, options: MediaRecorderOptions, width?: number, height?: number): Track {
    const recorder = new MediaRecorder(stream, { ...options, ...(type ? { mimeType: type } : {}) })
    const track: Track = { role, recorder, stream, chunks: [], type: recorder.mimeType || type || (role === 'microphone' ? 'audio/webm' : 'video/webm'), startedAt: null, stoppedAt: null, stopped: Promise.resolve(), width, height }
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
      if (event.data.size) track.chunks.push(event.data)
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
    this.handlers?.onStatus({ elapsedMs: startedAt === null || startedAt === undefined ? 0 : performance.now() - startedAt, level })
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
    const tracks = this.tracks
    this.tracks = []
    this.releaseAll()
    const screen = tracks.find((track) => track.role === 'screen')
    if (!screen || !screen.chunks.length) throw new Error('The screen recording came out empty. Try again.')
    const offsets = sourceOffsets(Object.fromEntries(tracks.map((track) => [track.role, track.startedAt])))
    const files: TakeFile[] = []
    for (const track of tracks) {
      if (!track.chunks.length) continue
      const type = track.type.split(';')[0]!.trim() || 'video/webm'
      const blob = new Blob(track.chunks, { type })
      const started = track.startedAt ?? screen.startedAt ?? 0
      const ended = track.stoppedAt ?? performance.now()
      files.push({
        role: track.role,
        name: takeFileName(track.role, extensionFor(track.type), this.createdAt),
        contentType: type,
        bytes: blob.size,
        offsetSeconds: offsets[track.role] ?? 0,
        durationSeconds: Math.max(0, (ended - started) / 1000),
        ...(track.width ? { width: track.width } : {}),
        ...(track.height ? { height: track.height } : {}),
        blob,
      })
    }
    const screenFile = files.find((file) => file.role === 'screen')!
    return {
      kind: 'browser',
      sessionId: crypto.randomUUID(),
      files,
      trace: null,
      sourceCursorHidden: false,
      transcript: null,
      durationSeconds: screenFile.durationSeconds ?? 0,
    }
  }

  async cancel(): Promise<void> {
    this.ending = true
    this.abort()
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
    this.tracks = []
    this.releaseAll()
  }

  async upload(_take: FinishedTake, file: TakeFile, onProgress: (fraction: number) => void): Promise<string> {
    if (!file.blob) throw new Error(`The ${file.role} recording is no longer here to upload.`)
    return uploadFile(file.blob, file.name, onProgress)
  }

  async discard(take: FinishedTake): Promise<void> {
    for (const file of take.files) delete file.blob
  }

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
