/**
 * One microphone to Deepgram's streaming API, and its final words back, each
 * with the moment it was said (./clock.ts).
 *
 *   - Finals only (interim results off), endpointing as the person's own app
 *     (web/src/lib/deepgram-stream.ts); no diarization: one track is one
 *     known speaker.
 *   - A socket that drops is opened again with backoff; the audio it had not
 *     finished hearing (since its last final, up to MAX_BUFFER_MS) is sent
 *     again on the new one, so nothing said while it was down is lost and
 *     nothing heard twice.
 *   - Nothing is sent while the microphone is muted: `pause` asks Deepgram to
 *     finish what it heard (Finalize), and KeepAlive holds the socket open
 *     until there is audio again.
 *   - `close` asks for the last words (CloseStream) and waits for them.
 *
 * The key goes as the socket's subprotocol, never in a URL or a log.
 */
import { AudioClock } from './clock.ts'
import { backoffMs } from './backoff.ts'

/** What a socket is to this file (the global WebSocket, or a test's). */
export interface SocketLike {
  readonly readyState: number
  binaryType: string
  send(data: string | ArrayBufferLike | ArrayBufferView): void
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
}

export type SocketFactory = (url: string, protocols: string[]) => SocketLike

const OPEN = 1

/** One final stretch of speech, with when it was said. */
export interface Heard {
  text: string
  startWallMs: number
  endWallMs: number
}

/** The audio that may wait for a socket (and be sent again on a new one). */
export const MAX_BUFFER_MS = 30_000
/** Deepgram closes a socket after about 10 s without audio. */
export const KEEPALIVE_MS = 4_000

interface Chunk {
  pcm: Int16Array
  wallMs: number
  durationMs: number
}

/**
 * A Deepgram live message's final result: its words (empty for a stretch of
 * silence, which still says that audio is heard) and its place in the
 * socket's audio (seconds), or null for anything else. Pure.
 */
export function finalOf(data: unknown): { text: string; start: number; end: number } | null {
  let msg: unknown = data
  if (typeof data === 'string') {
    try {
      msg = JSON.parse(data)
    } catch {
      return null
    }
  }
  const m = msg as {
    type?: unknown
    is_final?: unknown
    start?: unknown
    duration?: unknown
    channel?: { alternatives?: Array<{ transcript?: unknown; words?: Array<{ start?: unknown; end?: unknown }> }> }
  } | null
  if (!m || m.type !== 'Results' || m.is_final !== true) return null
  const alt = m.channel?.alternatives?.[0]
  const text = typeof alt?.transcript === 'string' ? alt.transcript.trim() : ''
  const words = Array.isArray(alt?.words) ? alt!.words.filter((w) => typeof w.start === 'number' && typeof w.end === 'number') : []
  const start = words.length > 0 ? (words[0].start as number) : typeof m.start === 'number' ? m.start : 0
  const end = words.length > 0 ? (words[words.length - 1].end as number) : start + (typeof m.duration === 'number' ? m.duration : 0)
  return { text, start, end: Math.max(start, end) }
}

export class DeepgramStream {
  private socket: SocketLike | null = null
  private clock = new AudioClock()
  private readonly buffer: Chunk[] = []
  private lastHeardWallMs = 0
  private lastSentAt = 0
  private attempts = 0
  private closing = false
  private closed = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private keepAlive: ReturnType<typeof setInterval> | null = null
  private closeWaiter: (() => void) | null = null
  private readonly url: string
  private readonly key: string
  private readonly onHeard: (heard: Heard) => void
  private readonly onState: (state: 'open' | 'down') => void
  private readonly factory: SocketFactory
  private readonly now: () => number

