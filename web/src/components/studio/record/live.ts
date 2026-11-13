// A take uploaded while it records. Each MediaRecorder hands over a chunk every second; a track gathers them into
// pieces of about PIECE_SECONDS (or PIECE_TARGET_BYTES, whichever comes first) and sends each one to storage as soon as
// it is cut, one after the other, through a link the Studio signs for that piece (POST /live-takes/:id/pieces). So a
// crash or a closed window loses only the last few seconds, and Stop has only the last piece left to send.
//
// Joined in order, the pieces are byte for byte what the recorder wrote: WebM from Chromium, fragmented MP4 from
// WebKit. A piece stays on this device until storage has it; while the connection is down the pieces wait and go up
// when it is back. When the Studio cannot take the recording at all (an older server, too many recordings at once),
// every piece stays here and the take uploads after Stop, as it always did. When it refuses the rest of a take (no
// space left, the take was finished elsewhere), what reached it is kept and the recording stops.
//
// No UI here. The server's side is src/lib/studio/server/live-takes.ts.
import { STUDIO_API } from '../studio-env'
import type { LiveTrackState, LiveTrackStatus, TakeRole } from './types'

/** About how long a piece is: what a crash can lose, at most, beyond what is still going up. */
export const PIECE_SECONDS = 4
/** A piece is cut early once it holds this much (a sharp screen at 12 Mbit/s makes about 6 MB in 4 s). */
export const PIECE_TARGET_BYTES = 8 * 1024 ** 2
/**
 * The least a piece but the last may hold (the Studio refuses less). A silent microphone makes about 2 KB in four
 * seconds: a piece is not cut below this however long it took to gather; the last piece, at Stop, may be any size.
 */
export const PIECE_MIN_BYTES = 1024
/** The longest piece the Studio takes. */
export const PIECE_MAX_BYTES = 16 * 1024 ** 2
/** After Stop, how long the last pieces may keep failing before the take is handed back to be tried again. */
export const GIVE_UP_AFTER_STOP_MS = 120_000

/** The server's name for a role. */
export type ServerRole = 'screen' | 'camera' | 'microphone' | 'systemAudio'
export const serverRole = (role: TakeRole): ServerRole => (role === 'system-audio' ? 'systemAudio' : role)

const LABELS: Record<TakeRole, string> = { screen: 'Screen', camera: 'Camera', microphone: 'Microphone', 'system-audio': 'System sound' }

/** What the Studio (or storage) answered when it did not take a request. Status 0: no answer at all. */
export class LiveError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
    this.name = 'LiveError'
  }
  /** Worth trying again: no answer, a timeout, too many at once, the server's own failure, or someone else's write first. */
  get transient(): boolean {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500 || this.code === 'BUSY'
  }
}

/** The calls a live take makes. Tests pass their own. */
export type LiveApi = {
  get<T>(path: string): Promise<T>
  post<T>(path: string, body: unknown): Promise<T>
  remove(path: string): Promise<void>
  put(url: string, headers: Record<string, string>, body: Blob): Promise<void>
}

async function answer<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown }
  if (!response.ok) throw new LiveError(typeof data.error === 'string' ? data.error : `The Studio answered ${response.status}.`, response.status, typeof data.code === 'string' ? data.code : undefined)
  return data as T
}

const unreachable = () => new LiveError('The Studio could not be reached.', 0)
/** How long a call to the Studio, and one piece's upload, may take before it counts as a dropped connection. */
const CALL_MS = 20_000
const PUT_MS = 120_000

/** The live take's calls over fetch: the app's own session, JSON in and out; a piece straight to its signed link. */
export const fetchApi: LiveApi = {
  async get<T>(path: string) {
    const response = await fetch(path, { signal: AbortSignal.timeout(CALL_MS) }).catch(() => null)
    if (!response) throw unreachable()
    return answer<T>(response)
  },
  async post<T>(path: string, body: unknown) {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(CALL_MS) }).catch(() => null)
    if (!response) throw unreachable()
    return answer<T>(response)
  },
  async remove(path) {
    const response = await fetch(path, { method: 'DELETE', signal: AbortSignal.timeout(CALL_MS) }).catch(() => null)
    if (!response) throw unreachable()
    await answer(response)
  },
  async put(url, headers, body) {
    const response = await fetch(url, { method: 'PUT', headers, body, signal: AbortSignal.timeout(PUT_MS) }).catch(() => null)
    if (!response) throw unreachable()
    await response.arrayBuffer().catch(() => undefined)
    // A link that expired or a part storage dropped: sign it again and send it again. Only "too large" is final.
    if (!response.ok) throw new LiveError(`The upload answered ${response.status}.`, response.status === 413 ? 413 : 503)
  },
}

