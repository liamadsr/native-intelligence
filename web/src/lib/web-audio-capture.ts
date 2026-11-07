/**
 * Browser microphone capture for web captures.
 *
 * Mirrors the desktop app's audio input path (mic_capture.rs + session.rs) so the
 * downstream pipeline (DeepgramStreamingService, Voice ID, transcript merge) sees
 * the SAME 16 kHz mono linear16 PCM regardless of source. The conversion math is
 * intentionally identical to the Rust side:
 *   1. downmix to mono (average channels)
 *   2. linear-interpolation downsample native rate → 16 kHz
 *   3. clamp(-1, 1) × 32767 → i16 little-endian
 *
 * Web is MIC-ONLY: there is no browser equivalent of the desktop's system-audio
 * tap, so we never produce a "system" stream here. The Capture UI surfaces that
 * limitation and points the user at the desktop app for full meeting capture.
 *
 * The AudioWorklet processor runs off the main thread, so it keeps producing PCM
 * even when the tab is backgrounded/occluded (unlike setInterval-driven capture,
 * which the browser throttles — the web analogue of the desktop occlusion issue).
 */

/** Deepgram wants 16 kHz mono linear16 — same target as the desktop pipeline. */
const TARGET_SAMPLE_RATE = 16000

/**
 * AudioWorklet processor source. Authored as a string and loaded via a blob URL
 * so there's no separate static asset to wire through Next.js / CSP. It receives
 * the raw float frames on the audio thread, downsamples + converts to int16, and
 * posts the PCM bytes (plus an RMS level) back to the main thread.
 *
 * Note: the worklet's own sampleRate global is the AudioContext rate (typically
 * 48000 in Chromium). We pass the target rate in via processorOptions.
 */
const WORKLET_SOURCE = /* js */ `
class PcmDownsamplerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const opts = (options && options.processorOptions) || {}
    this.targetRate = opts.targetRate || 16000
    // sampleRate is a global available inside AudioWorkletGlobalScope.
    this.ratio = sampleRate / this.targetRate
    // Carry the fractional read position across process() calls so resampling
    // doesn't restart every 128-frame render quantum (which would warp pitch).
    this.readPos = 0
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true

    // Downmix to mono by averaging channels (matches desktop downmix_to_mono).
    const channelCount = input.length
    const frameCount = input[0].length
    if (frameCount === 0) return true

    const mono = new Float32Array(frameCount)
    for (let c = 0; c < channelCount; c++) {
      const ch = input[c]
      for (let i = 0; i < frameCount; i++) mono[i] += ch[i]
    }
    if (channelCount > 1) {
      for (let i = 0; i < frameCount; i++) mono[i] /= channelCount
    }

    // Linear-interpolation downsample (matches desktop downsample()). readPos is
    // relative to this block; once it runs past the block we keep the remainder
    // for the next block so the stream stays phase-continuous.
    const ratio = this.ratio
    const out = []
    let pos = this.readPos
    while (pos < frameCount) {
      const idx = Math.floor(pos)
      const frac = pos - idx
      let sample
      if (idx + 1 < frameCount) {
        sample = mono[idx] * (1 - frac) + mono[idx + 1] * frac
      } else {
        sample = mono[idx]
      }
      out.push(sample)
      pos += ratio
    }
    // Carry the overshoot into the next block.
    this.readPos = pos - frameCount

    if (out.length === 0) return true

    // RMS level for the visualizer (computed on the downsampled mono signal,
    // same as the desktop level calc).
    let sumSq = 0
    for (let i = 0; i < out.length; i++) sumSq += out[i] * out[i]
    const rms = Math.sqrt(sumSq / out.length)

    // f32 → i16 little-endian (matches f32_to_linear16_bytes).
    const pcm = new Int16Array(out.length)
    for (let i = 0; i < out.length; i++) {
      let s = out[i]
      if (s > 1) s = 1
      else if (s < -1) s = -1
      pcm[i] = (s * 32767) | 0
    }

    // Transfer the underlying buffer to avoid a copy.
    this.port.postMessage({ pcm: pcm.buffer, level: rms }, [pcm.buffer])
    return true
  }
}

registerProcessor('pcm-downsampler', PcmDownsamplerProcessor)
`

