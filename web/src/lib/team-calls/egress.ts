/**
 * The app's side of LiveKit Egress (deploy/livekit, PR #80), server only:
 * what the call notes and recordings ask of it.
 *
 * Settings (an empty value counts as unset):
 *   LIVEKIT_EGRESS=on        the egress service runs beside LiveKit, with its
 *                            own storage settings: Supabase Storage's S3
 *                            endpoint, bucket `team-call-recordings` (566),
 *                            no filename prefix. The app sends only a file's
 *                            name, never a storage key. Off: no notes, no
 *                            recording, nothing below is ever called.
 *   DEEPGRAM_API_KEY         notes need it too (each file is transcribed).
 *   TEAM_CALL_RECORDING=on   the Record control shows (heavy on the server:
 *                            a whole browser per recording; measure first).
 *   TEAM_CALL_RECORDING_MAX  how many recordings may run at once across the
 *                            server (default 1).
 *
 * Every call goes through {@link TeamCallEgressPort}, so tests hand a fake.
 */
import 'server-only'
import {
  DirectFileOutput,
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  EncodingOptions,
  RoomServiceClient,
  TrackSource,
  TrackType,
} from 'livekit-server-sdk'
import { teamCallsConfig, type TeamCallsConfig } from './livekit'
import { NO_CALL_FEATURES, type TeamCallFeatures } from './notes'

function on(name: string, env: NodeJS.ProcessEnv): boolean {
  return env[name]?.trim().toLowerCase() === 'on'
}

/** LiveKit with its egress service, or null (calls off, or LIVEKIT_EGRESS not on). */
export function teamCallEgressConfig(env: NodeJS.ProcessEnv = process.env): TeamCallsConfig | null {
  const config = teamCallsConfig(env)
  return config && on('LIVEKIT_EGRESS', env) ? config : null
}

/** What this server offers a call: notes (egress and a Deepgram key) and recording (egress and TEAM_CALL_RECORDING=on). */
export function teamCallFeatures(env: NodeJS.ProcessEnv = process.env): TeamCallFeatures {
  if (!teamCallEgressConfig(env)) return NO_CALL_FEATURES
  return { notes: !!env.DEEPGRAM_API_KEY?.trim(), recording: on('TEAM_CALL_RECORDING', env) }
}

/** The most recordings at once across the server (TEAM_CALL_RECORDING_MAX, default 1). */
export function maxLiveRecordings(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.TEAM_CALL_RECORDING_MAX?.trim() ?? '', 10)
  return Number.isFinite(n) && n >= 1 && n <= 20 ? n : 1
}

/** An egress as LiveKit lists it (the parts the sweeper reads). */
export interface ListedEgress {
  egressId: string
  status: number
  updatedAtNs: bigint
  startedAtNs: bigint
  endedAtNs: bigint
  error: string
  file: { filename: string; startedAtNs: bigint; endedAtNs: bigint; durationNs: bigint; size: bigint } | null
}

export interface TeamCallEgressPort {
  /** Write one microphone track to a file (audio only, Opus in Ogg). */
  startTrack(room: string, trackSid: string, filepath: string): Promise<{ egressId: string }>
  /** Write the whole call (video and audio) to one MP4. */
  startRecording(room: string, filepath: string): Promise<{ egressId: string }>
  /** Stop an egress; one already over is fine. */
  stop(egressId: string): Promise<void>
  /** The egresses of a room LiveKit knows (active or finished recently). */
  list(room: string): Promise<ListedEgress[]>
  /** The microphone tracks published in a room now. */
  microphones(room: string): Promise<Array<{ identity: string; trackSid: string }>>
}

/**
 * The recording's encoding: 720p at 24 frames, 1.5 Mbit/s of video and 96
 * kbit/s of audio, about 0.7 GB an hour (2 hours fit the bucket's 2 GB).
 */
export function recordingEncoding(): EncodingOptions {
  return new EncodingOptions({ width: 1280, height: 720, framerate: 24, videoBitrate: 1500, audioBitrate: 96, keyFrameInterval: 4 })
}

function alreadyOver(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /not.?found|cannot be stopped|already|not active|EGRESS_(COMPLETE|FAILED|ABORTED)/i.test(message)
}

/** The real port: LiveKit's Egress and Room services at the server API. */
export function liveKitEgress(config: TeamCallsConfig): TeamCallEgressPort {
  const egress = new EgressClient(config.apiUrl, config.apiKey, config.apiSecret)
  const rooms = new RoomServiceClient(config.apiUrl, config.apiKey, config.apiSecret)
  return {
    async startTrack(room, trackSid, filepath) {
      const info = await egress.startTrackEgress(room, new DirectFileOutput({ filepath, disableManifest: true }), trackSid)
      return { egressId: info.egressId }
    },
    async startRecording(room, filepath) {
      const info = await egress.startRoomCompositeEgress(
        room,
        { file: new EncodedFileOutput({ fileType: EncodedFileType.MP4, filepath, disableManifest: true }) },
        { layout: 'grid', encodingOptions: recordingEncoding() },
      )
      return { egressId: info.egressId }
    },
    async stop(egressId) {
      try {
        await egress.stopEgress(egressId)
      } catch (err) {
        if (!alreadyOver(err)) throw err
      }
    },
    async list(room) {
      const list = await egress.listEgress({ roomName: room })
      return list.map((e) => {
        const f = e.fileResults[0]
        return {
          egressId: e.egressId,
          status: e.status,
          updatedAtNs: e.updatedAt,
          startedAtNs: e.startedAt,
          endedAtNs: e.endedAt,
          error: e.error,
          file: f ? { filename: f.filename, startedAtNs: f.startedAt, endedAtNs: f.endedAt, durationNs: f.duration, size: f.size } : null,
        }
      })
    },
    async microphones(room) {
      const people = await rooms.listParticipants(room)
      const out: Array<{ identity: string; trackSid: string }> = []
      for (const p of people) {
        for (const t of p.tracks) {
          if (t.type === TrackType.AUDIO && t.source === TrackSource.MICROPHONE && t.sid) out.push({ identity: p.identity, trackSid: t.sid })
        }
      }
      return out
    },
  }
}