/**
 * Pieces of at most `max` bytes from a run of chunks, in order: the chunks are joined, and a run longer than `max` is
 * cut into equal pieces (never a small tail, which the Studio would refuse as a piece but the last). Pure.
 */
export function piecesOf(chunks: Blob[], max = PIECE_MAX_BYTES): Blob[] {
  const joined = new Blob(chunks)
  if (!joined.size) return []
  const count = Math.ceil(joined.size / max)
  const size = Math.ceil(joined.size / count)
  const out: Blob[] = []
  for (let at = 0; at < joined.size; at += size) out.push(joined.slice(at, Math.min(joined.size, at + size)))
  return out
}

/** How long to wait before trying again, after `failures` failures in a row: 1 s doubling to 15 s. Pure. */
export const backoffMs = (failures: number) => Math.min(15_000, 1000 * 2 ** Math.max(0, failures - 1))

type Piece = { index: number; blob: Blob; seconds: number }

/** What a track leans on: the calls, the clock, and the recorder's word on where this track sits on the screen's clock. */
export type TrackDeps = {
  api: LiveApi
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** Seconds after the screen this track started, once both have started (null before). */
  offset: () => number | null
  /** The server refused the rest of the take: the recording should stop. */
  onFailed: (message: string) => void
  onChange: () => void
}

/** One track's pieces on their way to the server. */
export class LiveTrack {
  readonly label: string
  state: LiveTrackState = 'connecting'
  error: string | undefined
  key: string | null = null
  recordedBytes = 0
  uploadedBytes = 0
  /** How many pieces, from the first, are on the server. */
  uploadedPieces = 0
  private takeId: string | null = null
  private buffer: Blob[] = []
  private bufferBytes = 0
  private bufferStartedAt: number | null = null
  private queue: Piece[] = []
  private nextIndex = 0
  private recordedSeconds = 0
  private uploadedSeconds = 0
  private pumping: Promise<void> | null = null
  private closed = false
  private failures = 0
  private failingSince: number | null = null
  private gaveUp = false
  private waiters: (() => void)[] = []

  constructor(readonly role: TakeRole, private readonly deps: TrackDeps) {
    this.label = LABELS[role]
  }

  /** A chunk the recorder made, `seconds` into this track. */
  push(chunk: Blob, seconds: number): void {
    if (!chunk.size || this.state === 'failed' || this.closed) return
    this.buffer.push(chunk)
    this.bufferBytes += chunk.size
    this.recordedBytes += chunk.size
    this.recordedSeconds = Math.max(this.recordedSeconds, seconds)
    this.bufferStartedAt ??= this.deps.now()
    if (this.bufferBytes >= PIECE_MIN_BYTES && (this.bufferBytes >= PIECE_TARGET_BYTES || this.deps.now() - this.bufferStartedAt >= PIECE_SECONDS * 1000)) this.cut()
    this.changed()
  }

  /** The chunks gathered so far become pieces, in line to go up. */
  private cut(): void {
    if (!this.buffer.length) return
    for (const blob of piecesOf(this.buffer)) this.queue.push({ index: this.nextIndex++, blob, seconds: this.recordedSeconds })
    this.buffer = []
    this.bufferBytes = 0
    this.bufferStartedAt = null
    this.kick()
  }

  /** The take exists on the server: the pieces start going up. */
  connect(takeId: string, key: string): void {
    if (this.state !== 'connecting') return
    this.takeId = takeId
    this.key = key
    this.state = 'live'
    this.changed()
    this.kick()
  }

  /** The take could not be made on the server: every piece stays here, to be uploaded after Stop the old way. */
  goLocal(): void {
    if (this.state !== 'connecting') return
    this.state = 'local'
    this.changed()
  }