export interface WebAudioCaptureOptions {
  /** Specific input device id (from enumerateDevices). Omit for the OS default. */
  deviceId?: string
}

/**
 * Classified reason a web capture couldn't start. Lets the UI show a helpful
 * dialog ("grant mic access") instead of a raw, cryptic error string.
 * - `permission-denied` — user dismissed/blocked the mic prompt, or the browser
 *   has a standing block for this origin. Most common.
 * - `no-device`         — no microphone is connected.
 * - `in-use`            — the mic is held by another app and can't be opened.
 * - `insecure-context`  — not HTTPS/localhost, so getUserMedia is unavailable.
 * - `unsupported`       — the browser lacks getUserMedia / AudioWorklet.
 * - `unknown`           — anything else (carries the original message).
 */
export type WebAudioCaptureErrorKind =
  | 'permission-denied'
  | 'no-device'
  | 'in-use'
  | 'insecure-context'
  | 'unsupported'
  | 'unknown'

export class WebAudioCaptureError extends Error {
  readonly kind: WebAudioCaptureErrorKind
  constructor(kind: WebAudioCaptureErrorKind, message: string) {
    super(message)
    this.name = 'WebAudioCaptureError'
    this.kind = kind
  }
}

/**
 * Map a getUserMedia rejection (a DOMException with a standardized `name`) to
 * our classified error. Names per the Media Capture spec / MDN.
 */
function classifyGetUserMediaError(err: unknown): WebAudioCaptureError {
  const name = (err as { name?: string })?.name
  const message = err instanceof Error ? err.message : String(err)
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      // Permission denied by the user or a permissions-policy block.
      return new WebAudioCaptureError('permission-denied', message)
    case 'NotFoundError':
    case 'OverconstrainedError':
      // No device matched (none connected, or the requested deviceId is gone).
      return new WebAudioCaptureError('no-device', message)
    case 'NotReadableError':
    case 'AbortError':
      // OS/hardware error — typically the mic is held by another app.
      return new WebAudioCaptureError('in-use', message)
    default:
      return new WebAudioCaptureError('unknown', message)
  }
}

/**
 * Captures the microphone in the browser and emits 16 kHz mono linear16 PCM
 * chunks (Uint8Array) plus periodic RMS levels (0..1). Web is mic-only — there
 * is no system-audio stream.
 */
export class WebAudioCapture {
  private stream: MediaStream | null = null
  private audioContext: AudioContext | null = null
  private sourceNode: MediaStreamAudioSourceNode | null = null
  private workletNode: AudioWorkletNode | null = null
  private workletUrl: string | null = null
  private running = false
  /** Timestamp (performance.now) of the last onLevel fan-out — used to throttle
   *  level delivery to ~10 Hz (see the worklet message handler). */
  private lastLevelEmit = 0

  /** Fired with each PCM chunk (16 kHz mono linear16). */
  onPcm: ((bytes: Uint8Array) => void) | null = null
  /** Fired with the latest mic RMS level (0..1). */
  onLevel: ((level: number) => void) | null = null

  /**
   * Request mic permission and start capturing. Resolves once audio is flowing.
   * Throws if permission is denied or the browser lacks the required APIs — the
   * caller surfaces this to the user.
   */
  async start(options: WebAudioCaptureOptions = {}): Promise<void> {
    if (this.running) return
    // Fresh throttle window per capture so the first level fires immediately.
    this.lastLevelEmit = 0

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      // getUserMedia is gated behind a secure context — distinguish "this page
      // isn't HTTPS" from "this browser is just too old" so the UI can advise.
      const insecure = typeof window !== 'undefined' && window.isSecureContext === false
      throw new WebAudioCaptureError(
        insecure ? 'insecure-context' : 'unsupported',
        insecure
          ? 'Microphone capture requires a secure (HTTPS) connection.'
          : 'Microphone capture is not supported in this browser.',
      )
    }

