/**
 * One call on the page (src/lib/team-calls/call-session.ts), against a
 * stand-in for the LiveKit SDK: audio on and camera off as it joins, a
 * refused microphone joins listening only (and says why), the speaking
 * light follows LiveKit's active-speaker event, a connection lost for good
 * is joined again once with a fresh token (a call that ended there ends
 * here), the room closing ends it, and leaving tells the server.
 */
import { describe, expect, it, vi } from 'vitest'
import { TeamCallSession, deviceStateOfError, type TeamCallJoin } from '../call-session'

type Handler = (...args: unknown[]) => void

function fakeSdk(opts: { micError?: Error } = {}) {
  const rooms: FakeRoom[] = []
  class FakeParticipant {
    isMicrophoneEnabled = false
    isCameraEnabled = false
    isScreenShareEnabled = false
    joinedAt = new Date()
    constructor(
      public identity: string,
      public name: string,
    ) {}
    getTrackPublication() {
      return undefined
    }
    async setMicrophoneEnabled(on: boolean) {
      if (opts.micError) throw opts.micError
      this.isMicrophoneEnabled = on
    }
    async setCameraEnabled(on: boolean) {
      this.isCameraEnabled = on
    }
    async setScreenShareEnabled(on: boolean) {
      this.isScreenShareEnabled = on
    }
  }
  class FakeRoom {
    handlers = new Map<string, Handler[]>()
    localParticipant = new FakeParticipant('me', 'Ana Ruiz')
    remoteParticipants = new Map<string, FakeParticipant>()
    activeSpeakers: FakeParticipant[] = []
    canPlaybackAudio = true
    connected: TeamCallJoin | null = null
    disconnected = false
    constructor(public options: Record<string, unknown>) {
      rooms.push(this)
    }
    on(ev: string, fn: Handler) {
      this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn])
      return this
    }
    emit(ev: string, ...args: unknown[]) {
      for (const fn of this.handlers.get(ev) ?? []) fn(...args)
    }
    async connect(url: string, token: string) {
      this.connected = { url, token, room: 'tc-x', callId: 'x' }
    }
    async disconnect() {
      this.disconnected = true
    }
    getActiveDevice() {
      return undefined
    }
    async switchActiveDevice() {
      return true
    }
    async startAudio() {}
    static async getLocalDevices() {
      return []
    }
  }
  const sdk = {
    Room: FakeRoom,
    RoomEvent: new Proxy({}, { get: (_t, k) => String(k) }),
    Track: { Kind: { Audio: 'audio', Video: 'video' }, Source: { Camera: 'camera', ScreenShare: 'screen_share', Microphone: 'microphone' } },
    DisconnectReason: { CLIENT_INITIATED: 1, DUPLICATE_IDENTITY: 2, PARTICIPANT_REMOVED: 4, ROOM_DELETED: 5, ROOM_CLOSED: 10, SIGNAL_CLOSE: 9 },
    MediaDeviceFailure: { getFailure: (e: unknown) => ((e as Error)?.name === 'NotAllowedError' ? 'PermissionDenied' : undefined) },
    VideoPresets: { h720: { resolution: { width: 1280, height: 720 } } },
    supportsAudioOutputSelection: () => false,
  }
  return { sdk: sdk as unknown as typeof import('livekit-client'), rooms, FakeParticipant }
}

const JOIN: TeamCallJoin = { url: 'wss://lk.example.invalid', token: 't1', room: 'tc-x', callId: 'x' }
const INFO = { callId: 'x', channelId: 'c', channelKind: 'channel' as const, label: '#launch' }

function session(sdk: typeof import('livekit-client'), deps: Partial<ConstructorParameters<typeof TeamCallSession>[1]> = {}) {
  return new TeamCallSession(INFO, { refreshJoin: async () => null, hangUp: async () => {}, loadSdk: async () => sdk, ...deps })
}