  constructor(opts: {
    url: string
    key: string
    onHeard: (heard: Heard) => void
    onState?: (state: 'open' | 'down') => void
    socket?: SocketFactory
    now?: () => number
  }) {
    this.url = opts.url
    this.key = opts.key
    this.onHeard = opts.onHeard
    this.onState = opts.onState ?? (() => undefined)
    this.factory = opts.socket ?? ((url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike)
    this.now = opts.now ?? Date.now
    this.open()
    this.keepAlive = setInterval(() => this.tickKeepAlive(), KEEPALIVE_MS)
  }

  /** Audio heard at `wallMs`: sent now, or held for the socket. */
  write(pcm: Int16Array, wallMs: number, durationMs: number): void {
    if (this.closing) return
    this.buffer.push({ pcm, wallMs, durationMs })
    this.trimBuffer()
    if (this.socket?.readyState === OPEN) this.sendChunk({ pcm, wallMs, durationMs })
  }

  /** The microphone went quiet (muted): Deepgram says what it heard so far now. */
  pause(): void {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify({ type: 'Finalize' }))
  }

  /** The last words, then the socket closes. Resolves once Deepgram closed it, or after `timeoutMs`. */
  close(timeoutMs = 4_000): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.closing = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.keepAlive) clearInterval(this.keepAlive)
    const socket = this.socket
    if (!socket || socket.readyState !== OPEN) {
      this.finish()
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          socket.close(1000, 'done')
        } catch {
          // gone already
        }
        this.finish()
        resolve()
      }, timeoutMs)
      this.closeWaiter = () => {
        clearTimeout(t)
        resolve()
      }
      socket.send(JSON.stringify({ type: 'CloseStream' }))
    })
  }

  /** The audio waiting for a socket (or to be heard), in ms: a test's look. */
  get bufferedMs(): number {
    return this.buffer.reduce((n, c) => n + c.durationMs, 0)
  }

  private finish(): void {
    this.closed = true
    this.closing = true
    if (this.keepAlive) clearInterval(this.keepAlive)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    const s = this.socket
    this.socket = null
    if (s) {
      s.onopen = s.onmessage = s.onclose = s.onerror = null
    }
    this.closeWaiter?.()
    this.closeWaiter = null
  }

  private open(): void {
    const socket = this.factory(this.url, ['token', this.key])
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    socket.onopen = () => {
      if (this.socket !== socket) return
      this.attempts = 0
      // A new socket counts its audio from nothing: what it had not heard is sent again, at the times it was said.
      this.clock = new AudioClock()
      for (const c of this.buffer) if (c.wallMs + c.durationMs > this.lastHeardWallMs) this.sendChunk(c)
      this.onState('open')
    }
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return
      const f = finalOf(typeof ev.data === 'string' ? ev.data : null)
      if (!f) return
      const start = this.clock.wallAt(f.start * 1000)
      const end = this.clock.wallAt(f.end * 1000)
      if (start === null || end === null) return
      this.lastHeardWallMs = Math.max(this.lastHeardWallMs, end)
      this.clock.forgetBefore(f.end * 1000)
      this.trimBuffer()
      if (f.text) this.onHeard({ text: f.text, startWallMs: start, endWallMs: Math.max(start, end) })
    }
    socket.onerror = () => undefined
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = null
      if (this.closing) {
        this.finish()
        return
      }
      this.onState('down')
      const wait = backoffMs(this.attempts++, { baseMs: 500, maxMs: 10_000 })
      this.reconnectTimer = setTimeout(() => this.open(), wait)
    }
  }

  private sendChunk(c: Chunk): void {
    const s = this.socket
    if (!s || s.readyState !== OPEN) return
    s.send(new Uint8Array(c.pcm.buffer, c.pcm.byteOffset, c.pcm.byteLength))
    this.clock.sent(c.wallMs, c.durationMs)
    this.lastSentAt = this.now()
  }

  /** Keep what Deepgram has not heard yet, no more than MAX_BUFFER_MS of it. */
  private trimBuffer(): void {
    while (this.buffer.length > 0 && this.buffer[0].wallMs + this.buffer[0].durationMs <= this.lastHeardWallMs) this.buffer.shift()
    let total = this.bufferedMs
    while (this.buffer.length > 0 && total > MAX_BUFFER_MS) total -= this.buffer.shift()!.durationMs
  }

  private tickKeepAlive(): void {
    const s = this.socket
    if (!s || s.readyState !== OPEN) return
    if (this.now() - this.lastSentAt >= KEEPALIVE_MS) s.send(JSON.stringify({ type: 'KeepAlive' }))
  }
}