    // getUserMedia with the standard conferencing DSP flags. echoCancellation /
    // noiseSuppression / autoGainControl are what conferencing apps use; for a
    // single-mic notetaker they clean up the user's own voice.
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: options.deviceId ? { exact: options.deviceId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        video: false,
      })
    } catch (err) {
      // Classify the failure (permission denied / no device / in use / …) so the
      // caller can show a helpful dialog instead of a raw DOMException string.
      throw classifyGetUserMediaError(err)
    }

    // Everything after getUserMedia can still throw (resume, addModule on a
    // blocked blob URL, the worklet node). The caller only keeps this capture
    // once start() resolves, so a failure here must release the open mic, the
    // AudioContext and the blob URL itself, or the mic indicator stays on.
    try {
      // The AudioContext runs at the hardware rate (usually 48 kHz). We do NOT
      // request 16 kHz here — Chromium ignores it and forcing it can fail; instead
      // the worklet resamples to the target rate.
      this.audioContext = new AudioContext()
      // A user gesture started the recording, but resume() defensively unsuspends.
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume()
      }

      // Load the worklet from a blob URL (no separate static asset to ship).
      const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' })
      this.workletUrl = URL.createObjectURL(blob)
      await this.audioContext.audioWorklet.addModule(this.workletUrl)

      this.sourceNode = this.audioContext.createMediaStreamSource(this.stream)
      this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-downsampler', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        processorOptions: { targetRate: TARGET_SAMPLE_RATE },
      })

      this.workletNode.port.onmessage = (event) => {
        const data = event.data as { pcm: ArrayBuffer; level: number }
        // PCM delivery is untouched — every chunk flows to Deepgram as before.
        if (data.pcm && this.onPcm) {
          this.onPcm(new Uint8Array(data.pcm))
        }
        // Throttle the level fan-out to ~10 Hz (matching the desktop tap's cadence).
        // The worklet posts one message per render quantum (~every 2.7ms at 48 kHz),
        // and each drives a visualizer update; unthrottled that's ~370 level events
        // per second. A last-emit timestamp gate keeps the LATEST level and drops
        // the in-between ones — smooth enough for the waveform, far fewer updates.
        if (this.onLevel) {
          const now = performance.now()
          if (now - this.lastLevelEmit >= 100) {
            this.lastLevelEmit = now
            this.onLevel(data.level)
          }
        }
      }

      // Source → worklet. The worklet has no outputs (numberOfOutputs: 0), so we
      // do NOT connect it to the destination — we don't want to play the mic back
      // through the speakers.
      this.sourceNode.connect(this.workletNode)
    } catch (err) {
      this.stop()
      throw err
    }

    this.running = true
  }

  /** Stop capture and release the mic + audio graph. Idempotent. */
  stop(): void {
    this.running = false

    if (this.workletNode) {
      this.workletNode.port.onmessage = null
      try { this.workletNode.disconnect() } catch { /* already gone */ }
      this.workletNode = null
    }
    if (this.sourceNode) {
      try { this.sourceNode.disconnect() } catch { /* already gone */ }
      this.sourceNode = null
    }
    if (this.audioContext) {
      // close() releases the audio HW; ignore the returned promise.
      void this.audioContext.close().catch(() => {})
      this.audioContext = null
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop()
      this.stream = null
    }
    if (this.workletUrl) {
      URL.revokeObjectURL(this.workletUrl)
      this.workletUrl = null
    }

    this.onPcm = null
    this.onLevel = null
  }

  get isRunning(): boolean {
    return this.running
  }

  /** The deviceId of the open mic track (what getUserMedia actually picked),
   *  or undefined when stopped or the browser doesn't report it. */
  get deviceId(): string | undefined {
    if (!this.running) return undefined
    const track = this.stream?.getAudioTracks()[0]
    return track?.getSettings?.().deviceId || undefined
  }
}
