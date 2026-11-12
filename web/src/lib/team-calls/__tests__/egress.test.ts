/**
 * What the server offers a call (src/lib/team-calls/egress.ts): nothing
 * without LiveKit, nothing without LIVEKIT_EGRESS=on; notes need a Deepgram
 * key too, unless the call recorder takes them (then they are live, and need
 * neither); recording needs TEAM_CALL_RECORDING=on; the recordings' cap
 * defaults to 1; the recording's encoding fits its bound in the bucket.
 */
import { describe, expect, it } from 'vitest'
import { maxLiveRecordings, recordingEncoding, teamCallEgressConfig, teamCallFeatures } from '../egress'
import { TEAM_CALL_RECORDING_MAX_SECONDS } from '../notes'
import { LIVEKIT_ENV } from './signing'

const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv

describe('teamCallFeatures', () => {
  it('nothing without LiveKit, or without the egress service', () => {
    expect(teamCallFeatures(env({ LIVEKIT_EGRESS: 'on', DEEPGRAM_API_KEY: 'k', TEAM_CALL_RECORDING: 'on' }))).toEqual({ notes: false, recording: false, liveNotes: false })
    expect(teamCallFeatures(env({ ...LIVEKIT_ENV, DEEPGRAM_API_KEY: 'k', TEAM_CALL_RECORDING: 'on' }))).toEqual({ notes: false, recording: false, liveNotes: false })
    expect(teamCallFeatures(env({ ...LIVEKIT_ENV, LIVEKIT_EGRESS: 'yes', DEEPGRAM_API_KEY: 'k' }))).toEqual({ notes: false, recording: false, liveNotes: false })
    expect(teamCallEgressConfig(env({ ...LIVEKIT_ENV, LIVEKIT_EGRESS: ' On ' }))?.apiUrl).toBe('https://livekit.example.invalid')
  })
  it('notes with a Deepgram key; recording only when allowed', () => {
    expect(teamCallFeatures(env({ ...LIVEKIT_ENV, LIVEKIT_EGRESS: 'on', DEEPGRAM_API_KEY: 'k' }))).toEqual({ notes: true, recording: false, liveNotes: false })
    expect(teamCallFeatures(env({ ...LIVEKIT_ENV, LIVEKIT_EGRESS: 'on', DEEPGRAM_API_KEY: ' ', TEAM_CALL_RECORDING: 'on' }))).toEqual({ notes: false, recording: true, liveNotes: false })
  })
})

describe('the call recorder takes the notes (TEAM_CALL_RECORDER=on)', () => {
  const RECORDER = { ...LIVEKIT_ENV, TEAM_CALL_RECORDER: 'on', CAPTURE_FEED_SECRET: 'feed-secret-of-its-own-0123456789ab' }
  it('notes, live, without Egress or a Deepgram key here (the recorder holds its own); recording stays Egress’s', () => {
    expect(teamCallFeatures(env(RECORDER))).toEqual({ notes: true, recording: false, liveNotes: true })
    expect(teamCallFeatures(env({ ...RECORDER, LIVEKIT_EGRESS: 'on', TEAM_CALL_RECORDING: 'on' }))).toEqual({ notes: true, recording: true, liveNotes: true })
  })
  it('off without its secret, without calls, or unless exactly on', () => {
    expect(teamCallFeatures(env({ ...RECORDER, CAPTURE_FEED_SECRET: ' ' }))).toEqual({ notes: false, recording: false, liveNotes: false })
    expect(teamCallFeatures(env({ TEAM_CALL_RECORDER: 'on', CAPTURE_FEED_SECRET: 'x' }))).toEqual({ notes: false, recording: false, liveNotes: false })
    expect(teamCallFeatures(env({ ...RECORDER, TEAM_CALL_RECORDER: 'yes' }))).toEqual({ notes: false, recording: false, liveNotes: false })
  })
})

describe('the recordings', () => {
  it('one at a time across the server unless set otherwise (1 to 20)', () => {
    expect(maxLiveRecordings(env({}))).toBe(1)
    expect(maxLiveRecordings(env({ TEAM_CALL_RECORDING_MAX: '3' }))).toBe(3)
    expect(maxLiveRecordings(env({ TEAM_CALL_RECORDING_MAX: '0' }))).toBe(1)
    expect(maxLiveRecordings(env({ TEAM_CALL_RECORDING_MAX: 'lots' }))).toBe(1)
  })
  it('a recording at its bound fits the bucket\'s 2 GB', () => {
    const e = recordingEncoding()
    const bytes = ((e.videoBitrate + e.audioBitrate) * 1000 * TEAM_CALL_RECORDING_MAX_SECONDS) / 8
    expect(bytes).toBeLessThan(2 * 1024 ** 3)
    expect([e.width, e.height]).toEqual([1280, 720])
  })
})
