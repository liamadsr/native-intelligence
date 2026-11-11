/**
 * One team call on this page: the LiveKit room, and what the call panel
 * draws of it, as a snapshot that changes only when LiveKit says something
 * changed (useSyncExternalStore reads it). The SDK is loaded here, on the
 * first call, by a dynamic import: a page with no call never loads it.
 *
 *   - Audio on, camera off, as a call starts. A microphone the browser (or
 *     macOS) refuses joins listening only, and the panel says why; a camera
 *     refused says so too.
 *   - Adaptive stream (a hidden or small tile gets less, or nothing) and
 *     dynacast (nobody watching a layer: it isn't sent); simulcast for the
 *     camera. VP8, LiveKit's default, pinned: the desktop app's WebKit
 *     reports no Safari version, so nothing here depends on one.
 *   - Who is speaking comes from LiveKit's active-speaker events, never an
 *     analyser on the audio.
 *   - LiveKit reconnects by itself (`reconnecting` while it does). A
 *     connection lost for good is joined again once with a fresh token from
 *     the token route (`refreshJoin`); a call that ended there (409) ends
 *     here.
 *   - Joining a call whose notes (or recording) are on holds the microphone
 *     back (`holdMic`): the person hears the call and sees the notice
 *     first, and nothing of theirs is sent until they say so
 *     (releaseMic, or the mic button).
 *   - Remote audio plays from <audio> elements this session keeps in one
 *     hidden container, so React never re-mounts them; the speaker picker
 *     moves them all (where the browser can).
 */
import type {
  LocalParticipant,
  Participant,
  RemoteParticipant,
  RemoteTrack,
  Room,
  Track,
} from 'livekit-client'
import { guestIdOfIdentity } from '@/lib/meeting-links/shape'

export type CallDeviceKind = 'audioinput' | 'audiooutput' | 'videoinput'

/** Why a call is over here. */
export type CallEnd = 'left' | 'ended' | 'elsewhere' | 'removed' | 'failed'

/** A microphone or camera: on, off, refused by the browser or the OS, or none there. */
export type CallDeviceState = 'on' | 'off' | 'blocked' | 'missing' | 'busy'

export interface CallTile {
  /** identity, plus ':screen' for a shared screen. */
  key: string
  identity: string
  name: string
  kind: 'person' | 'screen'
  isLocal: boolean
  /** A meeting guest (identity `guest-<id>`, set by the server): labelled "Guest". */
  guest: boolean
  speaking: boolean
  micOn: boolean
  /** The video to draw (a camera, or the screen), or null: draw the person's initials. */
  video: Track | null
}

export interface CallSnapshot {
  /** 'error': the call couldn't be loaded or reached (`error` says which); the panel offers Retry. */
  phase: 'connecting' | 'connected' | 'reconnecting' | 'error' | 'ended'
  error: 'load' | 'connect' | null
  ended: CallEnd | null
  tiles: CallTile[]
  /** People in the call, this one included. */
  people: number
  mic: CallDeviceState
  camera: CallDeviceState
  screen: 'on' | 'off'
  canShareScreen: boolean
  canPickSpeaker: boolean
  /** The browser held audio back until a click (the panel offers one). */
  needsAudioStart: boolean
  /** The microphone waits for the person (they joined a call whose notes are on, and haven't said go). */
  micHeld: boolean
  devices: Record<CallDeviceKind, Array<{ deviceId: string; label: string }>>
  active: Partial<Record<CallDeviceKind, string>>
}

export interface TeamCallJoin {
  url: string
  token: string
  room: string
  callId: string
  /** False: a listen-only token (the notes notice comes first; the server lifts it after). */
  canPublish?: boolean
}

export interface TeamCallSessionInfo {
  callId: string
  channelId: string
  channelKind: 'channel' | 'dm' | 'meeting'
  /** What the panel calls it: "#launch", or the other person's name. */
  label: string
  /**
   * The server offers call notes (phase 6): the microphone is sent without
   * DTX, so a notes file's time runs with the call's even in silence.
   */
  notesOffered?: boolean
}

