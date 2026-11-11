/**
 * The app's side of LiveKit (src/lib/team-calls/livekit.ts): calling is off
 * unless all three settings are there; a join token is one room, the
 * member's id, their name, ten minutes, and only what a call needs; a
 * webhook is believed only with our signature over its own body.
 */
import { describe, expect, it } from 'vitest'
import { TokenVerifier, TrackSource } from 'livekit-server-sdk'
import { receiveTeamCallWebhook, teamCallGrant, teamCallToken, teamCallsConfig } from '../livekit'
import { TEAM_CALL_TOKEN_TTL_SECONDS } from '../types'

import { KEY, SECRET, signWebhook } from './signing'
const ENV = { LIVEKIT_URL: 'wss://livekit.example.invalid', LIVEKIT_API_KEY: KEY, LIVEKIT_API_SECRET: SECRET } as unknown as NodeJS.ProcessEnv
const MEMBER = '33333333-3333-4333-8333-333333333333'

describe('teamCallsConfig', () => {
  it('is on with all three settings, the API on the same host over https', () => {
    expect(teamCallsConfig(ENV)).toEqual({ url: 'wss://livekit.example.invalid', apiUrl: 'https://livekit.example.invalid', apiKey: KEY, apiSecret: SECRET })
  })

  it('is off when any one is unset or empty (an empty value counts as unset)', () => {
    for (const name of ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']) {
      expect(teamCallsConfig({ ...ENV, [name]: undefined } as NodeJS.ProcessEnv), name).toBeNull()
      expect(teamCallsConfig({ ...ENV, [name]: '  ' } as NodeJS.ProcessEnv), name).toBeNull()
    }
    expect(teamCallsConfig({} as NodeJS.ProcessEnv)).toBeNull()
  })

  it('is off for an address that is not a websocket one', () => {
    expect(teamCallsConfig({ ...ENV, LIVEKIT_URL: 'https://livekit.example.invalid' } as NodeJS.ProcessEnv)).toBeNull()
    expect(teamCallsConfig({ ...ENV, LIVEKIT_URL: 'not a url' } as NodeJS.ProcessEnv)).toBeNull()
  })

  it('a developer machine’s ws:// talks http', () => {
    expect(teamCallsConfig({ ...ENV, LIVEKIT_URL: 'ws://127.0.0.1:7880/' } as NodeJS.ProcessEnv)?.apiUrl).toBe('http://127.0.0.1:7880')
  })
})

describe('teamCallToken', () => {
  it('is for one room, the member, their name, ten minutes, with only a call’s grants', async () => {
    const config = teamCallsConfig(ENV)!
    const before = Math.floor(Date.now() / 1000)
    const jwt = await teamCallToken(config, { room: 'tc-abc', memberId: MEMBER, name: '  Ana Ruiz ' })
    const claims = await new TokenVerifier(KEY, SECRET).verify(jwt)
    expect(claims.sub).toBe(MEMBER)
    expect(claims.name).toBe('Ana Ruiz')
    expect(claims.iss).toBe(KEY)
    expect((claims.exp ?? 0) - before).toBeGreaterThanOrEqual(TEAM_CALL_TOKEN_TTL_SECONDS - 2)
    expect((claims.exp ?? 0) - before).toBeLessThanOrEqual(TEAM_CALL_TOKEN_TTL_SECONDS + 2)
    expect(TEAM_CALL_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(15 * 60)
    const video = claims.video!
    expect(video.room).toBe('tc-abc')
    expect(video.roomJoin).toBe(true)
    expect(video.canSubscribe).toBe(true)
    expect(video.canPublishData).toBe(false)
    expect(video.canUpdateOwnMetadata).toBe(false)
    expect(video.roomAdmin).toBe(false)
    expect(video.roomCreate).toBe(false)
    expect(video.roomList).toBe(false)
    expect(video.roomRecord).toBe(false)
    expect(video.hidden).toBe(false)
    expect(video.canPublishSources?.map(String).sort()).toEqual(['camera', 'microphone', 'screen_share', 'screen_share_audio'])
  })

  it('never carries the secret, and a token signed with another secret is refused', async () => {
    const config = teamCallsConfig(ENV)!
    const jwt = await teamCallToken(config, { room: 'tc-abc', memberId: MEMBER, name: '' })
    expect(jwt).not.toContain(SECRET)
    await expect(new TokenVerifier(KEY, 'another-secret-another-secret-another-0001').verify(jwt)).rejects.toBeTruthy()
    expect((await new TokenVerifier(KEY, SECRET).verify(jwt)).name).toBe('A teammate')
  })

  it('the grant lists exactly the four sources', () => {
    expect(teamCallGrant('tc-x').canPublishSources).toEqual([TrackSource.MICROPHONE, TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO])
  })
})

describe('receiveTeamCallWebhook', () => {
  const config = teamCallsConfig(ENV)!
  const body = JSON.stringify({ event: 'room_finished', id: 'EV_1', room: { name: 'tc-x' }, createdAt: '1762850000' })

  it('believes a delivery signed with our secret over its own body', async () => {
    const event = await receiveTeamCallWebhook(config, body, await signWebhook(body))
    expect(event?.event).toBe('room_finished')
    expect(event?.room?.name).toBe('tc-x')
  })

  it('refuses no signature, another secret, and a signature over another body', async () => {
    expect(await receiveTeamCallWebhook(config, body, null)).toBeNull()
    expect(await receiveTeamCallWebhook(config, body, await signWebhook(body, KEY, 'another-secret-another-secret-another-0001'))).toBeNull()
    expect(await receiveTeamCallWebhook(config, body, await signWebhook(body.replace('tc-x', 'tc-y')))).toBeNull()
    expect(await receiveTeamCallWebhook(config, body, 'Bearer nonsense')).toBeNull()
  })
})