describe('TeamCallSession', () => {
  it('joins with audio on and the camera off, adaptive stream, dynacast and simulcast on', async () => {
    const { sdk, rooms } = fakeSdk()
    const s = session(sdk)
    await s.connect(JOIN)
    const snap = s.getSnapshot()
    expect(snap.phase).toBe('connected')
    expect(snap.mic).toBe('on')
    expect(snap.camera).toBe('off')
    expect(snap.tiles.map((t) => [t.identity, t.isLocal])).toEqual([['me', true]])
    expect(rooms[0].options).toMatchObject({ adaptiveStream: true, dynacast: true, publishDefaults: expect.objectContaining({ simulcast: true, videoCodec: 'vp8' }) })
    expect(rooms[0].connected?.token).toBe('t1')
  })

  it('a refused microphone joins listening only, and says it is blocked', async () => {
    const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })
    const { sdk } = fakeSdk({ micError: denied })
    const s = session(sdk)
    await s.connect(JOIN)
    expect(s.getSnapshot().phase).toBe('connected')
    expect(s.getSnapshot().mic).toBe('blocked')
  })

  it('who is speaking comes from LiveKit’s active-speaker event', async () => {
    const { sdk, rooms, FakeParticipant } = fakeSdk()
    const s = session(sdk)
    await s.connect(JOIN)
    const ben = new FakeParticipant('ben', 'Ben Ito')
    rooms[0].remoteParticipants.set('ben', ben)
    rooms[0].emit('ParticipantConnected', ben)
    expect(s.getSnapshot().people).toBe(2)
    rooms[0].activeSpeakers = [ben]
    rooms[0].emit('ActiveSpeakersChanged', [ben])
    expect(s.getSnapshot().tiles.find((t) => t.identity === 'ben')?.speaking).toBe(true)
    expect(s.getSnapshot().tiles.find((t) => t.identity === 'me')?.speaking).toBe(false)
  })

  it('reconnecting shows, and clears when LiveKit is back', async () => {
    const { sdk, rooms } = fakeSdk()
    const s = session(sdk)
    await s.connect(JOIN)
    rooms[0].emit('Reconnecting')
    expect(s.getSnapshot().phase).toBe('reconnecting')
    rooms[0].emit('Reconnected')
    expect(s.getSnapshot().phase).toBe('connected')
  })

  it('lost for good: joined again once, with a fresh token from the token route', async () => {
    const { sdk, rooms } = fakeSdk()
    const refreshJoin = vi.fn(async () => ({ ...JOIN, token: 't2' }))
    const s = session(sdk, { refreshJoin })
    await s.connect(JOIN)
    rooms[0].emit('Disconnected', 9)
    await vi.waitFor(() => expect(rooms).toHaveLength(2))
    await vi.waitFor(() => expect(s.getSnapshot().phase).toBe('connected'))
    expect(refreshJoin).toHaveBeenCalledTimes(1)
    expect(rooms[1].connected?.token).toBe('t2')
    // A second loss is the end (no loop).
    rooms[1].emit('Disconnected', 9)
    await vi.waitFor(() => expect(s.getSnapshot().phase).toBe('ended'))
    expect(s.getSnapshot().ended).toBe('failed')
  })

  it('lost, and the call ended meanwhile (the token route said so): it ends here', async () => {
    const { sdk, rooms } = fakeSdk()
    const onEnded = vi.fn()
    const s = session(sdk, { refreshJoin: async () => null, onEnded })
    await s.connect(JOIN)
    rooms[0].emit('Disconnected', 9)
    await vi.waitFor(() => expect(onEnded).toHaveBeenCalledWith('ended'))
  })

  it('the room closed (a DM hung up, the last person left): ended', async () => {
    const { sdk, rooms } = fakeSdk()
    const onEnded = vi.fn()
    const s = session(sdk, { onEnded })
    await s.connect(JOIN)
    rooms[0].emit('Disconnected', 5)
    expect(s.getSnapshot()).toMatchObject({ phase: 'ended', ended: 'ended', tiles: [] })
    expect(onEnded).toHaveBeenCalledTimes(1)
  })

  it('joined on another device (same identity): this one says so', async () => {
    const { sdk, rooms } = fakeSdk()
    const s = session(sdk)
    await s.connect(JOIN)
    rooms[0].emit('Disconnected', 2)
    expect(s.getSnapshot().ended).toBe('elsewhere')
  })

  it('leaving disconnects and tells the server, once', async () => {
    const { sdk, rooms } = fakeSdk()
    const hangUp = vi.fn(async () => {})
    const s = session(sdk, { hangUp })
    await s.connect(JOIN)
    await s.leave()
    await s.leave()
    expect(rooms[0].disconnected).toBe(true)
    expect(hangUp).toHaveBeenCalledTimes(1)
    expect(s.getSnapshot().ended).toBe('left')
  })

  it('toggles the camera', async () => {
    const { sdk } = fakeSdk()
    const s = session(sdk)
    await s.connect(JOIN)
    await s.toggleCamera()
    expect(s.getSnapshot().camera).toBe('on')
    await s.toggleCamera()
    expect(s.getSnapshot().camera).toBe('off')
  })
})

describe('deviceStateOfError', () => {
  it('reads LiveKit’s failure first, then the error’s name', () => {
    expect(deviceStateOfError(new Error('x'), 'PermissionDenied')).toBe('blocked')
    expect(deviceStateOfError(new Error('x'), 'NotFound')).toBe('missing')
    expect(deviceStateOfError(new Error('x'), 'DeviceInUse')).toBe('busy')
    expect(deviceStateOfError(Object.assign(new Error('x'), { name: 'NotReadableError' }), undefined)).toBe('busy')
    expect(deviceStateOfError(Object.assign(new Error('x'), { name: 'NotFoundError' }), undefined)).toBe('missing')
  })
})