export interface TeamCallSessionDeps {
  /** A fresh join (the token route); `noticeSeen`: the person already saw the notes notice. Null: the call has ended. */
  refreshJoin: (noticeSeen: boolean) => Promise<TeamCallJoin | null>
  /** The person saw the notes notice: the server lets their listen-only connection publish (POST [id]/notice). */
  allowPublish?: () => Promise<boolean>
  /** Tell the server the person hung up (a DM's call ends with it). */
  hangUp: () => Promise<void>
  /** Called once, when the call is over here. */
  onEnded?: (why: CallEnd) => void
  /** The SDK, injectable for tests. */
  loadSdk?: () => Promise<typeof import('livekit-client')>
}

const EMPTY_DEVICES: CallSnapshot['devices'] = { audioinput: [], audiooutput: [], videoinput: [] }

function initialSnapshot(): CallSnapshot {
  return {
    phase: 'connecting',
    error: null,
    ended: null,
    tiles: [],
    people: 1,
    mic: 'off',
    camera: 'off',
    screen: 'off',
    canShareScreen: typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function',
    canPickSpeaker: false,
    needsAudioStart: false,
    micHeld: false,
    devices: EMPTY_DEVICES,
    active: {},
  }
}

/** A refused or missing device, as the panel says it (LiveKit's own reading of the error). */
export function deviceStateOfError(error: unknown, failure: string | undefined): CallDeviceState {
  if (failure === 'PermissionDenied') return 'blocked'
  if (failure === 'NotFound') return 'missing'
  if (failure === 'DeviceInUse') return 'busy'
  const name = error instanceof Error ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'blocked'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'missing'
  if (name === 'NotReadableError') return 'busy'
  return 'blocked'
}

export class TeamCallSession {
  private room: Room | null = null
  private sdk: typeof import('livekit-client') | null = null
  private snapshot: CallSnapshot = initialSnapshot()
  private readonly listeners = new Set<() => void>()
  private audioBox: HTMLDivElement | null = null
  private readonly audioEls = new Map<string, HTMLMediaElement[]>()
  private rejoined = false
  private over = false
  private mic: CallDeviceState = 'off'
  private camera: CallDeviceState = 'off'
  private holdMic = false
  /** The person muted themselves: a rejoin keeps them muted. */
  private userMuted = false
  /** The call's notes are on: muting unpublishes the microphone, so each unmuted stretch is its own notes file at its own place in the call. */
  private notesMode = false

  constructor(
    readonly info: TeamCallSessionInfo,
    private readonly deps: TeamCallSessionDeps,
  ) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  getSnapshot = (): CallSnapshot => this.snapshot

