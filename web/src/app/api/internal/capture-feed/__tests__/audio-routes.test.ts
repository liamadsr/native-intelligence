/**
 * The capture feed's audio requests (migration 650) and the start's `audio`:
 * nothing without the feed's secret; nothing granted while the switch
 * (TEAM_CALL_AUDIO, with the recorder on) is off, so a file made before it
 * went off is dropped; a grant is 650's function's answer, and its upload is
 * signed with the service role for exactly the path the database chose, one
 * object, upsert (a retry writes the same one); 'stored' is the database's
 * word after it checked Storage; a failed write is 503 (ask again).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import { LIVEKIT_ENV } from '@/lib/team-calls/__tests__/signing'

const CALL = '77777777-7777-4777-8777-777777777777'
const CH = '55555555-5555-4555-8555-555555555555'
const SESSION = '99999999-9999-4999-8999-999999999999'
const CAPTURE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const AUDIO_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FEED = 'capture-feed-secret-of-its-own-0123456789'
const producer = { kind: 'livekit_recorder', id: 'recorder' }
const PATH = `${CH}/${CALL}/audio/${AUDIO_ID}.m4a`

const h = vi.hoisted(() => ({
  svc: null as unknown as SupabaseClient,
  rpcs: [] as Array<[string, Record<string, unknown>]>,
  answers: {} as Record<string, { data: unknown; error: unknown }>,
  signed: [] as Array<{ bucket: string; path: string; opts: unknown }>,
  signError: null as { message: string } | null,
}))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => h.svc }))

import { POST as start } from '../start/route'
import { POST as grant } from '../sessions/[id]/audio/route'
import { POST as stored } from '../sessions/[id]/audio/stored/route'
import { teamCallAudioOn } from '@/lib/team-calls/recorder'

beforeEach(() => {
  vi.stubEnv('CAPTURE_FEED_SECRET', FEED)
  vi.stubEnv('TEAM_CALL_RECORDER', 'on')
  vi.stubEnv('TEAM_CALL_AUDIO', 'on')
  for (const [k, v] of Object.entries(LIVEKIT_ENV)) vi.stubEnv(k, v)
  const tables = {
    team_call: [{ id: CALL, channel_id: CH, workspace_id: 'ws', started_by: null, notes_by: null }],
    team_chat_channel: [{ id: CH, kind: 'channel', name: 'launch', dm_key: null }],
  }
  h.rpcs = []
  h.answers = {}
  h.signed = []
  h.signError = null
  const db = memoryDb(tables) as unknown as Record<string, unknown>
  db.rpc = async (name: string, args: Record<string, unknown>) => {
    h.rpcs.push([name, args])
    return h.answers[name] ?? { data: null, error: { message: `no answer for ${name}` } }
  }
  db.storage = {
    from: (bucket: string) => ({
      createSignedUploadUrl: async (path: string, opts: unknown) => {
        h.signed.push({ bucket, path, opts })
        if (h.signError) return { data: null, error: h.signError }
        return { data: { signedUrl: `https://sb.example.test/storage/v1/object/upload/sign/${bucket}/${path}?token=one-time`, token: 'one-time', path }, error: null }
      },
    }),
  }
  h.svc = db as unknown as SupabaseClient
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const post = (body: unknown, auth = `Bearer ${FEED}`) =>
  new Request('http://localhost/api/internal/capture-feed/x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', authorization: auth } })
const params = (id = SESSION) => ({ params: Promise.resolve({ id }) })
const ask = { producer, take: 't-1', offsetMs: 1200, durationMs: 3_600_000, bytes: 14_500_000, contentType: 'audio/mp4' }

describe('the switch', () => {
  it('TEAM_CALL_AUDIO=on keeps the sound only with the recorder on too', () => {
    const base = { ...LIVEKIT_ENV, CAPTURE_FEED_SECRET: FEED, TEAM_CALL_RECORDER: 'on' } as unknown as NodeJS.ProcessEnv
    expect(teamCallAudioOn({ ...base, TEAM_CALL_AUDIO: 'on' })).toBe(true)
    expect(teamCallAudioOn({ ...base, TEAM_CALL_AUDIO: '' })).toBe(false)
    expect(teamCallAudioOn({ ...base, TEAM_CALL_AUDIO: 'yes' })).toBe(false)
    expect(teamCallAudioOn({ ...base, TEAM_CALL_RECORDER: '', TEAM_CALL_AUDIO: 'on' })).toBe(false)
  })

  it('the start says audio while the switch is on, and not once it is off', async () => {
    h.answers.capture_feed_start = { data: [{ outcome: 'started', session_id: SESSION, capture_id: CAPTURE, started_at: '2026-11-13T10:00:00Z', round: 1, guests: [] }], error: null }
    expect((await (await start(post({ source: { kind: 'team_call', ref: CALL }, producer }))).json()).session.audio).toBe(true)
    vi.stubEnv('TEAM_CALL_AUDIO', '')
    expect((await (await start(post({ source: { kind: 'team_call', ref: CALL }, producer }))).json()).session.audio).toBe(false)
  })

  it('switch off: every grant is not_wanted, nothing asked of the database, nothing signed', async () => {
    vi.stubEnv('TEAM_CALL_AUDIO', '')
    const res = await grant(post(ask), params())
    expect(await res.json()).toEqual({ outcome: 'not_wanted', upload: null, expiresAt: null })
    expect(h.rpcs).toEqual([])
    expect(h.signed).toEqual([])
  })
})

describe('the secret and the shape', () => {
  it('404 while the feed is off, 401 without its secret, 400 for a take that is not the contract, 404 for a session that is not an id', async () => {
    vi.stubEnv('CAPTURE_FEED_SECRET', '')
    expect((await grant(post(ask), params())).status).toBe(404)
    vi.stubEnv('CAPTURE_FEED_SECRET', FEED)
    expect((await grant(post(ask, 'Bearer nope'), params())).status).toBe(401)
    expect((await stored(post({ producer, take: 't-1' }, ''), params())).status).toBe(401)
    expect((await grant(post({ ...ask, take: 'a/b' }), params())).status).toBe(400)
    expect((await grant(post({ ...ask, contentType: 'video/mp4' }), params())).status).toBe(400)
    expect((await grant(post({ ...ask, bytes: 3 * 1024 ** 3 }), params())).status).toBe(400)
    expect((await grant(post({ ...ask, bytes: 0 }), params())).status).toBe(400)
    expect((await grant(post(ask), params('not-an-id'))).status).toBe(404)
    expect(h.rpcs).toEqual([])
  })
})

describe('the grant', () => {
  it('granted: 650 decides and names the path; the upload is signed for that one object, upsert, with the service role', async () => {
    h.answers.capture_feed_audio_grant = { data: [{ outcome: 'granted', audio_id: AUDIO_ID, path: PATH, expires_at: '2026-12-13T10:00:00+00:00' }], error: null }
    const res = await grant(post(ask), params(SESSION.toUpperCase()))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      outcome: 'granted',
      upload: {
        url: `https://sb.example.test/storage/v1/object/upload/sign/team-call-recordings/${PATH}?token=one-time`,
        method: 'PUT',
        headers: { 'content-type': 'audio/mp4', 'x-upsert': 'true', 'cache-control': 'max-age=3600' },
      },
      expiresAt: '2026-12-13T10:00:00.000Z',
    })
    expect(h.rpcs).toEqual([
      ['capture_feed_audio_grant', { p_session: SESSION, p_producer_id: 'recorder', p_take: 't-1', p_offset_ms: 1200, p_duration_ms: 3_600_000, p_bytes: 14_500_000, p_content_type: 'audio/mp4' }],
    ])
    expect(h.signed).toEqual([{ bucket: 'team-call-recordings', path: PATH, opts: { upsert: true } }])
  })

  it('anything but granted: no upload, nothing signed (the producer drops its file)', async () => {
    for (const outcome of ['stored', 'not_wanted', 'too_large', 'taken', 'unknown']) {
      h.answers.capture_feed_audio_grant = { data: [{ outcome, audio_id: null, path: null, expires_at: null }], error: null }
      expect(await (await grant(post(ask), params())).json()).toEqual({ outcome, upload: null, expiresAt: null })
    }
    expect(h.signed).toEqual([])
  })

  it('the database or Storage could not be written: 503, ask again', async () => {
    h.answers.capture_feed_audio_grant = { data: null, error: { message: 'down' } }
    expect((await grant(post(ask), params())).status).toBe(503)
    h.answers.capture_feed_audio_grant = { data: [{ outcome: 'granted', audio_id: AUDIO_ID, path: PATH, expires_at: '2026-12-13T10:00:00Z' }], error: null }
    h.signError = { message: 'storage down' }
    expect((await grant(post(ask), params())).status).toBe(503)
  })
})

describe('stored', () => {
  it('the database’s word after it read Storage: stored, or missing (upload again); 503 on a failed write', async () => {
    h.answers.capture_feed_audio_stored = { data: [{ outcome: 'stored', audio_id: AUDIO_ID, bytes: 14_400_000, expires_at: '2026-12-13T10:00:00Z' }], error: null }
    expect(await (await stored(post({ producer, take: 't-1' }), params())).json()).toEqual({ outcome: 'stored', expiresAt: '2026-12-13T10:00:00.000Z' })
    expect(h.rpcs.at(-1)).toEqual(['capture_feed_audio_stored', { p_session: SESSION, p_producer_id: 'recorder', p_take: 't-1' }])
    h.answers.capture_feed_audio_stored = { data: [{ outcome: 'missing', audio_id: AUDIO_ID, bytes: null, expires_at: '2026-12-13T10:00:00Z' }], error: null }
    expect((await (await stored(post({ producer, take: 't-1' }), params())).json()).outcome).toBe('missing')
    h.answers.capture_feed_audio_stored = { data: null, error: { message: 'down' } }
    expect((await stored(post({ producer, take: 't-1' }), params())).status).toBe(503)
  })
})