  /** No more chunks will come (the recorder stopped without Stop: the dialog closed): what is gathered goes up as a piece. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.cut()
  }

  /** Thrown away: nothing more goes up. Answers once the piece being sent, if any, has settled. */
  async abandon(): Promise<void> {
    this.closed = true
    this.queue = []
    this.buffer = []
    this.bufferBytes = 0
    if (this.state !== 'local') this.state = 'failed'
    await this.pumping?.catch(() => undefined)
  }

  /** A local track's bytes, whole (it never sent a piece). */
  localBlob(type: string): Blob {
    this.cut()
    return new Blob(this.queue.map((piece) => piece.blob), { type })
  }

  status(): LiveTrackStatus {
    const waiting = this.state === 'done' ? 0 : Math.max(0, this.recordedSeconds - this.uploadedSeconds)
    return {
      role: this.role,
      label: this.label,
      state: this.state,
      recordedBytes: this.recordedBytes,
      uploadedBytes: this.uploadedBytes,
      unsavedSeconds: Math.round(waiting * 10) / 10,
      ...(this.error ? { error: this.error } : {}),
    }
  }

  private changed(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const wake of waiters) wake()
    this.deps.onChange()
  }

  private nextChange(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  private kick(): void {
    if ((this.state !== 'live' && this.state !== 'retrying') || this.pumping || this.gaveUp || !this.queue.length) return
    this.pumping = this.pump().finally(() => {
      this.pumping = null
      // A piece cut while the last round was finishing.
      this.kick()
    })
  }

  /** Send the pieces in line, one after the other, each signed and then put. */
  private async pump(): Promise<void> {
    while (this.queue.length && (this.state === 'live' || this.state === 'retrying')) {
      const piece = this.queue[0]!
      try {
        const offset = this.deps.offset()
        // `stored`: asked for again after its answer was lost, it is in storage already at its length: nothing to send.
        const link = await this.deps.api.post<{ url?: string; headers?: Record<string, string>; stored?: boolean }>(`${STUDIO_API}/live-takes/${encodeURIComponent(this.takeId!)}/pieces`, {
          role: serverRole(this.role),
          index: piece.index,
          bytes: piece.blob.size,
          seconds: Math.round(piece.seconds * 1000) / 1000,
          ...(offset !== null && Number.isFinite(offset) ? { offsetSeconds: Math.round(offset * 1000) / 1000 } : {}),
        })
        if (!link.stored) await this.deps.api.put(link.url!, link.headers ?? {}, piece.blob)
        this.queue.shift()
        this.uploadedBytes += piece.blob.size
        this.uploadedPieces = piece.index + 1
        this.uploadedSeconds = piece.seconds
        this.failures = 0
        this.failingSince = null
        this.state = 'live'
        this.error = undefined
        this.changed()
      } catch (cause) {
        const error = cause instanceof LiveError ? cause : new LiveError(cause instanceof Error ? cause.message : 'The upload failed.', 0)
        if (!error.transient) {
          this.state = 'failed'
          this.error = error.message
          this.changed()
          this.deps.onFailed(error.message)
          return
        }
        this.failures++
        this.failingSince ??= this.deps.now()
        this.state = 'retrying'
        this.error = 'The connection dropped. The recording is kept here and goes up when it is back.'
        this.changed()
        if (this.closed && this.deps.now() - this.failingSince >= GIVE_UP_AFTER_STOP_MS) {
          this.gaveUp = true
          this.changed()
          return
        }
        await this.deps.sleep(backoffMs(this.failures))
      }
    }
  }

  /**
   * Stop: the last chunk is in. Answers once every piece is on the server: the key and how many pieces make the
   * track (`complete` false when the server refused the rest, so only the start of it is kept). Throws when nothing
   * could go up for a while: the pieces stay here, and calling it again tries again.
   */
  async finish(onProgress?: (fraction: number) => void): Promise<{ key: string; pieces: number; complete: boolean }> {
    this.closed = true
    this.cut()
    const report = () => onProgress?.(this.recordedBytes ? Math.min(1, this.uploadedBytes / this.recordedBytes) : 1)
    report()
    while (this.state === 'connecting') await this.nextChange()
    if (this.state === 'local') throw new Error('This track was not uploaded while it recorded.')
    // Tried again after giving up: another full window.
    this.gaveUp = false
    this.failingSince = null
    this.kick()
    while (this.pumping) {
      const pumping = this.pumping
      await Promise.race([pumping, this.nextChange()])
      report()
    }
    if (this.state === 'failed') {
      if (!this.uploadedPieces || !this.key) throw new Error(this.error ?? 'The recording could not be saved.')
      return { key: this.key, pieces: this.uploadedPieces, complete: false }
    }
    if (this.queue.length || !this.key) throw new Error('The recording could not reach the Studio. It is kept on this device: try again.')
    this.state = 'done'
    this.changed()
    report()
    return { key: this.key, pieces: this.nextIndex, complete: true }
  }
}