  private emit(patch: Partial<CallSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const fn of this.listeners) fn()
  }

  /** Join the room: audio on (listening only if the mic is refused, or held back by `holdMic` until the person says go), camera off. */
  async connect(join: TeamCallJoin, opts: { holdMic?: boolean } = {}): Promise<void> {
    if (opts.holdMic !== undefined) this.holdMic = opts.holdMic
    let lk: typeof import('livekit-client')
    try {
      lk = this.sdk ?? (this.sdk = await (this.deps.loadSdk ?? (() => import('livekit-client')))())
    } catch {
      // The SDK's chunk didn't load (offline, a deploy in between): say so, with Retry, never "Connecting…" forever.
      if (!this.over) this.emit({ phase: 'error', error: 'load' })
      return
    }
    if (this.over) return
    const room = new lk.Room({
      adaptiveStream: true,
      dynacast: true,
      disconnectOnPageLeave: true,
      publishDefaults: { simulcast: true, videoCodec: 'vp8', dtx: !this.info.notesOffered, red: true },
      videoCaptureDefaults: { resolution: lk.VideoPresets.h720.resolution },
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    this.room = room
    this.wire(room, lk)
    this.emit({ phase: 'connecting', error: null, canPickSpeaker: lk.supportsAudioOutputSelection() })
    try {
      await room.connect(join.url, join.token, { autoSubscribe: true })
    } catch {
      if (this.room === room) {
        this.room = null
        void room.disconnect(true).catch(() => undefined)
        if (!this.over) this.emit({ phase: 'error', error: 'connect' })
      }
      return
    }
    if (this.over || this.room !== room) return
    this.emit({ phase: 'connected', error: null, micHeld: this.holdMic })
    // Held for the notice, or muted by the person before a rejoin: the microphone stays off.
    if (!this.holdMic && !this.userMuted) await this.enableMic(room, lk)
    this.refresh()
    void this.refreshDevices()
  }

  private async enableMic(room: Room, lk: typeof import('livekit-client')): Promise<void> {
    try {
      await room.localParticipant.setMicrophoneEnabled(true)
      this.mic = 'on'
    } catch (err) {
      this.mic = deviceStateOfError(err, lk.MediaDeviceFailure.getFailure(err))
    }
  }

  /** The person read the notice and says go: the server lets them publish, and their microphone is sent from now on. */
  async releaseMic(): Promise<void> {
    if (this.holdMic && this.deps.allowPublish && !(await this.deps.allowPublish())) return
    this.holdMic = false
    this.userMuted = false
    this.emit({ micHeld: false })
    const room = this.room
    const lk = this.sdk
    if (!room || !lk || this.snapshot.phase !== 'connected') return
    await this.enableMic(room, lk)
    this.refresh()
    void this.refreshDevices()
  }

  private wire(room: Room, lk: typeof import('livekit-client')) {
    const E = lk.RoomEvent
    const refresh = () => {
      if (this.room === room) this.refresh()
    }
    for (const ev of [
      E.ParticipantConnected,
      E.ParticipantDisconnected,
      E.TrackPublished,
      E.TrackUnpublished,
      E.TrackMuted,
      E.TrackUnmuted,
      E.LocalTrackPublished,
      E.LocalTrackUnpublished,
      E.ActiveSpeakersChanged,
      E.ParticipantNameChanged,
      E.AudioPlaybackStatusChanged,
    ] as const) {
      room.on(ev, refresh)
    }
    room.on(E.TrackSubscribed, (track: RemoteTrack, _pub, participant: RemoteParticipant) => {
      if (this.room !== room) return
      if (track.kind === lk.Track.Kind.Audio) this.playAudio(track, participant)
      this.refresh()
    })
    room.on(E.TrackUnsubscribed, (track: RemoteTrack) => {
      if (track.kind === lk.Track.Kind.Audio) this.stopAudio(track)
      refresh()
    })
    room.on(E.MediaDevicesChanged, () => {
      if (this.room === room) void this.refreshDevices()
    })
    room.on(E.ActiveDeviceChanged, () => {
      if (this.room === room) void this.refreshDevices()
    })
    room.on(E.Reconnecting, () => {
      if (this.room === room) this.emit({ phase: 'reconnecting' })
    })
    room.on(E.SignalReconnecting, () => {
      if (this.room === room) this.emit({ phase: 'reconnecting' })
    })
    room.on(E.Reconnected, () => {
      if (this.room === room) this.emit({ phase: 'connected' })
    })
    room.on(E.Disconnected, (reason) => {
      if (this.room !== room || this.over) return
      const R = lk.DisconnectReason
      if (reason === R.CLIENT_INITIATED) return this.finish('left')
      if (reason === R.ROOM_DELETED || reason === R.ROOM_CLOSED) return this.finish('ended')
      if (reason === R.DUPLICATE_IDENTITY) return this.finish('elsewhere')
      if (reason === R.PARTICIPANT_REMOVED) return this.finish('removed')
      void this.rejoin()
    })
  }

  /** Lost for good: once, with a fresh token. */
  private async rejoin() {
    if (this.rejoined || this.over) {
      this.finish('failed')
      return
    }
    this.rejoined = true
    this.emit({ phase: 'reconnecting' })
    this.clearAudio()
    let join: TeamCallJoin | null = null
    try {
      join = await this.deps.refreshJoin(!this.holdMic)
    } catch {
      join = null
    }
    if (this.over) return
    if (!join) {
      this.finish('ended')
      return
    }
    await this.connect(join)
  }

  private playAudio(track: RemoteTrack, participant: RemoteParticipant) {
    if (typeof document === 'undefined') return
    if (!this.audioBox) {
      this.audioBox = document.createElement('div')
      this.audioBox.hidden = true
      this.audioBox.dataset.teamCallAudio = ''
      document.body.appendChild(this.audioBox)
    }
    const el = track.attach()
    el.dataset.teamCallAudio = participant.identity
    this.audioBox.appendChild(el)
    this.audioEls.set(track.sid ?? participant.identity, [...(this.audioEls.get(track.sid ?? participant.identity) ?? []), el])
  }

  private stopAudio(track: RemoteTrack) {
    for (const el of track.detach()) el.remove()
    this.audioEls.delete(track.sid ?? '')
  }

  private clearAudio() {
    for (const els of this.audioEls.values()) for (const el of els) el.remove()
    this.audioEls.clear()
    this.audioBox?.remove()
    this.audioBox = null
  }

  private tileOf(p: Participant, lk: typeof import('livekit-client'), speaking: Set<string>, isLocal: boolean): CallTile[] {
    const guest = guestIdOfIdentity(p.identity) !== null
    const name = p.name?.trim() || (isLocal ? 'You' : guest ? 'Guest' : 'A teammate')
    const camera = p.getTrackPublication(lk.Track.Source.Camera)
    const screen = p.getTrackPublication(lk.Track.Source.ScreenShare)
    const tiles: CallTile[] = [
      {
        key: p.identity,
        identity: p.identity,
        name,
        kind: 'person',
        isLocal,
        guest,
        speaking: speaking.has(p.identity),
        micOn: p.isMicrophoneEnabled,
        video: camera && !camera.isMuted && camera.track ? camera.track : null,
      },
    ]
    if (screen?.track && !screen.isMuted) {
      tiles.push({ key: `${p.identity}:screen`, identity: p.identity, name, kind: 'screen', isLocal, guest, speaking: false, micOn: p.isMicrophoneEnabled, video: screen.track })
    }
    return tiles
  }

  private refresh() {
    const room = this.room
    const lk = this.sdk
    if (!room || !lk) return
    const speaking = new Set(room.activeSpeakers.map((s) => s.identity))
    const local: LocalParticipant = room.localParticipant
    const remotes = [...room.remoteParticipants.values()].sort((a, b) => (a.joinedAt?.getTime() ?? 0) - (b.joinedAt?.getTime() ?? 0))
    const tiles = [...this.tileOf(local, lk, speaking, true), ...remotes.flatMap((p) => this.tileOf(p, lk, speaking, false))]
    const micOn = local.isMicrophoneEnabled
    const camOn = local.isCameraEnabled
    this.emit({
      tiles,
      people: 1 + remotes.length,
      mic: micOn ? 'on' : this.mic === 'on' ? 'off' : this.mic,
      camera: camOn ? 'on' : this.camera === 'on' ? 'off' : this.camera,
      screen: local.isScreenShareEnabled ? 'on' : 'off',
      needsAudioStart: !room.canPlaybackAudio,
    })
  }

  private async refreshDevices() {
    const lk = this.sdk
    const room = this.room
    if (!lk || !room) return
    const read = async (kind: CallDeviceKind) => {
      try {
        return (await lk.Room.getLocalDevices(kind, false)).filter((d) => d.deviceId).map((d) => ({ deviceId: d.deviceId, label: d.label }))
      } catch {
        return []
      }
    }
    const [audioinput, audiooutput, videoinput] = await Promise.all([read('audioinput'), read('audiooutput'), read('videoinput')])
    if (this.room !== room) return
    this.emit({
      devices: { audioinput, audiooutput, videoinput },
      active: {
        audioinput: room.getActiveDevice('audioinput'),
        audiooutput: room.getActiveDevice('audiooutput'),
        videoinput: room.getActiveDevice('videoinput'),
      },
    })
  }

  /** The call's notes went on or off: from now on a mute unpublishes the microphone (on) or only mutes it (off). */
  setNotesMode(on: boolean): void {
    this.notesMode = on
  }

  async toggleMic(): Promise<void> {
    if (this.holdMic) return this.releaseMic()
    const room = this.room
    const lk = this.sdk
    if (!room || !lk) return
    const on = !room.localParticipant.isMicrophoneEnabled
    try {
      const mic = room.localParticipant.getTrackPublication(lk.Track.Source.Microphone)
      if (!on && this.notesMode && mic?.track) {
        // Notes on: a mute ends this microphone track (and its notes file); unmuting publishes a new one,
        // a new file whose place in the call is its own start. No stretch of a file is muted time.
        await room.localParticipant.unpublishTrack(mic.track, true)
      } else {
        await room.localParticipant.setMicrophoneEnabled(on)
      }
      this.mic = on ? 'on' : 'off'
      this.userMuted = !on
    } catch (err) {
      this.mic = deviceStateOfError(err, lk.MediaDeviceFailure.getFailure(err))
    }
    this.refresh()
    if (on) void this.refreshDevices()
  }

  async toggleCamera(): Promise<void> {
    const room = this.room
    const lk = this.sdk
    if (!room || !lk) return
    const on = !room.localParticipant.isCameraEnabled
    try {
      await room.localParticipant.setCameraEnabled(on)
      this.camera = on ? 'on' : 'off'
    } catch (err) {
      this.camera = deviceStateOfError(err, lk.MediaDeviceFailure.getFailure(err))
    }
    this.refresh()
    if (on) void this.refreshDevices()
  }

  async toggleScreen(): Promise<void> {
    const room = this.room
    if (!room || !this.snapshot.canShareScreen) return
    try {
      await room.localParticipant.setScreenShareEnabled(!room.localParticipant.isScreenShareEnabled, { audio: false })
    } catch {
      // The person closed the picker, or the system refused: nothing is shared, nothing to say.
    }
    this.refresh()
  }

  async setDevice(kind: CallDeviceKind, deviceId: string): Promise<void> {
    const room = this.room
    if (!room) return
    try {
      await room.switchActiveDevice(kind, deviceId)
    } catch {
      // The device went away: the list refreshes below.
    }
    void this.refreshDevices()
  }

  /** After an error: a fresh token from the token route, and join again (the call ended meanwhile: ended). */
  async retry(): Promise<void> {
    if (this.over || this.snapshot.phase !== 'error') return
    this.emit({ phase: 'connecting', error: null })
    let join: TeamCallJoin | null = null
    try {
      join = await this.deps.refreshJoin(!this.holdMic)
    } catch {
      join = null
    }
    if (this.over) return
    if (!join) {
      this.finish('ended')
      return
    }
    await this.connect(join)
  }

  /** The browser held audio back: a click lets it play. */
  async startAudio(): Promise<void> {
    try {
      await this.room?.startAudio()
    } finally {
      this.refresh()
    }
  }

  /** Hang up: out of the room, and the server told (a DM's call ends with it). */
  async leave(): Promise<void> {
    if (this.over) return
    this.finish('left')
    try {
      await this.deps.hangUp()
    } catch {
      // The webhook will tell the server anyway.
    }
  }

  private finish(why: CallEnd) {
    if (this.over) return
    this.over = true
    const room = this.room
    this.room = null
    this.clearAudio()
    if (room) void room.disconnect(true).catch(() => undefined)
    this.emit({ phase: 'ended', ended: why, tiles: [] })
    this.deps.onEnded?.(why)
  }
}
