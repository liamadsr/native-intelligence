/**
 * One call, heard: the recorder in its LiveKit room (hidden, subscribe only:
 * the token says so), every member's and guest's microphone to Deepgram on a
 * socket of its own, and what they say and who comes and goes delivered to
 * the call's feed session in the order it happened.
 *
 *   - Someone already in the room, or joining later: a roster event, then
 *     their microphone once it is subscribed. Leaving: their last words, then
 *     the roster event. Coming back (a reconnect, a new track): the same
 *     speaker, a new socket.
 *   - Muted: nothing is sent (the person's app only mutes now; it no longer
 *     ends its track), and Deepgram is asked for what it heard so far.
 *   - The room lost (LiveKit restarted, the connection gone for good), or
 *     nobody left in it for ALONE_MS: the recorder leaves without ending the
 *     session; the main loop asks for its work again and comes back with a
 *     fresh token if the call still wants notes. Told to stop by the
 *     heartbeat (notes off, the call over, the 3-hour bound): the last words
 *     are delivered, then the session is ended.
 *
 * Logs carry ids only: the call, the session, a track. Never a name or a word.
 */
import { AudioStream, Room, RoomEvent, TrackKind, TrackSource, type AudioFrame, type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication, type TrackPublication, type Participant } from '@livekit/rtc-node'
import type { AppClient, FeedSession, Job } from './app-client.ts'
import { DeepgramStream, type SocketFactory } from './deepgram.ts'
import { Delivery } from './delivery.ts'
import { Keys, identityOf, rosterEvent, segmentOf } from './speech.ts'

/** Nobody but the recorder in the room this long: it leaves, so the room can close. */
export const ALONE_MS = 30_000
/** The audio the recorder asks LiveKit for: what Deepgram is told it gets. */
export const SAMPLE_RATE = 16_000

export interface CallDeps {
  client: AppClient
  livekitUrl: string
  deepgramUrl: string
  deepgramKey: string
  maxCallMs: number
  keys: Keys
  /** Deepgram's sockets (a test's fake). */
  socket?: SocketFactory
}

interface Listener {
  trackSid: string
  identity: string
  deepgram: DeepgramStream
  muted: boolean
  reader: ReadableStreamDefaultReader<AudioFrame>
}

export type CallEnd = 'told' | 'alone' | 'disconnected' | 'bound' | 'shutdown' | 'refused' | 'failed'

export class CallRecorder {
  readonly job: Job
  readonly session: FeedSession
  private readonly deps: CallDeps
  private readonly room = new Room()
  private readonly delivery: Delivery
  private readonly listeners = new Map<string, Listener>()
  private readonly startedAtMs: number
  private stopping: Promise<void> | null = null
  private aloneSince: number | null = null
  private timers: Array<ReturnType<typeof setInterval>> = []
  private resolveDone: (why: CallEnd) => void = () => undefined
  /** Resolves with why the call ended here. */
  readonly done: Promise<CallEnd>

  constructor(job: Job, session: FeedSession, deps: CallDeps) {
    this.job = job
    this.session = session
    this.deps = deps
    this.startedAtMs = Date.parse(session.startedAt)
    this.delivery = new Delivery(
      { roster: (events) => deps.client.roster(session.id, events), segments: (segments) => deps.client.segments(session.id, segments) },
      {
        onDead: (why) => {
          console.warn(`[recorder] call=${job.callId} session=${session.id} feed refused (${why}): leaving`)
          void this.stop('refused', { end: false })
        },
      },
    )
    this.done = new Promise((resolve) => (this.resolveDone = resolve))
  }

  /** Join the room and hear it. Throws when the room can't be joined (the main loop asks again later). */
  async start(): Promise<void> {
    const room = this.room
    room
      .on(RoomEvent.ParticipantConnected, (p) => this.joined(p))
      .on(RoomEvent.ParticipantDisconnected, (p) => void this.left(p))
      .on(RoomEvent.TrackSubscribed, (track, pub, p) => this.subscribed(track, pub, p))
      .on(RoomEvent.TrackUnsubscribed, (_track, pub) => void this.closeListener(pub.sid))
      .on(RoomEvent.TrackMuted, (pub, p) => this.muted(pub, p, true))
      .on(RoomEvent.TrackUnmuted, (pub, p) => this.muted(pub, p, false))
      .on(RoomEvent.Disconnected, () => {
        if (!this.stopping) void this.stop('disconnected', { end: false })
      })
    await room.connect(this.deps.livekitUrl, this.job.token, { autoSubscribe: true, dynacast: false })
    console.info(`[recorder] call=${this.job.callId} session=${this.session.id} round=${this.session.round} joined`)
    for (const p of room.remoteParticipants.values()) this.joined(p)
    this.timers.push(setInterval(() => this.checkAlone(), 5_000))
    const bound = setTimeout(() => void this.stop('bound', { end: false }), this.deps.maxCallMs)
    this.timers.push(bound as unknown as ReturnType<typeof setInterval>)
  }

