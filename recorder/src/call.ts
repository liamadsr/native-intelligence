/**
 * One call, heard: the recorder in its LiveKit room (hidden, subscribe only:
 * the token says so), every member's microphone, and each meeting guest's once
 * the app says they may be heard, to Deepgram on a socket of its own, and what
 * they say and who comes and goes delivered to the call's feed session in the
 * order it happened.
 *
 *   - It subscribes to microphones and nothing else (no camera, no screen):
 *     auto-subscribe is off, and each microphone publication is asked for.
 *   - The app offers it a call only once two people have been in it at the
 *     same time (a ringing or missed call, one person waiting: not heard), and
 *     every call takes notes from its start. A member is heard from their
 *     first frame: no notice holds a member's microphone for the recorder's
 *     notes (being on the platform is agreeing to calls being captured; the
 *     "Notes are on" badge says so). A meeting guest is heard only once the
 *     app lists them (they said go to this round's notes: the start's answer,
 *     then every heartbeat's). Until then their microphone is not even
 *     subscribed: no audio of theirs leaves the server.
 *   - Someone already in the room, or joining later: a roster event, then their
 *     microphone. Leaving: their last words, then the roster event. Coming back
 *     (a reconnect, a new track): the same speaker, a new socket.
 *   - Muted: nothing is sent, and Deepgram is asked for what it heard so far.
 *   - It leaves when the room is lost, when nobody else has been in it for
 *     ALONE_MS, when the feed refuses its words (the capture was closed), at its
 *     bound, or when the heartbeat says stop; each time it delivers its last
 *     words first, then tells the feed it is done with the session (`end`), so
 *     a call's finish knows nothing more is coming (a room it could not join
 *     too: the session is handed back at once). Only a shutdown (SIGTERM)
 *     leaves without `end`: the next process takes the session up.
 *
 * The call's sound (./audio.ts), when the app asked for it at the start:
 * every member's frames also go into the call's one mixed take (never a
 * meeting guest's, never a muted microphone's), and leaving finishes the take
 * (a shutdown only pauses it, for the next process). The sound never holds up
 * the words: its take is finished alongside the last deliveries, and its
 * encode and upload run afterwards, on their own.
 *
 * Every room event handler is guarded: one that throws is logged, never the
 * end of the process (and of every other call in it). Logs carry ids only:
 * the call, the session, a track. Never a name or a word.
 */
import {
  AudioStream,
  Room,
  RoomEvent,
  TrackKind,
  TrackSource,
  type AudioFrame,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type TrackPublication,
  type Participant,
} from '@livekit/rtc-node'
import type { AppClient, FeedSession, Job } from './app-client.ts'
import type { AudioKeeper, CallAudio } from './audio.ts'
import { DeepgramStream, type SocketFactory } from './deepgram.ts'
import { Delivery } from './delivery.ts'
import { Keys, identityOf, mayHear, rosterEvent, segmentOf } from './speech.ts'

/** Nobody but the recorder in the room this long: it leaves, so the room can close. */
export const ALONE_MS = 30_000
/** The audio the recorder asks LiveKit for: what Deepgram is told it gets. */
export const SAMPLE_RATE = 16_000
/** The longest a join may take before it is given up (the main loop asks again later). */
export const CONNECT_TIMEOUT_MS = 20_000
/** How often the call's words go to the app: one write to the capture per call this often, not one per sentence. */
export const DELIVERY_EVERY_MS = 4_000
/** The longest opening the call's sound may take before the call goes on without it (a disk that hangs). */
export const AUDIO_OPEN_MS = 2_000
/** The longest finishing it may take before the call leaves without waiting for it. */
export const AUDIO_END_MS = 5_000

/** `p`'s value, or `timeout` once `ms` passed first (`p` goes on, unwatched). */
export function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), ms)
    }),
  ])
}
export const TIMEOUT = Symbol('timeout')

export interface CallDeps {
  client: AppClient
  livekitUrl: string
  deepgramUrl: string
  deepgramKey: string
  maxCallMs: number
  keys: Keys
  /** Deepgram's sockets (a test's fake). */
  socket?: SocketFactory
  /** Keeps the calls' sound (null: off in this process). */
  audio?: Pick<AudioKeeper, 'openTake'> | null
  /** How long opening and finishing the sound may take (a test's shorter ones). */
  audioOpenMs?: number
  audioEndMs?: number
  /** The room (a test's stand-in). */
  room?: Room
}

interface Listener {
  trackSid: string
  identity: string
  deepgram: DeepgramStream
  muted: boolean
  /** A member's microphone: in the call's sound (a meeting guest's never is). */
  member: boolean
  reader: ReadableStreamDefaultReader<AudioFrame>
}

export type CallEnd = 'told' | 'alone' | 'disconnected' | 'bound' | 'shutdown' | 'refused' | 'failed'

