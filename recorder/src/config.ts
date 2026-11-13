/**
 * The recorder's settings, from its environment (deploy/livekit/.env through
 * compose.yaml). An empty value counts as unset.
 *
 *   RECORDER_APP_URL          the app's public address (https://...): the
 *                             work it asks for and the feed it writes to.
 *   CAPTURE_FEED_SECRET       sent with every request to the app.
 *   RECORDER_DEEPGRAM_API_KEY Deepgram's key, for its streaming API.
 *   RECORDER_LIVEKIT_URL      where it joins rooms (default ws://livekit:7880,
 *                             LiveKit on the stack's private network).
 *   RECORDER_ID               its name on the feed (default `recorder`): a
 *                             restarted recorder with the same name takes its
 *                             calls up again at once.
 *   RECORDER_MAX_CALLS        calls at once (default 10).
 *   RECORDER_DEEPGRAM_URL     Deepgram's streaming address (a test's fake).
 *   RECORDER_HEALTH_PORT      the health answer, on 127.0.0.1 only (9091).
 *   RECORDER_AUDIO            `on`: keep each call's sound too, when the app
 *                             asks for it (./audio.ts). Off unless set.
 *   RECORDER_AUDIO_DIR        where takes are written (default
 *                             /var/lib/recorder/audio, the service's volume).
 *   RECORDER_FFMPEG           the encoder (default `ffmpeg`, in the image).
 *   RECORDER_AUDIO_MIN_FREE_MB  no new take with less free on that disk
 *                             (default 2048).
 */

export interface RecorderConfig {
  appUrl: string
  feedSecret: string
  deepgramKey: string
  deepgramUrl: string
  livekitUrl: string
  producerId: string
  maxCalls: number
  healthPort: number
  /** The most one call is heard (3 hours of notes, and a margin; the app stops it first). */
  maxCallMs: number
  /** Keeping the calls' sound (null: off). */
  audio: { dir: string; ffmpeg: string; minFreeBytes: number } | null
}

/** Deepgram's live endpoint, as the person's own app uses it (web/src/lib/deepgram-stream.ts), with finals only and no diarization: one track is one known speaker. */
export const DEEPGRAM_LIVE_URL = 'wss://api.deepgram.com/v1/listen'

export const DEEPGRAM_PARAMS: Readonly<Record<string, string>> = {
  model: 'nova-3',
  language: 'en',
  encoding: 'linear16',
  sample_rate: '16000',
  channels: '1',
  smart_format: 'true',
  punctuate: 'true',
  interim_results: 'false',
  endpointing: '300',
}

function setting(env: NodeJS.ProcessEnv, name: string): string | null {
  const v = env[name]?.trim()
  return v ? v : null
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(env[name]?.trim() ?? '', 10)
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback
}

/** The settings, or the names of the missing ones. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RecorderConfig | { missing: string[] } {
  const appUrl = setting(env, 'RECORDER_APP_URL')
  const feedSecret = setting(env, 'CAPTURE_FEED_SECRET')
  const deepgramKey = setting(env, 'RECORDER_DEEPGRAM_API_KEY')
  const missing = [
    ...(appUrl && /^https?:\/\/[^/\s]+\/?$/.test(appUrl) ? [] : ['RECORDER_APP_URL']),
    ...(feedSecret ? [] : ['CAPTURE_FEED_SECRET']),
    ...(deepgramKey ? [] : ['RECORDER_DEEPGRAM_API_KEY']),
  ]
  if (missing.length > 0) return { missing }
  return {
    appUrl: appUrl!.replace(/\/+$/, ''),
    feedSecret: feedSecret!,
    deepgramKey: deepgramKey!,
    deepgramUrl: setting(env, 'RECORDER_DEEPGRAM_URL') ?? DEEPGRAM_LIVE_URL,
    livekitUrl: setting(env, 'RECORDER_LIVEKIT_URL') ?? 'ws://livekit:7880',
    producerId: (setting(env, 'RECORDER_ID') ?? 'recorder').slice(0, 80),
    maxCalls: int(env, 'RECORDER_MAX_CALLS', 10, 1, 20),
    healthPort: int(env, 'RECORDER_HEALTH_PORT', 9091, 1, 65535),
    maxCallMs: (3 * 60 + 5) * 60_000,
    audio:
      setting(env, 'RECORDER_AUDIO')?.toLowerCase() === 'on'
        ? {
            dir: setting(env, 'RECORDER_AUDIO_DIR') ?? '/var/lib/recorder/audio',
            ffmpeg: setting(env, 'RECORDER_FFMPEG') ?? 'ffmpeg',
            minFreeBytes: int(env, 'RECORDER_AUDIO_MIN_FREE_MB', 2048, 0, 1_000_000) * 1024 * 1024,
          }
        : null,
  }
}

/** The streaming address with its parameters. */
export function deepgramUrl(base: string): string {
  const url = new URL(base)
  for (const [k, v] of Object.entries(DEEPGRAM_PARAMS)) url.searchParams.set(k, v)
  return url.toString()
}