  /** Speakers being heard now (a health answer's count). */
  get speakers(): number {
    return this.listeners.size
  }

  private joined(p: RemoteParticipant): void {
    const event = rosterEvent(p.identity, 'joined', Date.now(), this.startedAtMs, this.deps.keys.next('r'))
    if (event) this.delivery.push({ kind: 'roster', event })
  }

  private async left(p: RemoteParticipant): Promise<void> {
    if (!identityOf(p.identity)) return
    // Their last words first, then that they left.
    const theirs = [...this.listeners.values()].filter((l) => l.identity === p.identity)
    await Promise.all(theirs.map((l) => this.closeListener(l.trackSid)))
    const event = rosterEvent(p.identity, 'left', Date.now(), this.startedAtMs, this.deps.keys.next('r'))
    if (event) this.delivery.push({ kind: 'roster', event })
  }

  private subscribed(track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant): void {
    if (this.stopping || track.kind !== TrackKind.KIND_AUDIO || pub.source !== TrackSource.SOURCE_MICROPHONE) return
    if (!identityOf(p.identity) || !pub.sid || this.listeners.has(pub.sid)) return
    const trackSid = pub.sid
    const identity = p.identity
    const deepgram = new DeepgramStream({
      url: this.deps.deepgramUrl,
      key: this.deps.deepgramKey,
      socket: this.deps.socket,
      onHeard: (heard) => {
        const segment = segmentOf(heard, identity, this.startedAtMs, this.deps.keys.next(trackSid))
        if (segment) this.delivery.push({ kind: 'segment', segment })
      },
      onState: (state) => {
        if (state === 'down') console.warn(`[recorder] call=${this.job.callId} track=${trackSid} deepgram down, reconnecting`)
      },
    })
    const reader = new AudioStream(track, { sampleRate: SAMPLE_RATE, numChannels: 1 }).getReader()
    const listener: Listener = { trackSid, identity, deepgram, muted: pub.muted === true, reader }
    this.listeners.set(trackSid, listener)
    void this.pump(listener)
    console.info(`[recorder] call=${this.job.callId} track=${trackSid} hearing`)
  }

  /** Frames from LiveKit to Deepgram, each stamped with when it was heard. */
  private async pump(l: Listener): Promise<void> {
    try {
      for (;;) {
        const { value: frame, done } = await l.reader.read()
        if (done || this.listeners.get(l.trackSid) !== l) break
        if (l.muted) continue
        const durationMs = (frame.samplesPerChannel / frame.sampleRate) * 1000
        l.deepgram.write(frame.data, Date.now() - durationMs, durationMs)
      }
    } catch (err) {
      if (this.listeners.get(l.trackSid) === l) console.warn(`[recorder] call=${this.job.callId} track=${l.trackSid} audio ended:`, err instanceof Error ? err.message.slice(0, 120) : 'unknown')
    }
  }

  private muted(pub: TrackPublication, _p: Participant, muted: boolean): void {
    const l = pub.sid ? this.listeners.get(pub.sid) : undefined
    if (!l || l.muted === muted) return
    l.muted = muted
    if (muted) l.deepgram.pause()
  }

  private async closeListener(trackSid: string | undefined): Promise<void> {
    const l = trackSid ? this.listeners.get(trackSid) : undefined
    if (!l) return
    this.listeners.delete(l.trackSid)
    await l.deepgram.close()
    await l.reader.cancel().catch(() => undefined)
  }

  private checkAlone(): void {
    const anyone = [...this.room.remoteParticipants.values()].some((p) => identityOf(p.identity))
    if (anyone) {
      this.aloneSince = null
      return
    }
    this.aloneSince ??= Date.now()
    if (Date.now() - this.aloneSince >= ALONE_MS) void this.stop('alone', { end: false })
  }

  /**
   * Leave: every socket's last words, then everything delivered (at most
   * `flushMs`), then the room. `end`: the session is over for good (the app
   * said so), and the feed is told.
   */
  stop(why: CallEnd, opts: { end: boolean; flushMs?: number }): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopping = (async () => {
      for (const t of this.timers) clearInterval(t)
      await Promise.all([...this.listeners.keys()].map((sid) => this.closeListener(sid)))
      const delivered = await this.delivery.flush(opts.flushMs ?? 15_000)
      if (!delivered) console.warn(`[recorder] call=${this.job.callId} session=${this.session.id} left with ${this.delivery.pending} deliveries unsent`)
      if (opts.end) await this.deps.client.end(this.session.id, why).catch(() => false)
      await this.room.disconnect().catch(() => undefined)
      console.info(`[recorder] call=${this.job.callId} session=${this.session.id} left (${why})`)
      this.resolveDone(why)
    })()
    return this.stopping
  }
}