export class CallRecorder {
  readonly job: Job
  readonly session: FeedSession
  private readonly deps: CallDeps
  private readonly room: Room
  private readonly delivery: Delivery
  private readonly listeners = new Map<string, Listener>()
  private readonly startedAtMs: number
  private guests: Set<string>
  private stopping: Promise<void> | null = null
  private aloneSince: number | null = null
  private timers: Array<ReturnType<typeof setInterval>> = []
  private audio: CallAudio | null = null
  private stopWhy: CallEnd | null = null
  private resolveDone: (why: CallEnd) => void = () => undefined
  /** Resolves with why the call ended here. */
  readonly done: Promise<CallEnd>

  constructor(job: Job, session: FeedSession, deps: CallDeps) {
    this.job = job
    this.session = session
    this.deps = deps
    this.room = deps.room ?? new Room()
    this.startedAtMs = Date.parse(session.startedAt)
    this.guests = new Set((session.guests ?? []).map((g) => g.toLowerCase()))
    this.delivery = new Delivery(
      { roster: (events) => deps.client.roster(session.id, events), segments: (segments) => deps.client.segments(session.id, segments) },
      {
        everyMs: DELIVERY_EVERY_MS,
        onDead: (why) => {
          console.warn(`[recorder] call=${job.callId} session=${session.id} feed refused (${why}): leaving`)
          void this.stop('refused')
        },
      },
    )
    this.done = new Promise((resolve) => (this.resolveDone = resolve))
  }

  /** A room event's handler, guarded: a fault is logged, never thrown into the SDK (and the process). */
  private guard<A extends unknown[]>(name: string, fn: (...args: A) => unknown): (...args: A) => void {
    return (...args: A) => {
      try {
        const out = fn(...args)
        if (out instanceof Promise) out.catch((err) => this.fault(name, err))
      } catch (err) {
        this.fault(name, err)
      }
    }
  }

  private fault(name: string, err: unknown): void {
    console.warn(`[recorder] call=${this.job.callId} ${name} failed:`, err instanceof Error ? err.message.slice(0, 160) : 'unknown')
  }

