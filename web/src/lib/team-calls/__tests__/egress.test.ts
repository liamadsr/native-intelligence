/**
 * What the server offers a call (src/lib/team-calls/egress.ts): nothing
 * without LiveKit, nothing without LIVEKIT_EGRESS=on; notes need a Deepgram
 * key too; recording needs TEAM_CALL_RECORDING=on; the recordings' cap
 * defaults to 1; the recording's encoding fits its bound in the bucket.
 */
import { describe, expect, it } from 'vitest'
import { maxLiveRecordings, recordingEncoding, teamCallEgressConfig, teamCallFeatures } from '../egress'
import { TEAM_CALL_RECORDING_MAX_SECONDS } from '../notes'
import { LIVEKIT_ENV } from './signing'

describe('teamCallFeatures', () => {
  it('nothing without LiveKit, or without the egress service', () => {
    expect(teamCallFeatures({ LIVEKIT_EGRESS: 'on', DEEPGRAM_API_KEY: 'k', TEAM_CALL_RECORDING: 'on' })).toEqual({ notes: false, recording: false })
    expect(teamCallFeatures({ ...LIVEKIT_ENV, DEEPGRAM_API_KEY: 'k', TEAM_CALL_RECORDING: 'on' })).toEqual({ notes: false, recording: false })
    expect(teamCallFeatures({ ...LIVEKIT_ENV, LIVEKIT_EGRESS: 'yes', DEEPGRAM_API_KEY: 'k' })).toEqual({ notes: false, recording: false })
    expect(teamCallEgressConfig({ ...LIVEKIT_ENV, LIVEKIT_EGRESS: ' On ' })?.apiUrl).toBe('https://livekit.example.invalid')
  })
  it('notes with a Deepgram key; recording only when allowed', () => {
    expect(teamCallFeatures({ ...LIVEKIT_ENV, LIVEKIT_EGRESS: 'on', DEEPGRAM_API_KEY: 'k' })).toEqual({ notes: true, recording: false })
    expect(teamCallFeatures({ ...LIVEKIT_ENV, LIVEKIT_EGRESS: 'on', DEEPGRAM_API_KEY: ' ', TEAM_CALL_RECORDING: 'on' })).toEqual({ notes: false, recording: true })
  })
})

describe('the recordings', () => {
  it('one at a time across the server unless set otherwise (1 to 20)', () => {
    expect(maxLiveRecordings({})).toBe(1)
    expect(maxLiveRecordings({ TEAM_CALL_RECORDING_MAX: '3' })).toBe(3)
    expect(maxLiveRecordings({ TEAM_CALL_RECORDING_MAX: '0' })).toBe(1)
    expect(maxLiveRecordings({ TEAM_CALL_RECORDING_MAX: 'lots' })).toBe(1)
  })
  it('a recording at its bound fits the bucket\'s 2 GB', () => {
    const e = recordingEncoding()
    const bytes = ((e.videoBitrate + e.audioBitrate) * 1000 * TEAM_CALL_RECORDING_MAX_SECONDS) / 8
    expect(bytes).toBeLessThan(2 * 1024 ** 3)
    expect([e.width, e.height]).toEqual([1280, 720])
  })
})