/** The take on the server and its tracks. */
export class LiveTake {
  id: string | null = null
  /**
   * The take's id, chosen here: a start sent again (its answer lost) is the same take on the server, never a second
   * one left behind counting against the person's recordings at once.
   */
  readonly requestedId: string = globalThis.crypto.randomUUID()
  readonly tracks = new Map<TakeRole, LiveTrack>()
  /** True once the take exists on the server; false when it could not be made (every track then went local). */
  readonly ready: Promise<boolean>
  private settle!: (value: boolean) => void

  constructor(
    roles: TakeRole[],
    private readonly deps: Omit<TrackDeps, 'offset'> & { offset: (role: TakeRole) => number | null },
  ) {
    this.ready = new Promise((resolve) => (this.settle = resolve))
    for (const role of roles) this.tracks.set(role, new LiveTrack(role, { ...deps, offset: () => deps.offset(role) }))
  }

  /** Make the take on the server (a few tries over about ten seconds); the pieces wait here meanwhile. */
  async open(recorder: 'browser' | 'desktop', names: Partial<Record<TakeRole, string>>, frameRates: Partial<Record<TakeRole, number | undefined>> = {}): Promise<boolean> {
    const tracks = [...this.tracks.keys()].map((role) => ({ role: serverRole(role), name: names[role]!, ...(frameRates[role] ? { frameRate: frameRates[role] } : {}) }))
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { take } = await this.deps.api.post<{ take: { id: string; keys: Partial<Record<ServerRole, string>> } }>(`${STUDIO_API}/live-takes`, { id: this.requestedId, recorder, tracks })
        this.id = take.id
        for (const [role, track] of this.tracks) {
          const key = take.keys[serverRole(role)]
          if (key) track.connect(take.id, key)
          else track.goLocal()
        }
        this.settle(true)
        return true
      } catch (cause) {
        // Refused for good (an older server, too many recordings): record here and upload after Stop.
        if (!(cause instanceof LiveError) || !cause.transient) break
        await this.deps.sleep(attempt ? 5000 : 2000)
      }
    }
    for (const track of this.tracks.values()) track.goLocal()
    this.settle(false)
    return false
  }

  status(): LiveTrackStatus[] {
    return [...this.tracks.values()].map((track) => track.status())
  }

  /** The recorders stopped without Stop (the dialog closed): what each track gathered goes up as its last piece. */
  flush(): void {
    for (const track of this.tracks.values()) track.close()
  }

  /** Throw the take away on the server (Cancel). Best effort. Nothing more goes up first, so nothing lands after it. */
  async discard(): Promise<void> {
    await Promise.all([...this.tracks.values()].map((track) => track.abandon()))
    if (!(await this.ready) || !this.id) return
    await this.deps.api.remove(`${STUDIO_API}/live-takes/${encodeURIComponent(this.id)}`).catch(() => undefined)
  }
}

// ---- takes that stopped before they were finished -------------------------------------------------------------

/** A take the server kept after the recording stopped unexpectedly (src/lib/studio/server/live-takes.ts SavedTake). */
export type SavedTake = {
  id: string
  createdAt: string
  savedAt: string
  seconds: number
  bytes: number
  tracks: { role: ServerRole; pieces: number; bytes: number; seconds: number }[]
}

/** The person's takes that stopped before they were finished (a closed window, a crash), newest first. */
export async function listSavedTakes(api: LiveApi = fetchApi): Promise<SavedTake[]> {
  return (await api.get<{ takes: SavedTake[] }>(`${STUDIO_API}/live-takes`)).takes
}

/** Throw a saved take away. */
export async function discardSavedTake(id: string, api: LiveApi = fetchApi): Promise<void> {
  await api.remove(`${STUDIO_API}/live-takes/${encodeURIComponent(id)}`)
}