  /** Join the room and hear it. Throws when the room can't be joined in time (the main loop asks again later). */
  async start(): Promise<void> {
    const room = this.room
    room
      .on(RoomEvent.ParticipantConnected, this.guard('joined', (p: RemoteParticipant) => this.joined(p)))
      .on(RoomEvent.ParticipantDisconnected, this.guard('left', (p: RemoteParticipant) => this.left(p)))
      .on(RoomEvent.TrackPublished, this.guard('published', (pub: RemoteTrackPublication, p: RemoteParticipant) => this.offered(pub, p)))
      .on(RoomEvent.TrackSubscribed, this.guard('subscribed', (track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => this.subscribed(track, pub, p)))
      .on(RoomEvent.TrackUnsubscribed, this.guard('unsubscribed', (_track: RemoteTrack, pub: RemoteTrackPublication) => this.closeListener(pub.sid)))
      .on(RoomEvent.TrackUnpublished, this.guard('unpublished', (pub: RemoteTrackPublication) => this.closeListener(pub.sid)))
      .on(RoomEvent.TrackMuted, this.guard('muted', (pub: TrackPublication, p: Participant) => this.muted(pub, p, true)))
      .on(RoomEvent.TrackUnmuted, this.guard('unmuted', (pub: TrackPublication, p: Participant) => this.muted(pub, p, false)))
      .on(
        RoomEvent.Disconnected,
        this.guard('disconnected', () => {
          if (!this.stopping) void this.stop('disconnected')
        }),
      )
    let timer: ReturnType<typeof setTimeout> | undefined
    const connecting = room.connect(this.deps.livekitUrl, this.job.token, { autoSubscribe: false, dynacast: false })
    try {
      await Promise.race([
        connecting,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no room after ${CONNECT_TIMEOUT_MS / 1000} s`)), CONNECT_TIMEOUT_MS)
        }),
      ])
    } catch (err) {
      // Given up: a connect that completes after this leaves the room at once (never a deaf
      // participant holding the recorder's identity in it).
      connecting.then(
        () => void room.disconnect().catch(() => undefined),
        () => undefined,
      )
      throw err
    } finally {
      clearTimeout(timer)
    }
    console.info(`[recorder] call=${this.job.callId} session=${this.session.id} round=${this.session.round} joined`)
    // Everyone already here is heard first: the call's sound never holds up its words.
    for (const p of room.remoteParticipants.values()) {
      this.joined(p)
      for (const pub of p.trackPublications.values()) this.offered(pub, p)
    }
    // The sound's take (or the one a restart left, going on) opens beside it; what is heard before
    // it opens is in the notes, not in the file.
    if (!this.stopping && this.deps.audio) void this.openAudio(this.deps.audio)
    this.timers.push(setInterval(() => this.checkAlone(), 5_000))
    const bound = setTimeout(() => void this.stop('bound'), this.deps.maxCallMs)
    this.timers.push(bound as unknown as ReturnType<typeof setInterval>)
  }

  /**
   * The take, given AUDIO_OPEN_MS: a disk that hangs leaves the call heard without its sound, and a
   * take that opens later than that, or once the call is leaving, is ended at once (it heard
   * nothing): finished, or paused at a shutdown (the next process takes it up).
   */
  private async openAudio(keeper: Pick<AudioKeeper, 'openTake'>): Promise<void> {
    const opening = keeper.openTake(this.session).catch(() => null)
    const opened = await within(opening, this.deps.audioOpenMs ?? AUDIO_OPEN_MS)
    if (opened === TIMEOUT) {
      console.warn(`[recorder] call=${this.job.callId} session=${this.session.id} audio not opened in time: the call goes on without its sound`)
      void opening.then((late) => late?.end('finish').catch(() => undefined))
      return
    }
    if (!opened) return
    if (this.stopping) {
      void opened.end(this.stopWhy === 'shutdown' ? 'pause' : 'finish').catch(() => undefined)
      return
    }
    this.audio = opened
    console.info(`[recorder] call=${this.job.callId} session=${this.session.id} audio take=${opened.meta.take}`)
  }

  /** Speakers being heard now (a health answer's count). */
  get speakers(): number {
    return this.listeners.size
  }

  /**
   * The guests the app says may be heard now (each heartbeat). A guest newly
   * listed is subscribed to; one no longer listed is closed and unsubscribed.
   */
  setGuests(guestIds: readonly string[]): void {
    this.guests = new Set(guestIds.map((g) => g.toLowerCase()))
    for (const p of this.room.remoteParticipants.values()) {
      const who = identityOf(p.identity)
      if (!who || !('guestId' in who)) continue
      for (const pub of p.trackPublications.values()) {
        if (mayHear(p.identity, this.guests)) this.offered(pub, p)
        else if (pub.sid && this.listeners.has(pub.sid)) {
          void this.closeListener(pub.sid)
          pub.setSubscribed(false)
        }
      }
    }
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

  /** A publication: a microphone of someone who may be heard is subscribed to; anything else never is. */
  private offered(pub: RemoteTrackPublication, p: RemoteParticipant): void {
    if (this.stopping || pub.kind !== TrackKind.KIND_AUDIO || pub.source !== TrackSource.SOURCE_MICROPHONE) return
    if (!mayHear(p.identity, this.guests) || pub.subscribed) return
    pub.setSubscribed(true)
  }

  private subscribed(track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant): void {
    if (this.stopping || track.kind !== TrackKind.KIND_AUDIO || pub.source !== TrackSource.SOURCE_MICROPHONE) return
    if (!mayHear(p.identity, this.guests)) {
      pub.setSubscribed(false)
      return
    }
    if (!pub.sid || this.listeners.has(pub.sid)) return
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
    const who = identityOf(identity)
    const listener: Listener = { trackSid, identity, deepgram, muted: pub.muted === true, member: !!who && 'memberId' in who, reader }
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
        const now = Date.now()
        if (l.muted) {
          // No sound, but the member's place in the call's sound moves on with the call.
          if (l.member && frame.sampleRate === SAMPLE_RATE) this.audio?.skip(l.trackSid, frame.samplesPerChannel, now)
          continue
        }
        const durationMs = (frame.samplesPerChannel / frame.sampleRate) * 1000
        l.deepgram.write(frame.data, now - durationMs, durationMs)
        if (l.member && frame.sampleRate === SAMPLE_RATE) this.audio?.push(l.trackSid, frame.data, now)
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
    this.audio?.forget(l.trackSid)
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
    if (Date.now() - this.aloneSince >= ALONE_MS) void this.stop('alone')
  }

  /**
   * Leave: every socket's last words, then everything delivered (at most
   * `flushMs`), then the feed told it is done with the session (except at a
   * shutdown, when the next process takes it up), then out of the room.
   */
  stop(why: CallEnd, opts: { flushMs?: number } = {}): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopWhy = why
    this.stopping = (async () => {
      for (const t of this.timers) clearInterval(t)
      await Promise.all([...this.listeners.keys()].map((sid) => this.closeListener(sid)))
      // The take finished (or, at a shutdown, paused for the next process) beside the last words,
      // and never waited on past AUDIO_END_MS: a disk that hangs never keeps the call from saying
      // `end`, its slot from being freed, or a shutdown from finishing. A take cut off that way is
      // left as it is, for the next start to finish.
      const audio = this.audio
      const ending = audio ? within(audio.end(why === 'shutdown' ? 'pause' : 'finish'), this.deps.audioEndMs ?? AUDIO_END_MS).catch((err) => {
        console.warn(`[recorder] call=${this.job.callId} audio not finished:`, err instanceof Error ? err.message.slice(0, 120) : 'unknown')
        return null
      }) : null
      const [delivered, ended] = await Promise.all([this.delivery.flush(opts.flushMs ?? 15_000), ending])
      if (ended === TIMEOUT) console.warn(`[recorder] call=${this.job.callId} session=${this.session.id} audio not finished in time: left for the next start`)
      if (!delivered) console.warn(`[recorder] call=${this.job.callId} session=${this.session.id} left with ${this.delivery.pending} deliveries unsent`)
      if (why !== 'shutdown') await this.deps.client.end(this.session.id, why).catch(() => false)
      await this.room.disconnect().catch(() => undefined)
      console.info(`[recorder] call=${this.job.callId} session=${this.session.id} left (${why})`)
      this.resolveDone(why)
    })()
    return this.stopping
  }
}
